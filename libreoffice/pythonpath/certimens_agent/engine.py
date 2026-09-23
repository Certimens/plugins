"""Sending to the Certimens engine (the equivalent of extension/background.js), without LibreOffice.

Each document is tied to an engine file (created on the first send via POST /api/files,
then remembered). Metrics go out to POST /api/files/:id/metrics, authenticating as the
student with an API token (Bearer) that is created at login and kept in place of the
password. When offline, they stay in a queue (a JSON file in the LibreOffice
profile) that is retried every minute. Sending happens on a dedicated thread: the LibreOffice
UI never waits on the network.
"""

import base64
import json
import os
import threading
import urllib.error
import urllib.request
import uuid
from datetime import datetime, timezone

DEFAULT_ENGINE_URL = 'https://monespace.certimens.fr'
RETRY_S = 60
MAX_QUEUE = 5000
TIMEOUT_S = 30
# The engine caps a request body at 25 MiB; in base64 the .docx grows by a third.
MAX_UPLOAD_BASE64 = 24 * 1024 * 1024
# Metrics added by the browser agents: an older engine rejects them (400 "unknown
# metric type"), so we drop them rather than lose the whole window.
EXTENDED_TYPES = {'paste_events', 'focus_losses', 'median_flight_ms'}


class HttpError(Exception):
    def __init__(self, status, message, code=''):
        super().__init__(message)
        self.status = status
        self.message = message
        # The engine names the rule that refused the request ({"code", "error"}).
        self.code = code


def iso(timestamp):
    return datetime.fromtimestamp(timestamp, timezone.utc).isoformat(timespec='milliseconds').replace('+00:00', 'Z')


def trim_url(url):
    return url.rstrip('/')


