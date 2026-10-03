"""Sending to the Certimens engine (the equivalent of browser/background.js), without LibreOffice.

Each document is tied to an engine document (created on the first send via POST /api/documents,
then remembered). Measurements go out to POST /api/documents/:id/metrics as the windows of a
session, numbered by the sensor that sealed them (measure.py), authenticating as the student
with an API token (Bearer) obtained by pairing and kept in place of a password, which is never
asked for. There is one body and the engine either reads it or refuses it: nothing here adapts
a window to the engine that answers. When offline, they stay in a queue (a JSON file in the LibreOffice
profile) that is retried every minute. Sending happens on a dedicated thread: the LibreOffice
UI never waits on the network. The same file and the same thread carry the counters the agent
keeps about itself (TELEMETRY_EVENTS), sent at most every TELEMETRY_FLUSH_S.
"""

import base64
import json
import os
import platform
import re
import socket
import tempfile
import threading
import time
import traceback
import urllib.error
import urllib.parse
import urllib.request
import uuid
from datetime import datetime, timezone
from numbers import Real

from .i18n import language, set_language, t
from .log import warn

DEFAULT_ENGINE_URL = 'https://monespace.certimens.fr'
# What changed, for the student who finds the agent different from yesterday. Declared by each
# agent in its own engine client, and compared by `make check`.
RELEASE_NOTES_URL = 'https://github.com/certimens/plugins/releases'
RETRY_S = 60
# Added to the pairing interval each time the engine answers "too often" (RFC 8628 slow_down, or
# the rate limiter in front of it): asking at the same pace would only be refused again.
SLOW_DOWN_S = 5
# What the engine says of its own pairing, bounded: (lowest, highest), in seconds.
PAIRING_INTERVAL_S = (1, 60)
PAIRING_EXPIRES_S = (30, 1800)
MAX_QUEUE = 5000
TIMEOUT_S = 30
# The engine caps a request body at 25 MiB; in base64 the .docx grows by a third.
MAX_UPLOAD_BASE64 = 24 * 1024 * 1024
# The shape of an engine document id, as it goes into an API path. Every other id this agent
# handles was handed to it by the engine; this one is read out of the document, where whoever
# produced or last held the file could have written anything. A slash or a `..` in it would no
# longer be an id: it would be another route, called with the student's token. The agents that
# read one share this shape, and `make check` compares them.
ENGINE_ID = re.compile(r'^[A-Za-z0-9_-]{1,64}$')
# How many windows one request may carry. A window pushed live leaves alone; only a queue that
# waited offline is caught up in batches, one session at a time.
BATCH_MAX_WINDOWS = 64
# The refusals that are about the window itself: sending it again would be refused again, and
# would hold everything queued behind it. 400 is a body the engine does not read; 409 is a
# number the engine already holds for this session with another instant or another duration.
REFUSED_FOR_GOOD = (400, 409)
# The keys of a window, in the order they are sent, and those of its blocks. The order is the
# contract at every level but `counts`, and a key the window does not have is left out.
WINDOW_INSTANTS = ('seq', 'at', 'mono', 'ms')
COUNTS = ('corrections', 'reformulations', 'revisions', 'jumps', 'exits', 'back_keys', 'back_chars')
TEXT_SPAN = ('since', 'at', 'cut', 'add')
SUM = ('keys', 'chars', 'pastes')
# How many values a run has, by kind: n keystrokes over a duration, a gesture and its quantity,
# or a silence and its length.
RUN_SIZES = {'type': 3, 'erase': 3, 'nav': 3, 'other': 3,
             'move': 2, 'click': 2, 'paste': 2, 'self': 2, 'copy': 2, 'undo': 2, 'fix': 2,
             'gap': 2}

# --- WHAT THIS AGENT SAYS ABOUT ITSELF ---
#
# Counters of a closed vocabulary, kept in the state file beside the queue and sent to
# POST /api/plugins/telemetry, so that the people maintaining the agents see a regression before a
# student reports it (docs/moteur.md, "Ce que l'agent dit de lui-même"). What leaves is an object
# of counts, plus where this extension's own code broke (`fault_of`): never a message, a URL or a
# document name — the text of an exception raised in a writing tool can quote what the student
# wrote. What is counted is one of these words, never a string formed at run time.
#
# The four agents declare the same words in the same order, the same cap and the same period;
# `make check` compares them with each other and with the table of docs/moteur.md. This one
# counts in seconds, like the rest of its constants: TELEMETRY_FLUSH_S is the JavaScript
# agents' TELEMETRY_FLUSH_MS.
TELEMETRY_EVENTS = (
    'installed', 'updated', 'started',
    'error.runtime', 'error.engine', 'error.rejected', 'error.auth',
    'network.failure', 'queue.dropped',
)
TELEMETRY_FLUSH_S = 15 * 60
# Each count stops here: the engine would clip it anyway, and a loop that fails on every key
# must not grow a number without end.
TELEMETRY_MAX_COUNT = 10000
TELEMETRY_PATH = '/api/plugins/telemetry'
# Where the code broke, beside the counts: at most this many distinct faults are kept between two
# sends (a fault past them is still counted as error.runtime, just not located — the first ten of
# a broken build say where it breaks), each with at most this many frames, innermost first.
TELEMETRY_MAX_FAULTS = 10
TELEMETRY_MAX_FRAMES = 12
FAULT_TYPE = re.compile(r'^[A-Za-z][A-Za-z0-9]{0,47}$')
FAULT_FILE = re.compile(r'^[A-Za-z0-9_-]{1,64}\.py$')
FAULT_FUNCTION = re.compile(r'^[A-Za-z_$<][A-Za-z0-9_$.<>]{0,79}$')
FAULT_FRAME = re.compile(r'^(?:[A-Za-z_$<][A-Za-z0-9_$.<>]{0,79}@)?[A-Za-z0-9_-]{1,64}\.py:[1-9][0-9]{0,6}$')
# The directories whose files are this extension's: this package, and the one holding the
# registered component (src/certimens.py, two levels up). A frame anywhere else — the standard
# library, LibreOffice's own Python, another extension in the same interpreter — is not ours.
_HERE = os.path.dirname(os.path.realpath(__file__))
OWN_DIRS = tuple({os.path.normcase(_HERE), os.path.normcase(os.path.dirname(os.path.dirname(_HERE)))})
# The answers that let the counts go without being sent again: 400 and 413 say the body is wrong
# and sending it again will not fix it; 401 says the token is gone. Only 204 means they arrived.
TELEMETRY_ABANDONED = (400, 401, 413)


def valid_engine_id(value):
    """Whether a value may be used as an engine document id."""
    return isinstance(value, str) and ENGINE_ID.match(value) is not None


