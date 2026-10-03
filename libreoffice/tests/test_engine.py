"""engine.py against a local fake HTTP engine."""

import base64
import io
import json
import os
import pathlib
import platform
import shutil
import socket
import sys
import tempfile
import threading
import time
import unittest
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler, HTTPServer

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'src', 'pythonpath'))

from certimens_agent import engine as engine_module
from certimens_agent import i18n
from certimens_agent.engine import Engine, HttpError

SESSION = 'p3Vq0hJmR2aXw9LkT1yZ5g'


def window(seq=0, **blocks):
    """A sealed window as measure.take hands it over, numbered seq: five keys typed in 800 ms."""
    return {'seq': seq, 'at': 1000000 + seq * 10000, 'mono': seq * 10000, 'ms': 2000, 'why': 'idle',
            'active': 800, 'runs': [['type', 5, 800]],
            'counts': {'corrections': 0, 'reformulations': 0, 'revisions': 0, 'jumps': 0, 'exits': 0,
                       'back_keys': 0, 'back_chars': 0},
            'dwell': {'bins': [], 'rollover': 0}, **blocks,
            'sum': {'keys': 5 * (seq + 1), 'chars': 0, 'pastes': 0}}


def windows_sent():
    """Every window the fake engine received, in the order they arrived."""
    return [sent for call in FakeEngine.calls if call[1].endswith('/metrics') for sent in call[2]['windows']]


