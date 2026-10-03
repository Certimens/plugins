"""engine.py against a local fake HTTP engine."""

import base64
import io
import json
import os
import pathlib
import shutil
import sys
import tempfile
import threading
import unittest
import urllib.request
from http.server import BaseHTTPRequestHandler, HTTPServer

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'src', 'pythonpath'))

from certimens_agent import engine as engine_module
from certimens_agent import i18n
from certimens_agent.engine import Engine, HttpError


class FakeEngine(BaseHTTPRequestHandler):
    calls = []
    down = False
    metrics_error = None
    # A refusal that depends on what the push contains: given the metrics of the request, it
    # returns the body to refuse with, or None to accept. This is how an engine that knows one
    # generation of metrics and not the next is played.
    metrics_error_until = None
    put_error = None
    # Whether the pairing is still waiting for somebody to confirm the code.
    device_pending = False
    # The account a token belongs to, so a test can pair a second student on one installation.
    account_email = None
    # A refusal of the poll, as (status, body): a code that expired, one somebody refused, or a
    # rate limiter in front of the engine.
    device_error = None
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
            return self._reply(503, {'error': 'unavailable'})
        # Pairing: no password anywhere. The agent asks for a code, polls until somebody
        # confirms it in their Certimens space, then reads who the token belongs to.
        if self.path == '/api/auth/device' and self.command == 'POST':
            FakeEngine.next_token += 1
            return self._reply(201, {'device_code': f'dev{FakeEngine.next_token}',
                                     'user_code': 'CDFH-JKMN',
                                     'verification_uri': 'http://127.0.0.1/device',
                                     'verification_uri_complete': 'http://127.0.0.1/device?code=CDFH-JKMN',
                                     'expires_in': 600, 'interval': 0})
        if self.path == '/api/auth/device/token' and self.command == 'POST':
            if FakeEngine.device_error:
                return self._reply(*FakeEngine.device_error)
            if FakeEngine.device_pending:
                return self._reply(400, {'code': 'device_authorization_pending', 'error': 'not yet'})
            FakeEngine.next_token += 1
            return self._reply(200, {'token': f'api{FakeEngine.next_token}'})
        if self.path == '/api/auth/me':
            email = FakeEngine.account_email or 'a@b.fr'
            return self._reply(200, {'email': email, 'role': 'student', 'display_name': 'A B'})
        if self.path == '/api/auth/tokens' and self.command == 'GET':
            return self._reply(200, [{'id': 'tid1', 'label': 'Extension LibreOffice — 2026-10-10'}])
        if self.path.startswith('/api/auth/tokens/') and self.command == 'DELETE':
            return self._reply(204)
        if self.path == '/api/documents' and self.command == 'POST':
            FakeEngine.next_file += 1
            return self._reply(201, {'id': f'f{FakeEngine.next_file}', 'name': body['name']})
        if self.path.endswith('/metrics'):
            if FakeEngine.metrics_error:
                return self._reply(400, FakeEngine.metrics_error)
            conditional = FakeEngine.metrics_error_until and FakeEngine.metrics_error_until(body['metrics'])
            if conditional:
                return self._reply(400, conditional)
            return self._reply(201)
        if self.path.startswith('/api/documents/') and self.command == 'PUT':
            if FakeEngine.put_error:
                return self._reply(*FakeEngine.put_error)
            return self._reply(200, {'id': self.path.rsplit('/', 1)[-1], **body})
        return self._reply(404, {'error': 'not found'})

    do_GET = do_POST = do_PUT = do_DELETE = _handle


