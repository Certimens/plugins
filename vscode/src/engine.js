// Certimens — VS Code extension, sending to the engine (the counterpart of
// browser/background.js and libreoffice/pythonpath/certimens_agent/engine.py).
//
// Each source file of the project is tied to its own engine document (created on the first window
// that carries real activity via POST /api/documents, then remembered). Measurements go to
// POST /api/documents/:id/metrics, authenticating as the student with an API token (Bearer) created
// at login and kept in the editor's secret storage, never in settings.json — a settings file is
// synchronised, committed and read over the shoulder.
//
// A file only reaches the engine once the student has actually written in it: opening a project
// of four hundred files must not create four hundred documents on the engine.
//
// When offline, windows stay in a persisted queue and are resent every minute.
//
// The client also counts what happens to the agent itself — starts, updates, its own exceptions,
// the engine's refusals, calls left unanswered — and sends those counters, and nothing else, at
// most every fifteen minutes (see `count` and `reportTelemetry`).
//
// A window goes out in the one body the engine reads: an envelope naming the session, and the
// windows as the sensor sealed them (see `envelopeOf`). There is no other shape to fall back
// on — a body the engine refuses is a window given up, never a window sent differently.

const DEFAULT_ENGINE_URL = 'https://monespace.certimens.fr';
// What changed, for the student who finds the extension different from yesterday: the
// Marketplace updates it in the background and says nothing. Declared by each agent in its own
// engine client, and compared by `make check`.
const RELEASE_NOTES_URL = 'https://github.com/certimens/plugins/releases';
// How this agent names itself to the engine, beside the User-Agent it already sets. The header
// is the same in the four agents, and so is the shape of its value; the kind is this one's.
const AGENT_HEADER = 'X-Certimens-Agent';
const AGENT_KIND = 'vscode';
const AGENT_VERSION_MAX = 32;
const RETRY_MS = 60 * 1000;
// Added to the pairing interval each time the engine answers "too often" (RFC 8628 slow_down,
// or the rate limiter in front of it): asking at the same pace would only be refused again.
const SLOW_DOWN_MS = 5 * 1000;
// What the engine says of its own pairing is clamped before it paces a loop: an interval of a
// millisecond would turn the poll into a flood, and a validity of a year into a poll for a year.
const PAIRING_INTERVAL_S = [1, 60];
const PAIRING_EXPIRES_S = [30, 1800];
// How long a call may stay unanswered. `fetch` has no limit of its own that a student would
// outlive — a captive portal holds a connection for minutes — and the queue's lock is held
// across the call. An upload carries megabytes and is given longer.
const REQUEST_TIMEOUT_MS = 30 * 1000;
const UPLOAD_TIMEOUT_MS = 5 * 60 * 1000;
const MAX_QUEUE = 5000;
// The most windows one request may carry. Only a queue caught up after an outage is sent in
// batches; a window measured while the engine answers leaves alone.
const BATCH_MAX_WINDOWS = 64;
// The keys of `counts`, in the order they are written. A window read back from the editor's
// store may return its keys in any order, so the order is stated here rather than inherited.
const COUNT_KEYS = ['corrections', 'reformulations', 'revisions', 'jumps', 'exits', 'back_keys', 'back_chars'];
// The words a window may give for why it was sealed.
const WHY = new Set(['idle', 'volume', 'save', 'focus', 'away', 'end']);
// What a session identifier looks like.
const SESSION_ID = /^[A-Za-z0-9_-]{16,64}$/;

// The keys that belong to an account rather than to the installation, cleared when a session
// ends. `config` is not among them: its engine address and language are kept, so the next
// pairing starts where this one did rather than from nothing.
//
// They live in the **workspace's** store, not the global one. The editor keeps an extension's
// global state as one value shared by every open window, and a window that writes replaces what
// the others hold: a queue kept there was emptied by the window that finished draining while
// another was adding to it. A workspace is open in one window at a time, so its store has one
// writer. What the windows do share is the account, hence `accountEpoch` (see `stale`).
const ACCOUNT_KEYS = ['engineIds', 'names', 'syncedNames', 'queue', 'queueSent', 'status'];
// What the agent counts about itself and sends to POST /api/plugins/telemetry — the contract is
// docs/moteur.md, « Ce que l'agent dit de lui-même ». A closed vocabulary, in the order of the
// table there: what is counted is one of these words, never a string formed at run time, and
// never a message — an exception's text, in a writing tool, may quote the student. Of an
// exception of our own, what leaves beside the count is a fault: where it broke (`faultOf`).
// The four agents declare the same three constants and `make check` compares them.
const TELEMETRY_EVENTS = [
    'installed', 'updated', 'started',
    'error.runtime', 'error.engine', 'error.rejected', 'error.auth',
    'network.failure', 'queue.dropped',
];
// At most one report every fifteen minutes, on the loop that already drains the queue.
const TELEMETRY_FLUSH_MS = 15 * 60 * 1000;
// Where a count stops: past it the engine would clip it anyway.
const TELEMETRY_MAX_COUNT = 10000;
// The distinct faults kept between two reports, and the frames kept of each: the first ten of a
// broken build say where it breaks, and a dozen innermost frames say where in it. The engine
// refuses more of either.
const TELEMETRY_MAX_FAULTS = 10;
const TELEMETRY_MAX_FRAMES = 12;
// The pairing poll's "keep waiting" answers. They are RFC 8628 working as designed, answered every
// five seconds while the student confirms the code: counted as refusals, they would bury the real
// ones.
const PAIRING_PENDING = new Set(['device_authorization_pending', 'device_slow_down']);

// The longest name the engine takes for a document.
const DOCUMENT_NAME_MAX = 255;

// « Signaler un problème » — the contract is docs/moteur.md, « Signaler un problème ». The link
// opens the engine's own help form, prefilled: everything rides in the fragment, which a browser
// never sends to a server, and the block is lines `key: value` with these keys, in this order,
// fixed and in English. The four agents declare the same two constants and `make check`
// compares them.
const REPORT_FRAGMENT = '#report';
const REPORT_KEYS = ['agent', 'host', 'os', 'language', 'engine', 'signed_in', 'paused', 'status', 'queued', 'counters', 'at'];
// The block's length before encoding: the engine bounds the whole message, the rest is the
// student's.
const REPORT_MAX = 1500;
// One value's length: eleven of them always fit under REPORT_MAX, so the cap on the block never
// has to take a line away.
const REPORT_VALUE_MAX = 120;

/**
 * Where the windows waiting for the engine are kept: the host's to provide (a file under the
 * workspace's storage folder, `queue-file.js`), this client's to mirror in memory, so that
 * `state()` and `pending()` stay synchronous. Each method is called under the client's lock.
 *
 * Stopped between any two of its writes, a store may make a window go again — the engine takes
 * it for the resend it is — and must never skip one.
 * @typedef {object} QueueStore
 * @property {() => Promise<object[]>} load the windows still waiting, oldest first.
 * @property {(item: object) => Promise<void>} append one window at the tail.
 * @property {(count: number) => Promise<void>} advance `count` more windows at the head have left.
 * @property {(items: object[]) => Promise<void>} rewrite what waits is now `items`, and only them.
 * @property {() => Promise<void>} clear nothing waits any more (a sign-out).
 */

/**
 * The queue kept in the workspace's Memento, under `queue` and `queueSent`: what the client
 * falls back on when the host has no folder to give it (no workspace open, a storage that is
 * not a local path) — and what every queue was before the file.
 *
 * A Memento serialises its whole content on every write, so nothing here is cheaper than
 * rewriting the array; the array is therefore compacted wherever it is rewritten anyway (an
 * append), and `queueSent` is what a send writes. The cursor always goes to zero first: stopped
 * between the two writes, the old array is read from its start and windows go twice, never
 * the new array from the old cursor.
 * @param {{get: Function, set: Function}} local
 * @returns {QueueStore}
 */