class FakeEngine(BaseHTTPRequestHandler):
    calls = []
    declared = []
    # The bodies exactly as they arrived, byte for byte: the shape of a body is its key order
    # and its spacing, and a parsed body has lost both.
    raw = []
    # A refusal decided on what the push contains: given the parsed body, it returns
    # (status, body) to refuse with, or None to accept.
    metrics_reply = None
    down = False
    # An engine that is there and fails: it answers 503 to everything.
    failing = False
    # What POST /api/documents answers instead of creating, once per entry: (status, body).
    creation_errors = []
    # A refusal of every push, whatever it contains: the body of a 400.
    metrics_error = None
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
    # The agent's reports, as (raw body, headers), the status they are answered with, and what
    # happens while one is on its way.
    telemetry = []
    telemetry_status = 204
    telemetry_during = None

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
        received = self.rfile.read(length) if length else b''
        body = json.loads(received) if length else None
        if self.path.endswith('/metrics'):
            FakeEngine.raw.append(received)
        FakeEngine.calls.append((self.command, self.path, body, self.headers.get('Authorization')))
        # Kept apart from the tuple above, which half the file unpacks by shape.
        FakeEngine.declared.append((self.path, self.headers.get('X-Certimens-Agent')))
        if FakeEngine.down:
            # No answer at all — the connection is dropped, as an engine out of reach leaves
            # it. An engine that answers an error is another case, with tests of its own.
            self.close_connection = True
            return None
        if FakeEngine.failing:
            return self._reply(503, {'error': 'unavailable'})
        if self.path == '/api/documents' and self.command == 'POST' and FakeEngine.creation_errors:
            return self._reply(*FakeEngine.creation_errors.pop(0))
        if self.path == '/api/plugins/telemetry' and self.command == 'POST':
            FakeEngine.telemetry.append((received, dict(self.headers)))
            if FakeEngine.telemetry_during:
                FakeEngine.telemetry_during()
            if FakeEngine.telemetry_status == 204:
                self.send_response(204)
                self.end_headers()
                return None
            return self._reply(FakeEngine.telemetry_status, {'error': 'refused'})
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
            return self._reply(200, {'email': email, 'role': FakeEngine.account_role, 'display_name': 'A B'})
        if self.path == '/api/auth/tokens' and self.command == 'GET':
            return self._reply(200, [{'id': 'tid1', 'label': 'Extension LibreOffice — 2026-10-10'}])
        if self.path.startswith('/api/auth/tokens/') and self.command == 'DELETE':
            return self._reply(204)
        if self.path == '/api/documents' and self.command == 'POST':
            FakeEngine.next_file += 1
            FakeEngine.documents[f'f{FakeEngine.next_file}'] = body['name']
            return self._reply(201, {'id': f'f{FakeEngine.next_file}', 'name': body['name']})
        if self.path.startswith('/api/documents/') and self.command == 'GET':
            if FakeEngine.document_error:
                return self._reply(*FakeEngine.document_error)
            file_id = self.path.rsplit('/', 1)[-1]
            if file_id not in FakeEngine.documents:
                return self._reply(404, {'error': 'not found'})
            return self._reply(200, {'id': file_id, 'name': FakeEngine.documents[file_id]})
        if self.path.endswith('/metrics'):
            if FakeEngine.metrics_error:
                return self._reply(400, FakeEngine.metrics_error)
            decided = FakeEngine.metrics_reply and FakeEngine.metrics_reply(body)
            if decided:
                return self._reply(*decided)
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
        FakeEngine.declared = []
        FakeEngine.raw = []
        FakeEngine.metrics_reply = None
        FakeEngine.down = False
        FakeEngine.failing = False
        FakeEngine.creation_errors = []
        FakeEngine.metrics_error = None
        FakeEngine.put_error = None
        FakeEngine.device_pending = False
        FakeEngine.account_email = None
        FakeEngine.account_role = 'student'
        FakeEngine.documents = {}
        FakeEngine.document_error = None
        FakeEngine.device_error = None
        FakeEngine.telemetry = []
        FakeEngine.telemetry_status = 204
        FakeEngine.telemetry_during = None
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

    # --- a file that names its engine document ---
    def test_a_file_that_names_its_engine_document_is_taken_back(self):
        """The same .odt opened in Word, or on another machine, keeps one record."""
        self.pair()
        FakeEngine.documents['f9'] = 'Mémoire'

        file = self.engine.resume_engine_document('doc1', 'f9', 'Mémoire', 'file:///home/a/m.odt')

        self.assertEqual(file['id'], 'f9')
        self.assertEqual(self.engine.engine_id('doc1'), 'f9')
        FakeEngine.calls = []
        self.engine.enqueue('doc1', 'Mémoire', SESSION, window())
        self.engine.drain()
        # No second document was opened: the measurements went to the one the file named.
        self.assertEqual([c for c in FakeEngine.calls if c[:2] == ('POST', '/api/documents')], [])
        self.assertEqual([c[1] for c in FakeEngine.calls if c[1].endswith('/metrics')],
                         ['/api/documents/f9/metrics'])

    def test_a_document_that_is_not_this_account_s_is_not_taken_back(self):
        """A file a classmate sent carries their id: it is a file like any other here."""
        self.pair()
        FakeEngine.document_error = (403, {'error': 'forbidden'})

        self.assertIsNone(self.engine.resume_engine_document('doc1', 'f9', 'Mémoire'))
        self.assertIsNone(self.engine.engine_id('doc1'))

    def test_a_document_that_no_longer_exists_is_not_taken_back(self):
        self.pair()

        self.assertIsNone(self.engine.resume_engine_document('doc1', 'f9', 'Mémoire'))
        self.assertIsNone(self.engine.engine_id('doc1'))

    def test_only_a_student_takes_a_document_back(self):
        """A teacher may read a copy handed in to them: their keystrokes must not land in it."""
        self.pair()
        FakeEngine.account_role = 'teacher'
        FakeEngine.documents['f9'] = 'Mémoire'

        self.assertIsNone(self.engine.resume_engine_document('doc1', 'f9', 'Mémoire'))
        self.assertIsNone(self.engine.engine_id('doc1'))
        self.assertEqual([c for c in FakeEngine.calls if c[1].startswith('/api/documents/')], [])

    def test_an_id_shaped_like_a_route_never_reaches_one(self):
        """The id is read out of a file, where anyone who held it could have written anything."""
        self.pair()
        FakeEngine.calls = []

        for forged in ('../auth/tokens', 'f9/metrics', '', 'f' * 65, None, 42):
            self.assertIsNone(self.engine.resume_engine_document('doc1', forged, 'Mémoire'))
        self.assertEqual(FakeEngine.calls, [])

    def test_a_document_already_linked_here_is_left_alone(self):
        """Opening a file that names a document this profile already knows asks nothing."""
        self.pair()
        self.engine.enqueue('doc1', 'Mémoire', SESSION, window())
        self.engine.drain()
        linked = self.engine.engine_id('doc1')
        FakeEngine.calls = []

        self.assertIsNone(self.engine.resume_engine_document('doc1', 'f9', 'Mémoire'))
        self.assertEqual(self.engine.engine_id('doc1'), linked)
        self.assertEqual(FakeEngine.calls, [])

    def test_queue_survives_offline_then_drains(self):
        self.pair()
        FakeEngine.down = True
        self.engine.enqueue('doc1', 'Mémoire', SESSION, window())
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
        body = [c for c in FakeEngine.calls if c[1].endswith('/metrics')][-1][2]
        self.assertEqual(body['session'], SESSION)
        # Queued while the engine still answered, as far as anyone knew: it does not say offline.
        self.assertEqual(body['windows'], [window()])
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
            self.engine.enqueue('doc1', 'Mémoire', SESSION, window(i))

        def cut_after_three(_body):
            # `down` is read when the next request comes in: the first three go through.
            if len([c for c in FakeEngine.calls if c[1].endswith('/metrics')]) >= 3:
                FakeEngine.down = True
            return  # nothing to refuse: this call goes through

        FakeEngine.metrics_reply = cut_after_three
        self.engine.drain()

        self.assertEqual(self.engine.status()[0]['state'], 'offline')
        self.assertEqual(self.engine.status()[1], 1, 'a single window is left to send')

        # The cursor lives beside the state, and a restart reads it: that is what makes the
        # catch-up exact even if LibreOffice stops halfway.
        restarted = Engine(self.engine.path)
        self.assertEqual(restarted.status()[1], 1)

        FakeEngine.down = False
        FakeEngine.metrics_reply = None
        FakeEngine.calls = []
        restarted.drain()

        self.assertEqual([sent['seq'] for sent in windows_sent()], [3],
                         'only the window that was left goes again')
        self.assertEqual(restarted.status()[1], 0)
        self.assertFalse(os.path.exists(restarted.path + '.sent'),
                         'an emptied queue leaves no cursor behind it')

    def test_a_window_written_offline_says_so(self):
        """`offline` does not describe the queue, it describes the window.

        A window written while the engine was still answering goes out saying nothing, even if
        it then waits for hours — that is the previous test's case. The one written
        once the engine is out of reach carries `offline: true`, and the engine draws a rate of
        writing offline from it, never a penalty.
        """
        self.pair()
        FakeEngine.down = True
        self.engine.enqueue('doc1', 'Mémoire', SESSION, window(0))
        self.engine.drain()
        self.assertEqual(self.engine.status()[0]['state'], 'offline')
        # This second window, though, is written knowing the engine does not answer.
        self.engine.enqueue('doc1', 'Mémoire', SESSION, window(1))

        FakeEngine.down = False
        FakeEngine.calls = []
        self.engine.drain()
        self.assertEqual([sent.get('offline') for sent in windows_sent()], [None, True],
                         'only the window written offline must declare it')

    def test_every_call_names_this_agent(self):
        """The engine stores what measured a window, and flags a push that names nothing.

        So the header is not an extra: omitting it would raise a signal on every honest window
        of every student using this extension, and a signal that fires on everything tells a
        reader nothing. The kind is the engine's vocabulary and nothing else; a checkout has no
        build to claim and sends the kind alone, which the engine accepts.
        """
        self.pair()
        self.engine.enqueue('doc1', 'Mémoire', SESSION, window())
        self.engine.drain()

        pushed = [value for path, value in FakeEngine.declared if path.endswith('/metrics')]
        self.assertTrue(pushed, 'no measurement sent')
        for declared in pushed:
            self.assertRegex(declared, r'^libreoffice(/[A-Za-z0-9._+-]{1,32})?$')
        # Not only on the push: every call this agent makes says the same thing, from one place.
        self.assertTrue(all(value for _, value in FakeEngine.declared))

    def test_pause_survives_a_restart_and_does_not_hold_the_queue(self):
        """Suspending stops the measurement, not the sending.

        A pause that quietly lifted itself at the next start would be worse than none, and a
        pause that held back what was already measured would turn into a late, suspicious batch
        the day the student resumes.
        """
        self.pair()
        self.engine.enqueue('doc1', 'Mémoire', SESSION, window())
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
        self.engine.enqueue('doc1', 'Brouillon', SESSION, window())
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
        self.engine.enqueue('doc1', 'Mémoire', SESSION, window())
        self.engine.drain()
        FakeEngine.put_error = (403, {'code': 'deadline_passed',
                                      'error': "this assignment's deadline has passed"})
        self.engine.note_title('doc1', 'Mémoire rendu')
        self.engine.drain()
        self.assertEqual(self.engine.status()[0]['state'], 'synced')
        FakeEngine.calls = []
        self.engine.drain()
        self.assertFalse([c for c in FakeEngine.calls if c[0] == 'PUT'])

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
        self.engine.enqueue('doc-1', 'Mémoire', SESSION, window())
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
        self.engine.enqueue('doc-1', 'Mémoire', SESSION, window())
        FakeEngine.calls = []
        self.engine.logout()
        pushes = [c for c in FakeEngine.calls if c[0] == 'POST' and c[1].endswith('/metrics')]
        self.assertEqual(len(pushes), 1)

    def test_pairing_another_account_clears_the_previous_one(self):
        """Signing in again as somebody else, with no sign-out between, is the same door."""
        self.pair()
        self.engine.enqueue('doc-1', 'Mémoire', SESSION, window())
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
        self.engine.enqueue('doc-1', 'Mémoire', SESSION, window(), source=first_url)
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
        self.engine.enqueue('doc-1', 'Brouillon', SESSION, window(), source=pathlib.Path(before).as_uri())
        self.engine.drain()
        os.rename(before, os.path.join(self.dir, 'memoire.odt'))
        after = pathlib.Path(os.path.join(self.dir, 'memoire.odt')).as_uri()
        self.assertTrue(self.engine.binds('doc-1', after))
        self.assertTrue(self.engine.binds('doc-1', after))

    # --- Save As: the document goes on in the new file, the old one is left behind ---
    def files(self, *names):
        urls = []
        for name in names:
            path = os.path.join(self.dir, name)
            pathlib.Path(path).write_text('x', encoding='utf-8')
            urls.append(pathlib.Path(path).as_uri())
        return urls

    def test_save_as_carries_the_record_to_the_new_file(self):
        """Open A, Save As B, keep typing: B is the document being written, and A — still on
        disk, carrying the same identity — is the version left behind. The record follows B;
        A, opened again, is refused and gets an identity of its own."""
        self.pair()
        first, second = self.files('A.odt', 'B.odt')
        self.engine.enqueue('doc-1', 'A', SESSION, window(), source=first)
        self.engine.drain()
        self.engine.rebind('doc-1', second)
        self.assertTrue(self.engine.binds('doc-1', second))
        self.assertFalse(self.engine.binds('doc-1', first))
        # Written down, not only held: the next start of LibreOffice opens B under the record.
        reloaded = Engine(self.engine.path)
        self.assertEqual(reloaded.state['engineSources']['doc-1'], second)

    def test_save_as_before_the_record_exists_moves_the_waiting_windows(self):
        """Offline, nothing records a file yet but the queue: the windows written before the
        save name A, and the engine document created from the head of the queue would be bound
        to A — B would then split at its next opening."""
        self.pair()
        first, second = self.files('A.odt', 'B.odt')
        self.engine.enqueue('doc-1', 'A', SESSION, window(0), source=first)
        self.engine.enqueue('doc-2', 'Autre', SESSION, window(0), source=first + '-autre')
        self.engine.rebind('doc-1', second)
        sources = {item['documentId']: item['documentSource'] for item in self.engine.state['queue']}
        self.assertEqual(sources, {'doc-1': second, 'doc-2': first + '-autre'})
        self.engine.drain()
        self.assertEqual(self.engine.state['engineSources']['doc-1'], second)
        self.assertFalse(self.engine.binds('doc-1', first))

    def test_a_creation_already_on_its_way_records_the_new_file(self):
        """The drain read A from the head of the queue and is creating the document — on the
        network, without the state lock — when the save lands. It records B all the same."""
        self.pair()
        first, second = self.files('A.odt', 'B.odt')
        self.engine.enqueue('doc-1', 'A', SESSION, window(), source=first)
        create = self.engine._create_document

        def saved_meanwhile(*args, **kwargs):
            self.engine.rebind('doc-1', second)
            return create(*args, **kwargs)
        self.engine._create_document = saved_meanwhile
        self.engine.drain()
        self.assertEqual(self.engine.state['engineSources']['doc-1'], second)
        self.assertEqual(self.engine.moved, {})

    def test_save_as_of_a_document_never_saved_binds_it(self):
        self.pair()
        (second,) = self.files('B.odt')
        self.engine.enqueue('doc-1', 'Sans nom 1', SESSION, window(), source='')
        self.engine.drain()
        self.assertNotIn('doc-1', self.engine.state['engineSources'])
        self.engine.rebind('doc-1', second)
        self.assertEqual(self.engine.state['engineSources']['doc-1'], second)

    def test_state_file_never_world_readable(self):
        """The file carries the API token: it must be 0600 from its very first write."""
        self.pair()
        self.assertEqual(os.stat(self.engine.path).st_mode & 0o077, 0)