class EngineTest(unittest.TestCase):
    def setUp(self):
        FakeEngine.calls = []
        FakeEngine.down = False
        FakeEngine.metrics_error = None
        FakeEngine.metrics_error_until = None
        FakeEngine.put_error = None
        FakeEngine.device_pending = False
        FakeEngine.account_email = None
        FakeEngine.device_error = None
        self.server = HTTPServer(('127.0.0.1', 0), FakeEngine)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.url = f'http://127.0.0.1:{self.server.server_port}'
        self.dir = tempfile.mkdtemp()
        self.engine = Engine(os.path.join(self.dir, 'certimens.json'))

    def tearDown(self):
        # shutdown stops serve_forever; server_close releases the listening socket. Without the
        # second, every test leaves one open — and the profile directory on disk with it.
        self.server.shutdown()
        self.server.server_close()
        shutil.rmtree(self.dir, ignore_errors=True)

    def pair(self):
        """The whole pairing, as the window runs it: a code, one poll, then the token kept."""
        pairing = self.engine.start_pairing(self.url)
        token = self.engine.poll_pairing(pairing)
        return self.engine.adopt_token(pairing['engineUrl'], token)

    def test_pairing_keeps_the_token_and_asks_for_no_password(self):
        me = self.pair()

        self.assertEqual(me['email'], 'a@b.fr')
        self.assertTrue(self.engine.config()['token'])
        self.assertEqual(self.engine.config()['tokenId'], 'tid1')
        self.assertEqual(self.engine.config()['displayName'], 'A B')
        # Nothing resembling a password ever left this machine.
        self.assertFalse(any(body and 'password' in body for _, _, body, _ in FakeEngine.calls))

    def test_pairing_declares_what_this_agent_is(self):
        self.engine.start_pairing(self.url)

        _, _, body, _ = FakeEngine.calls[0]
        # Shown to the student at the moment they confirm, so they can tell what they are
        # letting in. The engine trusts it for nothing.
        self.assertEqual(body['client'], i18n.t('pair.clientWriter'))

    def test_pairing_waits_rather_than_failing_while_nobody_has_confirmed(self):
        FakeEngine.device_pending = True
        pairing = self.engine.start_pairing(self.url)

        # None, not an exception: the window keeps asking. An expired or refused code does
        # raise, because each means something the student has to be told.
        self.assertIsNone(self.engine.poll_pairing(pairing))
        self.assertFalse(self.engine.config().get('token'))

    def test_pairing_asked_too_often_waits_longer_rather_than_giving_up(self):
        """A 429 is the rate limiter, not a refusal: the exchange is alive on the other side.

        Two students pairing from the same campus address are enough to meet it, and an agent
        that read it as a failure would drop a code its owner is about to confirm.
        """
        FakeEngine.device_error = (429, {'error': 'too many requests'})
        pairing = self.engine.start_pairing(self.url)
        interval = pairing['interval']

        self.assertIsNone(self.engine.poll_pairing(pairing))
        # And the next attempt waits longer, as RFC 8628 has it.
        self.assertGreater(pairing['interval'], interval)

    def test_a_refused_pairing_is_said_in_the_student_language(self):
        """The engine answers in English, its only language: "device_denied" is reworded here.

        It is the one moment the student is watching a screen and waiting, and the sentence they
        read has to say what happened — not "access denied", which is the sentence for a token
        the engine no longer honours, and says nothing about a code waiting to be confirmed.
        """
        FakeEngine.device_error = (401, {'code': 'device_denied', 'error': 'this authorization was refused'})
        pairing = self.engine.start_pairing(self.url)

        with self.assertRaises(HttpError) as ctx:
            self.engine.poll_pairing(pairing)
        self.assertEqual(ctx.exception.message, i18n.t('pair.denied'))

    def test_queue_survives_offline_then_drains(self):
        self.pair()
        FakeEngine.down = True
        self.engine.enqueue('doc1', 'Mémoire', (1000, 1002), {'keystrokes_total': 5})
        self.engine.drain()
        self.assertEqual(self.engine.status()[0]['state'], 'offline')
        # the queue is persisted: a fresh startup finds it again
        restarted = Engine(self.engine.path)
        self.assertEqual(restarted.status()[1], 1)
        FakeEngine.down = False
        FakeEngine.calls = []
        restarted.drain()
        self.assertEqual(restarted.status(), ({**restarted.status()[0], 'state': 'synced'}, 0))
        created = [c for c in FakeEngine.calls if c[:2] == ('POST', '/api/documents')]
        self.assertEqual(len(created), 1)
        metrics = [c for c in FakeEngine.calls if c[1].endswith('/metrics')][-1][2]['metrics']
        self.assertEqual(metrics, [{'type': 'keystrokes_total', 'value': 5,
                                    'period': {'start': '1970-01-01T00:16:40.000Z',
                                               'end': '1970-01-01T00:16:42.000Z'}}])
        self.assertTrue(FakeEngine.calls[-1][3].startswith('Bearer '))

    def test_an_interrupted_catch_up_does_not_resend_what_has_gone(self):
        """Draining the queue no longer writes the queue at every window, but a cursor beside it.

        The state is a single JSON document: writing anything into it rewrites the queue along
        with it. A day offline, caught up, paid that price once per window — measured at 120 ms
        for 5000 windows, which is minutes of disk and gigabytes written. What has to be written
        *between* two submissions is only "how far we got", and that is a number.

        What this test holds is the property the old write served: a window that has gone never
        goes again, even if the catch-up is cut in two.
        """
        self.pair()
        for i in range(4):
            self.engine.enqueue('doc1', 'Mémoire', (1000 + i, 1002 + i), {'keystrokes_total': 5})

        def cut_after_three(_metrics):
            # `down` is read when the next request comes in: the first three go through.
            if len([c for c in FakeEngine.calls if c[1].endswith('/metrics')]) >= 3:
                FakeEngine.down = True
            return  # nothing to refuse: this call goes through

        FakeEngine.metrics_error_until = cut_after_three
        self.engine.drain()

        self.assertEqual(self.engine.status()[0]['state'], 'offline')
        self.assertEqual(self.engine.status()[1], 1, 'a single window is left to send')

        # The cursor lives beside the state, and a restart reads it: that is what makes the
        # catch-up exact even if LibreOffice stops halfway.
        restarted = Engine(self.engine.path)
        self.assertEqual(restarted.status()[1], 1)

        FakeEngine.down = False
        FakeEngine.metrics_error_until = None
        FakeEngine.calls = []
        restarted.drain()

        sent = [m for c in FakeEngine.calls if c[1].endswith('/metrics') for m in c[2]['metrics']]
        self.assertEqual(len(sent), 1, 'only the window that was left goes again')
        self.assertEqual(restarted.status()[1], 0)
        self.assertFalse(os.path.exists(restarted.path + '.sent'),
                         'an emptied queue leaves no cursor behind it')

    def test_a_window_written_offline_says_so(self):
        """`offline` does not describe the queue, it describes the window.

        A window written while the engine was still answering goes out saying nothing, even if
        it then waits for hours — that is the previous test's case. The one written
        une fois le moteur hors d'atteinte porte `offline: true`, et le moteur en tire un taux
        of writing offline, never a penalty.
        """
        self.pair()
        FakeEngine.down = True
        self.engine.enqueue('doc1', 'Mémoire', (1000, 1002), {'keystrokes_total': 5})
        self.engine.drain()
        self.assertEqual(self.engine.status()[0]['state'], 'offline')
        # This second window, though, is written knowing the engine does not answer.
        self.engine.enqueue('doc1', 'Mémoire', (1010, 1012), {'keystrokes_total': 7})

        FakeEngine.down = False
        FakeEngine.calls = []
        self.engine.drain()
        sent = [m for c in FakeEngine.calls if c[1].endswith('/metrics') for m in c[2]['metrics']]
        self.assertEqual([m.get('offline') for m in sent], [None, True],
                         'only the window written offline must declare it')

    def test_the_metric_keys_keep_the_order_the_engine_knows(self):
        """The engine recognises an agent's serialiser by the **order** of its keys.

        It accepts only two: {type, value, period}, and the same with `offline` appended at the
        end. A key inserted elsewhere — or always sent — steps out of it, and what the engine
        does with a body out of shape is documented on its side. json.loads keeps the document's
        order: this test therefore does read the order on the wire.
        """
        self.pair()
        self.engine.enqueue('doc1', 'Mémoire', (1000, 1002), {'keystrokes_total': 5})
        self.engine.drain()
        FakeEngine.down = True
        self.engine.enqueue('doc1', 'Mémoire', (1010, 1012), {'keystrokes_total': 7})
        self.engine.drain()
        FakeEngine.down = False
        self.engine.enqueue('doc1', 'Mémoire', (1020, 1022), {'keystrokes_total': 9})
        self.engine.drain()

        sent = [m for c in FakeEngine.calls if c[1].endswith('/metrics') for m in c[2]['metrics']]
        orders = {tuple(m.keys()) for m in sent}
        self.assertTrue(orders, 'no measurement sent')
        self.assertTrue(orders <= {('type', 'value', 'period'),
                                   ('type', 'value', 'period', 'offline')}, orders)
        self.assertIn(('type', 'value', 'period', 'offline'), orders)
        for metric in sent:
            self.assertEqual(tuple(metric['period'].keys()), ('start', 'end'))

    def test_the_flush_reason_comes_last_and_is_left_out_rather_than_empty(self):
        """`reason` is appended after `offline`, and only when the agent has one to give.

        A window queued before this agent knew how to say why it closed leaves without the key:
        a missing one is an agent that did not say, an empty one is a word the engine's
        vocabulary does not hold.
        """
        self.pair()
        self.engine.enqueue('doc1', 'Mémoire', (1000, 1002), {'keystrokes_total': 5}, 'idle')
        self.engine.drain()
        # The engine goes away. The window queued before the first failure does not declare
        # itself offline — `offline` describes the window, not the queue — so it is also the
        # window that stands in here for an agent too old to say why it flushed.
        FakeEngine.down = True
        self.engine.enqueue('doc1', 'Mémoire', (1010, 1012), {'keystrokes_total': 7})
        self.engine.drain()
        self.engine.enqueue('doc1', 'Mémoire', (1020, 1022), {'keystrokes_total': 9}, 'away')
        self.engine.enqueue('doc1', 'Mémoire', (1030, 1032), {'keystrokes_total': 11})
        FakeEngine.down = False
        self.engine.drain()

        sent = [m for c in FakeEngine.calls if c[1].endswith('/metrics') for m in c[2]['metrics']]
        orders = {tuple(m.keys()) for m in sent}
        self.assertEqual(orders, {('type', 'value', 'period'),
                                  ('type', 'value', 'period', 'reason'),
                                  ('type', 'value', 'period', 'offline'),
                                  ('type', 'value', 'period', 'offline', 'reason')})

    def test_the_period_keeps_its_order_even_when_the_queue_did_not(self):
        """The period comes from the queue, and the queue is a file.

        The test above puts the queue in place through the Engine itself: it is therefore
        written `{start, end}` and read back in that order, and its assertion would pass whether
        the code rebuilds the period or passes on the queue's. What has to be put to the test is
        the other case: a queue something else rewrote — an earlier version of the agent, a tool
        that normalises what it stores — and which returns `{end, start}`. It is then enough for
        the agent to pass it on as it is for every submission to step out of the shape the
        engine accepts.
        """
        self.pair()
        self.engine.enqueue('doc1', 'Mémoire', (1000, 1002), {'keystrokes_total': 5})

        path = os.path.join(self.dir, 'certimens.json')
        with open(path, encoding='utf-8') as handle:
            state = json.load(handle)
        for item in state['queue']:
            item['period'] = {'end': item['period']['end'], 'start': item['period']['start']}
        with open(path, 'w', encoding='utf-8') as handle:
            json.dump(state, handle)

        # An agent restarting on that queue: json.load keeps the document's order, so what it
        # has in hand really is `{end, start}`.
        reopened = Engine(path)
        self.assertEqual(tuple(reopened.state['queue'][0]['period'].keys()), ('end', 'start'),
                         'the queue read back should carry the file\'s order')
        reopened.drain()

        sent = [m for c in FakeEngine.calls if c[1].endswith('/metrics') for m in c[2]['metrics']]
        self.assertTrue(sent, 'no measurement sent')
        for metric in sent:
            self.assertEqual(tuple(metric['period'].keys()), ('start', 'end'))

    def test_pause_survives_a_restart_and_does_not_hold_the_queue(self):
        """Suspending stops the measurement, not the sending.

        A pause that quietly lifted itself at the next start would be worse than none, and a
        pause that held back what was already measured would turn into a late, suspicious batch
        the day the student resumes.
        """
        self.pair()
        self.engine.enqueue('doc1', 'Mémoire', (1000, 1002), {'keystrokes_total': 5})
        self.engine.set_paused(True)

        restarted = Engine(self.engine.path)
        self.assertTrue(restarted.paused())
        restarted.drain()
        self.assertEqual(restarted.status()[1], 0)
        self.assertTrue([c for c in FakeEngine.calls if c[1].endswith('/metrics')])

        restarted.set_paused(False)
        self.assertFalse(Engine(self.engine.path).paused())

    def test_rename_is_synced_once(self):
        self.pair()
        self.engine.enqueue('doc1', 'Brouillon', (1000, 1002), {'keystrokes_total': 1})
        self.engine.drain()
        self.engine.note_title('doc1', 'Mémoire final')
        self.engine.drain()
        self.engine.drain()
        renames = [c for c in FakeEngine.calls if c[0] == 'PUT' and c[2] == {'name': 'Mémoire final'}]
        self.assertEqual(len(renames), 1)

    def test_a_passed_deadline_is_refused_in_the_agent_wording(self):
        """The engine can only refuse in English: the sentence the student reads is ours.

        The code carries the rule, the message is only a fallback — an agent copying
        "this assignment's deadline has passed" would display English inside a French
        interface, and would leave out the one useful gesture: asking for the deadline to be
        pushed back.
        """
        self.pair()
        FakeEngine.put_error = (403, {'code': 'deadline_passed',
                                      'error': "this assignment's deadline has passed"})
        with self.assertRaises(HttpError) as ctx:
            self.engine.submit('f2', 'a1')
        self.assertEqual(ctx.exception.status, 403)
        self.assertEqual(ctx.exception.code, 'deadline_passed')
        self.assertEqual(ctx.exception.message, i18n.t('error.deadlinePassed'))

    def test_a_frozen_copy_does_not_hold_the_rename_forever(self):
        """Renaming a copy whose deadline has passed is refused: the queue must not suffer for it.

        Without this, the refusal came back from the drain every minute — syncing went to
        failed and the title was sent again endlessly, for a refusal the student can do nothing
        about.
        """
        self.pair()
        self.engine.enqueue('doc1', 'Mémoire', (1000, 1002), {'keystrokes_total': 1})
        self.engine.drain()
        FakeEngine.put_error = (403, {'code': 'deadline_passed',
                                      'error': "this assignment's deadline has passed"})
        self.engine.note_title('doc1', 'Mémoire rendu')
        self.engine.drain()
        self.assertEqual(self.engine.status()[0]['state'], 'synced')
        FakeEngine.calls = []
        self.engine.drain()
        self.assertFalse([c for c in FakeEngine.calls if c[0] == 'PUT'])

    def test_unknown_metric_type_drops_one_generation_at_a_time(self):
        """An engine that knows the older generations but not the newest loses only the newest.

        The extended metrics arrived in three batches, and a deployed engine may know the older
        ones and ignore the newest. Dropping them all on the first refusal would take away
        measurements it can read, and nobody would see it: on the engine's side, a measurement
        never sent looks like a measurement the sensor cannot take.
        """
        self.pair()
        unknown = {'code': 'metric_type_unknown', 'error': 'unknown metric type'}
        # This engine reads `focus_losses` and `injected_chars_max` (the two older generations)
        # but not `lexical_hesitations`: it refuses as long as that one is present.
        FakeEngine.metrics_error_until = staticmethod(
            lambda metrics: unknown if any(m['type'] == 'lexical_hesitations' for m in metrics) else None)
        self.engine.enqueue('doc1', 'Mémoire', (1000, 1002),
                            {'keystrokes_total': 5, 'focus_losses': 1, 'injected_chars_max': 300,
                             'lexical_hesitations': 2})
        self.engine.drain()

        self.assertEqual(self.engine.state['extendedDropped'], 1)
        sent = [c for c in FakeEngine.calls if c[1].endswith('/metrics')][-1][2]['metrics']
        # The newest generation is dropped, the two older ones stay.
        self.assertEqual(sorted(m['type'] for m in sent),
                         ['focus_losses', 'injected_chars_max', 'keystrokes_total'])

    def test_an_engine_that_knows_no_generation_drops_them_all(self):
        self.pair()
        FakeEngine.metrics_error = {'code': 'metric_type_unknown', 'error': 'unknown metric type'}
        self.engine.enqueue('doc1', 'Mémoire', (1000, 1002),
                            {'keystrokes_total': 5, 'focus_losses': 1, 'injected_chars_max': 300})
        self.engine.drain()
        self.assertEqual(self.engine.state['extendedDropped'],
                         len(engine_module.EXTENDED_GENERATIONS))

    def test_other_400_keeps_the_extended_metrics(self):
        """An invalid period used to silence focus_losses and the like for good."""
        self.pair()
        FakeEngine.metrics_error = {'code': 'metric_period_invalid',
                                    'error': 'metric period end must be after its start'}
        self.engine.enqueue('doc1', 'Mémoire', (1000, 1002), {'keystrokes_total': 5, 'focus_losses': 1})
        self.engine.drain()
        self.assertEqual(self.engine.state['extendedDropped'], 0)
        self.assertEqual(self.engine.status()[1], 0)  # the window is dropped, not retried forever

    def test_login_gives_the_extended_metrics_another_chance(self):
        self.pair()
        self.engine.state['extendedDropped'] = len(engine_module.EXTENDED_GENERATIONS)
        self.pair()
        self.assertEqual(self.engine.state['extendedDropped'], 0)

    def test_upload_sends_the_docx_in_base64(self):
        self.pair()
        engine_id, _ = self.engine.create_file('doc1', 'Mémoire', 'Mémoire')
        self.engine.upload_docx('doc1', b'PK\x03\x04docx')
        method, path, body, _ = FakeEngine.calls[-1]
        self.assertEqual((method, path), ('PUT', f'/api/documents/{engine_id}'))
        self.assertEqual(base64.b64decode(body['document']), b'PK\x03\x04docx')

    def test_upload_without_file_is_refused(self):
        self.pair()
        with self.assertRaises(Exception) as ctx:
            self.engine.upload_docx('inconnu', b'PK\x03\x04')
        self.assertEqual(ctx.exception.status, 404)

    def test_upload_too_large_is_refused_before_the_network(self):
        self.pair()
        self.engine.create_file('doc1', 'Mémoire', 'Mémoire')
        FakeEngine.calls = []
        with self.assertRaises(Exception) as ctx:
            self.engine.upload_docx('doc1', b'x' * (19 * 1024 * 1024))
        self.assertEqual(ctx.exception.status, 413)
        self.assertEqual(FakeEngine.calls, [])

    def test_state_file_is_private(self):
        self.pair()
        self.assertEqual(os.stat(self.engine.path).st_mode & 0o777, 0o600)

    def test_logout_revokes_the_token(self):
        self.pair()
        token_id = self.engine.config()['tokenId']
        FakeEngine.calls = []
        self.engine.logout()
        deletes = [c for c in FakeEngine.calls if c[0] == 'DELETE' and c[1] == f'/api/auth/tokens/{token_id}']
        self.assertEqual(len(deletes), 1)
        self.assertFalse(self.engine.config().get('token'))
        self.assertEqual(self.engine.status()[0]['state'], 'unconfigured')

    def test_pairing_stores_only_the_token(self):
        self.pair()
        cfg = self.engine.config()
        self.assertTrue(cfg['token'])
        self.assertNotIn('password', self.engine.state['config'])
        # Pairing = ask for a code, poll, read the account, find this token's id. No password
        # route is called at all, because there is no password to send.
        paths = [c[1] for c in FakeEngine.calls]
        self.assertEqual(paths[:2], ['/api/auth/device', '/api/auth/device/token'])
        self.assertIn('/api/auth/me', paths)
        self.assertNotIn('/api/auth/login', paths)

    def test_logout_clears_what_the_token_authorised(self):
        """Revoking the token ends what it can do at the engine; this ends what it left here.

        The map, the titles and a queued window all outlived a sign-out, so the next account to
        pair inherited them and sent them under its own bearer, towards the previous student's
        engine documents — with neither student told.
        """
        self.pair()
        self.engine.enqueue('doc-1', 'Mémoire', (1000.0, 1001.0), {'keystrokes_total': 10})
        self.engine.note_title('doc-1', 'Mémoire')
        self.engine.drain()
        self.assertTrue(self.engine.state['engineIds'])
        self.engine.logout()
        self.assertEqual(self.engine.state['engineIds'], {})
        self.assertEqual(self.engine.state['titles'], {})
        self.assertEqual(self.engine.state['syncedTitles'], {})
        self.assertEqual(self.engine.state['queue'], [])
        self.assertFalse(self.engine.state['paused'])
        # The address and the language stay: the next pairing starts where this one did. The
        # previous student's address does not — the next one has no reason to read it.
        self.assertTrue(self.engine.config()['engineUrl'])
        self.assertEqual(self.engine.config()['email'], '')

    def test_logout_sends_what_the_session_measured(self):
        """A window measured under this token leaves under it, or not at all."""
        self.pair()
        self.engine.enqueue('doc-1', 'Mémoire', (1000.0, 1001.0), {'keystrokes_total': 10})
        FakeEngine.calls = []
        self.engine.logout()
        pushes = [c for c in FakeEngine.calls if c[0] == 'POST' and c[1].endswith('/metrics')]
        self.assertEqual(len(pushes), 1)

    def test_pairing_another_account_clears_the_previous_one(self):
        """Signing in again as somebody else, with no sign-out between, is the same door."""
        self.pair()
        self.engine.enqueue('doc-1', 'Mémoire', (1000.0, 1001.0), {'keystrokes_total': 10})
        self.engine.drain()
        self.assertTrue(self.engine.state['engineIds'])
        FakeEngine.account_email = 'quelquun.dautre@example.org'
        try:
            self.pair()
        finally:
            FakeEngine.account_email = None
        self.assertEqual(self.engine.state['engineIds'], {})
        self.assertEqual(self.engine.state['queue'], [])

    def test_measuring_follows_the_session_and_the_pause(self):
        self.assertFalse(self.engine.measuring())
        self.pair()
        self.assertTrue(self.engine.measuring())
        self.engine.set_paused(True)
        self.assertFalse(self.engine.measuring())
        self.engine.set_paused(False)
        self.engine.logout()
        self.assertFalse(self.engine.measuring())

    def test_an_identity_belongs_to_one_file(self):
        """The identity travels inside the document, so two files can carry the same one.

        A copy of the student's own file is enough — no attacker anywhere. The second file must
        not be handed the first file's engine document.
        """
        self.pair()
        first = os.path.join(self.dir, 'memoire.odt')
        pathlib.Path(first).write_text('x', encoding='utf-8')
        first_url = pathlib.Path(first).as_uri()
        self.engine.enqueue('doc-1', 'Mémoire', (1000.0, 1001.0), {'keystrokes_total': 10},
                            source=first_url)
        self.engine.drain()
        self.assertTrue(self.engine.engine_id('doc-1'))
        # The same identity, presented by another file that still exists on disk.
        second = os.path.join(self.dir, 'memoire-copie.odt')
        pathlib.Path(second).write_text('x', encoding='utf-8')
        self.assertFalse(self.engine.binds('doc-1', pathlib.Path(second).as_uri()))
        # The file it was created for keeps it.
        self.assertTrue(self.engine.binds('doc-1', first_url))
        # And an identity nothing has mapped yet binds to whoever presents it first.
        self.assertTrue(self.engine.binds('doc-inconnu', pathlib.Path(second).as_uri()))

    def test_a_renamed_file_keeps_its_record(self):
        """A rename or a move must keep one record, not split it in two."""
        self.pair()
        before = os.path.join(self.dir, 'brouillon.odt')
        pathlib.Path(before).write_text('x', encoding='utf-8')
        self.engine.enqueue('doc-1', 'Brouillon', (1000.0, 1001.0), {'keystrokes_total': 10},
                            source=pathlib.Path(before).as_uri())
        self.engine.drain()
        os.rename(before, os.path.join(self.dir, 'memoire.odt'))
        after = pathlib.Path(os.path.join(self.dir, 'memoire.odt')).as_uri()
        self.assertTrue(self.engine.binds('doc-1', after))
        self.assertTrue(self.engine.binds('doc-1', after))

    def test_state_file_never_world_readable(self):
        """The file carries the API token: it must be 0600 from its very first write."""
        self.pair()
        self.assertEqual(os.stat(self.engine.path).st_mode & 0o077, 0)