class Engine:
    def __init__(self, state_path):
        self.path = state_path
        self.lock = threading.RLock()
        # The Certimens window and the sending thread can both create the file for the same
        # document: one at a time, otherwise the engine would end up with two.
        self.create_lock = threading.Lock()
        # Serializes the one-time legacy-password migration (see authed_config).
        self.migrate_lock = threading.Lock()
        self.wake = threading.Event()
        self.listeners = []
        self.state = self._load()

    # --- 1. STORAGE ---
    def _load(self):
        state = {'config': {}, 'files': {}, 'titles': {}, 'syncedTitles': {}, 'queue': [],
                 'status': {'state': 'idle'}, 'extendedUnsupported': False}
        try:
            with open(self.path, encoding='utf-8') as f:
                state.update(json.load(f))
        except (OSError, ValueError):
            pass
        return state

    def _save(self):
        # The file holds the student's API token: it is created 0600 up front, never chmod-ed
        # after the fact, so it is not briefly world-readable under the process umask.
        tmp = self.path + '.tmp'
        fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, 'w', encoding='utf-8') as f:
            json.dump(self.state, f)
        os.replace(tmp, self.path)

    def config(self):
        # token: API token (Bearer) kept in place of the password. tokenId: its
        # identifier, used to revoke it at logout. password: legacy setting, migrated on the
        # next send (see authed_config).
        with self.lock:
            return {'engineUrl': DEFAULT_ENGINE_URL, 'email': '', 'token': '', 'tokenId': '', **self.state['config']}

    @staticmethod
    def _has_auth(config):
        """True if the setting carries a token, or a legacy password still to be migrated."""
        return bool(config.get('token') or config.get('password'))

    def status(self):
        with self.lock:
            return dict(self.state['status']), len(self.state['queue'])

    def logged_in(self):
        return self._has_auth(self.config()) and self.status()[0]['state'] != 'auth_error'

    def file_id(self, document_id):
        with self.lock:
            return self.state['files'].get(document_id)

    def _set_status(self, status):
        with self.lock:
            self.state['status'] = {**status, 'at': iso(datetime.now().timestamp())}
            self._save()
        for listener in list(self.listeners):
            listener()

    # --- 2. ENGINE API ---
    def _request(self, method, url, body=None, token=None):
        data = None if body is None else json.dumps(body).encode('utf-8')
        req = urllib.request.Request(url, data=data, method=method)
        req.add_header('Content-Type', 'application/json')
        if token:
            req.add_header('Authorization', 'Bearer ' + token)
        try:
            with urllib.request.urlopen(req, timeout=TIMEOUT_S) as res:
                # The 201 from metrics returns the text "Created" (Fiber's SendStatus): only
                # JSON is read.
                if 'application/json' not in res.headers.get('Content-Type', ''):
                    return None
                return json.loads(res.read().decode('utf-8'))
        except urllib.error.HTTPError as err:
            message, code = err.reason, ''
            try:
                body = json.loads(err.read().decode('utf-8'))
                message = body.get('error') or message
                code = body.get('code') or ''
            except ValueError:
                pass
            raise HttpError(err.code, str(message), code)
        except (urllib.error.URLError, OSError) as err:
            raise HttpError(0, str(getattr(err, 'reason', err)))

    def api(self, method, path, body=None, config=None):
        config = config or self.authed_config()
        return self._request(method, trim_url(config['engineUrl']) + path, body, config['token'])

    def _create_api_token(self, engine_url, email, password):
        """Exchange email/password for an API token: log in (session token), then create a
        non-expiring token, revocable from the Certimens space; the now-useless session token
        is revoked. Returns (me, token, token_id)."""
        url = trim_url(engine_url or DEFAULT_ENGINE_URL)
        me = self._request('POST', url + '/api/auth/login', {'email': email, 'password': password})
        label = 'Extension LibreOffice (%s)' % datetime.now().strftime('%d/%m/%Y')
        token = self._request('POST', url + '/api/auth/tokens', {'label': label}, me['token'])
        try:
            self._request('POST', url + '/api/auth/logout', None, me['token'])
        except HttpError:
            pass  # network: the session token will expire on its own
        return me, token['token'], token['id']

    def authed_config(self):
        """Setting guaranteed to carry a token. A legacy password-based setting is migrated once
        here: its password is exchanged for a token, then erased.

        The migration runs under its own lock and re-checks the setting inside it: two callers
        racing here (the sending thread and the Certimens window) would otherwise each create an
        API token, and only the last one would be recorded — the other would stay valid on the
        engine with no way to revoke it.
        """
        config = self.config()
        if config.get('token') or not config.get('password'):
            return config
        with self.migrate_lock:
            config = self.config()
            if config.get('token') or not config.get('password'):
                return config
            return self._migrate(config)

    def _migrate(self, config):
        me, token, token_id = self._create_api_token(config['engineUrl'], config['email'], config['password'])
        migrated = {'engineUrl': trim_url(config['engineUrl']), 'email': me.get('email') or config['email'],
                    'token': token, 'tokenId': token_id}
        with self.lock:
            self.state['config'] = migrated
            self._save()
        return migrated

    def login(self, engine_url, email, password):
        """The password is exchanged for an API token, the only thing kept (the engine only
        grants it if the credentials are valid)."""
        me, token, token_id = self._create_api_token(engine_url, email, password)
        with self.lock:
            self.state['config'] = {'engineUrl': trim_url(engine_url or DEFAULT_ENGINE_URL),
                                    'email': me.get('email') or email, 'token': token, 'tokenId': token_id}
            # A new engine may well know the extended metrics the previous one refused.
            self.state['extendedUnsupported'] = False
        self._set_status({'state': 'idle'})  # clears any auth_error before the next send
        self.wake.set()
        return me

    def logout(self):
        config = self.config()
        if config.get('token') and config.get('tokenId'):
            try:
                self.api('DELETE', '/api/auth/tokens/%s' % config['tokenId'], config=config)
            except HttpError:
                pass  # already revoked or offline: the local token is erased anyway
        with self.lock:
            self.state['config'] = {'engineUrl': config['engineUrl'], 'email': config['email']}
        self._set_status({'state': 'unconfigured'})

    def _ensure_file(self, config, document_id, document_name, editor_title=None):
        """Creates the document's engine file if needed. editor_title is the document's name in
        LibreOffice at that moment: it serves as the baseline for detecting a later rename."""
        with self.create_lock:
            existing = self.file_id(document_id)
            if existing:
                return existing
            file = self.api('POST', '/api/files', {'document_name': document_name}, config)
            with self.lock:
                self.state['files'][document_id] = file['id']
                self.state['syncedTitles'][document_id] = editor_title or document_name
                self._save()
            return file['id']

    def create_file(self, document_id, name, editor_title):
        """Explicit creation (Certimens window); no effect if the file already exists."""
        existed = bool(self.file_id(document_id))
        return self._ensure_file(self.authed_config(), document_id, name, editor_title), existed

    def doc_info(self, document_id):
        """Engine file linked to a document (None if not yet created or deleted)."""
        file_id = self.file_id(document_id)
        if not file_id:
            return None
        try:
            return self.api('GET', f'/api/files/{file_id}')
        except HttpError as err:
            if err.status != 404:
                raise
            with self.lock:
                self.state['files'].pop(document_id, None)
                self._save()
            return None

    def assignments(self):
        """The student's assignments; none for other roles (only students submit)."""
        me = self.api('GET', '/api/auth/me')
        if me.get('role') != 'student':
            return []
        return sorted(self.api('GET', '/api/assignments') or [], key=lambda a: a['deadline'])

    def submit(self, file_id, assignment_id):
        """The engine silently ignores an assignment the student is not attached to."""
        file = self.api('PUT', f'/api/files/{file_id}', {'assignment_id': assignment_id})
        if file.get('assignment_id') != assignment_id:
            raise HttpError(403, "vous n'êtes pas rattaché à ce devoir")
        return file

    def upload_docx(self, document_id, docx_bytes):
        """Sends the .docx to the engine file (replaces the document already sent)."""
        file_id = self.file_id(document_id)
        if not file_id:
            raise HttpError(404, "créez d'abord le fichier Certimens")
        document = base64.b64encode(docx_bytes).decode('ascii')
        if len(document) > MAX_UPLOAD_BASE64:
            raise HttpError(413, 'document trop volumineux (18 Mo maximum)')
        return self.api('PUT', f'/api/files/{file_id}', {'document': document})

    def note_title(self, document_id, title):
        with self.lock:
            if not document_id or self.state['titles'].get(document_id) == title:
                return
            self.state['titles'][document_id] = title
            self._save()
        self.wake.set()

    # --- 3. QUEUE ---
    def enqueue(self, document_id, document_name, period, values):
        with self.lock:
            self.state['queue'].append({
                'id': str(uuid.uuid4()),
                'documentId': document_id,
                'documentName': document_name,
                'period': {'start': iso(period[0]), 'end': iso(period[1])},
                'values': values,
            })
            self.state['queue'] = self.state['queue'][-MAX_QUEUE:]
            self._save()
        self.wake.set()

    def _push(self, config, item):
        for _ in range(3):
            file_id = self._ensure_file(config, item['documentId'], item['documentName'])
            drop = self.state['extendedUnsupported']
            metrics = [{'type': t, 'value': v, 'period': item['period']}
                       for t, v in item['values'].items() if not (drop and t in EXTENDED_TYPES)]
            try:
                self.api('POST', f'/api/files/{file_id}/metrics', {'metrics': metrics}, config)
                return
            except HttpError as err:
                if err.status == 404:
                    # file deleted on the engine side: we recreate one for this document
                    with self.lock:
                        self.state['files'].pop(item['documentId'], None)
                        self._save()
                elif err.status == 400 and err.code == 'metric_type_unknown' and not drop:
                    # Only this code means the engine predates the extended metrics; any other
                    # 400 (an invalid period, a malformed body) must not silence them for good.
                    with self.lock:
                        self.state['extendedUnsupported'] = True
                        self._save()
                else:
                    raise

    def _sync_titles(self, config):
        """Propagates renamed documents (saved under a different name) to the engine."""
        with self.lock:
            pending = [(d, t, self.state['files'][d]) for d, t in self.state['titles'].items()
                       if d in self.state['files'] and self.state['syncedTitles'].get(d) != t]
        for document_id, title, file_id in pending:
            try:
                self.api('PUT', f'/api/files/{file_id}', {'document_name': title}, config)
            except HttpError as err:
                if err.status != 404:  # 404: file deleted, recreated on the next send
                    raise
            with self.lock:
                self.state['syncedTitles'][document_id] = title
                self._save()

    def drain(self):
        if not self._has_auth(self.config()):
            self._set_status({'state': 'unconfigured'})
            return
        try:
            config = self.authed_config()
            while True:
                with self.lock:
                    if not self.state['queue']:
                        break
                    item = self.state['queue'][0]
                try:
                    self._push(config, item)
                except HttpError as err:
                    if err.status != 400:
                        raise
                    # metric rejected by the engine: resending it would block the queue forever
                    print('Certimens: mesure rejetée', err.message)
                with self.lock:
                    self.state['queue'] = [q for q in self.state['queue'] if q['id'] != item['id']]
                    self._save()
            self._sync_titles(config)
        except HttpError as err:
            self._set_status({'state': 'auth_error', 'message': 'Identifiants refusés par le moteur.'}
                             if err.status == 401 else {'state': 'offline', 'message': err.message})
            return
        self._set_status({'state': 'synced'})

    def _run(self):
        while True:
            self.wake.wait(RETRY_S)
            self.wake.clear()
            try:
                self.drain()
            except Exception as err:  # the sending thread must never stop
                print('Certimens:', err)

    def start(self):
        threading.Thread(target=self._run, name='certimens-engine', daemon=True).start()
        self.wake.set()