class WhatOnlyShowsWithTwoThingsAtOnceTest(unittest.TestCase):
    """A sign-out during a catch-up, a file whose name is taken, a take-back that could not be
    asked, an engine that refuses without being down."""

    setUp = EngineTest.setUp
    tearDown = EngineTest.tearDown
    pair = EngineTest.pair

    def created(self):
        return [call[2]['name'] for call in FakeEngine.calls if call[:2] == ('POST', '/api/documents')]

    def pushes(self):
        return [call[2] for call in FakeEngine.calls if call[1].endswith('/metrics')]

    # --- `offline` is an engine out of reach ---
    def test_a_window_queued_behind_a_refusal_is_not_stamped_offline(self):
        self.pair()
        FakeEngine.failing = True
        self.engine.enqueue('doc1', 'Mémoire', SESSION, window(0))
        self.engine.drain()
        self.assertEqual(self.engine.state['status'], {'state': 'offline', 'reached': True})
        self.engine.enqueue('doc1', 'Mémoire', SESSION, window(1))
        self.assertNotIn('offline', self.engine.state['queue'][-1]['window'])

    def test_a_rename_the_engine_refuses_is_final(self):
        self.pair()
        self.engine.enqueue('doc1', 'Mémoire', SESSION, window(0))
        self.engine.drain()
        self.engine.note_title('doc1', 'Mémoire final')
        FakeEngine.put_error = (409, {'code': 'document_name_taken', 'error': 'taken'})
        FakeEngine.calls = []
        self.engine.drain()
        self.engine.drain()
        self.assertEqual(len([c for c in FakeEngine.calls if c[0] == 'PUT']), 1)
        self.assertEqual(self.engine.state['status'], {'state': 'synced'})

    # --- a name already taken ---
    def test_a_document_created_from_a_window_takes_a_free_name(self):
        self.pair()
        FakeEngine.creation_errors = [(409, {'code': 'document_name_taken', 'error': 'taken'})]
        self.engine.enqueue('doc1', 'Mémoire', SESSION, window(0))
        self.engine.drain()
        names = self.created()
        self.assertEqual(names[0], 'Mémoire')
        self.assertRegex(names[1], r'^Mémoire \(\d{4}-\d\d-\d\d \d\d\.\d\d\.\d\d\)$')
        self.assertEqual(len(self.pushes()), 1)

    def test_a_name_the_student_typed_is_said_not_changed(self):
        self.pair()
        FakeEngine.creation_errors = [(409, {'code': 'document_name_taken', 'error': 'taken'})]
        with self.assertRaises(HttpError) as ctx:
            self.engine.create_file('doc1', 'Mémoire', 'Mémoire')
        self.assertEqual(ctx.exception.code, 'document_name_taken')
        self.assertEqual(len(self.created()), 1)

    def test_a_creation_refused_keeps_the_window(self):
        """It is the document that was refused, not the window waiting for it."""
        self.pair()
        refusal = (409, {'code': 'document_name_taken', 'error': 'taken'})
        FakeEngine.creation_errors = [refusal, refusal]
        self.engine.enqueue('doc1', 'Mémoire', SESSION, window(0))
        self.engine.drain()
        self.assertEqual(self.engine.status()[1], 1)
        self.assertEqual(self.pushes(), [])

    def test_a_name_longer_than_the_engine_takes_is_cut(self):
        self.pair()
        self.engine.create_file('doc1', 'x' * 400, 'x')
        self.assertEqual(len(self.created()[0]), 255)

    # --- the take-back ---
    def test_a_file_opened_before_pairing_is_taken_back_at_its_first_window(self):
        FakeEngine.documents = {'f9': 'Mémoire'}
        self.engine.carry('doc1', 'f9', 'Mémoire')      # read out of the file, nobody signed in
        self.pair()
        self.engine.enqueue('doc1', 'Mémoire', SESSION, window(0))
        self.engine.drain()
        self.assertEqual(self.engine.engine_id('doc1'), 'f9')
        self.assertEqual(self.created(), [], 'a second document was opened')

    def test_a_take_back_that_cannot_be_asked_creates_nothing(self):
        self.pair()
        self.engine.carry('doc1', 'f9', 'Mémoire')
        self.engine.enqueue('doc1', 'Mémoire', SESSION, window(0))
        FakeEngine.failing = True
        self.engine.drain()
        self.assertEqual(self.created(), [])
        self.assertEqual(self.engine.status()[1], 1, 'the window waits')

    def test_a_file_that_names_somebody_else_s_document_gets_its_own(self):
        self.pair()
        FakeEngine.document_error = (403, {'error': 'forbidden'})
        self.engine.carry('doc1', 'f9', 'Mémoire')
        self.engine.enqueue('doc1', 'Mémoire', SESSION, window(0))
        self.engine.drain()
        self.assertEqual(self.created(), ['Mémoire'])

    # --- signing out ---
    def test_what_is_still_open_is_sealed_and_sent_before_the_token_goes(self):
        self.pair()
        self.engine.before_logout.append(
            lambda: self.engine.enqueue('doc1', 'Mémoire', SESSION, window(0)))
        self.engine.logout()
        self.assertEqual(len(self.pushes()), 1)

    def test_a_window_sealed_after_the_sign_out_is_not_queued(self):
        self.pair()
        self.engine.logout()
        self.engine.enqueue('doc1', 'Mémoire', SESSION, window(0))
        self.assertEqual(self.engine.state['queue'], [])

    def test_two_drains_never_take_the_same_windows(self):
        """A sign-out drains from the window's thread while the sending thread is at it."""
        self.pair()
        FakeEngine.down = True
        self.engine.enqueue('doc1', 'Mémoire', SESSION, window(0))
        self.engine.drain()
        for seq in range(1, 7):
            self.engine.enqueue('doc1', 'Mémoire', SESSION, window(seq))
        FakeEngine.down = False
        FakeEngine.calls = []
        threads = [threading.Thread(target=self.engine.drain) for _ in range(2)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join()
        self.assertEqual(sorted(sent['seq'] for sent in windows_sent()), list(range(7)))

    # --- what is read back ---
    def test_a_state_file_holding_the_wrong_things_does_not_stop_the_agent(self):
        with open(self.engine.path, 'w', encoding='utf-8') as f:
            json.dump({'config': None, 'queue': 'x', 'engineIds': [], 'paused': 'yes'}, f)
        engine = Engine(self.engine.path)
        self.assertEqual(engine.config()['token'], '')
        self.assertEqual(engine.state['queue'], [])
        self.assertFalse(engine.paused())

    def test_an_answer_that_is_not_what_was_asked_for_is_a_refusal(self):
        self.pair()
        FakeEngine.creation_errors = [(200, ['not', 'a', 'document'])]
        self.engine.enqueue('doc1', 'Mémoire', SESSION, window(0))
        self.engine.drain()
        self.assertEqual(self.engine.state['status']['state'], 'offline')
        self.assertEqual(self.engine.status()[1], 1)

    def test_a_number_in_another_base_is_not_a_local_name(self):
        for address in ('http://0x08080808/', 'http://0x8.8/', 'http://017700000001/'):
            with self.subTest(address=address):
                self.assertFalse(engine_module.engine_url_allowed(address))
        self.assertTrue(engine_module.engine_url_allowed('http://moteur:9000'))

if __name__ == '__main__':
    unittest.main()


class BodyTest(unittest.TestCase):
    """The one body measurements leave in: numbered windows of a session, in one exact shape."""

    setUp = EngineTest.setUp
    tearDown = EngineTest.tearDown
    pair = EngineTest.pair

    def window(self, seq, session=SESSION, document='doc1', **blocks):
        self.engine.enqueue(document, 'Mémoire', session, window(seq, **blocks))

    def pushes(self):
        return [call[2] for call in FakeEngine.calls if call[1].endswith('/metrics')]

    def test_a_live_window_leaves_alone_in_the_exact_shape(self):
        """The bytes, not the parsed body: the order of the keys at every level, no space, no
        indentation, an integer never written as a float, a run in the shape of its kind, and
        no block sent empty."""
        self.pair()
        self.engine.enqueue('doc1', 'Mémoire', SESSION, {
            'seq': 12, 'at': 1794478471120, 'mono': 1843120, 'ms': 34180, 'why': 'idle', 'active': 27800,
            'runs': [['gap', 5200], ['type', 20, 4100], ['nav', 3, 600], ['erase', 7, 900],
                     ['click', 2], ['paste', 240], ['self', 61], ['copy', 61], ['undo', 1]],
            'counts': {'corrections': 4, 'reformulations': 1, 'revisions': 0, 'jumps': 3, 'exits': 0,
                       'back_keys': 0, 'back_chars': 0},
            'flight': {'med': 120.0, 'mad': 12.5, 'bins': [0, 0, 0, 0, 0, 2, 2]},
            'dwell': {'bins': [0, 0, 0, 1, 3, 1], 'rollover': 2},
            'text': {'len': 1540, 'since': 11, 'at': 1180, 'cut': 40, 'add': 360, 'kept': 31},
            'sum': {'keys': 5400, 'chars': 240, 'pastes': 1}})
        before = int(time.time() * 1000)
        self.engine.drain()
        body = FakeEngine.raw[-1].decode('utf-8')
        sent = json.loads(body)['sent']
        self.assertIs(type(sent), int)
        self.assertTrue(before <= sent <= int(time.time() * 1000))
        self.assertEqual(body, (
            '{"session":"p3Vq0hJmR2aXw9LkT1yZ5g","sent":%d,"windows":[{"seq":12,"at":1794478471120,'
            '"mono":1843120,"ms":34180,"why":"idle","active":27800,'
            '"runs":[["gap",5200],["type",20,4100],["nav",3,600],["erase",7,900],["click",2],'
            '["paste",240],["self",61],["copy",61],["undo",1]],'
            '"counts":{"corrections":4,"reformulations":1,"revisions":0,"jumps":3,"exits":0,'
            '"back_keys":0,"back_chars":0},'
            '"flight":{"med":120,"mad":12.5,"bins":[0,0,0,0,0,2,2]},'
            '"dwell":{"bins":[0,0,0,1,3,1],"rollover":2},'
            '"text":{"len":1540,"since":11,"at":1180,"cut":40,"add":360,"kept":31},'
            '"sum":{"keys":5400,"chars":240,"pastes":1}}]}') % sent)

    def test_a_block_the_window_does_not_have_is_left_out(self):
        self.pair()
        self.window(0)
        self.window(1, text={'len': 12})
        self.engine.drain()
        first, second = windows_sent()
        self.assertEqual(list(first), ['seq', 'at', 'mono', 'ms', 'why', 'active', 'runs', 'counts',
                                       'dwell', 'sum'])
        self.assertEqual(second['text'], {'len': 12})    # a size with no span beside it

    def test_a_queued_window_keeps_its_number_and_its_shape_across_a_restart(self):
        """What waits in the profile is the window as it was sealed: its session, its number,
        its instants and the totals. And since what comes back from the disk comes back in the
        file's order, not this code's, the file is rewritten with its keys sorted."""
        self.pair()
        FakeEngine.down = True
        self.window(2)
        self.engine.drain()
        self.window(3, flight={'med': 110.0, 'mad': 9.25, 'bins': [1] * 14},
                    text={'len': 5, 'since': 2, 'at': 4, 'cut': 1, 'add': 2})
        with open(self.engine.path, encoding='utf-8') as f:
            state = json.load(f)
        kept = state['queue'][1]
        self.assertEqual((kept['session'], kept['window']['seq']), (SESSION, 3))
        self.assertEqual((kept['window']['at'], kept['window']['mono'], kept['window']['ms']),
                         (1030000, 30000, 2000))
        self.assertEqual(kept['window']['sum'], {'keys': 20, 'chars': 0, 'pastes': 0})
        with open(self.engine.path, 'w', encoding='utf-8') as f:
            json.dump(state, f, sort_keys=True)

        restarted = Engine(self.engine.path)
        self.assertEqual(list(restarted.state['queue'][1]['window'])[:3], ['active', 'at', 'counts'],
                         "the queue read back should carry the file's order")
        FakeEngine.down = False
        restarted.drain()
        body = json.loads(FakeEngine.raw[-1])
        self.assertEqual(list(body), ['session', 'sent', 'windows'])
        (sent,) = body['windows']
        self.assertEqual(list(sent), ['seq', 'at', 'mono', 'ms', 'why', 'offline', 'active', 'runs',
                                      'counts', 'flight', 'dwell', 'text', 'sum'])
        self.assertEqual(list(sent['counts']), ['corrections', 'reformulations', 'revisions', 'jumps',
                                                'exits', 'back_keys', 'back_chars'])
        self.assertEqual(list(sent['flight']), ['med', 'mad', 'bins'])
        self.assertEqual(list(sent['dwell']), ['bins', 'rollover'])
        self.assertEqual(list(sent['text']), ['len', 'since', 'at', 'cut', 'add'])
        self.assertEqual(list(sent['sum']), ['keys', 'chars', 'pastes'])
        self.assertNotIn(b' ', FakeEngine.raw[-1])

    def test_a_queued_entry_in_any_other_shape_is_dropped(self):
        """There is one body. What a profile holds in another shape — left by another build of
        the agent, or edited by hand — could only be refused: it is dropped when the profile is
        read, and the windows around it leave as ever."""
        self.pair()
        self.window(0)
        self.window(1)
        with open(self.engine.path, encoding='utf-8') as f:
            state = json.load(f)
        good = state['queue'][1]
        strangers = [
            {'id': 'a', 'documentId': 'doc1', 'documentName': 'Mémoire',
             'period': {'start': '1970-01-01T00:16:40.000Z', 'end': '1970-01-01T00:16:42.000Z'},
             'values': {'keystrokes_total': 5}},
            {**good, 'window': {**good['window'], 'runs': []}},                 # no timeline
            {**good, 'window': {**good['window'], 'runs': [['type', 5]]}},      # not its kind's shape
            {**good, 'window': {**good['window'], 'runs': [['typo', 5, 800]]}},
            {**good, 'window': {key: value for key, value in good['window'].items() if key != 'why'}},
            {**good, 'window': {**good['window'], 'ms': 2000.5}},
            {**good, 'window': {**good['window'], 'text': {'len': 5, 'since': 0, 'at': 1}}},
            {**good, 'session': None},
            'not even an entry',
        ]
        state['queue'] = [state['queue'][0], *strangers, good]
        with open(self.engine.path, 'w', encoding='utf-8') as f:
            json.dump(state, f)

        restarted = Engine(self.engine.path)
        self.assertEqual(restarted.status()[1], 2)
        restarted.drain()
        self.assertEqual([sent['seq'] for sent in windows_sent()], [0, 1])

    def test_a_window_that_is_not_one_is_refused_before_it_is_queued(self):
        self.pair()
        with self.assertRaises((KeyError, TypeError, ValueError)):
            self.engine.enqueue('doc1', 'Mémoire', SESSION, {**window(), 'runs': []})
        self.assertEqual(self.engine.status()[1], 0)

    def test_a_queue_that_waited_offline_is_caught_up_in_batches(self):
        """At most BATCH_MAX_WINDOWS windows a request, in the order they were numbered, each
        one saying it waited — `offline` between the reason and the effective time. The window
        that met the outage was sealed before anyone knew: it is not flagged, and leaves alone."""
        self.pair()
        FakeEngine.down = True
        self.window(0)
        self.engine.drain()
        for seq in range(1, 70):
            self.window(seq)
        FakeEngine.down = False
        FakeEngine.calls = []
        self.engine.drain()
        pushes = self.pushes()
        self.assertEqual([[w['seq'] for w in body['windows']] for body in pushes],
                         [[0], list(range(1, 65)), list(range(65, 70))])
        self.assertEqual(engine_module.BATCH_MAX_WINDOWS, 64)
        self.assertNotIn('offline', pushes[0]['windows'][0])
        for sent in pushes[1]['windows'] + pushes[2]['windows']:
            self.assertEqual(list(sent)[:7], ['seq', 'at', 'mono', 'ms', 'why', 'offline', 'active'])
            self.assertIs(sent['offline'], True)
        self.assertEqual(self.engine.status()[1], 0)

    def test_windows_that_waited_for_another_reason_leave_one_by_one(self):
        """Several windows in one request say a queue caught up after an outage. Windows held
        back by anything else — here, an engine answering an error it then recovers from
        without this agent ever seeing it unreachable — were not written offline, and each
        leaves alone."""
        self.pair()
        for seq in range(3):
            self.window(seq)
        self.engine.drain()
        self.assertEqual([[w['seq'] for w in body['windows']] for body in self.pushes()], [[0], [1], [2]])

    def test_two_sessions_never_share_a_request(self):
        self.pair()
        FakeEngine.down = True
        self.window(0)
        self.engine.drain()
        self.window(1)
        self.window(2)
        self.window(0, session='Zk81mQ4tXcVb2nL0pRs7Aw')
        self.window(1, session='Zk81mQ4tXcVb2nL0pRs7Aw')
        self.window(0, session='aB3dE6gH9jK2mN5pQ8sT1v', document='doc2')
        FakeEngine.down = False
        FakeEngine.calls = []
        self.engine.drain()
        self.assertEqual([(body['session'], [w['seq'] for w in body['windows']]) for body in self.pushes()],
                         [(SESSION, [0]), (SESSION, [1, 2]),
                          ('Zk81mQ4tXcVb2nL0pRs7Aw', [0, 1]), ('aB3dE6gH9jK2mN5pQ8sT1v', [0])])

    def test_the_sending_time_is_written_again_at_each_attempt(self):
        self.pair()
        FakeEngine.metrics_reply = staticmethod(lambda body: (503, {'error': 'unavailable'}))
        self.window(0)
        self.engine.drain()
        time.sleep(0.01)
        FakeEngine.metrics_reply = None
        self.engine.drain()
        first, second = (body['sent'] for body in self.pushes())
        self.assertLess(first, second)

    def test_a_refused_window_is_dropped_and_never_sent_another_way(self):
        """A 400 is about the window, whatever its code: it is dropped, once, and the queue
        moves on. No refusal makes this agent send the window again in another body, or leave
        anything out of the next one."""
        for code in ('invalid_body', 'unknown_field', 'run_shape_invalid'):
            with self.subTest(code=code):
                self.setUp()
                self.pair()
                FakeEngine.metrics_error = {'code': code, 'error': 'refused'}
                self.window(0)
                self.engine.drain()
                self.assertEqual(len(self.pushes()), 1)
                self.assertEqual(self.engine.status()[1], 0)     # dropped, not retried for ever
                FakeEngine.metrics_error = None
                self.window(1)
                self.engine.drain()
                self.assertEqual(self.pushes()[-1]['windows'], [window(1)])
                self.tearDown()

    def test_one_refused_window_does_not_take_its_batch_with_it(self):
        """The refusal does not say which window it is about, so the batch is sent again one
        by one: the one the engine refuses is lost, the others arrive. A number the engine
        already holds with another instant (409) is refused for good in the same way."""
        for status in (400, 409):
            with self.subTest(status=status):
                self.setUp()
                self.pair()
                FakeEngine.down = True
                self.window(0)
                self.engine.drain()
                for seq in range(1, 6):
                    self.window(seq)
                FakeEngine.down = False
                FakeEngine.calls = []
                FakeEngine.metrics_reply = staticmethod(
                    lambda body, status=status: (status, {'code': 'refused', 'error': 'no'})
                    if any(w['seq'] == 3 for w in body['windows']) else None)
                self.engine.drain()
                self.assertEqual([[w['seq'] for w in body['windows']] for body in self.pushes()],
                                 [[0], [1, 2, 3, 4, 5], [1], [2], [3], [4], [5]])
                self.assertEqual(self.engine.status(), ({**self.engine.status()[0], 'state': 'synced'}, 0))
                self.tearDown()

    def test_a_document_deleted_on_the_engine_is_created_again_for_the_window(self):
        self.pair()
        seen = []

        def gone_once(body):
            seen.append(body)
            return (404, {'error': 'not found'}) if len(seen) == 1 else None

        FakeEngine.metrics_reply = staticmethod(gone_once)
        self.window(0)
        self.engine.drain()
        created = [c for c in FakeEngine.calls if c[:2] == ('POST', '/api/documents')]
        self.assertEqual(len(created), 2)
        self.assertEqual(len(self.pushes()), 2)
        self.assertEqual(self.engine.status()[1], 0)

    def test_what_may_start_measuring_over_moves_the_epoch(self):
        """A sensor starts a new session when this number has moved: after a suspension set or
        lifted, a pairing, a sign-out."""
        seen = [self.engine.epoch]
        self.pair()
        seen.append(self.engine.epoch)
        self.engine.set_paused(True)
        seen.append(self.engine.epoch)
        self.engine.set_paused(False)
        seen.append(self.engine.epoch)
        self.engine.logout()
        seen.append(self.engine.epoch)
        self.assertEqual(len(set(seen)), len(seen))


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
        # Read once per LibreOffice session: forgotten here, and again once the test is over.
        engine_module._installed_version = None
        self.addCleanup(setattr, engine_module, '_installed_version', None)
        self.assertEqual(engine_module.installed_version(), '1.5.0')



class ReportTest(unittest.TestCase):
    """« Signaler un problème »: the link to the engine's help form and the block it carries.

    The contract is docs/moteur.md, « Signaler un problème »; the three other agents hold the
    same rules in their own suites, and `make check` compares REPORT_FRAGMENT and REPORT_KEYS.
    """

    T0 = 1_795_617_127  # 2026-11-25T14:32:07Z

    def setUp(self):
        self.dir = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.dir, ignore_errors=True)
        self.engine = Engine(os.path.join(self.dir, 'certimens.json'))
        i18n.set_language('fr')

    def signed_in(self):
        """A student paired and writing, with everything the block must never say in reach."""
        self.engine.state['config'] = {'engineUrl': 'https://moteur.univ.fr', 'token': 'tok-SECRET-42',
                                       'tokenId': 'tid-SECRET', 'email': 'etudiante@univ.fr',
                                       'displayName': 'Camille Martin', 'language': 'fr'}
        self.engine.state['engineIds']['doc-identity-1'] = 'engine-doc-77'
        self.engine.state['titles']['doc-identity-1'] = 'Mémoire confidentiel'
        for seq in range(3):
            self.engine.enqueue('doc-identity-1', 'Mémoire confidentiel', SESSION, window(seq),
                                'file:///home/camille/M%C3%A9moire.odt')

    def details(self, url):
        query = url.split('#report?', 1)[1]
        params = urllib.parse.parse_qs(query, keep_blank_values=True)
        self.assertEqual(list(params), ['kind', 'details'])
        self.assertEqual(params['kind'], ['problem'])
        return params['details'][0]

    def lines(self, url):
        return dict(line.split(': ', 1) for line in self.details(url).split('\n'))

    def test_the_keys_are_the_contract_s_in_its_order(self):
        self.assertEqual(engine_module.REPORT_FRAGMENT, '#report')
        self.assertEqual(engine_module.REPORT_KEYS, ('agent', 'host', 'os', 'language', 'engine', 'signed_in',
                                                     'paused', 'status', 'queued', 'counters', 'at'))

    def test_shape_and_order_of_the_link(self):
        self.signed_in()
        self.engine.state['status'] = {'state': 'offline', 'reached': True}
        self.engine.count('error.runtime', 2)
        self.engine.count('network.failure', 5)
        self.engine.set_paused(True)
        url = self.engine.report_url('7.4.7.2', now=self.T0)
        self.assertTrue(url.startswith('https://moteur.univ.fr/#report?kind=problem&details='), url)
        block = self.details(url)
        self.assertEqual([line.split(': ', 1)[0] for line in block.split('\n')], list(engine_module.REPORT_KEYS))
        lines = self.lines(url)
        self.assertEqual(lines['agent'], engine_module.agent_declaration())
        self.assertEqual(lines['host'], 'LibreOffice 7.4.7.2')
        self.assertEqual(lines['os'], ('%s %s' % (platform.system(), platform.machine())).strip())
        self.assertEqual(lines['language'], 'fr')
        self.assertEqual(lines['engine'], 'https://moteur.univ.fr')
        self.assertEqual(lines['signed_in'], 'yes')
        self.assertEqual(lines['paused'], 'yes')
        self.assertEqual(lines['status'], 'offline (reached)')
        self.assertEqual(lines['queued'], '3')
        # The vocabulary's order, not the order of counting.
        self.assertEqual(lines['counters'], 'error.runtime=2 network.failure=5')
        self.assertEqual(lines['at'], '2026-11-25T14:32:07Z')

    def test_status_words(self):
        for status, said in (({'state': 'offline', 'reached': False}, 'offline (unreachable)'),
                             ({'state': 'offline'}, 'offline (unreachable)'),
                             ({'state': 'synced'}, 'synced'), ({'state': 'auth_error'}, 'auth_error'),
                             ({'state': 'whatever the file says\nqueued: 0'}, 'unknown'), ({}, 'unknown')):
            with self.subTest(status=status):
                self.engine.state['status'] = status
                self.assertEqual(self.lines(self.engine.report_url('7.4'))['status'], said)

    def test_what_is_not_known_is_said_unknown_and_no_line_is_left_out(self):
        url = self.engine.report_url('', now=self.T0)
        lines = self.lines(url)
        self.assertEqual(list(lines), list(engine_module.REPORT_KEYS))
        self.assertEqual(lines['host'], 'unknown')
        self.assertEqual(lines['signed_in'], 'no')
        self.assertEqual(lines['paused'], 'no')
        self.assertEqual(lines['queued'], '0')
        self.assertEqual(lines['counters'], 'none')
        self.assertEqual(lines['status'], 'idle')
        # No agent version in a checkout (see installed_version): the kind alone, as the header.
        self.assertEqual(lines['agent'], 'libreoffice')
        self.assertEqual(engine_module.report_block({}).split('\n'),
                         ['%s: unknown' % key for key in engine_module.REPORT_KEYS])

    def test_never_the_token_the_email_nor_a_document(self):
        self.signed_in()
        self.engine.state['config']['engineUrl'] = 'https://user:motdepasse@moteur.univ.fr/chemin?q=1'
        url = self.engine.report_url('7.4.7.2')
        block = self.details(url)
        for secret in ('tok-SECRET-42', 'tid-SECRET', 'etudiante', 'univ.fr/chemin', 'Camille', 'Martin',
                       'Mémoire', 'confidentiel', 'doc-identity-1', 'engine-doc-77', 'camille', 'odt', 'motdepasse',
                       'user', 'chemin', SESSION):
            self.assertNotIn(secret, block)
            self.assertNotIn(secret, url)
        self.assertEqual(self.lines(url)['engine'], 'https://moteur.univ.fr')

    def test_a_refused_engine_falls_back_to_the_default_one(self):
        # The link is opened on the default engine; the `engine` line says what was configured —
        # what the support needs to read — as long as it is an http(s) address at all, like the
        # three other agents. Anything else is no address to report: `unknown`.
        for refused, line in (('http://moteur.univ.fr', 'http://moteur.univ.fr'),
                              ('ftp://moteur.univ.fr', 'unknown'), ('javascript:alert(1)', 'unknown'),
                              ('pas une adresse', 'unknown')):
            with self.subTest(refused=refused):
                self.engine.state['config']['engineUrl'] = refused
                url = self.engine.report_url('7.4')
                self.assertTrue(url.startswith(engine_module.DEFAULT_ENGINE_URL + '/#report?'), url)
                self.assertEqual(self.lines(url)['engine'], line)
        # A local engine in http is one the agent calls: it is the one reported to.
        self.engine.state['config']['engineUrl'] = 'http://localhost:8000/'
        self.assertTrue(self.engine.report_url('7.4').startswith('http://localhost:8000/#report?'))

    def test_the_address_the_login_window_is_about_to_use(self):
        url = self.engine.report_url('7.4', engine_url='https://moteur.univ.fr/')
        self.assertTrue(url.startswith('https://moteur.univ.fr/#report?'), url)
        url = self.engine.report_url('7.4', engine_url='http://moteur.univ.fr')
        self.assertTrue(url.startswith(engine_module.DEFAULT_ENGINE_URL + '/#report?'), url)

    def test_quoted_whole_as_one_component(self):
        url = self.engine.report_url('7.4 & co=1#x?y/z', now=self.T0)
        query = url.split('#report?', 1)[1]
        # One fragment, two parameters: nothing in the block opens a third or ends the fragment.
        self.assertEqual(url.count('#'), 1)
        self.assertEqual(query.count('&'), 1)
        self.assertNotIn(' ', url)
        self.assertNotIn('\n', url)
        details = query.split('&details=', 1)[1]
        self.assertEqual(urllib.parse.unquote(details), engine_module.report_block(
            self.engine.report_values('7.4 & co=1#x?y/z', now=self.T0)))
        self.assertIn('%0A', details)
        self.assertNotIn('/', details)
        self.assertEqual(self.lines(url)['host'], 'LibreOffice 7.4 & co=1#x?y/z')

    def test_a_value_never_spans_two_lines(self):
        url = self.engine.report_url('7.4\nqueued: 999\r\nat: 1970 x')
        self.assertEqual(len(self.details(url).split('\n')), len(engine_module.REPORT_KEYS))
        self.assertEqual(self.lines(url)['host'], 'LibreOffice 7.4 queued: 999 at: 1970 x')

    def test_capped_at_1500_characters_on_a_line_boundary(self):
        block = engine_module.report_block({'agent': 'libreoffice/1.0.0', 'host': 'LibreOffice ' + 'x' * 700,
                                            'os': 'y' * 800, 'language': 'fr'})
        self.assertLessEqual(len(block), engine_module.REPORT_MAX)
        self.assertEqual([line.split(': ', 1)[0] for line in block.split('\n')], ['agent', 'host'])
        self.assertTrue(block.endswith('x'))
        # Exactly at the cap, the line fits.
        exact = engine_module.report_block({'agent': 'a' * (engine_module.REPORT_MAX - len('agent: '))})
        self.assertEqual(len(exact), engine_module.REPORT_MAX)
        self.assertEqual(exact.split('\n')[0], 'agent: ' + 'a' * (engine_module.REPORT_MAX - len('agent: ')))
        self.assertEqual(len(exact.split('\n')), 1)

    def test_the_language_of_the_interface(self):
        i18n.set_language('en')
        self.addCleanup(i18n.set_language, 'fr')
        self.assertEqual(self.lines(self.engine.report_url('7.4'))['language'], 'en')

    def test_reading_the_state_writes_nothing_and_calls_nothing(self):
        self.signed_in()
        path = self.engine.path
        before = os.stat(path).st_mtime_ns
        opened = []
        original = engine_module.OPENER.open
        engine_module.OPENER.open = lambda *args, **kwargs: opened.append(args)
        self.addCleanup(setattr, engine_module.OPENER, 'open', original)
        self.engine.report_url('7.4')
        self.assertEqual(opened, [])
        self.assertEqual(os.stat(path).st_mtime_ns, before)