def whole(value):
    """A number as the engine expects to read it: a whole one is never written `20.0`, and
    nothing that is not a number passes for one."""
    if isinstance(value, bool) or not isinstance(value, Real):
        raise TypeError('not a number')
    return int(value) if isinstance(value, float) and value.is_integer() else value


def count(value):
    """A whole number, zero or more — an instant, a duration, a quantity."""
    if isinstance(value, bool) or not isinstance(value, int) or value < 0:
        raise ValueError('not a count')
    return value


def wire_window(stored):
    """A queued window as it is sent: every key in the order of the contract.

    The window was built in that order by the sensor, but it comes back from the profile on
    disk, and the order its keys come back in is the file's, not this code's: every level is
    rebuilt key by key. A block the window does not have is left out, never sent empty;
    `offline` sits between the reason and the effective time, and only when it is true.

    Raises when the entry is not a window of this shape — a profile left by another build of
    the agent, or a file somebody edited. Such an entry is dropped, never sent or repaired
    (see Engine._load).
    """
    window = {name: count(stored[name]) for name in WINDOW_INSTANTS}
    if not isinstance(stored['why'], str):
        raise TypeError('a window that does not say why it was sealed')
    window['why'] = stored['why']
    if stored.get('offline'):
        window['offline'] = True
    window['active'] = count(stored['active'])
    runs = []
    for run in stored['runs']:
        kind = run[0]
        if len(run) != RUN_SIZES[kind]:
            raise ValueError('a run that does not have the shape of its kind')
        runs.append([kind, *(count(value) for value in run[1:])])
    if not runs:
        raise ValueError('a window without a timeline')
    window['runs'] = runs
    # The one level whose order the contract leaves free: it is written in one order all the
    # same, so that two sendings of one window are the same bytes.
    window['counts'] = {name: count(stored['counts'][name]) for name in COUNTS
                        if name in stored['counts']}
    if 'flight' in stored:
        flight = stored['flight']
        window['flight'] = {'med': whole(flight['med']), 'mad': whole(flight['mad']),
                            'bins': [count(value) for value in flight['bins']]}
    if 'dwell' in stored:
        dwell = stored['dwell']
        window['dwell'] = {'bins': [count(value) for value in dwell['bins']],
                           'rollover': count(dwell['rollover'])}
    if 'text' in stored:
        text = stored['text']
        window['text'] = {'len': count(text['len'])}
        # A span is whole or absent: the engine refuses a part of one.
        if 'since' in text:
            for name in TEXT_SPAN:
                window['text'][name] = count(text[name])
            if 'kept' in text:
                window['text']['kept'] = count(text['kept'])
    window['sum'] = {name: count(stored['sum'][name]) for name in SUM}
    return window


def queued_window(item):
    """Whether a queue entry is a window this agent can send."""
    try:
        if not (isinstance(item['documentId'], str) and isinstance(item['documentName'], str)
                and isinstance(item['session'], str)):
            return False
        wire_window(item['window'])
    except (KeyError, IndexError, TypeError, ValueError):
        return False
    return True


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
    global _installed_version
    # Read once: every call to the engine declares it, and the manifest does not change under a
    # running LibreOffice.
    if _installed_version is None:
        try:
            manifest = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..', 'description.xml')
            with open(manifest, encoding='utf-8') as f:
                found = re.search(r'<version value="([^"]+)"', f.read())
            version = found.group(1) if found else ''
        except OSError:
            version = ''
        _installed_version = '' if '{' in version else version
    return _installed_version


_installed_version = None


# --- HOW THIS AGENT NAMES ITSELF ---
#
# Every call to the engine carries `X-Certimens-Agent: <kind>/<version>`. The engine stores it
# beside each measurement — so whoever reads the copy is told it was written in Writer and with
# which build of this extension — and flags a push that names nothing, because every agent speaks
# up.
#
# It proves nothing, and is not meant to: this extension ships as readable Python, so the header
# can be copied out of it. What it buys is **precision** the transport signature cannot give
# (that one says "a Python client", never which build), and what keeps it honest is that the
# engine checks the two against each other.
#
# The three other agents make the same declaration, with the same header and the same shape;
# `make check` compares the four.
AGENT_HEADER = 'X-Certimens-Agent'
AGENT_KIND = 'libreoffice'
# The charset the engine accepts for a build label, applied here rather than trusted: a version
# outside it makes the whole declaration unreadable.
AGENT_VERSION_MAX = 32
AGENT_VERSION_ALLOWED = re.compile(r'[^A-Za-z0-9._+-]')


def agent_declaration():
    """The declaration this agent sends: its kind, and its build when it can read one.

    A checkout cannot (see installed_version) and sends its kind alone, which the engine accepts:
    refusing the whole declaration over the part the agent does not know would throw away the
    part that is true.
    """
    label = AGENT_VERSION_ALLOWED.sub('', installed_version())[:AGENT_VERSION_MAX]
    return AGENT_KIND + '/' + label if label else AGENT_KIND


class HttpError(Exception):
    def __init__(self, status, message, code=''):
        super().__init__(message)
        self.status = status
        self.message = message
        # The engine names the rule that refused the request ({"code", "error"}).
        self.code = code
        # Set when what failed is the creation of a document, not what was to be sent to it.
        self.creation = False


def shaped(value, kind):
    """`value`, which the engine answered where a `kind` was expected — or a refusal.

    A 200 that is not what was asked for is a proxy's page, a maintenance notice, an engine that
    is not one: read as it came, it surfaced as a TypeError three calls later, and left the
    sending status saying everything had gone through.
    """
    if not isinstance(value, kind):
        raise HttpError(502, t('error.unknown'))
    return value


# The longest name the engine takes for a document.
DOCUMENT_NAME_MAX = 255


def free_name(name, now=None):
    """A name the account does not hold yet, made from one it does: the name, and the second
    the document was created at. The engine keeps one living document per name and per account,
    and a document created from a sealed window is created with nobody watching — the name is
    then the agent's to choose, so the agent chooses one that is free."""
    stamp = (now or datetime.now()).strftime(' (%Y-%m-%d %H.%M.%S)')
    return name[:DOCUMENT_NAME_MAX - len(stamp)] + stamp


def clamp(value, bounds, fallback):
    """`value` within `bounds`, or `fallback` when it is not a number at all."""
    if isinstance(value, bool) or not isinstance(value, Real) or value != value:
        value = fallback
    return min(max(value, bounds[0]), bounds[1])


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
    # `new URL` rewrites `0x08080808` as 8.8.8.8 before the pattern sees it; `urlparse` hands it
    # over as written, where it is a single label like `moteur` — and the resolver then reads
    # it as the public address it is. A single label that is a number in any base is refused
    # here, which is what the three other agents get from their parser.
    if '.' not in parsed.hostname and ':' not in parsed.hostname:
        try:
            socket.inet_aton(parsed.hostname)
            return False
        except OSError:
            pass
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


