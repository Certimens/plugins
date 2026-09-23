"""engine.py against a local fake HTTP engine."""

import base64
import json
import os
import sys
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, HTTPServer

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'pythonpath'))

from certimens_agent.engine import Engine  # noqa: E402


class FakeEngine(BaseHTTPRequestHandler):
    calls = []
    down = False
    metrics_error = None
    next_file = 1
    next_token = 0

    def log_message(self, *args):
        pass

    def _reply(self, status, body=None):
        self.send_response(status)
        if body is None:
            self.send_header('Content-Type', 'text/plain')
            self.end_headers()
            self.wfile.write(b'Created')
            return
        self.send_header('Content-Type', 'application/json')
        self.end_headers()
        self.wfile.write(json.dumps(body).encode())

    def _handle(self):
        length = int(self.headers.get('Content-Length') or 0)
        body = json.loads(self.rfile.read(length)) if length else None
        FakeEngine.calls.append((self.command, self.path, body, self.headers.get('Authorization')))
        if FakeEngine.down:
            return self._reply(503, {'error': 'indisponible'})
        if self.path == '/api/auth/login':
            if body['password'] != 'secret':
                return self._reply(401, {'error': 'invalid credentials'})
            FakeEngine.next_token += 1
            return self._reply(200, {'email': body['email'], 'role': 'student', 'token': f'sess{FakeEngine.next_token}'})
        if self.path == '/api/auth/tokens' and self.command == 'POST':
            FakeEngine.next_token += 1
            return self._reply(201, {'id': f'tid{FakeEngine.next_token}', 'token': f'api{FakeEngine.next_token}', 'label': body['label']})
        if self.path == '/api/auth/logout':
            return self._reply(204)
        if self.path.startswith('/api/auth/tokens/') and self.command == 'DELETE':
            return self._reply(204)
        if self.path == '/api/files' and self.command == 'POST':
            FakeEngine.next_file += 1
            return self._reply(201, {'id': f'f{FakeEngine.next_file}', 'document_name': body['document_name']})
        if self.path.endswith('/metrics'):
            if FakeEngine.metrics_error:
                return self._reply(400, FakeEngine.metrics_error)
            return self._reply(201)
        if self.path.startswith('/api/files/') and self.command == 'PUT':
            return self._reply(200, {'id': self.path.rsplit('/', 1)[-1], **body})
        return self._reply(404, {'error': 'not found'})

    do_GET = do_POST = do_PUT = do_DELETE = _handle