if __name__ == '__main__':
    unittest.main()


class RedirectTest(unittest.TestCase):
    """A redirect must not carry the token out of the engine.

    `fetch` strips `Authorization` by itself when a redirect changes origin: the three
    JavaScript agents never had to think about it. `urllib` does not — its handler copies every
    header but Content-Length and Content-Type — so a redirect to another host, or from https to
    http, carried the student's token away. That token does not expire: one that leaks is kept.
    """

    def _redirect(self, to):
        req = urllib.request.Request('https://moteur.test/api/auth/me')
        req.add_header('Authorization', 'Bearer secret')
        req.add_header('Content-Type', 'application/json')
        return engine_module.SafeRedirect().redirect_request(
            req, io.BytesIO(), 302, 'Found', {}, to)

    def test_to_another_host_the_token_stays_behind(self):
        new = self._redirect('https://ailleurs.test/x')
        self.assertIsNotNone(new, 'the redirect is followed, only the token stays behind')
        self.assertNotIn('Authorization', new.headers)

    def test_from_https_to_http_as_well(self):
        # Same host, but in the clear: the token would cross the network readable.
        new = self._redirect('http://moteur.test/x')
        self.assertNotIn('Authorization', new.headers)

    def test_but_an_internal_redirect_keeps_what_it_takes_to_authenticate(self):
        new = self._redirect('https://moteur.test/api/v2/me')
        self.assertEqual(new.headers.get('Authorization'), 'Bearer secret')

    def test_the_rule_is_carried_by_the_opener_of_every_request(self):
        # Laying down the rule without wiring it in would be worse than not laying it down.
        self.assertTrue(any(isinstance(h, engine_module.SafeRedirect)
                            for h in engine_module.OPENER.handlers))