function mementoQueue(local) {
    return {
        load: async () => local.get('queue', []).slice(local.get('queueSent', 0)),
        append: async (item) => {
            const sent = local.get('queueSent', 0);
            const waiting = local.get('queue', []).slice(sent);
            waiting.push(item);
            if (sent !== 0) await local.set('queueSent', 0);
            await local.set('queue', waiting);
        },
        advance: (count) => local.set('queueSent', local.get('queueSent', 0) + count),
        rewrite: async (items) => {
            await local.set('queueSent', 0);
            await local.set('queue', items);
        },
        clear: async () => {
            for (const key of ['queueSent', 'queue']) {
                if (local.get(key) !== undefined) await local.set(key, undefined);
            }
        },
    };
}

// A name the account does not hold yet, made from one it does. The engine keeps one living
// document per name and per account, and a document created from a sealed window is created
// with nobody watching: the name is then the agent's to choose, so the agent chooses one that
// is free — the name, and the second it was created at.
function freeName(name, now = new Date()) {
    const pad = (n) => String(n).padStart(2, '0');
    const stamp = ` (${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} `
        + `${pad(now.getHours())}.${pad(now.getMinutes())}.${pad(now.getSeconds())})`;
    return name.slice(0, DOCUMENT_NAME_MAX - stamp.length) + stamp;
}

// The engine caps a request body at 25 MiB; in base64 the source grows by a third.
const MAX_UPLOAD_BASE64 = 24 * 1024 * 1024;
const { t, dateLocale, setLanguage, currentLanguage } = require('./i18n.js');
const path = require('node:path');
const { fileURLToPath } = require('node:url');

// --- WHERE OUR CODE BROKE ---
// A fault, as the telemetry report carries it (docs/moteur.md, « Ce que l'agent dit de
// lui-même »): the exception's type and the frames of its stack that are this extension's own
// files, innermost first, as `function@file.js:line:column`. **Never the message**: an exception
// text in a writing tool can quote what the student wrote. The extension is not minified, so a
// file, a line and a function name are a position in the published source of this build.
//
// A frame of ours keeps its bare file name and never its directory: the extension is installed
// under the student's home, whose path names their account. A frame anywhere else — the editor's,
// another extension's, Node's — is skipped. Only Node's `    at` lines are read: the lines before
// them are the message, which may run over several lines and say anything.
const OWN_DIR = __dirname + path.sep;
const FAULT_TYPE = /^[A-Za-z][A-Za-z0-9]{0,47}$/;
const FAULT_FILE = /^[A-Za-z0-9_-]{1,64}\.(?:js|mjs|cjs)$/;
const FAULT_FUNCTION = /^[A-Za-z_$<][A-Za-z0-9_$.<>]{0,79}$/;
const V8_FRAME = /^\s+at (?:async )?(?:(.+?) \()?(.+?):(\d+):(\d+)\)?$/;

/**
 * @param {unknown} type the exception's `name`
 * @param {unknown} stack the exception's `stack`
 * @param {string} [own] the directory our files live in, with its trailing separator
 * @returns {{ type: string, frames: string[] }}
 */
function faultOf(type, stack, own = OWN_DIR) {
    const frames = [];
    for (const line of (typeof stack === 'string' ? stack : '').split('\n')) {
        if (frames.length >= TELEMETRY_MAX_FRAMES) break;
        const match = V8_FRAME.exec(line);
        if (!match) continue;
        let where = match[2];
        if (where.startsWith('file://')) {
            try {
                where = fileURLToPath(where);
            } catch (_) {
                continue;
            }
        }
        if (!where.startsWith(own)) continue;
        const file = where.slice(own.length);
        if (!FAULT_FILE.test(file)) continue;
        const name = (match[1] || '').replace(/^(?:new |async )/, '');
        frames.push(`${FAULT_FUNCTION.test(name) ? name + '@' : ''}${file}:${match[3]}:${match[4]}`);
    }
    return { type: typeof type === 'string' && FAULT_TYPE.test(type) ? type : 'Other', frames };
}

/** @param {{ type: string, frames: string[] }} fault */
function faultKey(fault) {
    return [fault.type, ...fault.frames].join('\n');
}

class HttpError extends Error {
    constructor(status, message, code) {
        super(message);
        this.status = status;
        // The engine names the rule that refused the request ({"code", "error"}).
        this.code = code || '';
        // Set when what failed is the creation of a document, not what was to be sent to it.
        this.creation = false;
    }
}

// What a failure reads as for the student. A pairing refused — an expired code, a code somebody
// said they had not asked for — is already worded, and says what to do next; read as a 401 it
// would become "wrong credentials", and send them looking for a password nobody asked for.
function errorMessage(err) {
    const refusal = err instanceof HttpError && err.code.startsWith('device_');
    if (err instanceof HttpError && err.status === 401 && !refusal) return t('error.credentials');
    return (err && err.message) || String(err);
}

/**
 * @param {unknown} value
 * @param {number[]} bounds the lowest and the highest value allowed
 * @param {number} fallback what a value that is not a number reads as
 */
const clamp = (value, bounds, fallback) => Math.min(Math.max(Number(value) || fallback, bounds[0]), bounds[1]);

const wholeNumber = (value) => Number.isInteger(value) && value >= 0;

// Whether a queue entry is a window this client can send: it names its session and carries the
// window the sensor sealed, with every block the body requires. Anything else — an entry left
// by a build that queued another shape — is dropped from the queue rather than sent: the
// engine would refuse it, and there is no other body to rebuild it into.
function sendable(item) {
    const window = item && item.window;
    return !!window && typeof item.documentId === 'string'
        && typeof item.session === 'string' && SESSION_ID.test(item.session)
        && wholeNumber(window.seq) && wholeNumber(window.at) && wholeNumber(window.mono)
        && wholeNumber(window.ms) && wholeNumber(window.active) && WHY.has(window.why)
        && Array.isArray(window.runs) && window.runs.length > 0 && window.runs.every(Array.isArray)
        && !!window.counts && typeof window.counts === 'object'
        && !!window.sum && [window.sum.keys, window.sum.chars, window.sum.pastes].every(wholeNumber);
}

function trimUrl(url) {
    return String(url || '').replace(/\/+$/, '');
}

// --- WHERE THE TOKEN MAY TRAVEL ---
//
// The student can point the extension at another engine, and that address decides where an API
// token **that never expires** is sent. Over `http:` it crosses the network in the clear, and a
// token read once is a token kept. Refusing `http:` outright would break the deployment it
// exists for — an establishment serving its engine on its own intranet — so the rule is about
// the host: plain `http:` is accepted exactly where the request cannot leave the building. A
// single label (`moteur`), but not an all-digit one; localhost and `127.0.0.0/8` or `::1`;
// `*.local`; the private ranges and IPv6 unique local. Everything else must be `https:`.
//
// **The four agents hold this pattern character for character** — `browser/src/constants.js`
// carries the long version of this comment, and `make check` compares the four.
const LOCAL_ENGINE_HOST = /^(?:(?!\d+$)[^.:]+|(?:.+\.)?local|(?:.+\.)?localhost|127\.\d+\.\d+\.\d+|::1|10\.\d+\.\d+\.\d+|172\.(?:1[6-9]|2\d|3[01])\.\d+\.\d+|192\.168\.\d+\.\d+|f[cd][0-9a-f]{2}:.*)$/i;

