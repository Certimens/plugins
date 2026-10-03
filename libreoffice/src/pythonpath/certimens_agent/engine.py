"""Sending to the Certimens engine (the equivalent of browser/background.js), without LibreOffice.

Each document is tied to an engine document (created on the first send via POST /api/documents,
then remembered). Metrics go out to POST /api/documents/:id/metrics, authenticating as the
student with an API token (Bearer) obtained by pairing and kept in place of a password, which is
never asked for. When offline, they stay in a queue (a JSON file in the LibreOffice
profile) that is retried every minute. Sending happens on a dedicated thread: the LibreOffice
UI never waits on the network.
"""

import base64
import json
import os
import re
import tempfile
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from datetime import datetime, timezone

from .i18n import set_language, t
from .log import warn

DEFAULT_ENGINE_URL = 'https://monespace.certimens.fr'
# What changed, for the student who finds the agent different from yesterday. Declared by each
# agent in its own engine client, and compared by `make check`.
RELEASE_NOTES_URL = 'https://github.com/certimens/plugins/releases'
RETRY_S = 60
# Added to the pairing interval each time the engine answers "too often" (RFC 8628 slow_down, or
# the rate limiter in front of it): asking at the same pace would only be refused again.
SLOW_DOWN_S = 5
MAX_QUEUE = 5000
TIMEOUT_S = 30
# The engine caps a request body at 25 MiB; in base64 the .docx grows by a third.
MAX_UPLOAD_BASE64 = 24 * 1024 * 1024
# Metrics some deployed engines don't know, **newest generation first**: a 400
# "metric_type_unknown" drops one generation and the window is sent again, rather than dropping
# everything the engine was never asked about. An engine that knows the older generations but
# not the newest keeps receiving the ones it reads.
EXTENDED_GENERATIONS = [
    ('self_paste_chars_total', 'lexical_hesitations', 'keystrokes_after_return'),
    ('self_paste_events', 'injected_chars_max', 'injected_chars_after_return'),
    ('paste_events', 'focus_losses', 'flight_median_ms'),
]


def dropped_types(dropped):
    """The types no longer sent, once `dropped` generations have been refused."""
    return {metric for generation in EXTENDED_GENERATIONS[:dropped] for metric in generation}


def installed_version():
    """The version of the installed extension, read from the description.xml beside us.

    Of the four agents this is the only one whose version its own code cannot see: a browser
    hands its manifest over, VS Code hands over its packageJSON, the Word pane is served with
    its build written into the page. Here, the number lives in the package manifest two folders
    up — `pythonpath/certimens_agent/` is inside the extension — and build.py is what writes it
    in.

    A checkout, where that manifest still holds the `{{VERSION}}` placeholder, has no version to
    speak of and says '': nothing is announced to whoever is running the agent from source.
    """
    try:
        manifest = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..', 'description.xml')
        with open(manifest, encoding='utf-8') as f:
            found = re.search(r'<version value="([^"]+)"', f.read())
    except OSError:
        return ''
    version = found.group(1) if found else ''
    return '' if '{' in version else version


class HttpError(Exception):
    def __init__(self, status, message, code=''):
        super().__init__(message)
        self.status = status
        self.message = message
        # The engine names the rule that refused the request ({"code", "error"}).
        self.code = code


def iso(timestamp):
    return datetime.fromtimestamp(timestamp, timezone.utc).isoformat(timespec='milliseconds').replace('+00:00', 'Z')


def now_iso():
    return datetime.now(timezone.utc).isoformat(timespec='milliseconds').replace('+00:00', 'Z')


def trim_url(url):
    return url.rstrip('/')


# Refuses to open a symbolic link, which is how a file of ours could be made to write somewhere
# else entirely. Windows has neither the flag nor the trick, and `getattr` is what keeps this
# module importable there: 0 adds nothing to the mode.
O_NOFOLLOW = getattr(os, 'O_NOFOLLOW', 0)