class EngineUrlTest(unittest.TestCase):
    """Where the token may travel: https anywhere, http only on a host inside the building.

    This is the rule that decides whether an API token **that never expires** crosses the
    network in the clear. It is written four times — the three JavaScript agents hold the same
    pattern, and `make check` compares the four character for character — so what this adds is
    whether the pattern is the right one. The cases are deliberately those of
    `browser/tests/helpers/engine-url.mjs`, which the three others read.
    """

    ALLOWED = (
        # https goes anywhere: that is the whole point of asking for it.
        'https://monespace.certimens.fr',
        'https://moodle.univ-exemple.fr:8443/certimens',
        # An establishment serving its engine on its own intranet, which is what plain http
        # exists for: a name only an internal resolver answers, and the private ranges.
        'http://moteur',
        'http://certimens-srv:9000',
        'http://ecole.local',
        'http://10.0.0.1',
        'http://172.16.3.9',
        'http://172.31.255.254',
        'http://192.168.1.5',
        'http://[fd00::1]',
        # A developer against their own machine.
        'http://localhost:8080',
        'http://sub.localhost',
        'http://127.0.0.1:3000',
        'http://127.1.2.3',
        'http://[::1]:80',
    )

    REFUSED = (
        # Plain http to a public host: the case the rule exists for.
        'http://moodle.univ-exemple.fr',
        'http://monespace.certimens.fr',
        'http://8.8.8.8',
        'http://[2001:db8::1]',
        # 172.16/12 stops at 172.31, and 172.15 is somebody else's.
        'http://172.15.0.1',
        'http://172.32.0.1',
        # A public address written to look like a hostname: 134744072 is 8.8.8.8. `urlparse`
        # hands it over as it stands, unlike `new URL`, and the all-digit guard catches it.
        'http://134744072/',
        # Not addresses to follow at all. `urlopen` would read the file and speak ftp.
        'javascript:alert(1)',
        'file:///etc/passwd',
        'ftp://files.univ-exemple.fr',
        'data:text/html,<script>1</script>',
        # Not a URL, or not one with a host.
        'monespace.certimens.fr',
        'https://',
        '',
        '   ',
    )

    def test_allowed(self):
        for url in self.ALLOWED:
            with self.subTest(url=url):
                self.assertTrue(engine_module.engine_url_allowed(url))

    def test_refused(self):
        for url in self.REFUSED:
            with self.subTest(url=url):
                self.assertFalse(engine_module.engine_url_allowed(url))

    def test_the_client_refuses_to_call_one_of_the_others(self):
        # The window refuses it earlier and with a sentence on screen; this is the floor under
        # it, and the only check an address stored before the rule existed ever meets.
        agent = Engine(os.path.join(tempfile.mkdtemp(), 'certimens.json'))
        with self.assertRaises(HttpError) as refused:
            agent.start_pairing('http://engine.example.fr')
        self.assertEqual(refused.exception.code, 'engine_url_refused')

    def test_and_nothing_reaches_the_network_through_urlopen(self):
        # The scheme used to be the only thing checked here, and it was checked right before
        # `urlopen`: the noqa on that line still says so. The rule replaced it, in the same
        # place, so there is no second door.
        source = (pathlib.Path(__file__).parent.parent / 'src' / 'pythonpath'
                  / 'certimens_agent' / 'engine.py').read_text(encoding='utf-8')
        self.assertIn('if not engine_url_allowed(url):', source)
        self.assertNotIn('urllib.request.urlopen(', source)