function engineUrlAllowed(rawUrl) {
    let url;
    try {
        url = new URL(String(rawUrl).trim());
    } catch (_) {
        return false;
    }
    if (url.protocol === 'https:') return true;
    if (url.protocol !== 'http:') return false;
    // `new URL('http://[::1]/')` keeps the brackets in `hostname`; Python's urlparse does not,
    // and the pattern is shared with it.
    return LOCAL_ENGINE_HOST.test(url.hostname.replace(/^\[|\]$/g, ''));
}

// The engine's address, checked on the way out. Every call this client makes goes through here:
// the address comes from the student, through a panel that is a webview and decides nothing,
// and it may have been stored before this rule existed.
function engineBase(engineUrl) {
    // The code is what lets `errorText` hand this sentence straight to the student rather
    // than folding it into "engine unreachable", which is how a status 0 reads by default.
    if (!engineUrlAllowed(engineUrl)) throw new HttpError(0, t('error.engineUrlInsecure'), 'engine_url_refused');
    return trimUrl(engineUrl);
}

// The address the engine says to open, kept only if it is one a browser should follow.
//
// It is a string from a server whose address the student is free to change, and this agent does
// not merely put it in an `href`: it hands it to `vscode.env.openExternal`, which gives an
// unknown scheme to whatever the operating system has registered for it. A refusal falls back to
// the engine's own device page — the pairing is still valid, only the shortcut is lost.
function verificationUri(value, engineUrl) {
    try {
        const url = new URL(value);
        if (url.protocol === 'https:' || url.protocol === 'http:') return url.href;
    } catch (_) { /* not an absolute URL at all */ }
    return engineUrl + '/device';
}

// The report block (docs/moteur.md, « Le bloc »): one line per key of REPORT_KEYS, in that
// order, none ever left out — a value missing reads `unknown`, so two reports read line by line.
// A value is one line: a line break or any other control character inside it becomes a space.
// The block stops at REPORT_MAX, and only ever between two lines.
function reportBlock(values) {
    const lines = REPORT_KEYS.map((key) => {
        const raw = values[key];
        const value = raw === undefined || raw === null ? '' : String(raw);
        const flat = value.replace(/[\p{Cc}\p{Zl}\p{Zp}]+/gu, ' ').trim().slice(0, REPORT_VALUE_MAX);
        return `${key}: ${flat || 'unknown'}`;
    });
    let block = '';
    for (const line of lines) {
        const next = block ? `${block}\n${line}` : line;
        if (next.length > REPORT_MAX) break;
        block = next;
    }
    return block;
}

// The origin of an address, '' when it is not one.
function originOf(url) {
    try {
        const origin = new URL(String(url).trim()).origin;
        return origin === 'null' ? '' : origin;
    } catch (_) {
        return '';
    }
}

// Refusals the agent words itself instead of passing on the engine's sentence. The engine names
// the rule it applied and answers in English — the only language its fallback messages have —
// so a code it can act on is reworded here, once, for every call that may meet it.
const REWORDED = {
    deadline_passed: 'error.deadlinePassed',
    // A name the student chose, and already gave to another of their documents: said, never
    // worked around — renaming behind somebody is how two documents end up with names nobody
    // chose. A document created with nobody watching takes a free name instead (`freeName`).
    document_name_taken: 'error.nameTaken',
    // The two ends of a pairing that will not complete. Passed on as they come, the student
    // would read the engine's English sentence at the one moment they are waiting on a screen.
    device_code_expired: 'pair.expired',
    device_denied: 'pair.denied',
};

// Whether an assignment's deadline has gone by. The deadline is the door: the engine refuses a
// hand-in past it, and refuses to touch a copy already handed in — until a teacher pushes it,
// which reopens everything at once. Read locally rather than asked for, since the agent already
// holds the date.
function deadlinePassed(deadline) {
    return !!deadline && new Date(deadline) < new Date();
}

// The deadline as the student reads it, in the language the interface is in.
function formatDeadline(iso) {
    return new Date(iso).toLocaleDateString(dateLocale(), { day: 'numeric', month: 'short' });
}

/**
 * The engine client and its queue.
 *
 * It knows nothing of VS Code: the host hands it a `store` (a key/value map it persists), a
 * `queue` (where the windows waiting are kept), a `secrets` (where the API token is kept) and the
 * timers, which is what lets the queue be exercised without an editor.
 */
class Engine {
    /**
     * @param {object} host what the editor provides; the last three are the tests' seams.
     * @param {{get: Function, set: Function}} host.store persisted key/value map, shared by every window.
     * @param {{get: Function, set: Function}} [host.local] the same, for this workspace alone: where
     *   the files' engine documents are kept. The shared one when none is given.
     * @param {QueueStore} [host.queue] where the windows waiting are kept, for this workspace
     *   alone. In `local`, under `queue` and `queueSent`, when none is given (`mementoQueue`).
     * @param {{get: Function, set: Function, delete: Function}} host.secrets where the API token lives.
     * @param {string} host.userAgent how this agent announces itself (see docs/moteur.md).
     * @param {string} [host.version] the extension's own build, declared to the engine.
     * @param {string} host.hostLanguage the editor's display language, until the account's is known.
     * @param {typeof globalThis.fetch} [host.fetch] Node's own, unless a test hands over another.
     * @param {Function} [host.schedule] setInterval, unless a test drives the clock.
     * @param {Function} [host.cancel] clearInterval, likewise.
     * @param {() => number} [host.now] Date.now, unless a test moves the clock.
     */
    constructor({ store, local, queue, secrets, userAgent, version, hostLanguage, fetch: fetchImpl, schedule, cancel, now }) {
        this.store = store;
        this.local = local || store;
        this.queue = queue || mementoQueue(this.local);
        // Whether the queue lives outside `local`: a queue an earlier build left there is then
        // moved over once (`loadQueue`).
        this.queueOwn = !!queue;
        // The queue's mirror, read once from `this.queue` (`loadQueue`) and kept in step with
        // every write to it: the windows as stored, and how many at the head have left. Null
        // until read.
        /** @type {object[] | null} */
        this.queued = null;
        this.queuedHead = 0;
        // The editor's display language, used until the account's own is known.
        this.hostLanguage = hostLanguage;
        this.secrets = secrets;
        this.userAgent = userAgent;
        this.version = version || '';
        this.fetch = fetchImpl || globalThis.fetch;
        this.schedule = schedule || setInterval;
        this.cancel = cancel || clearInterval;
        this.now = now || Date.now;
        // Set while a telemetry report is on its way, so two loops never send the same counts.
        this.reporting = false;
        this.listeners = [];
        this.retryTimer = null;
        // Every read/write of the queue goes through this lock: a send and a new measurement
        // never step on each other, nor create two documents for the same file.
        this.lock = Promise.resolve();
    }

    // --- 1. STORAGE ---
    state() {
        // The queue is the in-memory mirror, read from its cursor: the windows already pushed stay
        // at the head until something compacts it, and everything outside this method only ever
        // sees what is still waiting. Draining used to rewrite the array after each window — a
        // day caught up offline wrote megabytes thousands of times — and what it writes now is a
        // cursor (`QueueStore.advance`).
        return {
            engineIds: this.account('engineIds', {}),
            // Path of each file in the project: the last one seen, and the one last sent to the
            // engine. A file renamed or moved in the project is renamed on the engine too.
            names: this.account('names', {}),
            syncedNames: this.account('syncedNames', {}),
            queue: this.stale() ? [] : this.waiting(),
            status: this.status(),
        };
    }

    /**
     * Whether this workspace's account state was left by another session than the current one.
     *
     * Signing out, or pairing as somebody else, happens in one window and must end what every
     * workspace holds: a queue left in another one would be sent under the next account's
     * bearer. The window that signs out can only clear its own workspace, so it raises a number
     * every window reads (`accountEpoch`, in the shared store), and each workspace remembers the
     * one its state was written under. A workspace found behind is read as empty, and emptied
     * the next time the lock is taken (`reconcile`).
     */
    stale() {
        return this.local.get('epoch', 0) !== this.store.get('accountEpoch', 0);
    }