# --- WHERE THE TOKEN MAY TRAVEL ---
#
# The student can point the agent at another engine, and that address decides where an API token
# **that never expires** is sent. Over `http:` it crosses the network in the clear, and a token
# read once is a token kept. Refusing `http:` outright would break the deployment it exists for
# — an establishment serving its engine on its own intranet — so the rule is about the host:
# plain `http:` is accepted exactly where the request cannot leave the building. A single label
# (`moteur`), but not an all-digit one; localhost and `127.0.0.0/8` or `::1`; `*.local`; the
# private ranges and IPv6 unique local. Everything else must be `https:`.
#
# **The four agents hold this pattern character for character** — `browser/src/constants.js`
# carries the long version of this comment, and `make check` compares the four.
LOCAL_ENGINE_HOST = re.compile(r'^(?:(?!\d+$)[^.:]+|(?:.+\.)?local|(?:.+\.)?localhost|127\.\d+\.\d+\.\d+|::1|10\.\d+\.\d+\.\d+|172\.(?:1[6-9]|2\d|3[01])\.\d+\.\d+|192\.168\.\d+\.\d+|f[cd][0-9a-f]{2}:.*)$', re.IGNORECASE)  # noqa: E501 — one line, because `make check` compares it to the three other agents character for character; wrapped, it would be four patterns that only look alike


def engine_url_allowed(raw_url):
    """Whether an engine address may be used at all: https anywhere, http only on a local host.

    The three JavaScript agents hand the address to `new URL`, which refuses what is not one;
    `urlparse` accepts almost anything and leaves `hostname` empty, so emptiness is the refusal
    here. It raises on control characters in the authority, which is a refusal too.

    `fullmatch` and not `match`: in Python a trailing `$` also matches before a final newline,
    and the pattern is shared with JavaScript, where it does not.
    """
    try:
        parsed = urllib.parse.urlparse(str(raw_url or '').strip())
    except ValueError:
        return False
    if not parsed.hostname:
        return False
    if parsed.scheme == 'https':
        return True
    if parsed.scheme != 'http':
        return False
    return bool(LOCAL_ENGINE_HOST.fullmatch(parsed.hostname))


class SafeRedirect(urllib.request.HTTPRedirectHandler):
    """Drops the Authorization header when a redirect leaves the origin it was meant for.

    `fetch` does this of its own accord, which is why the three JavaScript agents never had to
    think about it. `urllib` does not: its redirect handler copies every header but
    Content-Length and Content-Type onto the new request, so a redirect — to another host, or
    from https down to plain http — carries the student's API token with it. That token has no
    expiry, so one that leaks is one somebody keeps.

    The redirect itself is still followed; only the credential stays behind.
    """

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        new = super().redirect_request(req, fp, code, msg, headers, newurl)
        if new is None:
            return None
        before = urllib.parse.urlparse(req.full_url)
        after = urllib.parse.urlparse(newurl)
        if (before.scheme, before.netloc) != (after.scheme, after.netloc):
            # add_header capitalizes what it stores, so the key is 'Authorization'.
            new.headers.pop('Authorization', None)
        return new


# One opener for every call this agent makes, so the rule above cannot be bypassed by reaching
# for urlopen.
OPENER = urllib.request.build_opener(SafeRedirect)


def verification_uri(value, engine_url):
    """The address the engine says to open, kept only if it is one worth handing to a browser.

    It is a string from a server whose address the student is free to change, and the three other
    agents put it in an `href` or in the editor's `openExternal`. This one only ever shows it as
    text, so the risk is theirs and not its own — but the rule belongs to all four, and the one
    place a window of this agent does open an address, `SystemShellExecute`, is given URIS_ONLY
    for the same reason.

    A refusal falls back to the engine's own device page: the pairing is still valid, only the
    shortcut is lost.
    """
    if value and urllib.parse.urlparse(value).scheme in ('http', 'https'):
        return value
    return engine_url + '/device'