def new_request(method, url, data, token):
    """A request to the engine with the headers every call carries: its body type, the agent's
    declaration, and the token when there is one — in the Authorization header and nowhere else.

    The caller has already checked the address with engine_url_allowed (hence the noqa).
    """
    req = urllib.request.Request(url, data=data, method=method)  # noqa: S310
    req.add_header('Content-Type', 'application/json')
    req.add_header(AGENT_HEADER, agent_declaration())
    if token:
        req.add_header('Authorization', 'Bearer ' + token)
    return req


def loaded_telemetry(stored):
    """The counters as read back from the state file: known words with counts in range, and
    nothing else. The file is the student's to edit, and what it holds is sent."""
    stored = stored if isinstance(stored, dict) else {}
    counts = stored.get('counts') if isinstance(stored.get('counts'), dict) else {}
    sent_at = stored.get('sentAt')
    version = stored.get('version')
    return {
        'counts': {name: min(TELEMETRY_MAX_COUNT, value) for name, value in counts.items()
                   if name in TELEMETRY_EVENTS and isinstance(value, int)
                   and not isinstance(value, bool) and value > 0},
        'sentAt': sent_at if isinstance(sent_at, (int, float)) and not isinstance(sent_at, bool) else 0,
        'version': version if isinstance(version, str) else '',
        'faults': loaded_faults(stored.get('faults')),
    }


def fault_of(err, own_dirs=OWN_DIRS):
    """Where this extension's own code broke: the exception's type and the frames of its traceback
    that are this extension's files, innermost first, as `function@file.py:line`.

    **Never the message**, which can quote what the student wrote, and **never a directory**: the
    path of an installed extension names the student's account. The extension is not compiled or
    minified, so a file, a line and a function name are a position in the published source of
    this build and nothing else.
    """
    name = type(err).__name__
    frames = []
    for frame in reversed(traceback.extract_tb(getattr(err, '__traceback__', None))):
        if len(frames) >= TELEMETRY_MAX_FRAMES:
            break
        path = os.path.realpath(frame.filename or '')
        folder, file = os.path.split(path)
        if os.path.normcase(folder) not in own_dirs or not FAULT_FILE.match(file):
            continue
        function = frame.name if FAULT_FUNCTION.match(frame.name or '') else ''
        frames.append('%s%s:%d' % (function + '@' if function else '', file, frame.lineno or 1))
    return {'type': name if FAULT_TYPE.match(name) else 'Other', 'frames': frames}


def fault_key(fault):
    """What makes two faults the same one: the type and the frames."""
    return (fault['type'], tuple(fault['frames']))


def loaded_faults(stored):
    """The faults as read back from the state file: the shape `fault_of` makes, and nothing else.
    The file is the student's to edit, and what it holds is sent."""
    faults = []
    for fault in stored if isinstance(stored, list) else []:
        if not isinstance(fault, dict):
            continue
        kind, frames, n = fault.get('type'), fault.get('frames'), fault.get('count')
        if not (isinstance(kind, str) and FAULT_TYPE.match(kind) and isinstance(frames, list)
                and len(frames) <= TELEMETRY_MAX_FRAMES
                and all(isinstance(f, str) and FAULT_FRAME.match(f) for f in frames)
                and isinstance(n, int) and not isinstance(n, bool) and n > 0):
            continue
        faults.append({'type': kind, 'frames': list(frames), 'count': min(n, TELEMETRY_MAX_COUNT)})
        if len(faults) >= TELEMETRY_MAX_FAULTS:
            break
    return faults


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


# What a poll of the pairing answers while it is still alive: "keep waiting", in the engine's
# words or in those of the rate limiter in front of it. Not a refusal, so not counted.
PAIRING_WAIT = ('device_authorization_pending', 'device_slow_down', 429)


# Refusals the agent words itself instead of passing on the engine's sentence. The engine names
# the rule it applied and answers in English — the only language its fallback messages have — so
# a code it can act on is reworded here, once, for every call that may meet it.
REWORDED = {
    'deadline_passed': 'error.deadlinePassed',
    # A name the student chose, and already gave to another of their documents: said, never
    # worked around — renaming behind somebody is how two documents end up with names nobody
    # chose. A document created with nobody watching takes a free name instead (`free_name`).
    'document_name_taken': 'error.nameTaken',
    # The two ends of a pairing that will not complete. Passed on as they come, the student would
    # read the engine's English sentence at the one moment they are waiting on a screen.
    'device_code_expired': 'pair.expired',
    'device_denied': 'pair.denied',
}


# « Signaler un problème » (docs/moteur.md): a link to the engine's own help form, opened in the
# browser, prefilled with a block the student reads before sending it. The agent sends nothing
# itself. The keys are fixed and in English, in this order, and `make check` compares the
# fragment and the list across the four agents: keep each on one line.
REPORT_FRAGMENT = '#report'
REPORT_KEYS = ('agent', 'host', 'os', 'language', 'engine', 'signed_in', 'paused', 'status', 'queued', 'counters', 'at')
# Before encoding: the engine bounds the whole message at 5,000, and the rest is the student's.
REPORT_MAX = 1500
# The states `_set_status` writes. The file is the student's to edit: a word outside them is
# reported as unknown rather than copied into a block that is meant to be a closed vocabulary.
REPORT_STATES = ('idle', 'synced', 'offline', 'auth_error', 'unconfigured')
REPORT_CONTROL = re.compile(r'[\x00-\x1f\x7f\u2028\u2029]+')


def report_origin(raw_url, fallback=True):
    """scheme://host[:port] of an engine address.

    The origin and nothing else: a path is not the engine's address, and credentials written in
    the authority (`https://user:secret@…`) must never reach a block the student pastes in.

    `fallback`: the default engine when the address is refused — what the link is opened on, since
    a link is not opened in the clear towards a public host. The `engine` line of the block takes
    the address as configured instead, refused or not, like the three other agents: it is what
    tells the support what the student actually typed. Anything that is not http(s) is '' there.
    """
    url = str(raw_url or '').strip()
    if not engine_url_allowed(url):
        if fallback:
            url = DEFAULT_ENGINE_URL
        elif urllib.parse.urlparse(url).scheme not in ('http', 'https'):
            return ''
    parsed = urllib.parse.urlparse(url)
    return '%s://%s' % (parsed.scheme, parsed.netloc.rpartition('@')[2])