    /** One of ACCOUNT_KEYS, as the current session left it. */
    account(key, fallback) {
        return this.stale() ? fallback : this.local.get(key, fallback);
    }

    // Under the lock, before anything is written beside what a past session left.
    async reconcile() {
        await this.loadQueue();
        if (!this.stale()) return;
        for (const key of ACCOUNT_KEYS) await this.local.set(key, undefined);
        await this.clearQueue();
        await this.local.set('epoch', this.store.get('accountEpoch', 0));
    }

    // --- The queue's mirror. Every write goes to the store first, then to the mirror: a write
    // that fails leaves the mirror saying what the store says.

    /**
     * The windows still waiting, a copy.
     * @returns {any[]}
     */
    waiting() {
        return this.queued ? this.queued.slice(this.queuedHead) : [];
    }

    /**
     * Reads the queue once, under the lock. A queue an earlier build kept in the workspace's
     * Memento is moved into the host's store first — the file is written before the Memento is
     * emptied, so a stop in between sends those windows twice rather than never. A store that
     * cannot be read (a storage folder refused) gives way to the Memento: the windows are kept
     * the slow way rather than not at all.
     */
    async loadQueue() {
        if (this.queued) return;
        let items;
        try {
            items = await this.queue.load();
        } catch (err) {
            console.warn('Certimens: the queue file cannot be read — kept in the workspace state', (err && err.message) || err);
            this.queue = mementoQueue(this.local);
            this.queueOwn = false;
            items = await this.queue.load();
        }
        if (this.queueOwn && this.local.get('queue') !== undefined) {
            // A stale workspace's leftovers are not moved: `reconcile` is about to clear them.
            const legacy = this.stale() ? [] : this.local.get('queue', []).slice(this.local.get('queueSent', 0));
            if (legacy.length > 0) {
                items = [...legacy, ...items].slice(-MAX_QUEUE);
                await this.queue.rewrite(items);
            }
            await this.local.set('queueSent', undefined);
            await this.local.set('queue', undefined);
        }
        this.queued = items;
        this.queuedHead = 0;
        if (items.length > 0) this.notify();
    }

    async appendQueue(item) {
        await this.queue.append(item);
        this.queued.push(item);
    }

    async advanceQueue(count) {
        await this.queue.advance(count);
        this.queuedHead += count;
    }

    async rewriteQueue(items) {
        await this.queue.rewrite(items);
        this.queued = items;
        this.queuedHead = 0;
    }

    async clearQueue() {
        await this.queue.clear();
        this.queued = [];
        this.queuedHead = 0;
    }

    status() {
        return this.account('status') || { state: 'idle' };
    }

    // How many windows are waiting, without copying them: the status bar asks at every change.
    pending() {
        return this.stale() || !this.queued ? 0 : this.queued.length - this.queuedHead;
    }

    config() {
        // language: the account's own, sent by the engine at login, so the panel and every
        // message open in the language the student chose in their Certimens space.
        return { engineUrl: DEFAULT_ENGINE_URL, email: '', displayName: '', tokenId: '', language: '', ...this.store.get('config', {}) };
    }

    token() {
        return this.secrets.get('token');
    }

    async configured() {
        return !!(await this.token());
    }

    // Written only when it says something new: the loop comes through here every minute, in
    // every window, and a write is a whole store serialised and every listener redrawn.
    async setStatus(status) {
        const current = this.status();
        if (current.state === status.state && current.message === status.message
            && !!current.reached === !!status.reached) return;
        await this.local.set('status', status);
        this.notify();
    }

    onChange(listener) {
        this.listeners.push(listener);
        return () => {
            this.listeners = this.listeners.filter((l) => l !== listener);
        };
    }

    notify() {
        for (const listener of [...this.listeners]) listener();
    }

    withLock(fn) {
        const run = this.lock.then(fn, fn);
        this.lock = run.catch(() => {});
        return run;
    }

    // --- 2. ENGINE API ---
    // JSON body of an engine response, or an HttpError carrying its message.
    async read(res) {
        if (!res.ok) {
            let message = res.statusText;
            let code = '';
            try {
                const body = await res.json();
                message = body.error || message;
                code = body.code || '';
            } catch (_) { /* non-JSON body */ }
            throw new HttpError(res.status, REWORDED[code] ? t(REWORDED[code]) : message, code);
        }
        // The metrics 201 returns the text "Created" (Fiber's SendStatus): only JSON is read.
        if (!(res.headers.get('Content-Type') || '').includes('application/json')) return null;
        return res.json();
    }

    /**
     * The declaration this agent sends: its kind, and its build when the host named one.
     *
     * Every call carries `X-Certimens-Agent: <kind>/<version>`. The engine stores it beside each
     * measurement — so whoever reads the copy is told it was written in the editor and with which
     * build of this extension — and flags a push that names nothing, because every agent speaks up.
     *
     * It proves nothing, and is not meant to: this extension ships as readable source, so the
     * header can be copied out of it. What it buys is **precision** the transport signature
     * cannot give, and what keeps it honest is that the engine checks the two against each other.
     *
     * The three other agents make the same declaration, with the same header and the same shape;
     * `make check` compares the four.
     */
    agentDeclaration() {
        // The charset the engine accepts for a build label, applied here rather than trusted: a
        // version outside it makes the whole declaration unreadable.
        const label = this.version.replace(/[^A-Za-z0-9._+-]/g, '').slice(0, AGENT_VERSION_MAX);
        return label ? `${AGENT_KIND}/${label}` : AGENT_KIND;
    }

    // The User-Agent is set explicitly, and it is what the engine recognizes this agent by
    // (its client family): Node sends none of the headers a browser adds on its own, so without
    // it every push would be filed as coming from a client the platform does not know.
    headers(token) {
        const headers = {
            'Content-Type': 'application/json',
            'User-Agent': this.userAgent,
            [AGENT_HEADER]: this.agentDeclaration(),
        };
        if (token) headers['Authorization'] = `Bearer ${token}`;
        return headers;
    }

    // Every call of the agent's work goes through here — pairing, documents, measurements,
    // assignments — so this is where its failures are counted, once. The telemetry report does
    // not come through here (`reportTelemetry`): an engine out of reach would otherwise grow the
    // very count that says it is out of reach. `pending` marks the pairing poll, whose "keep
    // waiting" answers are not refusals.
    async request(method, url, body, token, { pending = false, timeout = REQUEST_TIMEOUT_MS } = {}) {
        let res;
        try {
            res = await this.fetch(url, {
                method,
                headers: this.headers(token),
                body: body === undefined ? undefined : JSON.stringify(body),
                signal: AbortSignal.timeout(timeout),
            });
        } catch (err) {
            this.count('network.failure');
            // An aborted call is worded here: what the runtime says of it names the mechanism.
            const timedOut = err && err.name === 'TimeoutError';
            throw new HttpError(0, timedOut ? t('error.networkError') : err.message || t('error.networkError'));
        }
        try {
            return await this.read(res);
        } catch (err) {
            if (err instanceof HttpError && !(pending && (PAIRING_PENDING.has(err.code) || err.status === 429))) {
                if (err.status >= 500) this.count('error.engine');
                else if (err.status === 401) this.count('error.auth');
                else if (err.status >= 400) this.count('error.rejected');
            }
            throw err;
        }
    }

    async api(method, path, body, options) {
        const token = await this.token();
        if (!token) throw new HttpError(401, t('error.noToken'));
        return this.request(method, engineBase(this.config().engineUrl) + path, body, token, options);
    }