class EngineTest(unittest.TestCase):
    def setUp(self):
        FakeEngine.calls = []
        FakeEngine.down = False
        FakeEngine.metrics_error = None
        self.server = HTTPServer(('127.0.0.1', 0), FakeEngine)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.url = f'http://127.0.0.1:{self.server.server_port}'
        self.dir = tempfile.mkdtemp()
        self.engine = Engine(os.path.join(self.dir, 'certimens.json'))

    def tearDown(self):
        self.server.shutdown()

    def test_refused_login_is_not_saved(self):
        with self.assertRaises(Exception) as ctx:
            self.engine.login(self.url, 'a@b.fr', 'faux')
        self.assertEqual(ctx.exception.status, 401)
        self.assertFalse(self.engine.config().get('token'))
        self.assertNotIn('password', self.engine.state['config'])

    def test_queue_survives_offline_then_drains(self):
        self.engine.login(self.url, 'a@b.fr', 'secret')
        FakeEngine.down = True
        self.engine.enqueue('doc1', 'Mémoire', (1000, 1002), {'total_keystrokes': 5})
        self.engine.drain()
        self.assertEqual(self.engine.status()[0]['state'], 'offline')
        # the queue is persisted: a fresh startup finds it again
        restarted = Engine(self.engine.path)
        self.assertEqual(restarted.status()[1], 1)
        FakeEngine.down = False
        FakeEngine.calls = []
        restarted.drain()
        self.assertEqual(restarted.status(), ({**restarted.status()[0], 'state': 'synced'}, 0))
        created = [c for c in FakeEngine.calls if c[:2] == ('POST', '/api/files')]
        self.assertEqual(len(created), 1)
        metrics = [c for c in FakeEngine.calls if c[1].endswith('/metrics')][-1][2]['metrics']
        self.assertEqual(metrics, [{'type': 'total_keystrokes', 'value': 5,
                                    'period': {'start': '1970-01-01T00:16:40.000Z', 'end': '1970-01-01T00:16:42.000Z'}}])
        self.assertTrue(FakeEngine.calls[-1][3].startswith('Bearer '))

    def test_rename_is_synced_once(self):
        self.engine.login(self.url, 'a@b.fr', 'secret')
        self.engine.enqueue('doc1', 'Brouillon', (1000, 1002), {'total_keystrokes': 1})
        self.engine.drain()
        self.engine.note_title('doc1', 'Mémoire final')
        self.engine.drain()
        self.engine.drain()
        renames = [c for c in FakeEngine.calls if c[0] == 'PUT' and c[2] == {'document_name': 'Mémoire final'}]
        self.assertEqual(len(renames), 1)

    def test_unknown_metric_type_drops_the_extended_metrics(self):
        self.engine.login(self.url, 'a@b.fr', 'secret')
        FakeEngine.metrics_error = {'code': 'metric_type_unknown', 'error': 'unknown metric type'}
        self.engine.enqueue('doc1', 'Mémoire', (1000, 1002), {'total_keystrokes': 5, 'focus_losses': 1})
        self.engine.drain()
        self.assertTrue(self.engine.state['extendedUnsupported'])
        # the window is resent without them, and goes through
        sent = [c for c in FakeEngine.calls if c[1].endswith('/metrics')][-1][2]['metrics']
        self.assertEqual([m['type'] for m in sent], ['total_keystrokes'])

    def test_other_400_keeps_the_extended_metrics(self):
        """An invalid period used to silence focus_losses and the like for good."""
        self.engine.login(self.url, 'a@b.fr', 'secret')
        FakeEngine.metrics_error = {'code': 'metric_period_invalid', 'error': 'metric period end must be after its start'}
        self.engine.enqueue('doc1', 'Mémoire', (1000, 1002), {'total_keystrokes': 5, 'focus_losses': 1})
        self.engine.drain()
        self.assertFalse(self.engine.state['extendedUnsupported'])
        self.assertEqual(self.engine.status()[1], 0)  # the window is dropped, not retried forever

    def test_login_gives_the_extended_metrics_another_chance(self):
        self.engine.login(self.url, 'a@b.fr', 'secret')
        self.engine.state['extendedUnsupported'] = True
        self.engine.login(self.url, 'a@b.fr', 'secret')
        self.assertFalse(self.engine.state['extendedUnsupported'])

    def test_upload_sends_the_docx_in_base64(self):
        self.engine.login(self.url, 'a@b.fr', 'secret')
        file_id, _ = self.engine.create_file('doc1', 'Mémoire', 'Mémoire')
        self.engine.upload_docx('doc1', b'PK\x03\x04docx')
        method, path, body, _ = FakeEngine.calls[-1]
        self.assertEqual((method, path), ('PUT', f'/api/files/{file_id}'))
        self.assertEqual(base64.b64decode(body['document']), b'PK\x03\x04docx')

    def test_upload_without_file_is_refused(self):
        self.engine.login(self.url, 'a@b.fr', 'secret')
        with self.assertRaises(Exception) as ctx:
            self.engine.upload_docx('inconnu', b'PK\x03\x04')
        self.assertEqual(ctx.exception.status, 404)

    def test_upload_too_large_is_refused_before_the_network(self):
        self.engine.login(self.url, 'a@b.fr', 'secret')
        self.engine.create_file('doc1', 'Mémoire', 'Mémoire')
        FakeEngine.calls = []
        with self.assertRaises(Exception) as ctx:
            self.engine.upload_docx('doc1', b'x' * (19 * 1024 * 1024))
        self.assertEqual(ctx.exception.status, 413)
        self.assertEqual(FakeEngine.calls, [])

    def test_state_file_is_private(self):
        self.engine.login(self.url, 'a@b.fr', 'secret')
        self.assertEqual(os.stat(self.engine.path).st_mode & 0o777, 0o600)

    def test_legacy_password_is_migrated_once(self):
        # Legacy password-based setting (before tokens): migrated on the first authenticated call.
        self.engine.state['config'] = {'engineUrl': self.url, 'email': 'a@b.fr', 'password': 'secret'}
        cfg = self.engine.authed_config()
        self.assertTrue(cfg['token'])
        self.assertNotIn('password', cfg)
        # persisted: a fresh startup keeps the token, no longer the password
        restarted = Engine(self.engine.path)
        self.assertTrue(restarted.config().get('token'))
        self.assertNotIn('password', restarted.state['config'])
        creates = [c for c in FakeEngine.calls if c[:2] == ('POST', '/api/auth/tokens')]
        self.assertEqual(len(creates), 1)
        # a second call no longer exchanges anything
        FakeEngine.calls = []
        self.engine.authed_config()
        self.assertEqual([c for c in FakeEngine.calls if c[1] == '/api/auth/tokens'], [])

    def test_logout_revokes_the_token(self):
        self.engine.login(self.url, 'a@b.fr', 'secret')
        token_id = self.engine.config()['tokenId']
        FakeEngine.calls = []
        self.engine.logout()
        deletes = [c for c in FakeEngine.calls if c[0] == 'DELETE' and c[1] == f'/api/auth/tokens/{token_id}']
        self.assertEqual(len(deletes), 1)
        self.assertFalse(self.engine.config().get('token'))
        self.assertEqual(self.engine.status()[0]['state'], 'unconfigured')

    def test_login_stores_token_not_password(self):
        self.engine.login(self.url, 'a@b.fr', 'secret')
        cfg = self.engine.config()
        self.assertTrue(cfg['token'])
        self.assertNotIn('password', self.engine.state['config'])
        # login = log in + create the token + revoke the session token
        paths = [c[1] for c in FakeEngine.calls]
        self.assertIn('/api/auth/login', paths)
        self.assertIn('/api/auth/tokens', paths)
        self.assertIn('/api/auth/logout', paths)

    def test_concurrent_migration_creates_one_token(self):
        """Two threads reaching authed_config() at once must not create two API tokens: the
        extra one would stay valid on the engine with nothing recording it."""
        import threading as th
        self.engine.state['config'] = {'engineUrl': self.url, 'email': 'a@b.fr', 'password': 'secret'}
        results, barrier = [], th.Barrier(2)
        def go():
            barrier.wait()
            results.append(self.engine.authed_config())
        threads = [th.Thread(target=go) for _ in range(2)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()
        creates = [c for c in FakeEngine.calls if c[:2] == ('POST', '/api/auth/tokens')]
        self.assertEqual(len(creates), 1)
        self.assertEqual(results[0]['token'], results[1]['token'])

    def test_failed_migration_sets_offline_status(self):
        """A migration that cannot reach the engine must report it, not escape drain() and
        leave the status showing the previous state while the queue grows."""
        self.engine.state['config'] = {'engineUrl': self.url, 'email': 'a@b.fr', 'password': 'secret'}
        self.engine.enqueue('doc1', 'Mémoire', (1000, 1002), {'total_keystrokes': 1})
        FakeEngine.down = True
        self.engine.drain()  # must not raise
        self.assertEqual(self.engine.status()[0]['state'], 'offline')
        self.assertEqual(self.engine.status()[1], 1)  # the measurement is kept

    def test_state_file_never_world_readable(self):
        """The file carries the API token: it must be 0600 from its very first write."""
        self.engine.login(self.url, 'a@b.fr', 'secret')
        self.assertEqual(os.stat(self.engine.path).st_mode & 0o077, 0)


if __name__ == '__main__':
    unittest.main()