def free_port():
    """A port nothing listens on: a call there gets no answer at all."""
    with socket.socket() as s:
        s.bind(('127.0.0.1', 0))
        return s.getsockname()[1]


class TelemetryTest(unittest.TestCase):
    """What the agent says about itself: counters of a closed vocabulary, and when they leave.

    The contract is docs/moteur.md, « Ce que l'agent dit de lui-même »; the three other agents
    hold the same rules in their own suites.
    """

    setUp = EngineTest.setUp
    tearDown = EngineTest.tearDown
    pair = EngineTest.pair

    T0 = 2_000_000_000.0

    def counts(self, engine=None):
        return dict((engine or self.engine).state['telemetry']['counts'])

    def reports(self):
        return list(FakeEngine.telemetry)

    def paired(self):
        """Paired, with the pairing's own counts (none, against this fake) out of the way."""
        self.pair()
        self.engine.state['telemetry']['counts'] = {}

    # --- what is counted ---
    def test_the_vocabulary_is_the_contract_s_in_its_order(self):
        self.assertEqual(engine_module.TELEMETRY_EVENTS, (
            'installed', 'updated', 'started', 'error.runtime', 'error.engine', 'error.rejected',
            'error.auth', 'network.failure', 'queue.dropped'))
        self.assertEqual(engine_module.TELEMETRY_FLUSH_S, 900)
        self.assertEqual(engine_module.TELEMETRY_MAX_COUNT, 10000)
        with self.assertRaises(ValueError):
            self.engine.count('error.something formed at run time')

    def test_a_count_stops_at_the_cap(self):
        self.engine.count('error.runtime', 9999)
        self.engine.count('error.runtime')
        self.engine.count('error.runtime')
        self.engine.count('started', 50000)
        self.assertEqual(self.counts(), {'error.runtime': 10000, 'started': 10000})

    def test_counts_survive_a_restart_beside_the_queue(self):
        self.engine.count('error.engine', 2)
        self.engine.record_start('1.5.0')
        again = Engine(self.engine.path)
        self.assertEqual(self.counts(again), {'error.engine': 2, 'installed': 1, 'started': 1})
        # The state file holds the token: telemetry does not loosen how it is created.
        self.assertEqual(os.stat(self.engine.path).st_mode & 0o077, 0)

    def test_a_state_file_edited_by_hand_sends_only_known_words_in_range(self):
        with open(self.engine.path, 'w', encoding='utf-8') as f:
            json.dump({'telemetry': {'counts': {'started': 3, 'password': 'x', 'updated': -2,
                                                'error.auth': True, 'error.engine': 10 ** 9},
                                     'sentAt': 'yesterday'}}, f)
        loaded = Engine(self.engine.path).state['telemetry']
        self.assertEqual(loaded['counts'], {'started': 3, 'error.engine': 10000})
        self.assertEqual(loaded['sentAt'], 0)

    def test_installed_updated_and_started(self):
        cases = [
            # (version the profile holds, its notice's version, the build that starts, counted)
            ('', '', '1.5.0', {'installed': 1, 'started': 1}),
            ('1.5.0', '', '1.5.0', {'started': 1}),
            ('1.4.0', '', '1.5.0', {'updated': 1, 'started': 1}),
            # A profile from before these counters: its update notice knew the previous build.
            ('', '1.4.0', '1.5.0', {'updated': 1, 'started': 1}),
            # A checkout knows no version: it starts, and says nothing else.
            ('', '', '', {'started': 1}),
        ]
        for held, seen, build, expected in cases:
            with self.subTest(held=held, seen=seen, build=build):
                engine = Engine(os.path.join(tempfile.mkdtemp(dir=self.dir), 'certimens.json'))
                engine.state['telemetry']['version'] = held
                if seen:
                    engine.state['seenVersion'] = seen
                engine.record_start(build)
                self.assertEqual(self.counts(engine), expected)
                if build:
                    self.assertEqual(engine.state['telemetry']['version'], build)
                # The update notice still has its own say: it reads another key.
                self.assertEqual(engine.state.get('seenVersion', ''), seen)

    def test_failures_of_the_agent_s_work_are_counted_by_class(self):
        self.paired()
        cases = [
            (lambda: setattr(FakeEngine, 'failing', True), 'error.engine'),
            (lambda: setattr(FakeEngine, 'down', True), 'network.failure'),
            (lambda: setattr(FakeEngine, 'put_error', (401, {'error': 'revoked'})), 'error.auth'),
            (lambda: setattr(FakeEngine, 'put_error', (403, {'error': 'no'})), 'error.rejected'),
        ]
        for arrange, event in cases:
            with self.subTest(event=event):
                FakeEngine.down, FakeEngine.failing, FakeEngine.put_error = False, False, None
                self.engine.state['telemetry']['counts'] = {}
                arrange()
                with self.assertRaises(HttpError):
                    self.engine.api('PUT', '/api/documents/f1', {'name': 'x'})
                self.assertEqual(self.counts(), {event: 1})

    def test_a_window_the_engine_refuses_is_counted(self):
        self.paired()
        FakeEngine.metrics_error = {'error': 'refused'}
        self.engine.enqueue('doc1', 'Mémoire', SESSION, window(0))
        self.engine.drain()
        self.assertEqual(self.counts(), {'error.rejected': 1})

    def test_no_answer_is_a_network_failure(self):
        self.paired()
        self.engine.state['config']['engineUrl'] = f'http://127.0.0.1:{free_port()}'
        self.engine.enqueue('doc1', 'Mémoire', SESSION, window(0))
        self.engine.drain()
        self.assertEqual(self.counts(), {'network.failure': 1})
        self.assertEqual(self.engine.status()[0]['state'], 'offline')

    def test_the_ordinary_answers_are_not_failures(self):
        # A pairing nobody has confirmed yet, or asked about too often: keep waiting.
        FakeEngine.device_pending = True
        pairing = self.engine.start_pairing(self.url)
        self.engine.poll_pairing(pairing)
        FakeEngine.device_pending = False
        FakeEngine.device_error = (429, {'error': 'too many'})
        self.engine.poll_pairing(pairing)
        FakeEngine.device_error = None
        self.assertEqual(self.counts(), {})
        # A file that names somebody else's document, or one since deleted.
        self.paired()
        FakeEngine.document_error = (403, {'error': 'forbidden'})
        self.assertIsNone(self.engine.resume_engine_document('doc1', 'f9', 'Mémoire'))
        FakeEngine.document_error = None
        self.assertIsNone(self.engine.resume_engine_document('doc1', 'f9', 'Mémoire'))
        self.assertEqual(self.counts(), {})

    def test_a_full_queue_counts_what_it_lets_go(self):
        original = engine_module.MAX_QUEUE
        engine_module.MAX_QUEUE = 3
        self.addCleanup(setattr, engine_module, 'MAX_QUEUE', original)
        self.paired()
        FakeEngine.down = True
        for seq in range(5):
            self.engine.enqueue('doc1', 'Mémoire', SESSION, window(seq))
        self.assertEqual(self.counts(), {'queue.dropped': 2})

    def test_a_runtime_error_is_counted_without_its_text_and_never_raises(self):
        self.engine.runtime_error('touche', RuntimeError('the student wrote "secret"'))
        self.assertEqual(self.counts(), {'error.runtime': 1})
        self.assertNotIn('secret', json.dumps(self.engine.state['telemetry']))

    # --- where the code broke ---
    @staticmethod
    def raised(fn, *args):
        try:
            fn(*args)
        except Exception as err:
            return err
        raise AssertionError('nothing raised')

    def test_a_fault_is_our_frames_innermost_first_never_a_directory_or_the_message(self):
        err = self.raised(engine_module.whole, 'the student wrote "secret"')
        fault = engine_module.fault_of(err)
        self.assertEqual(fault['type'], 'TypeError')
        # This test's own frame is not the extension's: only engine.py is kept, as a bare name.
        self.assertEqual(len(fault['frames']), 1)
        self.assertRegex(fault['frames'][0], r'^whole@engine\.py:[1-9][0-9]*$')
        self.assertNotIn('secret', json.dumps(fault))
        self.assertNotIn(os.sep, json.dumps(fault))

    def test_frames_of_the_standard_library_are_not_ours(self):
        err = self.raised(json.loads, '{"essai": "le texte de l\'étudiant"')
        fault = engine_module.fault_of(err)
        self.assertEqual(fault, {'type': 'JSONDecodeError', 'frames': []})

    def test_a_type_that_is_no_name_is_other_and_frames_stop_at_twelve(self):
        odd = type('Not a name!', (Exception,), {})
        self.assertEqual(engine_module.fault_of(odd())['type'], 'Other')

        def deep(n):
            if n == 0:
                raise ValueError('x')
            deep(n - 1)
        err = self.raised(deep, 20)
        here = os.path.dirname(os.path.realpath(__file__))
        fault = engine_module.fault_of(err, (os.path.normcase(here),))
        self.assertEqual(len(fault['frames']), engine_module.TELEMETRY_MAX_FRAMES)
        self.assertTrue(all(f.startswith('deep@test_engine.py:') for f in fault['frames']))

    def test_a_runtime_error_is_kept_as_a_fault_once_with_its_count_ten_at_most(self):
        err = self.raised(engine_module.whole, 'x')
        self.engine.runtime_error('touche', err)
        self.engine.runtime_error('touche', err)
        faults = self.engine.state['telemetry']['faults']
        self.assertEqual(len(faults), 1)
        self.assertEqual(faults[0]['count'], 2)
        self.assertEqual(self.counts(), {'error.runtime': 2})
        for n in range(12):
            self.engine.runtime_error('touche', type('Fault%d' % n, (Exception,), {})())
        self.assertEqual(len(self.engine.state['telemetry']['faults']), engine_module.TELEMETRY_MAX_FAULTS)
        self.assertEqual(self.counts(), {'error.runtime': 14})

    def test_a_state_file_edited_by_hand_keeps_only_faults_of_the_right_shape(self):
        good = {'type': 'KeyError', 'frames': ['flush@engine.py:12', '<module>@certimens.py:3'], 'count': 2}
        with open(self.engine.path, 'w', encoding='utf-8') as f:
            json.dump({'telemetry': {'faults': [
                good,
                {'type': 'KeyError', 'frames': ['/home/alice/engine.py:12'], 'count': 1},
                {'type': 'KeyError', 'frames': ['the student wrote'], 'count': 1},
                {'type': 'Not a name', 'frames': [], 'count': 1},
                {'type': 'KeyError', 'frames': [], 'count': 0},
                'nonsense',
            ]}}, f)
        self.assertEqual(Engine(self.engine.path).state['telemetry']['faults'], [good])

    def test_faults_leave_with_the_counts_and_are_forgotten_with_them(self):
        self.paired()
        err = self.raised(engine_module.whole, 'x')
        self.engine.runtime_error('touche', err)
        fault = engine_module.fault_of(err)

        self.assertEqual(self.engine.flush_telemetry(self.T0), 204)

        (raw, _), = self.reports()
        self.assertEqual(json.loads(raw), {'events': {'error.runtime': 1}, 'faults': [dict(fault, count=1)]})
        self.assertEqual(self.engine.state['telemetry']['faults'], [])

    def test_faults_are_kept_for_next_time_when_nothing_answers(self):
        self.paired()
        self.engine.runtime_error('touche', self.raised(engine_module.whole, 'x'))
        FakeEngine.failing = True
        self.assertEqual(self.engine.flush_telemetry(self.T0), 503)
        self.assertEqual(len(self.engine.state['telemetry']['faults']), 1)

    # --- when it leaves ---
    def test_the_report_is_counts_in_a_compact_body_with_the_usual_headers(self):
        self.paired()
        self.engine.count('error.runtime')
        self.engine.count('started', 3)

        self.assertEqual(self.engine.flush_telemetry(self.T0), 204)

        (raw, headers), = self.reports()
        # The order of the vocabulary, no space, and nothing but counts.
        self.assertEqual(raw, b'{"events":{"started":3,"error.runtime":1}}')
        self.assertEqual(headers['Authorization'], 'Bearer ' + self.engine.config()['token'])
        self.assertEqual(headers['Content-Type'], 'application/json')
        self.assertEqual(headers['X-Certimens-Agent'], engine_module.agent_declaration())
        self.assertEqual(self.counts(), {})

    def test_it_goes_through_the_one_opener(self):
        source = (pathlib.Path(__file__).parent.parent / 'src' / 'pythonpath'
                  / 'certimens_agent' / 'engine.py').read_text(encoding='utf-8')
        sender = source[source.index('def _send_telemetry'):source.index('def _run')]
        self.assertIn('OPENER.open(', sender)
        self.assertIn('engine_url_allowed(url)', sender)

    def test_nothing_leaves_unpaired_and_nothing_is_lost_waiting(self):
        self.engine.record_start('1.5.0')
        self.assertIsNone(self.engine.flush_telemetry(self.T0))
        self.assertEqual(self.reports(), [])
        # `installed` almost always comes before the pairing: it leaves once paired.
        self.pair()
        self.assertEqual(self.engine.flush_telemetry(self.T0), 204)
        self.assertEqual(json.loads(self.reports()[0][0]), {'events': {'installed': 1, 'started': 1}})

    def test_nothing_to_say_sends_nothing(self):
        self.paired()
        self.assertIsNone(self.engine.flush_telemetry(self.T0))
        self.assertEqual(self.reports(), [])

    def test_at_most_once_every_fifteen_minutes(self):
        self.paired()
        self.engine.count('started')
        self.assertEqual(self.engine.flush_telemetry(self.T0), 204)
        self.engine.count('started')
        self.assertIsNone(self.engine.flush_telemetry(self.T0 + 60))
        self.assertIsNone(self.engine.flush_telemetry(self.T0 + 899))
        self.assertEqual(self.engine.flush_telemetry(self.T0 + 900), 204)
        self.assertEqual(len(self.reports()), 2)
        # A clock set back does not hold the report for ever.
        self.engine.count('started')
        self.assertEqual(self.engine.flush_telemetry(self.T0 - 3600), 204)

    def test_the_throttle_survives_a_restart(self):
        self.paired()
        self.engine.count('started')
        self.engine.flush_telemetry(self.T0)
        again = Engine(self.engine.path)
        again.count('started')
        self.assertIsNone(again.flush_telemetry(self.T0 + 60))

    def test_what_is_counted_during_the_send_stays_for_the_next(self):
        self.paired()
        self.engine.count('started', 2)
        FakeEngine.telemetry_during = lambda: (self.engine.count('started'),
                                               self.engine.count('error.runtime'))
        self.assertEqual(self.engine.flush_telemetry(self.T0), 204)
        self.assertEqual(self.counts(), {'started': 1, 'error.runtime': 1})

    def test_kept_when_nothing_answers_or_the_engine_fails(self):
        self.paired()
        self.engine.count('started', 2)
        engine_url = self.engine.state['config']['engineUrl']
        self.engine.state['config']['engineUrl'] = f'http://127.0.0.1:{free_port()}'
        self.assertEqual(self.engine.flush_telemetry(self.T0), 0)
        self.engine.state['config']['engineUrl'] = engine_url
        FakeEngine.failing = True
        self.assertEqual(self.engine.flush_telemetry(self.T0 + 900), 503)
        # Kept — and the report's own failures are not counted: an engine out of reach would
        # otherwise grow the counter that says it is out of reach.
        self.assertEqual(self.counts(), {'started': 2})

    def test_let_go_when_the_body_or_the_token_is_refused(self):
        self.paired()
        for at, status in enumerate((400, 401, 413)):
            with self.subTest(status=status):
                self.engine.count('started')
                FakeEngine.telemetry_status = status
                self.assertEqual(self.engine.flush_telemetry(self.T0 + at * 900), status)
                self.assertEqual(self.counts(), {})

    def test_kept_on_any_other_answer(self):
        self.paired()
        for at, status in enumerate((200, 404, 429)):
            with self.subTest(status=status):
                self.engine.count('started')
                FakeEngine.telemetry_status = status
                self.assertEqual(self.engine.flush_telemetry(self.T0 + at * 900), status)
        self.assertEqual(self.counts(), {'started': 3})