    /**
     * Opens a pairing: the engine answers with a short code to show and a long one to poll with.
     * No password is asked for anywhere — an account that signs in through Google, through its
     * establishment's provider or from a Moodle launch has none, and a password box in an editor
     * is the exact shape a counterfeit extension would take.
     */
    async startPairing(engineUrl) {
        const url = engineBase(engineUrl || DEFAULT_ENGINE_URL);
        const res = await this.request('POST', url + '/api/auth/device', { client: t('pair.clientVscode') });
        return {
            engineUrl: url,
            deviceCode: res.device_code,
            userCode: res.user_code,
            verificationUri: verificationUri(res.verification_uri, url),
            verificationUriComplete: verificationUri(res.verification_uri_complete || res.verification_uri, url),
            expiresAt: Date.now() + clamp(res.expires_in, PAIRING_EXPIRES_S, 600) * 1000,
            interval: clamp(res.interval, PAIRING_INTERVAL_S, 5) * 1000,
        };
    }

    /**
     * Asks once whether a pairing has been confirmed. Returns the API token, or null while
     * nobody has confirmed yet; every other refusal throws, because each means something the
     * student has to be told.
     */
    async pollPairing(pairing) {
        try {
            const res = await this.request('POST', engineBase(pairing.engineUrl) + '/api/auth/device/token', {
                device_code: pairing.deviceCode,
            }, undefined, { pending: true });
            return res.token;
        } catch (err) {
            // Nobody has confirmed yet, or we asked again too soon: both are "keep waiting". A
            // 429 says the same thing from the layer in front of the engine — the exchange is
            // alive on the other side, and this machine is one caller too many on this address.
            // Either way the next attempt waits five seconds longer, as RFC 8628 has it.
            if (err && (err.code === 'device_slow_down' || err.status === 429)) {
                pairing.interval += SLOW_DOWN_MS;
                return null;
            }
            if (err && err.code === 'device_authorization_pending') return null;
            throw err;
        }
    }

    /** Completes a pairing: reads who the token belongs to, and keeps it in secret storage. */
    async adoptToken(engineUrl, token) {
        const url = engineBase(engineUrl || DEFAULT_ENGINE_URL);
        const me = await this.request('GET', url + '/api/auth/me', undefined, token);
        const tokens = await this.request('GET', url + '/api/auth/tokens', undefined, token);
        // The id of this very token, so signing out revokes it; the engine never returns a raw
        // token twice, so it is found by being the newest one.
        const tokenId = (tokens[0] && tokens[0].id) || '';

        setLanguage(me.language, this.hostLanguage);
        // Under the lock: a send in flight would otherwise write its cursor and the documents
        // it created back over what is cleared here.
        await this.withLock(async () => {
            // Signing in again as somebody else — another account, or the same address on
            // another engine — without signing out first, leaves exactly the residue a sign-out
            // would have cleared, and no gesture forbids it. Same door.
            const previous = this.config();
            const changed = previous.email !== (me.email || '') || trimUrl(previous.engineUrl) !== url;
            if (previous.email && changed) await this.clearAccountState();
            await this.secrets.set('token', token);
            // Not a credential: it says a session exists, not whose. The host reads it on every
            // editor event, where it cannot await the secret store.
            await this.store.set('signedIn', true);
            // displayName: computed by the engine, which falls back to the e-mail when the
            // account has no name. An engine too old to send it leaves it empty.
            await this.store.set('config', {
                engineUrl: url, email: me.email || '',
                displayName: me.display_name || '', tokenId, language: me.language || '',
            });
            await this.reconcile();
            await this.setStatus({ state: 'idle' }); // clears any auth_error before the next send
        });
        return me;
    }

    async logout() {
        const { tokenId } = this.config();
        // Whether the engine really destroyed the credential, rather than whether we tried. The
        // local wipe happens either way, but a student told their token was revoked when it is
        // still live has been told the one thing that would have made them act.
        let revoked = false;
        if (tokenId) {
            try {
                await this.api('DELETE', `/api/auth/tokens/${tokenId}`);
                revoked = true;
            } catch (err) {
                // The engine no longer knows this token, or no longer accepts it: it is as dead
                // as a revocation would have made it. Anything else — no answer, a 5xx — leaves
                // it alive, and the caller says so.
                revoked = err.status === 401 || err.status === 404;
            }
        }
        // Under the lock, like every write to the queue: a send in flight finishes first, and
        // cannot then write its cursor back over what is cleared here.
        await this.withLock(async () => {
            await this.secrets.delete('token');
            // The host reads this synchronously to know whether to keep measuring.
            await this.store.set('signedIn', false);
            await this.clearAccountState();
            await this.store.set('config', { engineUrl: this.config().engineUrl, language: this.config().language });
            await this.setStatus({ state: 'unconfigured' });
        });
        return revoked;
    }

    /**
     * Everything the revoked token authorised on this installation, as opposed to the token
     * itself. Revoking ends what the credential can do at the engine; this ends what it left
     * behind here. The map, the names it synced and a queued window all outlive it otherwise,
     * and the next account to pair inherits them and sends them under its own bearer.
     */
    async clearAccountState() {
        // Raised first: the other windows read their own workspace as empty from here on.
        const epoch = this.store.get('accountEpoch', 0) + 1;
        await this.store.set('accountEpoch', epoch);
        for (const key of ACCOUNT_KEYS) await this.local.set(key, undefined);
        await this.clearQueue();
        await this.local.set('epoch', epoch);
    }

    // --- 3. FILES ---
    // Creates the file's engine document if needed. The name sent is the project-relative path: an
    // absolute one would carry the student's account name to the engine for nothing.
    async ensureDocument(engineIds, item) {
        if (engineIds[item.documentId]) return engineIds[item.documentId];
        const file = await this.createDocument(item.documentName);
        engineIds[item.documentId] = file.id;
        await this.local.set('engineIds', engineIds);
        const syncedNames = this.account('syncedNames', {});
        syncedNames[item.documentId] = item.documentName;
        await this.local.set('syncedNames', syncedNames);
        return file.id;
    }

    /**
     * Creates an engine document under `name`, or under a free name made from it when the
     * account already holds one called that (409 `document_name_taken`): the same project
     * opened on a second machine, or after signing out and in again. Read as a refusal of the
     * window, that 409 threw away every measurement of the file, for good and without a word.
     *
     * Whatever it throws is marked `creation`: it says nothing of the window that was waiting
     * for the document, which stays in the queue.
     */
    async createDocument(name) {
        const clipped = name.slice(0, DOCUMENT_NAME_MAX);
        try {
            try {
                return await this.api('POST', '/api/documents', { name: clipped });
            } catch (err) {
                if (err.code !== 'document_name_taken') throw err;
            }
            return await this.api('POST', '/api/documents', { name: freeName(clipped, new Date(this.now())) });
        } catch (err) {
            err.creation = true;
            throw err;
        }
    }

    // Propagates to the engine the files renamed or moved in the project since the last send.
    async syncNames(state) {
        for (const [documentId, name] of Object.entries(state.names)) {
            const engineId = state.engineIds[documentId];
            if (!engineId || state.syncedNames[documentId] === name) continue;
            try {
                await this.api('PUT', `/api/documents/${engineId}`, { name });
            } catch (err) {
                // A refusal of this very rename is final: a 404 is a file deleted, recreated on
                // the next send; `deadline_passed` a copy frozen; a 409 a name already taken.
                // Noting it as synced anyway is what stops it being retried at every drain, and
                // the sending status going red over a refusal nobody here can act on. A rename
                // made after the teacher pushes the deadline does go through; this one stays as
                // it was when the window shut. What is not final is what says nothing of the
                // rename: no answer, a token refused, a limiter, an engine that failed.
                const final = err.status >= 400 && err.status < 500 && ![401, 408, 429].includes(err.status);
                if (!final) throw err;
            }
            state.syncedNames[documentId] = name;
            await this.local.set('syncedNames', state.syncedNames);
        }
    }