class StoredStateMigrationTest(unittest.TestCase):
    """A profile written before the generations carries a boolean.

    Read as "nothing dropped", it would push again at every window a generation this engine has
    already refused — and the refusal would come back round, at every window, without end.
    """

    def setUp(self):
        self.dir = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.dir, ignore_errors=True)
        self.path = os.path.join(self.dir, 'certimens.json')

    def test_a_boolean_means_everything_known_then(self):
        with open(self.path, 'w', encoding='utf-8') as f:
            json.dump({'extendedUnsupported': True}, f)
        self.assertEqual(Engine(self.path).state['extendedDropped'],
                         len(engine_module.EXTENDED_GENERATIONS))

    def test_a_profile_that_never_met_an_old_engine_starts_at_zero(self):
        with open(self.path, 'w', encoding='utf-8') as f:
            json.dump({'extendedUnsupported': False}, f)
        self.assertEqual(Engine(self.path).state['extendedDropped'], 0)

    def test_a_count_is_kept_as_it_is(self):
        with open(self.path, 'w', encoding='utf-8') as f:
            json.dump({'extendedDropped': 1}, f)
        self.assertEqual(Engine(self.path).state['extendedDropped'], 1)


class UpdateNoticeTest(unittest.TestCase):
    """"Certimens has been updated", and the version the profile remembers.

    The same rule as in the three other agents (browser/tests/update.test.mjs,
    word/tests/agent.test.mjs, vscode/tests/panel.test.mjs), with the same trap: a profile that
    has never written the key has just installed the agent, and reading that as an update would
    tell every student already running the extension, the day this ships, that they moved to the
    version they have been running for a month.
    """

    def setUp(self):
        self.dir = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.dir, ignore_errors=True)
        self.path = os.path.join(self.dir, 'certimens.json')

    def test_a_fresh_profile_says_nothing_and_remembers(self):
        engine = Engine(self.path)
        self.assertEqual(engine.updated_version('1.5.0'), '')
        self.assertEqual(Engine(self.path).state['seenVersion'], '1.5.0')

    def test_the_version_that_changed_is_announced_once(self):
        engine = Engine(self.path)
        engine.updated_version('1.4.0')
        self.assertEqual(engine.updated_version('1.5.0'), '1.5.0')
        # Shared by every document of the session: the first window says it, the others do not.
        self.assertEqual(engine.updated_version('1.5.0'), '')

    def test_no_version_says_nothing_and_writes_nothing(self):
        engine = Engine(self.path)
        engine.updated_version('1.4.0')
        self.assertEqual(engine.updated_version(''), '')
        self.assertEqual(engine.state['seenVersion'], '1.4.0')

    def test_a_checkout_has_no_version_to_announce(self):
        """src/description.xml still holds the {{VERSION}} the build replaces.

        Of the four agents this is the only one whose code cannot see its own version: it reads
        the package manifest sitting two folders above it. Run from a checkout, that manifest is
        a template — and a template is not a version.
        """
        self.assertEqual(engine_module.installed_version(), '')

    def test_the_built_package_announces_its_version(self):
        """What `installed_version` reads is the manifest of the installed extension."""
        root = os.path.join(self.dir, 'pythonpath', 'certimens_agent')
        os.makedirs(root)
        with open(os.path.join(self.dir, 'description.xml'), 'w', encoding='utf-8') as f:
            f.write('<description><version value="1.5.0"/></description>')
        module = os.path.join(root, 'engine.py')
        with open(module, 'w', encoding='utf-8') as f:
            f.write('')
        # The function reads `__file__`, which is what places it inside the package.
        original = engine_module.__file__
        engine_module.__file__ = module
        self.addCleanup(setattr, engine_module, '__file__', original)
        self.assertEqual(engine_module.installed_version(), '1.5.0')