# Refusals the agent words itself instead of passing on the engine's sentence. The engine names
# the rule it applied and answers in English — the only language its fallback messages have — so
# a code it can act on is reworded here, once, for every call that may meet it.
REWORDED = {
    'deadline_passed': 'error.deadlinePassed',
    # The two ends of a pairing that will not complete. Passed on as they come, the student would
    # read the engine's English sentence at the one moment they are waiting on a screen.
    'device_code_expired': 'pair.expired',
    'device_denied': 'pair.denied',
}


def _file_exists(url):
    """Whether a file URL still names something on disk. A URL this agent cannot read as a path
    is treated as present, so a document on a remote share is never silently re-bound."""
    if not url.startswith('file://'):
        return True
    try:
        return os.path.exists(urllib.request.url2pathname(urllib.parse.urlparse(url).path))
    except Exception:  # an unreadable URL is not a reason to split a record
        return True


class Engine:
    def __init__(self, state_path):
        self.path = state_path
        self.lock = threading.RLock()
        # The Certimens window and the sending thread can both create the file for the same
        # document: one at a time, otherwise the engine would end up with two.
        self.create_lock = threading.Lock()
        self.wake = threading.Event()
        self.listeners = []
        # How many windows at the head of the queue have already reached the engine, since the
        # last full write of the state. See `_save_cursor`.
        self.queue_sent = 0
        self.state = self._load()
        # A cursor found at startup has just been folded into the queue: writing the state back
        # is what makes that permanent and clears it. Reading it twice would drop windows.
        if self._read_cursor():
            self._save()

    # --- 1. STORAGE ---
    def _load(self):
        state = {'config': {}, 'engineIds': {}, 'engineSources': {}, 'titles': {}, 'syncedTitles': {},
                 'queue': [], 'status': {'state': 'idle'}, 'extendedDropped': 0, 'paused': False}
        try:
            with open(self.path, encoding='utf-8') as f:
                stored = json.load(f)
            state.update(stored)
            # A profile written before generations existed carries a boolean instead, which meant
            # "everything known then": the first generation, which is the last of the list. It is
            # looked for in the file and not in `state`, whose default would hide its absence.
            if 'extendedDropped' not in stored:
                state['extendedDropped'] = len(EXTENDED_GENERATIONS) if stored.get('extendedUnsupported') else 0
        except (OSError, ValueError):
            pass
        # A drain interrupted between two sends left its cursor beside the state: what it counts
        # has already reached the engine and must not be sent again.
        sent = self._read_cursor()
        if sent:
            state['queue'] = state['queue'][sent:]
        return state

    @property
    def _cursor_path(self):
        return self.path + '.sent'

    def _read_cursor(self):
        try:
            with open(self._cursor_path, encoding='utf-8') as f:
                return max(0, int(f.read().strip() or 0))
        except (OSError, ValueError):
            return 0

    def _save_cursor(self, sent):
        """Record how far the queue has been pushed, in a file of its own.

        The state is a single JSON document, so writing anything in it rewrites the queue along
        with it — a full queue is megabytes, and the drain used to pay that once per window: a
        day caught up offline wrote the whole file five thousand times over. This number is the
        one thing that has to be written *between* two sends — without it a window could be
        pushed twice — so it is the one thing that lives beside the state rather than inside it.

        It is only ever read at startup: `_save` compacts the queue and clears it.
        """
        self.queue_sent = sent
        fd = os.open(self._cursor_path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC | O_NOFOLLOW, 0o600)
        with os.fdopen(fd, 'w', encoding='utf-8') as f:
            f.write(str(sent))

    def _compact(self):
        """Drop what has already been pushed, and forget the cursor with it."""
        if self.queue_sent:
            self.state['queue'] = self.state['queue'][self.queue_sent:]
            self.queue_sent = 0

    def _save(self):
        # A full write is paid in full, so it is also where the queue is compacted.
        self._compact()
        # The file holds the student's API token: it is created 0600 up front, never chmod-ed
        # after the fact, so it is not briefly world-readable under the process umask. It is
        # written beside its destination and renamed over it, so a reader sees the old state or
        # the new one and never half of either.
        #
        # `mkstemp` rather than a `.tmp` of our own: it creates the file with O_EXCL, 0600 and a
        # name nobody can guess. A fixed name could be waiting there already — a symbolic link,
        # or a file somebody left 0666 — and O_CREAT alone opens what it finds without touching
        # its mode, which would put the token wherever the link points, or leave it readable by
        # everyone on the machine. The 0600 above would then have protected nothing.
        fd, tmp = tempfile.mkstemp(dir=os.path.dirname(self.path) or '.',
                                   prefix='.certimens-', suffix='.tmp')
        try:
            with os.fdopen(fd, 'w', encoding='utf-8') as f:
                json.dump(self.state, f)
            os.replace(tmp, self.path)
        finally:
            # Nothing left after a rename; still there when the write threw, and a temporary
            # per failure would pile up in the profile of a student with a full disk.
            if os.path.exists(tmp):
                try:
                    os.unlink(tmp)
                except OSError:
                    pass
        # The state on disk now starts where the cursor pointed: a stale one would drop windows
        # at the next start.
        try:
            os.remove(self._cursor_path)
        except OSError:
            pass

    def config(self):
        # token: API token (Bearer) obtained by pairing — no password is ever asked for, so none is
        # never stored. tokenId: its identifier, used to revoke the token at logout.
        with self.lock:
            # language: the account's own, sent by the engine at login, so every window opens in
            # the language the student chose in their Certimens space.
            return {'engineUrl': DEFAULT_ENGINE_URL, 'email': '', 'token': '', 'tokenId': '',
                    'language': '', **self.state['config']}

    @staticmethod
    def _has_auth(config):
        return bool(config.get('token'))

    def status(self):
        with self.lock:
            # What is still waiting: the array keeps the windows already pushed at its head
            # until the next full write compacts it.
            return dict(self.state['status']), len(self.state['queue']) - self.queue_sent

    def logged_in(self):
        return self._has_auth(self.config()) and self.status()[0]['state'] != 'auth_error'

    def measuring(self):
        """The one question every sensor handler asks before counting.

        Measurement belongs to a session. Signing out revokes the token, and what the student
        writes afterwards is nobody's to send: the queue would hold it for whichever account
        pairs next. A suspension and a sign-out stop the same thing for different reasons, and a
        handler that remembers only one of them is how both shipped.
        """
        return not self.paused() and self._has_auth(self.config())

    def paused(self):
        """Whether the measurement is suspended. Held here because it is shared by every open
        document, and persisted because a suspension that quietly lifted itself at the next start
        would be worse than none: the student would believe they are measured when they are not.

        It suspends the *measurement*, not the sending — the queue keeps draining, since what was
        measured before the pause is already the engine's."""
        with self.lock:
            return bool(self.state['paused'])

    def updated_version(self, version):
        """The version to announce, or '' when there is nothing to say.

        LibreOffice is the only host of the four that updates an extension **because the
        student asked it to**: the others do it in the background. The line is said all the
        same, and for the same reason — it carries the link to what changed, which no extension
        manager shows once the update is installed.

        **A profile that has never written the key has just installed the agent, not updated
        it**: the version is recorded in silence, and the first notice is the one after the
        *next* update. That also covers every student already running the extension the day
        this ships.
        """
        if not version:
            return ''
        with self.lock:
            seen = self.state.get('seenVersion', '')
            if seen == version:
                return ''
            self.state['seenVersion'] = version
            self._save()
        return version if seen else ''

    def set_paused(self, paused):
        with self.lock:
            self.state['paused'] = bool(paused)
            self._save()
        for listener in list(self.listeners):
            listener()

    def engine_id(self, document_id):
        with self.lock:
            return self.state['engineIds'].get(document_id)

    def _set_status(self, status):
        with self.lock:
            self.state['status'] = {**status, 'at': now_iso()}
            self._save()
        for listener in list(self.listeners):
            listener()

    # --- 2. ENGINE API ---
    def _request(self, method, url, body=None, token=None):
        # The engine address is typed by the student, and urlopen would happily open a file://
        # path or speak ftp with it. The three other agents go through fetch, which cannot
        # leave http(s): this keeps the Python one on the same footing (hence the noqa below —
        # the scheme is checked right here). It also refuses plain `http:` to a host outside
        # the building, which is where the token would travel in the clear; the window refuses
        # it earlier and with a sentence on screen, and this is the floor under it.
        if not engine_url_allowed(url):
            raise HttpError(0, t('error.engineUrlInsecure'), 'engine_url_refused')
        data = None if body is None else json.dumps(body).encode('utf-8')
        req = urllib.request.Request(url, data=data, method=method)  # noqa: S310
        req.add_header('Content-Type', 'application/json')
        if token:
            req.add_header('Authorization', 'Bearer ' + token)
        try:
            with OPENER.open(req, timeout=TIMEOUT_S) as res:
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
            if code in REWORDED:
                message = t(REWORDED[code])
            raise HttpError(err.code, str(message), code) from err
        except (urllib.error.URLError, OSError) as err:
            raise HttpError(0, str(getattr(err, 'reason', err))) from err

    def api(self, method, path, body=None, config=None):
        config = config or self.config()
        return self._request(method, trim_url(config['engineUrl']) + path, body, config['token'])

    def start_pairing(self, engine_url):
        """Open an authorization and return what to show, plus what to poll with.

        No password is asked for, here or in the window. An account that signs in through
        Google, through its establishment's provider or from a Moodle launch has none at all,
        and a password box inside an office extension is the exact shape a counterfeit agent
        would take. The student reads a short code, confirms it in their Certimens space, and
        this agent is handed an API token.
        """
        url = trim_url(engine_url or DEFAULT_ENGINE_URL)
        res = self._request('POST', url + '/api/auth/device', {'client': t('pair.clientWriter')})
        return {
            'engineUrl': url,
            'deviceCode': res['device_code'],
            'userCode': res['user_code'],
            'verificationUri': verification_uri(res.get('verification_uri'), url),
            'verificationUriComplete': verification_uri(
                res.get('verification_uri_complete') or res.get('verification_uri'), url),
            'expiresAt': time.time() + res.get('expires_in', 600),
            'interval': res.get('interval', 5),
        }

    def poll_pairing(self, pairing):
        """Ask once. Returns the API token, or None while nobody has confirmed yet.

        Every other refusal is raised: an expired code and a refused one each mean something the
        student has to be told, and a window that treated them as "keep waiting" would spin
        until the end of time.
        """
        try:
            res = self._request('POST', trim_url(pairing['engineUrl']) + '/api/auth/device/token',
                                {'device_code': pairing['deviceCode']})
        except HttpError as err:
            # Nobody has confirmed yet, or we asked again too soon: both are "keep waiting". A
            # 429 says the same thing from the layer in front of the engine — the exchange is
            # alive on the other side, and this machine is one caller too many on this address.
            # Either way the next attempt waits five seconds longer, as RFC 8628 has it.
            if err.code == 'device_slow_down' or err.status == 429:
                pairing['interval'] += SLOW_DOWN_S
                return None
            if err.code == 'device_authorization_pending':
                return None
            raise
        return res['token']

    def adopt_token(self, engine_url, token):
        """Complete a pairing: read who the token belongs to, and keep it in place of a password."""
        url = trim_url(engine_url or DEFAULT_ENGINE_URL)
        me = self._request('GET', url + '/api/auth/me', None, token)
        tokens = self._request('GET', url + '/api/auth/tokens', None, token)
        # The id of this very token, so signing out revokes it; the engine never returns a raw
        # token twice, so it is found by being the newest one.
        token_id = tokens[0]['id'] if tokens else ''
        # From here on every window speaks the account's language, not the editor's.
        set_language(me.get('language'))
        # Signing in again as somebody else, without signing out first, leaves exactly the
        # residue a sign-out would have cleared — and no gesture forbids it. Same door.
        previous = (self.config().get('email') or '')
        if previous and previous != (me.get('email') or ''):
            self._clear_account_state()
        with self.lock:
            # displayName: the engine computes it, falling back to the e-mail when the account
            # carries no name. An engine too old to send it leaves it empty, and the window
            # falls back to the e-mail on its own.
            self.state['config'] = {'engineUrl': url,
                                    'email': me.get('email') or '', 'token': token,
                                    'displayName': me.get('display_name') or '',
                                    'tokenId': token_id, 'language': me.get('language') or ''}
            # A new engine may well know the extended metrics the previous one refused.
            self.state['extendedDropped'] = 0
        self._set_status({'state': 'idle'})  # clears any auth_error before the next send
        self.wake.set()
        return me

    def logout(self):
        config = self.config()
        # The windows still open belong to the session that is ending: they are sealed and sent
        # while the token that measured them is still valid, because what is cleared below is
        # cleared for good. One left in the queue would otherwise be sent under the next
        # account's bearer, towards this account's documents.
        try:
            self.drain()
        except Exception:  # offline, or the engine refused: nothing must outlive the token
            pass
        # Whether the engine really destroyed the credential, rather than whether we tried. The
        # local erase happens either way, but a student told their token was revoked when it is
        # still live has been told the one thing that would have made them act.
        revoked = False
        if config.get('token') and config.get('tokenId'):
            try:
                self.api('DELETE', '/api/auth/tokens/%s' % config['tokenId'], config=config)
                revoked = True
            except HttpError:
                pass  # offline, or already revoked: said as it is, by the caller
        self._clear_account_state()
        with self.lock:
            self.state['config'] = {'engineUrl': config['engineUrl'],
                                    'language': config.get('language', '')}
            self._save()
        self._set_status({'state': 'unconfigured'})
        return revoked

    def _clear_account_state(self):
        """Everything the revoked token authorised on this installation, as opposed to the token
        itself.

        Revoking ends what the credential can do at the engine; this ends what it left behind
        here. The map, the titles it synced and a queued window all outlive it otherwise, and the
        next account to pair inherits them and sends them under its own bearer — towards the
        previous student's engine documents, under the new student's own credential, with
        neither of them told.

        `config` is not cleared here: its engine address and language are kept, so the next
        pairing starts where this one did rather than from nothing.
        """
        with self.lock:
            self.state['engineIds'] = {}
            self.state['titles'] = {}
            self.state['syncedTitles'] = {}
            self.state['queue'] = []
            self.state['extendedDropped'] = 0
            self.state.pop('extendedUnsupported', None)
            # A suspension is one student's choice about their own measurement. The next account
            # must not start silently suspended by it.
            self.state['paused'] = False
            self.queue_sent = 0
            self._save()

    def _ensure_document(self, config, document_id, document_name, editor_title=None, source=''):
        """Creates the document's engine document if needed. editor_title is the document's name in
        LibreOffice at that moment: it serves as the baseline for detecting a later rename.
        source is the file the identity was read from, recorded so that no other file can later
        present the same identity and be handed this engine document."""
        with self.create_lock:
            existing = self.engine_id(document_id)
            if existing:
                return existing
            file = self.api('POST', '/api/documents', {'name': document_name}, config)
            with self.lock:
                self.state['engineIds'][document_id] = file['id']
                if source:
                    self.state.setdefault('engineSources', {})[document_id] = source
                self.state['syncedTitles'][document_id] = editor_title or document_name
                self._save()
            return file['id']

    def binds(self, document_id, source):
        """Whether this identity may be used for this file.

        The identity travels inside the document, so two files can carry the same one with no
        attacker anywhere: a copy kept beside the original, a version saved under another name, a
        draft a corrector edited and sent back. Nothing in the engine can see the collision —
        the creation call carries a name and the local identity never crosses the wire — so the
        refusal has to live here, and the caller mints a fresh identity for the second file so
        that the link prompt is offered rather than skipped.

        A document that has never been saved has no file to bind to, and an identity nothing has
        mapped yet binds to whichever file presents it first. A mapping made before this rule
        existed has no recorded file either: the first document to open after the update claims
        it, which is the only migration that does not re-link everything a student already has.
        """
        if not source:
            return True
        with self.lock:
            if document_id not in self.state['engineIds']:
                return True
            sources = self.state.setdefault('engineSources', {})
            bound = sources.get(document_id)
            if bound == source:
                return True
            if bound is None or not _file_exists(bound):
                # Either the mapping predates this rule, or the file it was created for is no
                # longer where it was: a rename or a move, which must keep one record rather
                # than split it in two.
                sources[document_id] = source
                self._save()
                return True
            return False

    def create_file(self, document_id, name, editor_title, source=''):
        """Explicit creation (Certimens window); no effect if the file already exists."""
        existed = bool(self.engine_id(document_id))
        return self._ensure_document(self.config(), document_id, name, editor_title, source), existed

    def doc_info(self, document_id):
        """Engine file linked to a document (None if not yet created or deleted)."""
        engine_id = self.engine_id(document_id)
        if not engine_id:
            return None
        try:
            return self.api('GET', f'/api/documents/{engine_id}')
        except HttpError as err:
            if err.status != 404:
                raise
            with self.lock:
                self.state['engineIds'].pop(document_id, None)
                self._save()
            return None

    def assignments(self):
        """The student's assignments; none for other roles (only students submit)."""
        me = self.api('GET', '/api/auth/me')
        if me.get('role') != 'student':
            return []
        return sorted(self.api('GET', '/api/assignments') or [], key=lambda a: a['deadline'])

    def submit(self, engine_id, assignment_id):
        """The engine silently ignores an assignment the student is not attached to."""
        file = self.api('PUT', f'/api/documents/{engine_id}', {'assignment_id': assignment_id})
        if file.get('assignment_id') != assignment_id:
            raise HttpError(403, t('error.notEnrolled'))
        return file

    def upload_docx(self, document_id, docx_bytes):
        """Sends the .docx to the engine document (replaces the document already sent)."""
        engine_id = self.engine_id(document_id)
        if not engine_id:
            raise HttpError(404, t('error.noFile'))
        document = base64.b64encode(docx_bytes).decode('ascii')
        if len(document) > MAX_UPLOAD_BASE64:
            raise HttpError(413, t('error.tooLarge'))
        return self.api('PUT', f'/api/documents/{engine_id}', {'document': document})

    def note_title(self, document_id, title):
        with self.lock:
            if not document_id or self.state['titles'].get(document_id) == title:
                return
            self.state['titles'][document_id] = title
            self._save()
        self.wake.set()

    # --- 3. QUEUE ---
    def enqueue(self, document_id, document_name, period, values, flush=None, source=''):
        with self.lock:
            # A window written while the engine was out of reach is stamped here, once, at the
            # moment it is queued — not when it finally leaves. What tells us is our own last
            # attempt; there is no "am I online" worth trusting from inside LibreOffice.
            item = {
                'id': str(uuid.uuid4()),
                'documentId': document_id,
                'documentName': document_name,
                # The file this identity was read from, so the engine document created for the
                # window is bound to it and no other file can later be handed the same one.
                'documentSource': source,
                'period': {'start': iso(period[0]), 'end': iso(period[1])},
                'values': values,
            }
            if self.state['status'].get('state') == 'offline':
                item['offline'] = True
            if flush:
                item['flush'] = flush
            # Compacted before the cap applies, so the cap counts what is waiting and not what
            # has already left.
            self._compact()
            self.state['queue'].append(item)
            self.state['queue'] = self.state['queue'][-MAX_QUEUE:]
            self._save()
        self.wake.set()

    def _push(self, config, item):
        # One attempt per generation that may have to be dropped, plus one for a document
        # recreated after a 404, plus the first.
        for _ in range(len(EXTENDED_GENERATIONS) + 2):
            engine_id = self._ensure_document(config, item['documentId'], item['documentName'],
                                              source=item.get('documentSource', ''))
            with self.lock:
                dropped = self.state['extendedDropped']
            refused = dropped_types(dropped)
            # The engine accepts one exact shape for a measurement: {type, value, period}, with
            # `offline` appended when — and only when — the window was written while the engine
            # was out of reach, and `reason` last, which says which trigger sealed the window.
            # json.dumps keeps insertion order, so this order is what is sent. The period is
            # rebuilt key by key rather than forwarded as it arrives: the item was read back
            # from the profile on disk, and the order its keys come back in is the file's, not
            # this code's. Changing this shape is a change of contract, settled on the engine's
            # side first.
            #
            # `reason` is left out rather than sent empty for a window queued before this agent
            # knew how to say it: a missing key is an agent that did not say, an empty one is a
            # word the engine's vocabulary does not hold.
            extra = {'offline': True} if item.get('offline') else {}
            if item.get('flush'):
                extra['reason'] = item['flush']
            period = {'start': item['period']['start'], 'end': item['period']['end']}
            metrics = [{'type': metric, 'value': value, 'period': period, **extra}
                       for metric, value in item['values'].items()
                       if metric not in refused]
            try:
                self.api('POST', f'/api/documents/{engine_id}/metrics', {'metrics': metrics}, config)
                return
            except HttpError as err:
                if err.status == 404:
                    # file deleted on the engine side: we recreate one for this document
                    with self.lock:
                        self.state['engineIds'].pop(item['documentId'], None)
                        self._save()
                elif (err.status == 400 and err.code == 'metric_type_unknown'
                      and dropped < len(EXTENDED_GENERATIONS)):
                    # Only this code means the engine predates one generation of metrics; any
                    # other 400 (an invalid period, a malformed body) must not silence them for
                    # good.
                    with self.lock:
                        self.state['extendedDropped'] += 1
                        self._save()
                else:
                    raise

    def _sync_titles(self, config):
        """Propagates renamed documents (saved under a different name) to the engine."""
        with self.lock:
            pending = [(document_id, title, self.state['engineIds'][document_id])
                       for document_id, title in self.state['titles'].items()
                       if document_id in self.state['engineIds']
                       and self.state['syncedTitles'].get(document_id) != title]
        for document_id, title, engine_id in pending:
            try:
                self.api('PUT', f'/api/documents/{engine_id}', {'name': title}, config)
            except HttpError as err:
                # 404: file deleted, recreated on the next send. deadline_passed: the copy is
                # frozen, so this rename will not land — noting it as synced anyway is what
                # stops it being retried at every drain, and the sending status going red over
                # a refusal nobody here can act on. A rename made after the teacher pushes the
                # deadline does go through; this one stays as it was when the window shut.
                if err.status != 404 and err.code != 'deadline_passed':
                    raise
            with self.lock:
                self.state['syncedTitles'][document_id] = title
                self._save()

    def drain(self):
        if not self._has_auth(self.config()):
            self._set_status({'state': 'unconfigured'})
            return
        try:
            config = self.config()
            while True:
                with self.lock:
                    if self.queue_sent >= len(self.state['queue']):
                        break
                    item = self.state['queue'][self.queue_sent]
                try:
                    self._push(config, item)
                except HttpError as err:
                    if err.status != 400:
                        raise
                    # metric rejected by the engine: resending it would block the queue forever
                    warn('measurement rejected', err.message)
                # The cursor moves before the next send, so nothing is ever pushed twice — and
                # it is a number in a file of its own, so this write does not carry the queue.
                with self.lock:
                    self._save_cursor(self.queue_sent + 1)
            # Everything waiting has left: the state is written once, which compacts the queue
            # and clears the cursor. On a failure above, the status write does the same.
            if self.queue_sent:
                with self.lock:
                    self._save()
            self._sync_titles(config)
        except HttpError as err:
            self._set_status({'state': 'auth_error', 'message': t('sync.auth_error')}
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
                warn('envoi interrompu', err)

    def start(self):
        threading.Thread(target=self._run, name='certimens-engine', daemon=True).start()
        self.wake.set()