    // A file's path as last seen in the project (on open, then on every rename).
    noteName(documentId, documentName) {
        if (!documentId || !documentName) return Promise.resolve();
        return this.withLock(async () => {
            await this.reconcile();
            const names = this.local.get('names', {});
            if (names[documentId] === documentName) return;
            names[documentId] = documentName;
            await this.local.set('names', names);
        });
    }

    /**
     * A file, or a folder of files, was renamed or moved in the project: everything known under
     * the old identity now answers to the new one — the engine document, the name to send it,
     * and the windows still waiting. `from` and `to` are identities (`vscode:<project>:<path>`),
     * `name` the new path as the engine displays it; a folder carries every file below it.
     *
     * Keeping the old identity instead is what made a renamed file a second document: the file
     * reopened under its new path had no engine document, and created one. The engine document
     * is renamed by the next `syncNames`, the name last sent to it being the old one.
     */
    moveFile(from, to, name) {
        return this.withLock(async () => {
            await this.reconcile();
            const moved = (id) => (id === from || id.startsWith(from + '/') ? to + id.slice(from.length) : null);
            for (const key of ['engineIds', 'syncedNames', 'names']) {
                const map = this.local.get(key, {});
                let changed = false;
                for (const id of Object.keys(map)) {
                    const target = moved(id);
                    if (!target) continue;
                    map[target] = key === 'names' ? name + id.slice(from.length) : map[id];
                    delete map[id];
                    changed = true;
                }
                if (key === 'names' && map[to] !== name) {
                    // Known or not before the move: the file is named from here on.
                    map[to] = name;
                    changed = true;
                }
                if (changed) await this.local.set(key, map);
            }
            // Rare, and the one write of the queue that depends on what is in it: rewritten whole
            // (and compacted with it), only when a window waiting does belong to the file moved.
            let requeued = false;
            const renamed = this.waiting().map((item) => {
                const target = item && typeof item.documentId === 'string' ? moved(item.documentId) : null;
                if (!target) return item;
                requeued = true;
                return { ...item, documentId: target, documentName: name + item.documentId.slice(from.length) };
            });
            if (requeued) await this.rewriteQueue(renamed);
        });
    }

    // Engine file of a project file (null when none was created yet, or it was deleted there).
    async fileInfo(documentId) {
        const engineId = this.account('engineIds', {})[documentId];
        if (!engineId) return { engineId: null, file: null };
        try {
            return { engineId, file: await this.api('GET', `/api/documents/${engineId}`) };
        } catch (err) {
            if (err.status !== 404) throw err;
            await this.forget(documentId);
            return { engineId: null, file: null };
        }
    }

    forget(documentId) {
        return this.withLock(async () => {
            const engineIds = this.account('engineIds', {});
            delete engineIds[documentId];
            await this.local.set('engineIds', engineIds);
        });
    }

    // Explicit creation of a project file's engine document, before handing it in; no-op if it
    // exists.
    createFileFor(documentId, documentName) {
        return this.withLock(async () => {
            await this.reconcile();
            const engineIds = this.local.get('engineIds', {});
            const existed = !!engineIds[documentId];
            const engineId = await this.ensureDocument(engineIds, { documentId, documentName });
            return { engineId, existed };
        });
    }

    // Assignments the student is enrolled in. Submitting is reserved for students: any other
    // role (teacher, administrator, free account) has none.
    async listAssignments() {
        const me = await this.api('GET', '/api/auth/me');
        if (me.role !== 'student') return [];
        return this.api('GET', '/api/assignments');
    }

    /**
     * Sends a file's source to its engine document, replacing what was already sent. This is the one
     * place where the student's own text leaves the machine, and it only ever runs on an explicit
     * command: the measurement itself sends numbers and categories, and nothing else.
     */
    async uploadDocument(documentId, text) {
        const engineId = this.account('engineIds', {})[documentId];
        if (!engineId) throw new HttpError(404, t('error.noFile'));
        const document = Buffer.from(text, 'utf8').toString('base64');
        if (document.length > MAX_UPLOAD_BASE64) throw new HttpError(413, t('error.tooLarge'));
        return this.api('PUT', `/api/documents/${engineId}`, { document }, { timeout: UPLOAD_TIMEOUT_MS });
    }

    // The engine silently ignores an assignment the student isn't enrolled in: we detect it.
    async submitDocument(engineId, assignmentId) {
        const file = await this.api('PUT', `/api/documents/${engineId}`, { assignment_id: assignmentId });
        if (file.assignment_id !== assignmentId) throw new HttpError(403, t('error.notEnrolled'));
        return file;
    }

    // --- 4. QUEUE ---
    // The body of a measurement: the envelope, then each window. **The key order is the
    // contract's, at every level, and every object is rebuilt key by key** — what comes out of
    // the queue was read back from the editor's store, which promises nothing about the order
    // of its keys. A block the window does not carry is left out, never sent empty or null, and
    // a key this client does not know is never forwarded: the engine refuses a body that holds
    // one.
    //
    // `sent` is this machine's clock at the instant of the attempt: the body is built again
    // for each one, so it is rewritten each time.
    envelopeOf(items) {
        return {
            session: items[0].session,
            sent: Date.now(),
            windows: items.map((item) => this.windowOf(item)),
        };
    }

    // One window, as the sensor sealed it. `offline` is the one thing this client adds — it is
    // the queue that knows the engine was out of reach — and it sits between `why` and
    // `active`, only when it is true.
    windowOf(item) {
        const sealed = item.window;
        const window = { seq: sealed.seq, at: sealed.at, mono: sealed.mono, ms: sealed.ms, why: sealed.why };
        if (item.offline) window.offline = true;
        window.active = sealed.active;
        window.runs = sealed.runs.map((run) => [...run]);
        // A measure this agent cannot take is absent from `counts`, never sent as a zero.
        window.counts = {};
        for (const key of COUNT_KEYS) {
            if (wholeNumber(sealed.counts[key])) window.counts[key] = sealed.counts[key];
        }
        if (sealed.flight) {
            window.flight = { med: sealed.flight.med, mad: sealed.flight.mad, bins: [...sealed.flight.bins] };
        }
        if (sealed.text) {
            // The size alone, or the size and the whole span: a span is never sent in part.
            const text = sealed.text;
            window.text = { len: text.len };
            if ([text.since, text.at, text.cut, text.add].every(wholeNumber)) {
                Object.assign(window.text, { since: text.since, at: text.at, cut: text.cut, add: text.add });
                // Optional, and last: absent when the sensor did not compute it.
                if (wholeNumber(text.kept)) window.text.kept = text.kept;
            }
        }
        window.sum = { keys: sealed.sum.keys, chars: sealed.sum.chars, pastes: sealed.sum.pastes };
        return window;
    }

    /**
     * The windows that leave in the next request, starting at `from`.
     *
     * One, as a rule: a window measured while the engine answers goes alone. A queue being
     * caught up after an outage goes in batches — the windows that follow each other in the
     * queue, flagged `offline`, of the same session, in the order they were sealed, and
     * BATCH_MAX_WINDOWS of them at most. Only neighbours are gathered, so the cursor still
     * says "everything before this has gone".
     */
    batchFrom(queue, from) {
        const first = queue[from];
        const batch = [first];
        if (!first.offline) return batch;
        while (batch.length < BATCH_MAX_WINDOWS) {
            const next = queue[from + batch.length];
            if (!next || !next.offline || !sendable(next) || next.session !== first.session
                || next.documentId !== first.documentId
                || !(next.window.seq > batch[batch.length - 1].window.seq)) break;
            batch.push(next);
        }
        return batch;
    }