def report_block(values):
    """The `key: value` lines, in REPORT_KEYS order, cut at REPORT_MAX on a line boundary.

    A missing or empty value is `unknown` — a line is never left out, so two reports read line
    by line — and a value never spans two lines.
    """
    lines = []
    size = 0
    for key in REPORT_KEYS:
        value = REPORT_CONTROL.sub(' ', str(values.get(key) if values.get(key) is not None else '')).strip()
        line = '%s: %s' % (key, value or 'unknown')
        added = len(line) + (1 if lines else 0)
        if size + added > REPORT_MAX:
            break
        lines.append(line)
        size += added
    return '\n'.join(lines)


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
        # One drain at a time: the sending thread's, or the one a sign-out makes before it
        # clears the queue. Two of them took the same windows from the head and each moved the
        # cursor by what it had sent — every other window was skipped, and never left.
        self.drain_lock = threading.Lock()
        self.wake = threading.Event()
        # Called before a sign-out clears anything, so the windows still open are sealed and
        # sent under the token that measured them (the agent registers its sensors here).
        self.before_logout = []
        # The engine document each open file names in its own properties, by local identity:
        # asked for before a document is created in its place (see _ensure_document).
        self.carried = {}
        # The file a document was saved under since its windows were queued, by local identity,
        # while no engine document records one yet: a creation already on its way read the old
        # file from the head of the queue, and records this one instead (see `rebind`).
        self.moved = {}
        # Whether something in memory is waiting for the next write of the state — a counter
        # (see `count`), which never pays for a write of its own.
        self.dirty = False
        # How many windows at the head of the queue have already reached the engine, since the
        # last full write of the state. See `_save_cursor`.
        self.queue_sent = 0
        # Moves each time measuring may have started over — a suspension set or lifted, a
        # pairing, a sign-out. A sensor that sees it move starts a new session (sensor.py).
        self.epoch = 0
        self.state = self._load()
        # Whether a counter is being sent right now, so two threads never send the same counts.
        self.telemetry_sending = False
        # A cursor found at startup has just been folded into the queue: writing the state back
        # is what makes that permanent and clears it. Reading it twice would drop windows.
        if self._read_cursor():
            self._save()

    # --- 1. STORAGE ---
    def _load(self):
        state = {'config': {}, 'engineIds': {}, 'engineSources': {}, 'titles': {}, 'syncedTitles': {},
                 'queue': [], 'status': {'state': 'idle'}, 'paused': False}
        try:
            with open(self.path, encoding='utf-8') as f:
                stored = json.load(f)
        except (OSError, ValueError):
            stored = {}
        # The file is the student's to edit, and a profile can come from anywhere: a key is
        # kept only when it holds what this agent would have written there. A `config` that is
        # not a dictionary otherwise stopped the agent from starting, in every session.
        if isinstance(stored, dict):
            for key, value in stored.items():
                if key not in state or type(value) is type(state[key]):
                    state[key] = value
        # A drain interrupted between two sends left its cursor beside the state: what it counts
        # has already reached the engine and must not be sent again.
        sent = self._read_cursor()
        if sent:
            state['queue'] = state['queue'][sent:]
        # The queue holds windows in the one shape the engine reads. An entry in any other —
        # the profile of another build, a file edited by hand — is dropped here: it could only
        # be refused, and would be refused again at every start. The cursor is applied first,
        # since it counts entries of the file as it was written.
        state['queue'] = [item for item in state['queue'] if queued_window(item)]
        state['telemetry'] = loaded_telemetry(state.get('telemetry'))
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
            # The cursor goes before the state that makes it stale: stopped between the two,
            # the old state is read from its start and windows leave twice, which the engine
            # takes for the resend it is. The other order read the new, compacted queue from
            # the old cursor — and skipped windows that had never left.
            try:
                os.remove(self._cursor_path)
            except OSError:
                pass
            os.replace(tmp, self.path)
            self.dirty = False
        finally:
            # Nothing left after a rename; still there when the write threw, and a temporary
            # per failure would pile up in the profile of a student with a full disk.
            if os.path.exists(tmp):
                try:
                    os.unlink(tmp)
                except OSError:
                    pass

    def config(self):
        # token: API token (Bearer) obtained by pairing — no password is ever asked for, so none
        # is ever stored. tokenId: its identifier, used to revoke the token at logout.
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
            self.epoch += 1
            self._save()

    def engine_id(self, document_id):
        with self.lock:
            return self.state['engineIds'].get(document_id)

    def _set_status(self, status):
        # Written only when it says something new, or when a counter is waiting for a write:
        # the loop comes through here every minute, and a write is the whole state on disk.
        with self.lock:
            if self.state['status'] != status or self.dirty:
                self.state['status'] = dict(status)
                self._save()

    # --- 2. ENGINE API ---
    def _request(self, method, url, body=None, token=None, compact=False, expected=()):
        """One call of this agent's work — pairing, documents, measurements, assignments.

        Every failure is counted for the agent's own report (see TELEMETRY_EVENTS) except the
        answers named in `expected`, by status or by the engine's code: those are how the call
        says something ordinary — "nobody has confirmed the code yet", "this file is not yours to
        resume" — and counting them would bury the refusals that mean something.
        """
        # The engine address is typed by the student, and urlopen would happily open a file://
        # path or speak ftp with it. The three other agents go through fetch, which cannot
        # leave http(s): this keeps the Python one on the same footing (hence the noqa in
        # new_request — the scheme is checked right here). It also refuses plain `http:` to a host outside
        # the building, which is where the token would travel in the clear; the window refuses
        # it earlier and with a sentence on screen, and this is the floor under it.
        if not engine_url_allowed(url):
            raise HttpError(0, t('error.engineUrlInsecure'), 'engine_url_refused')
        # A body of measurements is written without a space, which is part of its contract;
        # every other call keeps the spacing its serializer has always had.
        separators = (',', ':') if compact else None
        data = None if body is None else json.dumps(body, separators=separators).encode('utf-8')
        req = new_request(method, url, data, token)
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
                # Read only in the shape the engine gives a refusal: anything else is the body
                # of whatever answered in its place.
                if isinstance(body, dict):
                    message = body.get('error') or message
                    code = body.get('code') if isinstance(body.get('code'), str) else ''
            except ValueError:
                pass
            if code in REWORDED:
                message = t(REWORDED[code])
            refused = HttpError(err.code, str(message), code)
            if err.code not in expected and code not in expected:
                self._count_refusal(err.code)
            raise refused from err
        except (urllib.error.URLError, OSError) as err:
            # No answer at all: offline, DNS, TLS, a timeout.
            self.count('network.failure')
            raise HttpError(0, str(getattr(err, 'reason', err))) from err

    def _count_refusal(self, status):
        """Counts an answer of the engine that was not the one asked for, by its class."""
        if status == 401:
            self.count('error.auth')
        elif status >= 500:
            self.count('error.engine')
        elif status >= 400:
            self.count('error.rejected')

    def api(self, method, path, body=None, config=None, compact=False, expected=()):
        config = config or self.config()
        return self._request(method, trim_url(config['engineUrl']) + path, body, config['token'], compact,
                             expected)

    def start_pairing(self, engine_url):
        """Open an authorization and return what to show, plus what to poll with.

        No password is asked for, here or in the window. An account that signs in through
        Google, through its establishment's provider or from a Moodle launch has none at all,
        and a password box inside an office extension is the exact shape a counterfeit agent
        would take. The student reads a short code, confirms it in their Certimens space, and
        this agent is handed an API token.
        """
        url = trim_url(engine_url or DEFAULT_ENGINE_URL)
        res = shaped(self._request('POST', url + '/api/auth/device', {'client': t('pair.clientWriter')}), dict)
        return {
            'engineUrl': url,
            'deviceCode': res['device_code'],
            'userCode': res['user_code'],
            'verificationUri': verification_uri(res.get('verification_uri'), url),
            'verificationUriComplete': verification_uri(
                res.get('verification_uri_complete') or res.get('verification_uri'), url),
            # Clamped before they pace a loop: an interval of a millisecond would turn the poll
            # into a flood, a validity of a year into a poll for a year.
            'expiresAt': time.time() + clamp(res.get('expires_in'), PAIRING_EXPIRES_S, 600),
            'interval': clamp(res.get('interval'), PAIRING_INTERVAL_S, 5),
        }

    def poll_pairing(self, pairing):
        """Ask once. Returns the API token, or None while nobody has confirmed yet.

        Every other refusal is raised: an expired code and a refused one each mean something the
        student has to be told, and a window that treated them as "keep waiting" would spin
        until the end of time.
        """
        try:
            res = self._request('POST', trim_url(pairing['engineUrl']) + '/api/auth/device/token',
                                {'device_code': pairing['deviceCode']}, expected=PAIRING_WAIT)
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
        return shaped(res, dict).get('token')

    def adopt_token(self, engine_url, token):
        """Complete a pairing: read who the token belongs to, and keep it in place of a password."""
        url = trim_url(engine_url or DEFAULT_ENGINE_URL)
        me = shaped(self._request('GET', url + '/api/auth/me', None, token), dict)
        tokens = shaped(self._request('GET', url + '/api/auth/tokens', None, token), list)
        # The id of this very token, so signing out revokes it; the engine never returns a raw
        # token twice, so it is found by being the newest one.
        token_id = tokens[0].get('id', '') if tokens and isinstance(tokens[0], dict) else ''
        # From here on every window speaks the account's language, not the editor's.
        set_language(me.get('language'))
        # Signing in again as somebody else — another account, or the same address on another
        # engine — without signing out first, leaves exactly the residue a sign-out would have
        # cleared, and no gesture forbids it. Same door.
        previous = self.config()
        changed = previous.get('email') != (me.get('email') or '') or trim_url(previous['engineUrl']) != url
        if previous.get('email') and changed:
            self._clear_account_state()
        with self.lock:
            # displayName: the engine computes it, falling back to the e-mail when the account
            # carries no name. An engine too old to send it leaves it empty, and the window
            # falls back to the e-mail on its own.
            self.state['config'] = {'engineUrl': url,
                                    'email': me.get('email') or '', 'token': token,
                                    'displayName': me.get('display_name') or '',
                                    'tokenId': token_id, 'language': me.get('language') or ''}
            # What is measured from here on is a new session.
            self.epoch += 1
            self._save()
        self._set_status({'state': 'idle'})  # clears any auth_error before the next send
        self.wake.set()
        return me

    def logout(self):
        config = self.config()
        # The windows still open belong to the session that is ending: they are sealed and sent
        # while the token that measured them is still valid, because what is cleared below is
        # cleared for good. One left in the queue would otherwise be sent under the next
        # account's bearer, towards this account's documents.
        for seal in list(self.before_logout):
            try:
                seal()
            except Exception as err:  # a sensor that cannot seal must not keep the token alive
                self.runtime_error('logout', err)
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
            except HttpError as err:
                # The engine no longer knows this token, or no longer accepts it: it is as dead
                # as a revocation would have made it. Anything else leaves it alive, and the
                # caller says so.
                revoked = err.status in (401, 404)
        # No drain between the two: the sending thread waits, and cannot then write its cursor
        # back over a queue that has just been cleared.
        with self.drain_lock, self.lock:
            self._clear_account_state()
            self.state['config'] = {'engineUrl': config['engineUrl'],
                                    'language': config.get('language', '')}
            self.epoch += 1
            self._save()
        self._set_status({'state': 'unconfigured'})
        return revoked

    def carry(self, document_id, engine_id, name):
        """Notes the engine document an open file names (sensor.py reads it out of the file)."""
        if document_id and valid_engine_id(engine_id):
            with self.lock:
                self.carried[document_id] = (engine_id, name)

    def _clear_account_state(self):
        """Everything the revoked token authorised on this installation, as opposed to the token
        itself.

        Revoking ends what the credential can do at the engine; this ends what it left behind
        here. The map, the titles it synced and a queued window all outlive it otherwise, and the
        next account to pair inherits them and sends them under its own bearer — towards the
        previous student's engine documents, under the new student's own credential, with
        neither of them told.

        `config` is not cleared here: its engine address and language are kept, so the next
        pairing starts where this one did rather than from nothing. Nor are the telemetry
        counters: they describe this installation, not an account, and the engine keeps no
        account with them.
        """
        with self.lock:
            self.state['engineIds'] = {}
            self.state['engineSources'] = {}
            self.state['titles'] = {}
            self.state['syncedTitles'] = {}
            self.state['queue'] = []
            # A suspension is one student's choice about their own measurement. The next account
            # must not start silently suspended by it.
            self.state['paused'] = False
            self.queue_sent = 0
            self._save()

    def _create_document(self, config, name, chosen):
        """POST /api/documents, under `name` — or under a free name made from it when the
        account already holds one called that (409 `document_name_taken`) and nobody chose it.

        `chosen` is a name typed in the Certimens window: its collision is said to the student,
        never worked around. Read as a refusal of the window, that 409 threw away every
        measurement of the second file called « Mémoire », for good and without a word.
        """
        clipped = name[:DOCUMENT_NAME_MAX]
        try:
            return shaped(self.api('POST', '/api/documents', {'name': clipped}, config), dict)
        except HttpError as err:
            if chosen or err.code != 'document_name_taken':
                raise
        return shaped(self.api('POST', '/api/documents', {'name': free_name(clipped)}, config), dict)

    def _ensure_document(self, config, document_id, document_name, editor_title=None, source='',
                         chosen=False):
        """Creates the document's engine document if needed. editor_title is the document's name in
        LibreOffice at that moment: it serves as the baseline for detecting a later rename.
        source is the file the identity was read from, recorded so that no other file can later
        present the same identity and be handed this engine document."""
        with self.create_lock:
            existing = self.engine_id(document_id)
            if existing:
                return existing
            try:
                # The file may name the document it already feeds: taken back rather than
                # doubled. Asked here, where the document would otherwise be created, because
                # this is the one moment that cannot be missed — the take-back made when the
                # file opens is skipped when nobody is signed in yet, and lost when the engine
                # is out of reach; the first window then opened a second record, and the file
                # was re-stamped with it. A question that cannot be asked is raised: nothing is
                # created on an answer nobody gave.
                with self.lock:
                    carried = self.carried.get(document_id)
                if carried and self._take_back(config, document_id, carried[0], carried[1], source):
                    return carried[0]
                file = self._create_document(config, document_name, chosen)
            except HttpError as err:
                # Whatever it is, it says nothing of the window waiting for this document.
                err.creation = True
                raise
            with self.lock:
                self.state['engineIds'][document_id] = file['id']
                source = self.moved.pop(document_id, source)
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

    def rebind(self, document_id, source):
        """The document was saved under another file (*Save As*) and goes on in it: the
        identity is bound to that file from now on.

        The document open in Writer is the one the student carries on writing, so it keeps its
        identity and its record; the file it was read from stays behind on disk, carrying the
        same identity — a version left behind, which `binds` refuses at its next opening and
        which gets a fresh identity of its own. Without this, the windows written after the
        save went on to the old file's binding, and the next opening of the new file found the
        old one still on disk, minted a new identity and split the record in two.

        Three places name the file, and all three move: the binding of an engine document that
        exists; the windows still waiting in the queue, from which a document not created yet
        will take its file; and, for a creation already on its way with the old file read from
        the queue, `moved`, which it records instead. Under self.lock alone — no network — so
        it may be called from the UI thread; the creation path records its file under the same
        lock, so one of the two orders always wins with the new file.
        """
        if not document_id or not source:
            return
        with self.lock:
            changed = False
            if document_id in self.state['engineIds']:
                sources = self.state.setdefault('engineSources', {})
                if sources.get(document_id) != source:
                    sources[document_id] = source
                    changed = True
                self.moved.pop(document_id, None)
            else:
                self.moved[document_id] = source
            for item in self.state['queue'][self.queue_sent:]:
                if item.get('documentId') == document_id and item.get('documentSource') != source:
                    item['documentSource'] = source
                    changed = True
            if changed:
                self._save()

    def create_file(self, document_id, name, editor_title, source=''):
        """Explicit creation (Certimens window); no effect if the file already exists."""
        existed = bool(self.engine_id(document_id))
        return self._ensure_document(self.config(), document_id, name, editor_title, source,
                                     chosen=True), existed

    def resume_engine_document(self, document_id, engine_id, name, source=''):
        """Takes back the engine document a file names, instead of opening a second one.

        The file carries the id of its engine document in its own properties, so the same .odt
        or .docx opened in another editor, or on another machine, goes on filling the record it
        already has rather than starting an empty one beside it. Nothing read there is trusted:
        the shape is checked before the id reaches a path, and the engine answers 404 or 403
        for a document that is not this account's, which is the whole of the authorisation —
        only the owner of a document ever writes to it.

        **Only a student resumes.** A teacher opening a copy handed in to them is allowed to
        read that document, so the engine would answer 200 here: their own keystrokes would
        then be measured into their student's record.

        Returns the engine document taken back, or None when there is none to take — which is
        the ordinary case, and says nothing to the student.
        """
        if not valid_engine_id(engine_id):
            return None
        config = self.config()
        if not config.get('token'):
            return None
        # The same lock the creation path holds: a window measured while this answer is on its
        # way must not open a second record beside the one being taken back.
        with self.create_lock:
            if self.engine_id(document_id):
                return None
            return self._take_back(config, document_id, engine_id, name, source)

    def _take_back(self, config, document_id, engine_id, name, source):
        """The take-back itself, with create_lock held. Returns the engine document, or None
        when the engine answered that there is none to take; raises when it did not answer."""
        try:
            if shaped(self.api('GET', '/api/auth/me', None, config), dict).get('role') != 'student':
                file = None
            else:
                # Both refusals are the ordinary case, not a failure worth counting.
                file = shaped(self.api('GET', f'/api/documents/{engine_id}', None, config,
                                       expected=(403, 404)), dict)
        except HttpError as err:
            # 404: the document was deleted. 403: it belongs to somebody else — a file a
            # classmate sent, which is a file like any other and gets its own record here.
            if err.status not in (403, 404):
                raise
            file = None
        with self.lock:
            # Answered, one way or the other: not asked again for this file.
            self.carried.pop(document_id, None)
            if file is None:
                return None
            self.state['engineIds'][document_id] = engine_id
            source = self.moved.pop(document_id, source)
            if source:
                self.state.setdefault('engineSources', {})[document_id] = source
            # The name the engine holds, not the one this file carries: a document renamed
            # in Writer since it was last sent must still be seen as a rename and
            # propagated.
            self.state['syncedTitles'][document_id] = file.get('name') or name
            self._save()
        return file

    def doc_info(self, document_id):
        """Engine file linked to a document (None if not yet created or deleted)."""
        engine_id = self.engine_id(document_id)
        if not engine_id:
            return None
        try:
            return shaped(self.api('GET', f'/api/documents/{engine_id}'), dict)
        except HttpError as err:
            if err.status != 404:
                raise
            with self.lock:
                self.state['engineIds'].pop(document_id, None)
                self._save()
            return None

    def assignments(self):
        """The student's assignments; none for other roles (only students submit)."""
        me = shaped(self.api('GET', '/api/auth/me'), dict)
        if me.get('role') != 'student':
            return []
        # An assignment without a deadline sorts last: it is not one that is about to close.
        return sorted(shaped(self.api('GET', '/api/assignments') or [], list),
                      key=lambda a: (not a.get('deadline'), a.get('deadline') or ''))

    def submit(self, engine_id, assignment_id):
        """The engine silently ignores an assignment the student is not attached to."""
        file = shaped(self.api('PUT', f'/api/documents/{engine_id}', {'assignment_id': assignment_id}), dict)
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
    def enqueue(self, document_id, document_name, session, window, source=''):
        """Queues a sealed window: what measure.take returned, the session it belongs to and
        the window as it will be sent. Nothing else of the session is ever written."""
        # Read once as it will be sent, here where a window of another shape is still somebody's
        # mistake to hear about: in the queue it would only be found at the next start.
        wire_window(window)
        with self.lock:
            # A window sealed after the session ended — the idle timer of a keystroke typed
            # while signing out — is nobody's to send: queued, it would wait for whichever
            # account pairs next.
            if not self._has_auth(self.config()):
                return
            window = dict(window)
            # A window written while the engine was out of reach is stamped here, once, at the
            # moment it is queued — not when it finally leaves. What tells us is our own last
            # attempt; there is no "am I online" worth trusting from inside LibreOffice. **Out
            # of reach, not refused**: an engine that answered an error was there, and a window
            # that waits behind its refusal was not written offline (`reached`, see drain).
            status = self.state['status']
            if status.get('state') == 'offline' and not status.get('reached'):
                window['offline'] = True
            # A token the engine refused is not tried again at every window: the loop asks once
            # a minute, and pairing again clears the state.
            refused = status.get('state') == 'auth_error'
            item = {
                'id': str(uuid.uuid4()),
                'documentId': document_id,
                'documentName': document_name,
                # The file this identity was read from, so the engine document created for the
                # window is bound to it and no other file can later be handed the same one.
                'documentSource': source,
                'session': session,
                'window': window,
            }
            # Compacted before the cap applies, so the cap counts what is waiting and not what
            # has already left.
            self._compact()
            self.state['queue'].append(item)
            dropped = len(self.state['queue']) - MAX_QUEUE
            if dropped > 0:
                # The oldest windows go to make room: the queue is full.
                self.count('queue.dropped', dropped)
            self.state['queue'] = self.state['queue'][-MAX_QUEUE:]
            self._save()
        if not refused:
            self.wake.set()

    def _batch(self, alone):
        """The windows the next request carries, taken from the head of what is waiting.

        One window, unless the head of the queue waited offline: then the windows that follow
        it, of the same document and the same session, queued offline too and numbered
        upwards, up to BATCH_MAX_WINDOWS. A window that waited for another reason leaves alone
        — the engine reads several windows in one request as a queue caught up, and flags a
        batch that is not one. Windows of another session leave in another request. Called
        with self.lock held.
        """
        waiting = self.state['queue'][self.queue_sent:self.queue_sent + BATCH_MAX_WINDOWS]
        batch = waiting[:1]
        head = batch[0]
        if alone or not head['window'].get('offline'):
            return batch
        for item in waiting[1:]:
            if (not item['window'].get('offline') or item['documentId'] != head['documentId']
                    or item['session'] != head['session']
                    or item['window']['seq'] <= batch[-1]['window']['seq']):
                break
            batch.append(item)
        return batch

    def _push(self, config, items):
        """Sends the windows of one request, and returns how many of them left the queue."""
        head = items[0]
        # One attempt, and one more for a document recreated after a 404.
        for _ in range(2):
            engine_id = self._ensure_document(config, head['documentId'], head['documentName'],
                                              source=head.get('documentSource', ''))
            # `sent` is this attempt's, not the window's: the clock of this machine now, in
            # milliseconds, written again each time.
            body = {'session': head['session'], 'sent': int(time.time() * 1000),
                    'windows': [wire_window(item['window']) for item in items]}
            try:
                self.api('POST', f'/api/documents/{engine_id}/metrics', body, config, compact=True)
                return len(items)
            except HttpError as err:
                if err.status != 404:
                    raise
                # file deleted on the engine side: we recreate one for this document
                with self.lock:
                    self.state['engineIds'].pop(head['documentId'], None)
                    self._save()
        # Both attempts were spent on a document that keeps disappearing: the window is let go
        # rather than held at the head of the queue for ever.
        return 1

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
                # A refusal of this very rename is final: a 404 is a file deleted, recreated on
                # the next send; `deadline_passed` a copy frozen; a 409 a name already taken.
                # Noting it as synced anyway is what stops it being retried at every drain, and
                # the sending status going red over a refusal nobody here can act on. A rename
                # made after the teacher pushes the deadline does go through; this one stays as
                # it was when the window shut. What is not final says nothing of the rename: no
                # answer, a token refused, a limiter, an engine that failed.
                if not 400 <= err.status < 500 or err.status in (401, 408, 429):
                    raise
            with self.lock:
                self.state['syncedTitles'][document_id] = title
                self._save()

    def drain(self):
        with self.drain_lock:
            self._drain()

    def _drain(self):
        if not self._has_auth(self.config()):
            self._set_status({'state': 'unconfigured'})
            return
        try:
            config = self.config()
            # How many of the next windows leave one by one, after a batch was refused.
            alone = 0
            while True:
                with self.lock:
                    if self.queue_sent >= len(self.state['queue']):
                        break
                    batch = self._batch(alone > 0)
                try:
                    sent = self._push(config, batch)
                except HttpError as err:
                    # Not when it is the *document* that could not be created: that says
                    # nothing of the window, which waits.
                    if err.status not in REFUSED_FOR_GOOD or err.creation:
                        raise
                    if len(batch) > 1:
                        # The refusal does not say which window it is about: they are sent
                        # again one by one, so that only that one is lost.
                        alone = len(batch)
                        continue
                    # Refused by the engine: sending it again would be refused again and block
                    # the queue for ever, and there is no other body to send it in.
                    warn('measurement rejected', err.message)
                    sent = 1
                alone = max(0, alone - sent)
                # The cursor moves before the next send, so nothing is ever pushed twice — and
                # it is a number in a file of its own, so this write does not carry the queue.
                with self.lock:
                    # Counted on what is still at the head: a queue that filled up meanwhile
                    # gave up its oldest windows — these very ones — and moving the cursor by
                    # what was sent would then step over windows that never left.
                    gone = {item['id'] for item in batch[:sent]}
                    head = self.state['queue'][self.queue_sent:self.queue_sent + sent]
                    self._save_cursor(self.queue_sent + sum(1 for item in head if item['id'] in gone))
            # Everything waiting has left: the state is written once, by the status below, which
            # compacts the queue and clears the cursor. On a failure, its status does the same.
            with self.lock:
                self.dirty = self.dirty or bool(self.queue_sent)
            self._sync_titles(config)
        except HttpError as err:
            # `reached` says the engine answered, whatever it answered: it is what keeps a
            # refusal from being read as an outage when the next window is queued.
            self._set_status({'state': 'auth_error'} if err.status == 401
                             else {'state': 'offline', 'reached': bool(err.status)})
            return
        self._set_status({'state': 'synced'})

    # --- 4. WHAT THE AGENT SAYS ABOUT ITSELF ---
    def count(self, event, n=1):
        """Adds n to one counter of the agent's own report, up to TELEMETRY_MAX_COUNT.

        In memory only: the count is written with the next write of the state, which the
        once-a-minute drain always makes (its status). A write per count would put the whole
        state on disk for each failing keystroke; what this costs instead is the last minute of
        counts when LibreOffice is killed.
        """
        if event not in TELEMETRY_EVENTS:
            raise ValueError('not a telemetry event: %s' % event)
        with self.lock:
            counts = self.state['telemetry']['counts']
            counts[event] = min(TELEMETRY_MAX_COUNT, counts.get(event, 0) + n)
            self.dirty = True

    def runtime_error(self, where, err):
        """An exception this extension's own code did not handle, caught at one of its entry points.

        LibreOffice runs every Python extension in one interpreter, so `sys.excepthook` is not
        ours to replace: what is counted is what reaches the catch-all of an entry point of this
        extension — a UNO listener, a dispatch, a window's button, a timer or a thread of ours.
        Never raises: it runs where the agent has already failed once.

        Counted as error.runtime, and kept as a fault (`fault_of`): one entry per distinct fault
        with its count, at most TELEMETRY_MAX_FAULTS of them, sent and forgotten with the counts.
        """
        warn(where, err)
        try:
            self.count('error.runtime')
            fault = fault_of(err)
            with self.lock:
                faults = self.state['telemetry']['faults']
                known = next((f for f in faults if fault_key(f) == fault_key(fault)), None)
                if known is not None:
                    known['count'] = min(TELEMETRY_MAX_COUNT, known['count'] + 1)
                elif len(faults) < TELEMETRY_MAX_FAULTS:
                    faults.append(dict(fault, count=1))
                self.dirty = True
        except Exception:
            pass

    def record_start(self, version):
        """The agent has been loaded in this LibreOffice session; and installed, or updated, when
        the build is not the last one this profile ran.

        A profile from before these counters has no version of its own for them, but may hold the
        one its "has been updated" notice last saw: that is an update, not an installation. A
        checkout has no version (see installed_version) and says neither.
        """
        with self.lock:
            telemetry = self.state['telemetry']
            if version:
                previous = telemetry.get('version') or self.state.get('seenVersion') or ''
                if not previous:
                    self.count('installed')
                elif previous != version:
                    self.count('updated')
                telemetry['version'] = version
            self.count('started')
            self._save()

    def flush_telemetry(self, now=None):
        """Sends the counters, at most once every TELEMETRY_FLUSH_S, and only when paired and
        there is something to say. Returns the engine's status, 0 for no answer, None when
        nothing was sent.

        Reset on a 204 and only on a 204, minus nothing counted meanwhile: what is subtracted is
        what was sent. Kept on no answer, a 5xx or any other refusal; let go on 400, 413 and 401
        (TELEMETRY_ABANDONED). This call's own failures are not counted — an engine out of reach
        would otherwise grow the counter that says it is out of reach.
        """
        now = time.time() if now is None else now
        with self.lock:
            telemetry = self.state['telemetry']
            # A clock set back is not a reason to wait for ever.
            elapsed = now - telemetry['sentAt']
            if self.telemetry_sending or 0 <= elapsed < TELEMETRY_FLUSH_S or not self.logged_in():
                return None
            events = {name: telemetry['counts'][name] for name in TELEMETRY_EVENTS
                      if telemetry['counts'].get(name)}
            if not events:
                return None
            faults = [dict(f, frames=list(f['frames'])) for f in telemetry['faults']]
            telemetry['sentAt'] = now
            self.telemetry_sending = True
            config = self.config()
        try:
            status = self._send_telemetry(config, events, faults)
        finally:
            with self.lock:
                self.telemetry_sending = False
        if status == 204 or status in TELEMETRY_ABANDONED:
            with self.lock:
                counts = self.state['telemetry']['counts']
                for name, sent in events.items():
                    left = counts.get(name, 0) - sent
                    if left > 0:
                        counts[name] = left
                    else:
                        counts.pop(name, None)
                # The faults the same way: what was sent comes off, what arrived meanwhile stays.
                sent = {fault_key(f): f['count'] for f in faults}
                kept = []
                for fault in self.state['telemetry']['faults']:
                    fault['count'] -= sent.get(fault_key(fault), 0)
                    if fault['count'] > 0:
                        kept.append(fault)
                self.state['telemetry']['faults'] = kept
                self._save()
        return status

    def _send_telemetry(self, config, events, faults=()):
        """POST the counters, and the faults when there are any, through the one OPENER, and say
        how the engine answered.

        Not through `_request`: that one counts its failures, and this call must not.
        """
        url = trim_url(config['engineUrl']) + TELEMETRY_PATH
        if not engine_url_allowed(url):
            return 0
        body = {'events': events, 'faults': list(faults)} if faults else {'events': events}
        data = json.dumps(body, separators=(',', ':')).encode('utf-8')
        req = new_request('POST', url, data, config['token'])
        try:
            with OPENER.open(req, timeout=TIMEOUT_S) as res:
                return res.status
        except urllib.error.HTTPError as err:
            err.close()
            return err.code
        except (urllib.error.URLError, OSError):
            return 0

    # --- 5. REPORTING A PROBLEM ---
    def report_values(self, office_version='', engine_url=None, now=None):
        """What the block says, from the same things the telemetry is made of: states, numbers
        and words of a closed vocabulary. Never the token, the e-mail, a document's name, file or
        identity, nor a character the student wrote — none of them is even read here.

        office_version is read through UNO by the window (engine.py stays free of `uno`);
        engine_url is the address the login window is about to use, when it has one.
        """
        config = self.config()
        status, queued = self.status()
        state = status.get('state')
        if state not in REPORT_STATES:
            state = 'unknown'
        elif state == 'offline':
            state += ' (reached)' if status.get('reached') else ' (unreachable)'
        with self.lock:
            counts = self.state['telemetry']['counts']
            counters = ' '.join('%s=%d' % (name, counts[name]) for name in TELEMETRY_EVENTS if counts.get(name))
        moment = datetime.fromtimestamp(time.time() if now is None else now, timezone.utc)
        return {
            'agent': agent_declaration(),
            'host': 'LibreOffice %s' % office_version if office_version else '',
            'os': ('%s %s' % (platform.system(), platform.machine())).strip(),
            'language': language(),
            'engine': report_origin(engine_url or config.get('engineUrl'), fallback=False),
            'signed_in': 'yes' if self.logged_in() else 'no',
            'paused': 'yes' if self.paused() else 'no',
            'status': state,
            'queued': str(queued),
            'counters': counters or 'none',
            'at': moment.strftime('%Y-%m-%dT%H:%M:%SZ'),
        }

    def report_url(self, office_version='', engine_url=None, now=None):
        """<engine origin>/#report?kind=problem&details=<block>, everything in the fragment: a
        browser never sends a fragment to the server, so the block reaches no log on the way."""
        values = self.report_values(office_version, engine_url, now)
        details = urllib.parse.quote(report_block(values), safe='')
        base = report_origin(engine_url or self.config().get('engineUrl'))
        return '%s/%s?kind=problem&details=%s' % (base, REPORT_FRAGMENT, details)

    def _run(self):
        while True:
            self.wake.wait(RETRY_S)
            self.wake.clear()
            try:
                self.drain()
            except Exception as err:  # the sending thread must never stop
                self.runtime_error('envoi interrompu', err)
            # On the same loop, and throttled there to TELEMETRY_FLUSH_S: most turns of it ask a
            # question that costs a lock and a clock reading.
            try:
                self.flush_telemetry()
            except Exception as err:
                self.runtime_error('telemetry', err)

    def start(self):
        threading.Thread(target=self._run, name='certimens-engine', daemon=True).start()
        self.wake.set()