    /**
     * Sends the windows of one request: several of one session, or a single one.
     *
     * One refusal is answered by sending again: a 404 is a document deleted on the engine, and
     * it is recreated — once. Every other refusal is the caller's to read; none of them makes
     * this client send the window in another shape.
     */
    async pushBatch(state, items) {
        const item = items[0];
        for (let attempt = 0; ; attempt++) {
            const engineId = await this.ensureDocument(state.engineIds, item);
            try {
                await this.api('POST', `/api/documents/${engineId}/metrics`, this.envelopeOf(items));
                return;
            } catch (err) {
                if (err.status !== 404 || attempt > 0) throw err;
                // file deleted on the engine side: we recreate one for this project file
                delete state.engineIds[item.documentId];
                await this.local.set('engineIds', state.engineIds);
            }
        }
    }

    // A window written while the engine was out of reach is stamped here, once, at the moment
    // it is queued — not when it finally leaves. What tells us is our own last attempt: the
    // extension host has no reliable "am I online" of its own. **Out of reach, not refused**:
    // an engine that answered an error was there, and a window that waits behind its refusal
    // was not written offline (`reached`, see `failureStatus`).
    enqueue(item) {
        return this.withLock(async () => {
            await this.reconcile();
            const status = this.status();
            const unreachable = status.state === 'offline' && !status.reached;
            const entry = unreachable ? { ...item, offline: true } : item;
            // One window appended, whatever waits before it: the store's write does not grow
            // with the queue. Only a full queue is rewritten — its oldest windows are given up,
            // and each one is counted.
            const dropped = this.pending() + 1 - MAX_QUEUE;
            if (dropped > 0) {
                for (let n = dropped; n > 0; n--) this.count('queue.dropped');
                await this.rewriteQueue([...this.waiting(), entry].slice(-MAX_QUEUE));
            } else {
                await this.appendQueue(entry);
            }
            // A token the engine refused is not tried again at every window: the loop asks once
            // a minute, and pairing again clears the state.
        }).then(() => (this.status().state === 'auth_error' ? undefined : this.drain()));
    }

    // `reached` says the engine answered, whatever it answered: it is what keeps a refusal from
    // being read as an outage when the next window is queued.
    failureStatus(err) {
        return err.status === 401
            ? { state: 'auth_error', message: t('error.credentials') }
            : { state: 'offline', message: err.message, reached: !!err.status };
    }

    drain() {
        return this.withLock(async () => {
            // Read first, signed in or not: it is what the panel counts.
            await this.loadQueue();
            if (!(await this.configured())) {
                await this.setStatus({ state: 'unconfigured' });
                return;
            }
            await this.reconcile();
            const state = this.state();
            let sent = 0;
            // Set when a batch has just been refused: its first window then goes alone.
            let alone = false;
            while (sent < state.queue.length) {
                if (!sendable(state.queue[sent])) {
                    // Not a window of the body this client sends: dropped, and the queue moves on.
                    console.warn('Certimens: a queued entry is not a measurement window — dropped');
                    sent++;
                    await this.advanceQueue(1);
                    continue;
                }
                const batch = alone ? [state.queue[sent]] : this.batchFrom(state.queue, sent);
                alone = false;
                try {
                    await this.pushBatch(state, batch);
                } catch (err) {
                    // A 400 is not a window of the protocol, a 409 a rank the engine already
                    // holds otherwise: both are final, and sending again changes nothing.
                    // Neither says anything of the window when it is the *document* that could
                    // not be created (`creation`): the window waits.
                    if ((err.status !== 400 && err.status !== 409) || err.creation) {
                        await this.setStatus(this.failureStatus(err));
                        return;
                    }
                    if (batch.length > 1) {
                        // The engine refuses a request whole. One window it will not take must
                        // not cost the sixty-three sent with it: the batch is taken apart, and
                        // each window is then accepted or refused for itself.
                        alone = true;
                        continue;
                    }
                    // measurement refused by the engine: resending it would block the queue
                    // forever
                    console.warn('Certimens: measurement rejected —', err.message);
                }
                // The cursor moves before the next send, so nothing is ever pushed twice — and
                // it is a number, so this write does not grow with the queue behind it. After
                // the last batch there is no next send: the queue is emptied below instead, and
                // a stop in between sends that batch again, never another.
                sent += batch.length;
                if (sent < state.queue.length) await this.advanceQueue(batch.length);
            }
            // Everything waiting has left: the store is emptied, cursor first (`QueueStore`).
            if (sent > 0) await this.rewriteQueue([]);
            try {
                await this.syncNames(state);
            } catch (err) {
                await this.setStatus(this.failureStatus(err));
                return;
            }
            await this.setStatus({ state: 'synced' });
        });
    }

    // --- 5. WHAT THE AGENT SAYS OF ITSELF ---
    // Counters of a closed vocabulary (TELEMETRY_EVENTS), kept in the editor's store beside the
    // queue so they survive a restart, and sent as they are: numbers, never a text. Beside them,
    // `telemetryFaults`: where our own code broke (`faultOf`), one entry per distinct fault. They belong
    // to the installation, not to an account — a sign-out does not clear them, and `installed`
    // is counted long before anybody pairs.

    /** Adds one to an event of the vocabulary; a word outside it is not counted at all. */
    count(event) {
        if (!TELEMETRY_EVENTS.includes(event)) return;
        // Read and written with no await in between: two counts can never step on each other.
        const counts = { ...this.store.get('telemetry', {}) };
        counts[event] = Math.min((wholeNumber(counts[event]) ? counts[event] : 0) + 1, TELEMETRY_MAX_COUNT);
        this.store.set('telemetry', counts).catch(() => {});
    }

    /**
     * One activation of the extension: `started`, preceded by `installed` the first time this
     * store sees any build, or by `updated` when the build differs from the last one it saw.
     * The build is the one the host declared; with none to compare, only `started` is counted.
     *
     * An installation that predates these counters has no `telemetryVersion`, yet it is not new:
     * the last build seen is then the panel's `seenVersion` (the « Certimens a été mis à jour »
     * line), and failing that a stored configuration or a session is enough to call it an
     * update. Counted as `installed`, every student already running the extension would read,
     * the day this ships, as a fresh install.
     */
    noteStart() {
        const seen = this.store.get('telemetryVersion', '') || this.store.get('seenVersion', '');
        const known = !!seen || this.store.get('config') !== undefined || this.store.get('signedIn', false);
        if (this.version && seen !== this.version) {
            this.count(known ? 'updated' : 'installed');
            this.store.set('telemetryVersion', this.version).catch(() => {});
        }
        this.count('started');
    }

    /**
     * Counts an exception of this agent's own code. An HttpError is not one: it is a failure the
     * engine client met and has already counted where it met it. Called by the extension's
     * entry points — commands, event listeners, timers — and never by a process-wide handler:
     * the extension host is shared with every other extension, whose exceptions are not ours.
     */
    countRuntime(err) {
        if (err instanceof HttpError) return;
        this.count('error.runtime');
        const real = err && typeof err === 'object' && typeof err.stack === 'string';
        this.countFault(faultOf(real ? String(err.name) : '', real ? err.stack : ''));
    }

    /**
     * Keeps a fault under `telemetryFaults` with its count: at most TELEMETRY_MAX_FAULTS distinct
     * ones, each count capped at TELEMETRY_MAX_COUNT. A fault past the tenth is still counted as
     * `error.runtime`, just not located.
     * @param {{ type: string, frames: string[] }} fault
     */
    countFault(fault) {
        const key = faultKey(fault);
        // Read and written with no await in between, as `count`.
        const faults = this.storedFaults();
        const known = faults.find((f) => faultKey(f) === key);
        if (known) known.count = Math.min(known.count + 1, TELEMETRY_MAX_COUNT);
        else if (faults.length < TELEMETRY_MAX_FAULTS) faults.push({ type: fault.type, frames: [...fault.frames], count: 1 });
        else return;
        this.store.set('telemetryFaults', faults).catch(() => {});
    }

    /** The stored faults whose shape still holds, as fresh copies. */
    storedFaults() {
        const kept = this.store.get('telemetryFaults', []);
        if (!Array.isArray(kept)) return [];
        return kept
            .filter((f) => f && typeof f.type === 'string' && Array.isArray(f.frames) && wholeNumber(f.count) && f.count > 0)
            .slice(0, TELEMETRY_MAX_FAULTS)
            .map((f) => ({ type: f.type, frames: f.frames.slice(0, TELEMETRY_MAX_FRAMES), count: Math.min(f.count, TELEMETRY_MAX_COUNT) }));
    }

    /**
     * `fn`, with its exceptions counted: what the extension hands the editor as a listener or a
     * timer goes through here. The exception is thrown again, so the editor logs it as before.
     * @template {(...args: any[]) => any} F
     * @param {F} fn
     * @returns {F}
     */
    guard(fn) {
        const engine = this;
        return /** @type {F} */ (function guarded(...args) {
            try {
                return fn.apply(this, args);
            } catch (err) {
                engine.countRuntime(err);
                throw err;
            }
        });
    }

    /**
     * Sends the counters, at most every TELEMETRY_FLUSH_MS, and only when paired and something
     * was counted. Never through `request`: what happens to this call is not counted.
     *
     * A 204 clears what was sent, and only that — what was counted during the send stays for the
     * next report. A 400 or a 413 drops it (the body is wrong, sending it again will not right
     * it), and so does a 401 (the token is gone). Anything else — no answer, a 5xx — keeps it.
     */
    async reportTelemetry() {
        if (this.reporting) return;
        const now = this.now();
        const last = this.store.get('telemetryAt', 0);
        // A clock set back since the last report would otherwise hold the next one for as long.
        if (now >= last && now - last < TELEMETRY_FLUSH_MS) return;
        const stored = this.store.get('telemetry', {});
        const events = {};
        for (const event of TELEMETRY_EVENTS) {
            if (wholeNumber(stored[event]) && stored[event] > 0) events[event] = stored[event];
        }
        if (Object.keys(events).length === 0) return;
        const faults = this.storedFaults();
        const token = await this.token();
        if (!token || !engineUrlAllowed(this.config().engineUrl)) return;

        this.reporting = true;
        try {
            await this.store.set('telemetryAt', now);
            let status = 0;
            try {
                const res = await this.fetch(trimUrl(this.config().engineUrl) + '/api/plugins/telemetry', {
                    method: 'POST',
                    headers: this.headers(token),
                    // `faults` only when there are some: the shape an older engine knows otherwise.
                    body: JSON.stringify(faults.length ? { events, faults } : { events }),
                    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
                });
                status = res.status;
            } catch (_) { /* no answer: kept for the next report */ }
            if (status !== 204 && status !== 400 && status !== 413 && status !== 401) return;
            // What was sent is taken off; what was counted in the meantime stays.
            const counts = this.store.get('telemetry', {});
            const left = {};
            for (const event of TELEMETRY_EVENTS) {
                const rest = (wholeNumber(counts[event]) ? counts[event] : 0) - (events[event] || 0);
                if (rest > 0) left[event] = rest;
            }
            await this.store.set('telemetry', left);
            const sent = new Map(faults.map((f) => [faultKey(f), f.count]));
            const rest = this.storedFaults()
                .map((f) => ({ ...f, count: f.count - (sent.get(faultKey(f)) || 0) }))
                .filter((f) => f.count > 0);
            await this.store.set('telemetryFaults', rest);
        } finally {
            this.reporting = false;
        }
    }

    // --- 6. « SIGNALER UN PROBLÈME » ---

    /**
     * The link that opens the engine's help form, prefilled with what support needs to read a
     * problem: `<origin>/#report?kind=problem&details=<block>` (docs/moteur.md, « Signaler un
     * problème »). Nothing is sent from here — the student reads the block, and may take it out,
     * before anything leaves.
     *
     * The block is made of the same things as the telemetry: states, numbers and words of a
     * closed vocabulary. **Never** the token or the device code, the e-mail or the name, the name,
     * path or identifier of a file or a project, nor a character the student wrote — which is why
     * every value below is read from a named field, and none from a status message, an engine
     * sentence or a document.
     *
     * The address opened is the configured engine's, or the default one when the configured one
     * is refused (`engineUrlAllowed`): a link is not opened in the clear towards a public host.
     * The `engine` line still says what is configured, as an origin — it is what support needs to
     * read when the link went elsewhere.
     *
     * @param {object} about what only the editor knows; this client stays free of it.
     * @param {string} [about.host] the editor and its version (`VS Code 1.97.0`, `… VSCodium`).
     * @param {string} [about.os] the system as Node names it, and a remote window's kind.
     * @param {boolean} [about.paused] whether the measurement is suspended (the Agent's to say).
     * @returns {string}
     */
    reportUrl({ host, os, paused } = {}) {
        const config = this.config();
        const status = this.status();
        const yesNo = (value) => (typeof value === 'boolean' ? (value ? 'yes' : 'no') : undefined);
        const telemetry = this.store.get('telemetry', {});
        const counters = TELEMETRY_EVENTS
            .filter((event) => wholeNumber(telemetry[event]) && telemetry[event] > 0)
            .map((event) => `${event}=${telemetry[event]}`);
        const state = typeof status.state === 'string' && /^[a-z_]+$/.test(status.state) ? status.state : '';
        const block = reportBlock({
            agent: this.agentDeclaration(),
            host,
            os,
            language: currentLanguage(),
            engine: originOf(config.engineUrl),
            signed_in: yesNo(this.store.get('signedIn', false)),
            paused: yesNo(paused),
            status: state && state === 'offline' ? `${state} (${status.reached ? 'reached' : 'unreachable'})` : state,
            queued: this.pending(),
            counters: counters.length ? counters.join(' ') : 'none',
            // To the second, in UTC: the instant reads the same whatever the student's zone.
            at: new Date(this.now()).toISOString().replace(/\.\d+Z$/, 'Z'),
        });
        const base = engineUrlAllowed(config.engineUrl) ? originOf(config.engineUrl) : DEFAULT_ENGINE_URL;
        return `${base || DEFAULT_ENGINE_URL}/${REPORT_FRAGMENT}?kind=problem&details=${encodeURIComponent(block)}`;
    }

    // The once-a-minute loop: the queue first, then the report when it is due. A failure here is
    // this agent's own, since a refusal of the engine never leaves `drain` as an exception.
    tick() {
        return this.drain()
            .then(() => this.reportTelemetry())
            .catch((err) => {
                this.countRuntime(err);
                console.warn('Certimens:', (err && err.message) || err);
            });
    }

    start() {
        this.retryTimer = this.schedule(() => this.tick(), RETRY_MS);
        return this.tick();
    }

    stop() {
        this.cancel(this.retryTimer);
    }
}

module.exports = { Engine, HttpError, errorMessage, TELEMETRY_EVENTS, TELEMETRY_FLUSH_MS, TELEMETRY_MAX_COUNT, TELEMETRY_MAX_FAULTS, TELEMETRY_MAX_FRAMES, faultOf, trimUrl, engineUrlAllowed, deadlinePassed, formatDeadline, DEFAULT_ENGINE_URL, RELEASE_NOTES_URL, MAX_UPLOAD_BASE64, BATCH_MAX_WINDOWS, REPORT_FRAGMENT, REPORT_KEYS };
