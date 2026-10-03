// Certimens — writing agent, background: pushes measurement windows to the engine.
//
// Each document (Google Docs, Word Online, Overleaf, a page the student added) is tied to an engine document (created on the first send via
// POST /api/documents, then remembered). Measurements are sent to POST /api/documents/:id/metrics,
// authenticating with an API token (Bearer) obtained by pairing (see PAIRING below) and kept in
// place of a password, which is never asked for. When offline, they stay in a persisted queue
// (chrome.storage.local) and are resent every minute.

// The constants the pages share with this worker, the shared dictionary, then the problem
// report's block, shared with the Word pane. Chrome runs this as a service worker and imports
// them here; Firefox runs it as an event page and loads them from the manifest's
// background.scripts, where importScripts does not exist.
if (typeof importScripts === 'function') importScripts('constants.js', 'i18n.js', 'report.js');

const RETRY_ALARM = 'certimens-retry';
const MAX_QUEUE = 5000;
// The engine caps a request body at 25 MiB; in base64, the .docx grows by a third.
const MAX_UPLOAD_BASE64 = 24 * 1024 * 1024;
// How long a call may stay unanswered; an upload carries megabytes and is given longer.
const REQUEST_TIMEOUT_MS = 30 * 1000;
const UPLOAD_TIMEOUT_MS = 5 * 60 * 1000;
// What the engine says of how long a pairing is valid, bounded: [lowest, highest], in seconds.
const PAIRING_EXPIRES_S = [30, 1800];
const clamp = (value, bounds, fallback) => Math.min(Math.max(Number(value) || fallback, bounds[0]), bounds[1]);
// The longest name the engine takes for a document, and the longest of the two things a page
// hands over that are stored as they come: the document's local identity — an address, for a
// site the student added — and its window's timeline, which the sensor seals at this size.
const DOCUMENT_NAME_MAX = 255;
const DOCUMENT_ID_MAX = 2048;
const WINDOW_RUNS_MAX = 512;

// --- THE MEASUREMENT BODY ---
//
// There is one body and it has no version (docs/moteur.md, "Le corps de mesure"):
// `{session, sent, windows}`. A window sealed by the sensor is numbered within a session and
// arrives here already in the shape the engine reads; this worker checks it, queues it, and lays
// its keys out again on the way out. It leaves one window per request when it is live, and up to
// BATCH_MAX_WINDOWS of one session when the queue is catching up after an outage. The engine
// refuses a longer batch.
//
// No refusal makes this agent change body: a 400 or a 409 drops the window, and that is all.
const BATCH_MAX_WINDOWS = 64;
// What a session id looks like. The id arrives in a message from a page, and it goes into a
// request made with the student's token: it is checked here like every other field that does.
const SESSION_ID = /^[A-Za-z0-9_-]{16,64}$/;
// The six words a window may give for why it was sealed. Held by the engine; the sensor
// translates its own triggers into them (content.js, WIRE_FLUSH_REASONS).
const WHY = new Set(['idle', 'volume', 'save', 'focus', 'away', 'end']);
// The order the keys leave in, block by block. A window drained from the queue was read back
// from `chrome.storage.local`, which does not promise the order it was written in: the keys are
// laid out again from these lists, so a live window and a queued one are the same bytes. They
// are also the whole vocabulary: a key that is not listed is not sent, and the engine refuses
// one it does not know.
const COUNT_KEYS = ['corrections', 'reformulations', 'revisions', 'jumps', 'exits', 'back_keys', 'back_chars'];
const TEXT_SPAN_KEYS = ['since', 'at', 'cut', 'add'];
const SUM_KEYS = ['keys', 'chars', 'pastes'];

// --- HOW THIS AGENT NAMES ITSELF ---
//
// Every call to the engine carries `X-Certimens-Agent: <kind>/<version>`. The engine stores it
// beside each measurement — so whoever reads the copy is told it was written with this extension
// and which build of it — and flags a push that names nothing, because every agent speaks up.
//
// It proves nothing, and it is not meant to: this source is public, so the header can be copied
// out of it. What it buys is **precision**, which the transport signature cannot give (that one
// says "a browser extension", never which one, never which build), and what keeps it honest is
// that the engine checks the two against each other. Sending it costs nothing and omitting it
// would raise a signal on every honest window — a signal that fires on everything says nothing.
//
// This is the same declaration the three other agents make, with the same header and the same
// shape; `make check` compares the four.
const AGENT_HEADER = 'X-Certimens-Agent';
const AGENT_KIND = 'browser';
// The charset the engine accepts for a build label, applied here rather than trusted: a version
// outside it makes the whole declaration unreadable, and the manifest is not the only thing that
// has ever written that field.
const AGENT_VERSION_MAX = 32;

/** The declaration this agent sends: its kind, and its build when the host names one. */
function agentDeclaration() {
    const version = (chrome.runtime.getManifest?.() || {}).version || '';
    const label = version.replace(/[^A-Za-z0-9._+-]/g, '').slice(0, AGENT_VERSION_MAX);
    return label ? `${AGENT_KIND}/${label}` : AGENT_KIND;
}

class HttpError extends Error {
    constructor(status, message, code) {
        super(message);
        this.status = status;
        // The engine names the rule that refused the request ({"code", "error"}): a 400 says
        // which one, instead of being read as "this engine is too old".
        this.code = code || '';
        // Set when what failed is the creation of a document, not what was to be sent to it.
        this.creation = false;
    }
}

// --- 1. STORAGE ---
// chrome.storage.local is a bag of keys with no shape of its own. types/storage.d.ts is that
// shape — the only description of it there is — and these two are where it is applied: every
// read of the stored state goes through one of them.
// `keys` is left loose on purpose: storage.get has an overload per shape of argument, and a
// union of them matches none. What the shape buys is the answer, not the question.
/** @type {(keys: any) => Promise<CertimensStored>} */
const stored = (keys) => chrome.storage.local.get(keys);
/** @type {(keys: any) => Promise<CertimensSession>} */
const sessionStored = (keys) => chrome.storage.session.get(keys);

// --- WHAT A CONTENT SCRIPT MAY READ ---
// `chrome.storage.local` holds the token, a pairing's device code and the queue, and by default
// every content script reads it — including the one running on an address the student added,
// which may be any page, plain `http:` included. A content script runs in that page's renderer:
// whatever it can read, a compromised renderer can read too. So where the browser allows it,
// the area is closed to everything but the extension's own contexts, and the sensors are given
// the four keys they need another way: read by message (CERTIMENS_SENSOR_STATE, a request a
// sensor may make), and told of every change by a message to every tab (tellSensors).
//
// Set at every start of this worker, because nothing promises the level outlives it, and
// feature-detected: Firefox has no `setAccessLevel` at all, Safari only takes it for the
// session area before 27.2 (and refuses it for this one). Where it is missing or refused,
// nothing changes: the sensors read the area and hear its changes themselves, as they always did
// (docs/extension-navigateur.md, "Le jeton hors de portée des content scripts").
const SENSOR_KEYS = ['debug', 'paused', 'signedIn', 'sites'];

function lockStorage() {
    return Promise.resolve()
        .then(() => {
            const local = /** @type {any} */ (chrome.storage.local);
            if (typeof local.setAccessLevel !== 'function') return false;
            return local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' }).then(() => true);
        })
        .catch(() => false);
}

// Whether the area is closed to the content scripts in this browser, for this run of the worker.
const storageLocked = lockStorage();

// What a sensor reads when it starts: three booleans, and nothing else of the storage — named
// one by one, like `publicPairing`, so a key added later is not handed over by default.
async function sensorState() {
    const { debug, paused, signedIn } = await stored(['debug', 'paused', 'signedIn']);
    return { debug: !!debug, paused: !!paused, signedIn: !!signedIn };
}

// A change to one of the sensors' keys, carried to every open tab, all frames: the content
// scripts can no longer hear it from the storage. A suspension and a sign-out must reach an open
// document at once: measuring stops there, and the window in progress is sealed — which, after a
// sign-out, the queue then refuses (see CERTIMENS_LOGOUT). Only the four keys, as `{ key: { newValue } }`. A tab without a sensor
// answers nothing, which is not an error. Where the area is still open to them, they hear the
// change themselves and nothing is sent.
async function tellSensors(changes) {
    /** @type {Record<string, { newValue: unknown }>} */
    const forSensors = {};
    for (const key of SENSOR_KEYS) {
        if (changes[key]) forSensors[key] = { newValue: changes[key].newValue };
    }
    if (Object.keys(forSensors).length === 0 || !(await storageLocked)) return;
    const tabs = await chrome.tabs.query({});
    await Promise.all(tabs.map((tab) => (tab.id === undefined ? null
        : Promise.resolve(chrome.tabs.sendMessage(tab.id, { type: 'CERTIMENS_SENSOR_STATE', changes: forSensors }))
            .catch(() => {}))));
}

async function getConfig() {
    const { config } = await stored('config');
    // token: API token (Bearer) obtained by pairing and kept in place of a password — none is
    // ever asked for. tokenId: its id, used to revoke the token at logout.
    // language: the account's own, read from GET /api/auth/me once paired, so the popup and the
    // options page open in the language the student chose in their Certimens space.
    return { engineUrl: DEFAULT_ENGINE_URL, email: '', displayName: '', token: '', tokenId: '', language: '', ...config };
}

function hasAuth(config) {
    return !!config.token;
}

// What is still waiting in the queue: the windows past the cursor. The array keeps the ones
// already pushed at its head until something compacts it — see `enqueue` and `drain`.
function pendingCount(state) {
    return state.queue.length - state.queueSent;
}

async function getState() {
    const s = await stored(['engineIds', 'titles', 'syncedTitles', 'queue', 'queueSent', 'status', 'paused']);
    return {
        // Suspended measurement: the content scripts read this key themselves (see content.js).
        // Nothing is gated here — the queue keeps draining while paused, because what was already
        // measured belongs to the engine.
        paused: !!s.paused,
        engineIds: s.engineIds || {},
        // Document title in the editor: the last one seen, and the one from the last send to the engine.
        titles: s.titles || {},
        syncedTitles: s.syncedTitles || {},
        queue: s.queue || [],
        // How many windows at the head of the queue have already reached the engine. Draining
        // used to rewrite the whole queue after each window: a day caught up offline then wrote
        // a 3 MB array five thousand times over. A cursor is a number, so the write that must
        // happen between two sends — the one that stops a window ever being sent twice — costs
        // the same whether ten windows are waiting or five thousand. Absent on an install that
        // predates it, which reads as nothing sent yet, and is exactly right.
        queueSent: s.queueSent || 0,
        status: s.status || { state: 'idle' },
    };
}

async function setStatus(status) {
    await chrome.storage.local.set({ status: { ...status, at: new Date().toISOString() } });
    await refreshBadge();
}

// Every read/write of the queue goes through this lock: a send and a new
// measurement never step on each other (nor create two documents for the same one).
let lock = Promise.resolve();
function withLock(fn) {
    const run = lock.then(fn, fn);
    lock = run.catch(() => {});
    return run;
}

// --- SELF-TELEMETRY ---
//
// What happens to the agent without anything being pushed — an install, an update, an exception
// in its own code, a call that never reached the engine — is invisible from the engine. So the
// agent counts those, and sends the counters (docs/moteur.md, "Ce que l'agent dit de lui-même").
//
// **Counters, nothing else**: a word of the vocabulary below and a number. Never a message,
// never a stack, never a URL — an exception text in a writing tool can quote what the student
// wrote, and no text of theirs leaves the machine. Nothing here is formed at run time: a name
// outside the list is not counted at all.
//
// The three constants are the contract's, in the table's order; the three other agents declare
// the same, and `make check` compares the four with docs/moteur.md.
const TELEMETRY_EVENTS = ['installed', 'updated', 'started', 'error.runtime', 'error.engine',
    'error.rejected', 'error.auth', 'network.failure', 'queue.dropped'];
const TELEMETRY_FLUSH_MS = 15 * 60 * 1000;
const TELEMETRY_MAX_COUNT = 10000;
const TELEMETRY_PATH = '/api/plugins/telemetry';

// The counters live in `chrome.storage.local` (`telemetry`, with `telemetryAt` for the last
// attempt), beside the queue, and are **not** account state: they name no account, so signing
// out keeps them, and an `installed` counted before the first pairing leaves after it.
//
// A lock of their own, not the queue's: they are counted from inside a drain, which holds that
// one, and a send must not hold up the work it reports on. Counting never throws — a counter that
// failed to count is not worth a failure in the call that was being counted.
/** @type {Promise<unknown>} */
let telemetryLock = Promise.resolve();
/**
 * @template T
 * @param {() => Promise<T>} fn
 * @returns {Promise<T>}
 */
function withTelemetryLock(fn) {
    const run = telemetryLock.then(fn, fn);
    telemetryLock = run.catch(() => {});
    return run;
}

function countEvent(name, n = 1) {
    if (!TELEMETRY_EVENTS.includes(name) || !(n > 0)) return Promise.resolve();
    return withTelemetryLock(async () => {
        const { telemetry = {} } = await stored('telemetry');
        telemetry[name] = Math.min((telemetry[name] || 0) + n, TELEMETRY_MAX_COUNT);
        await chrome.storage.local.set({ telemetry });
    }).catch(() => {});
}

// An exception of the extension's own code: counted as `error.runtime`, and kept as a fault —
// where it broke (`faultOf`, constants.js) — under `telemetryFaults`, one entry per distinct
// fault with its count, at most TELEMETRY_MAX_FAULTS of them. A fault past that is still counted,
// just not located: the first ten of a broken build say where it breaks.
//
// `type` and `stack` are the exception's own strings, read by whoever caught it — this scope, a
// page or a content script (CERTIMENS_RUNTIME_ERROR) — and they go no further than this function:
// what is stored, and sent, is only what `faultOf` keeps.
function countRuntimeError(type, stack) {
    const fault = faultOf(type, stack, chrome.runtime.getURL(''));
    const key = faultKey(fault);
    return Promise.all([countEvent('error.runtime'), withTelemetryLock(async () => {
        const { telemetryFaults: faults = [] } = await stored('telemetryFaults');
        const known = faults.find((/** @type {any} */ f) => faultKey(f) === key);
        if (known) known.count = Math.min((known.count || 0) + 1, TELEMETRY_MAX_COUNT);
        else if (faults.length < TELEMETRY_MAX_FAULTS) faults.push({ ...fault, count: 1 });
        else return;
        await chrome.storage.local.set({ telemetryFaults: faults });
    }).catch(() => {})]);
}

/** @param {{ type: string, frames: string[] }} fault */
function faultKey(fault) {
    return [fault.type, ...fault.frames].join('\n');
}

// What an uncaught event carries, as the two strings `faultOf` reads: an `error` event's error,
// an `unhandledrejection`'s reason. A rejection with something other than an error — a string,
// nothing — has no stack and becomes a fault of type `Other` with no frame.
function errorStrings(/** @type {any} */ error) {
    const real = error instanceof Error || (error && typeof error === 'object' && typeof error.stack === 'string');
    return real ? [String(error.name), String(error.stack)] : ['', ''];
}

// The event an engine refusal counts as.
function refusalEvent(status) {
    if (status === 401) return 'error.auth';
    return status >= 500 ? 'error.engine' : 'error.rejected';
}

// The body's `events`, in the vocabulary's order: what storage gave back is laid out again, as
// the measurement body is, and only whole positive counts of known words go. Null when there
// is nothing to say.
function telemetryEvents(counts) {
    /** @type {Record<string, number>} */
    const events = {};
    for (const name of TELEMETRY_EVENTS) {
        const value = counts && counts[name];
        if (Number.isInteger(value) && value > 0) events[name] = Math.min(value, TELEMETRY_MAX_COUNT);
    }
    return Object.keys(events).length ? events : null;
}

// The body's `faults`: the stored ones whose shape still holds, with a whole positive count.
// Null when there are none, so the body keeps the shape an older engine knows.
function telemetryFaults(kept) {
    if (!Array.isArray(kept)) return null;
    const faults = kept
        .filter((f) => f && typeof f.type === 'string' && Array.isArray(f.frames) && Number.isInteger(f.count) && f.count > 0)
        .slice(0, TELEMETRY_MAX_FAULTS)
        .map((f) => ({ type: f.type, frames: f.frames.slice(0, TELEMETRY_MAX_FRAMES), count: Math.min(f.count, TELEMETRY_MAX_COUNT) }));
    return faults.length ? faults : null;
}

// Takes what was sent off the counters and the faults, and only that: what was counted while the
// request was in flight stays for the next one.
function forgetSent(events, faults) {
    return withTelemetryLock(async () => {
        const { telemetry = {}, telemetryFaults: kept = [] } = await stored(['telemetry', 'telemetryFaults']);
        for (const [name, value] of Object.entries(events)) {
            const left = (telemetry[name] || 0) - value;
            if (left > 0) telemetry[name] = left;
            else delete telemetry[name];
        }
        const sent = new Map((faults || []).map((f) => [faultKey(f), f.count]));
        const left = kept
            .map((/** @type {any} */ f) => ({ ...f, count: (f.count || 0) - (sent.get(faultKey(f)) || 0) }))
            .filter((/** @type {any} */ f) => f.count > 0);
        await chrome.storage.local.set({ telemetry, telemetryFaults: left });
    });
}

// Sends the counters, at most every TELEMETRY_FLUSH_MS, on the minute the retry alarm already
// spends — and only paired, with something to say. Reset on a 204 and on nothing else that
// succeeds; dropped on a 400 or 413 (resending the same body will not mend it) and on a 401 (the
// token is gone); kept for next time on a 5xx, another refusal or no answer at all. None of this
// call's own failures is counted: an unreachable engine would otherwise grow the counter that
// says it is unreachable.
async function flushTelemetry() {
    const config = await getConfig();
    if (!hasAuth(config) || !(await telemetryConsented())) return;
    // The attempt is claimed under the lock, then the lock is let go for the request.
    const pending = await withTelemetryLock(async () => {
        const { telemetry, telemetryFaults: kept, telemetryAt = 0 } = await stored(['telemetry', 'telemetryFaults', 'telemetryAt']);
        const now = Date.now();
        // A clock set back is not a reason to wait until it catches up again.
        if (telemetryAt && now >= telemetryAt && now - telemetryAt < TELEMETRY_FLUSH_MS) return null;
        const events = telemetryEvents(telemetry);
        if (!events) return null;
        await chrome.storage.local.set({ telemetryAt: now });
        return { events, faults: telemetryFaults(kept) };
    });
    if (!pending) return;
    const { events, faults } = pending;
    let res;
    try {
        res = await fetch(engineBase(config.engineUrl) + TELEMETRY_PATH, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${config.token}`,
                'Content-Type': 'application/json',
                [AGENT_HEADER]: agentDeclaration(),
            },
            body: JSON.stringify(faults ? { events, faults } : { events }),
        });
    } catch (_) {
        return; // kept, and not counted
    }
    if (res.status === 204 || res.status === 400 || res.status === 413 || res.status === 401) await forgetSent(events, faults);
}

// Firefox files these counters under `technicalAndInteraction`, the one category of its
// `data_collection_permissions` that may only be **optional**: the student opts in, at install
// or later from the add-on's permissions in about:addons, and until then nothing leaves (the
// counters still count, on the machine). The rule is read from the manifest, which the Firefox
// package alone keeps `browser_specific_settings` in: Chrome, Edge, Opera and Safari have no
// such category and send. A host that cannot answer is read as a refusal — sending without the
// consent a store requires is the one wrong answer here.
async function telemetryConsented() {
    /** @type {any} */
    const manifest = chrome.runtime.getManifest?.() || {};
    const declared = manifest.browser_specific_settings?.gecko?.data_collection_permissions?.optional || [];
    if (!declared.includes('technicalAndInteraction')) return true;
    try {
        // `data_collection` is Firefox's, and @types/chrome does not know it.
        return await chrome.permissions.contains(/** @type {any} */ ({ data_collection: ['technicalAndInteraction'] }));
    } catch (_) {
        return false;
    }
}

// `installed` and `updated` come from the browser itself rather than from a version kept in
// storage: `onInstalled` says which of the two happened and from which version, and it is the
// one source that also gets right the installs already out there the day this ships — they hold
// no stored version, and would otherwise all read as new installs. A reload of the same version
// (an unpacked extension during development) is neither.
function noteInstalled(details) {
    if (details.reason === 'install') return countEvent('installed');
    const version = (chrome.runtime.getManifest?.() || {}).version;
    if (details.reason === 'update' && details.previousVersion !== version) return countEvent('updated');
    return Promise.resolve();
}

// `started` is the extension starting, not the worker waking: the worker is woken by every
// alarm and every message, many times a minute. `chrome.storage.session` lasts as long as the
// browser runs and is cleared when the extension is disabled, reloaded or updated, which are
// exactly the starts there are — including an extension switched back on, which neither
// `onStartup` nor `onInstalled` announces.
async function noteStarted() {
    const { telemetryStarted } = await chrome.storage.session.get('telemetryStarted');
    if (telemetryStarted) return;
    await chrome.storage.session.set({ telemetryStarted: true });
    await countEvent('started');
}

// The worker's own uncaught exceptions. This scope runs nothing but the extension's code — the
// service worker on Chrome and Safari, the background page on Firefox — so whatever reaches it
// is ours. The content scripts and the pages report theirs by message (CERTIMENS_RUNTIME_ERROR):
// a content script must not listen for a page's errors, which are the page's.
if (typeof addEventListener === 'function') {
    addEventListener('error', (/** @type {any} */ event) => { countRuntimeError(...errorStrings(event?.error)); });
    addEventListener('unhandledrejection', (/** @type {any} */ event) => { countRuntimeError(...errorStrings(event?.reason)); });
}

// --- 2. ENGINE API ---
// The engine authenticates every request with an API token (Bearer), obtained by pairing and
// kept in place of a password.
function trimUrl(url) {
    return url.replace(/\/+$/, '');
}

// The engine's address, checked on the way out. Every call this worker makes to an engine goes
// through here, and that is the point: the address comes from the student, it may have been
// stored before this rule existed, and a `CERTIMENS_PAIR_START` names one of its own. The pages
// refuse it earlier and with a sentence on screen (`requestEngineAccess`); this is the floor
// under them, and the only check the worker's own callers — the retry alarm finishing a pairing,
// a drain — ever meet.
function engineBase(engineUrl) {
    // The code is what lets `errorText` hand this sentence straight to the student rather
    // than folding it into "engine unreachable", which is how a status 0 reads by default.
    if (!engineUrlAllowed(engineUrl)) throw new HttpError(0, t('error.engineUrlInsecure'), 'engine_url_refused');
    return trimUrl(engineUrl);
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

// Answers the agent reads as ordinary, and which are therefore not counted as refusals (docs/
// moteur.md, "Ce que l'agent dit de lui-même"). A pairing poll waiting is RFC 8628 wording "not
// yet" and "not so fast" as 4xx — the protocol working, not the engine refusing anything; a 429
// on that poll says the same from the layer in front. Counted, they would add a few dozen
// `error.rejected` to every pairing. Callers that look a document up name their own (`ordinary`
// below): a 404 there is "deleted", a 403 "somebody else's", and both are answers.
const PAIRING_WAIT_CODES = new Set(['device_authorization_pending', 'device_slow_down']);
const PAIRING_WAIT = (status, code) => PAIRING_WAIT_CODES.has(code) || status === 429;
// A document looked up that the engine no longer has, or that is not this account's.
const DOCUMENT_GONE = (status) => status === 403 || status === 404;

// JSON body of an engine response, or an HttpError carrying its error message.
/** @param {(status: number, code: string) => boolean} [ordinary] */
async function readResponse(res, ordinary = () => false) {
    if (!res.ok) {
        let message = res.statusText;
        let code = '';
        try {
            const body = await res.json();
            message = body.error || message;
            code = body.code || '';
        } catch (_) { /* non-JSON body */ }
        if (!ordinary(res.status, code)) await countEvent(refusalEvent(res.status));
        throw new HttpError(res.status, REWORDED[code] ? t(REWORDED[code]) : message, code);
    }
    // The metrics 201 returns the text "Created" (Fiber's SendStatus): only JSON is read.
    if (!(res.headers.get('Content-Type') || '').includes('application/json')) return null;
    return res.json();
}

// Every call the agent's work makes to the engine — pairing, documents, measurements,
// assignments — leaves through here: a call that got no answer at all is counted, then thrown
// exactly as `fetch` threw it, so nothing downstream reads it differently. The Google Docs
// export does not come here (it is not the engine), and neither does the telemetry send, whose
// own failures are not counted (see SELF-TELEMETRY).
//
// None of them waits for ever: `fetch` has no limit of its own, a captive portal holds a
// connection for minutes, and the queue's lock is held across the call — in a worker the
// browser stops after thirty seconds of nothing else happening.
async function engineFetch(url, init, timeout = REQUEST_TIMEOUT_MS) {
    try {
        return await fetch(url, { ...init, signal: AbortSignal.timeout(timeout) });
    } catch (err) {
        await countEvent('network.failure');
        throw err;
    }
}

async function api(config, method, path, body, ordinary = undefined, timeout = REQUEST_TIMEOUT_MS) {
    return readResponse(await engineFetch(engineBase(config.engineUrl) + path, {
        method,
        headers: {
            'Authorization': `Bearer ${config.token}`,
            'Content-Type': 'application/json',
            [AGENT_HEADER]: agentDeclaration(),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
    }, timeout), ordinary);
}

// --- PAIRING (device authorization) ---
//
// The agent never asks for a password. It asks the engine for a pair of codes, shows the short
// one, and polls with the long one until somebody confirms it in their Certimens space — where
// they sign in however they normally do. The agent then receives an API token, exactly the one it
// used to create for itself.
//
// Two reasons it is done this way. An account that signs in through Google, through an
// establishment's provider or from a Moodle launch **has no password at all**, so there was
// nothing to type. And a password field inside a browser extension is the exact shape a
// counterfeit agent would take: better not to teach the gesture.

// The address the engine says to open, kept only if it is one a browser should follow.
//
// It is a string from a server whose address the student is free to change, and it ends up in an
// `href`: a `javascript:` there would run in a page holding `chrome.*` and the token. The CSP of
// an extension page refuses it today, which is a second lock and not a reason to leave the first
// one open — the add-in's task pane has no such CSP, and the VS Code agent hands this to
// `openExternal`, which gives an unknown scheme to the operating system.
//
// A refusal falls back to the engine's own device page: the pairing is still valid, only the
// shortcut is lost.
function verificationUri(value, engineUrl) {
    try {
        const url = new URL(value);
        if (url.protocol === 'https:' || url.protocol === 'http:') return url.href;
    } catch (_) { /* not an absolute URL at all */ }
    return engineUrl + '/device';
}

// Opens an authorization and returns what to show: { deviceCode, userCode, verificationUri,
// verificationUriComplete, expiresAt }.
async function startPairing(engineUrl) {
    const url = engineBase(engineUrl);
    const res = await readResponse(await engineFetch(url + '/api/auth/device', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ client: t('pair.clientBrowser') }),
    }));
    return {
        engineUrl: url,
        deviceCode: res.device_code,
        userCode: res.user_code,
        verificationUri: verificationUri(res.verification_uri, url),
        verificationUriComplete: verificationUri(res.verification_uri_complete || res.verification_uri, url),
        // Seconds on the wire, an instant here: the popup may be reopened at any moment and has
        // to know whether the code is still worth showing.
        // Bounded: a validity of a year would be a code asked about for a year. The interval
        // the engine asks for is not kept — here the asking is done by the retry alarm and by
        // the popup opening, both far slower than it; the three other agents, which schedule
        // their own, do widen it when told to slow down.
        expiresAt: Date.now() + clamp(res.expires_in, PAIRING_EXPIRES_S, 600) * 1000,
    };
}

// Asks once whether the pairing has been confirmed. Returns the API token, or null while the
// answer is "not yet" — every other refusal throws, because they each mean something the student
// has to be told: the code expired, or somebody refused it.
async function pollPairing(pairing) {
    let res;
    try {
        res = await readResponse(await engineFetch(engineBase(pairing.engineUrl) + '/api/auth/device/token', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ device_code: pairing.deviceCode }),
        }), PAIRING_WAIT);
    } catch (err) {
        // Nobody has confirmed yet, or we asked again too soon: both are "keep waiting". A 429
        // says the same thing from the layer in front of the engine — the exchange is alive on
        // the other side, and this agent is one caller too many on this address.
        if (err instanceof HttpError
            && (err.code === 'device_authorization_pending' || err.code === 'device_slow_down' || err.status === 429)) return null;
        throw err;
    }
    return res.token;
}

// Creates the document's engine document if needed. editorTitle is the document title in
// the editor at that moment: it serves as the reference for detecting a later rename, even if the
// file was given another name in the popup.
//
// `chosen`: the name was typed by the student in the popup. A name the account already holds is
// then *said* (409 `document_name_taken`, reworded). Otherwise the document is being created
// from a sealed window, with nobody watching, and takes a free name made from the title — read
// as a refusal of the window, that 409 threw away every measurement of the document: after
// signing out and in again, or on a second machine, the title is one the account already has.
async function ensureDocument(config, engineIds, item, editorTitle = item.documentName, chosen = false) {
    if (engineIds[item.documentId]) return engineIds[item.documentId];
    const file = await createDocument(config, item.documentName, chosen);
    engineIds[item.documentId] = file.id;
    const { syncedTitles = {} } = await stored('syncedTitles');
    syncedTitles[item.documentId] = editorTitle;
    await chrome.storage.local.set({ engineIds, syncedTitles });
    return file.id;
}

// A name the account does not hold yet, made from one it does: the name, and the second the
// document was created at.
function freeName(name, now = new Date()) {
    const pad = (n) => String(n).padStart(2, '0');
    const stamp = ` (${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} `
        + `${pad(now.getHours())}.${pad(now.getMinutes())}.${pad(now.getSeconds())})`;
    return name.slice(0, DOCUMENT_NAME_MAX - stamp.length) + stamp;
}

// Whatever this throws is marked `creation`: it says nothing of the window that was waiting for
// the document, which stays in the queue.
async function createDocument(config, name, chosen) {
    const clipped = String(name).slice(0, DOCUMENT_NAME_MAX);
    try {
        try {
            return await api(config, 'POST', '/api/documents', { name: clipped });
        } catch (err) {
            if (chosen || !(err instanceof HttpError) || err.code !== 'document_name_taken') throw err;
        }
        return await api(config, 'POST', '/api/documents', { name: freeName(clipped) });
    } catch (err) {
        if (err instanceof HttpError) err.creation = true;
        throw err;
    }
}

// Propagates to the engine any documents renamed in the editor (Google Docs, Word Online).
// The name chosen in the popup is kept as long as the document title doesn't change.
async function syncTitles(config, state) {
    for (const [documentId, title] of Object.entries(state.titles)) {
        const engineId = state.engineIds[documentId];
        if (!engineId || state.syncedTitles[documentId] === title) continue;
        try {
            await api(config, 'PUT', `/api/documents/${engineId}`, { name: title });
        } catch (err) {
            // A refusal of this very rename is final: a 404 is a file deleted, recreated on the
            // next send; `deadline_passed` a copy frozen; a 409 a name already taken. Noting it
            // as synced anyway is what stops it being retried at every drain, and the sending
            // status going red over a refusal nobody here can act on. A rename made after the
            // teacher pushes the deadline does go through; this one stays as it was when the
            // window shut. What is not final says nothing of the rename: no answer, a token
            // refused, a limiter, an engine that failed.
            const final = err.status >= 400 && err.status < 500 && ![401, 408, 429].includes(err.status);
            if (!final) throw err;
        }
        state.syncedTitles[documentId] = title;
        await chrome.storage.local.set({ syncedTitles: state.syncedTitles });
    }
}

// Document title seen by the content script (on open, then on every change).
function noteTitle(documentId, title) {
    if (!documentId || !title) return Promise.resolve();
    return withLock(async () => {
        const { titles } = await getState();
        if (titles[documentId] === title) return;
        titles[documentId] = title;
        await chrome.storage.local.set({ titles });
    }).then(drain);
}

// Asks once whether a pairing in flight has been confirmed, and completes it if so. Returns the
// account when it just connected, and null otherwise — including when there is nothing in
// flight, which is the ordinary case.
//
// Every failure clears the pairing rather than retrying forever: the code expired, somebody
// refused it, or the engine is unreachable with a code that will have expired before it comes
// back. The student asks for a new code, which costs them one click.
//
// **One at a time.** The alarm, the popup opening and the options page coming back to the
// front all ask, sometimes together: two polls of one code drew a "too often" from the engine,
// and the loser's refusal cleared a pairing the winner was completing — "code expired" on one
// page while the other signed in.
let pairingAdvance = null;
function advancePairing() {
    pairingAdvance ??= advancePairingOnce().finally(() => { pairingAdvance = null; });
    return pairingAdvance;
}

async function advancePairingOnce() {
    const { pairing } = await stored('pairing');
    if (!pairing) return null;
    if (Date.now() >= pairing.expiresAt) {
        await chrome.storage.local.remove('pairing');
        // Said rather than swallowed: a card that silently goes back to its button leaves the
        // student holding a code nobody wants any more, with nothing to tell them so.
        throw new HttpError(0, t('pair.expired'), 'device_code_expired');
    }
    let token = pairing.token;
    if (!token) {
        try {
            token = await pollPairing(pairing);
        } catch (err) {
            await chrome.storage.local.remove('pairing');
            throw err;
        }
        if (!token) return null;
        // Kept with the pairing until it is adopted: the engine hands a token out once, and
        // the two calls that adopt it can fail for a reason that has nothing to do with it.
        // Dropped here, it stayed alive at the engine with nobody left to revoke it.
        await chrome.storage.local.set({ pairing: { ...pairing, token } });
    }
    let me;
    try {
        me = await adoptToken(pairing.engineUrl, token);
    } catch (err) {
        // No answer: asked again at the next turn, until the pairing expires. An answer that
        // is a refusal ends it, like a refused poll.
        if (!(err instanceof HttpError)) return null;
        await chrome.storage.local.remove('pairing');
        throw err;
    }
    await chrome.storage.local.remove('pairing');
    return me;
}

// What the popup is allowed to see of a pairing: everything but the device code, which is this
// agent's own credential and has no business in a page. Named field by field rather than by
// removing one, so a field added to a pairing later is not published by default.
function publicPairing(pairing) {
    return {
        userCode: pairing.userCode,
        verificationUri: pairing.verificationUri,
        verificationUriComplete: pairing.verificationUriComplete,
        expiresAt: pairing.expiresAt,
    };
}

// Stores a token just obtained and reads back who it belongs to. It is the second half of a
// pairing, and the only place a session begins.
async function adoptToken(engineUrl, token) {
    const url = engineBase(engineUrl);
    const me = await readMe(url, token);
    const tokens = await readResponse(await engineFetch(url + '/api/auth/tokens', {
        headers: { 'Authorization': `Bearer ${token}` },
    }));
    // The id of this very token, so logging out revokes it rather than leaving it live. The
    // engine never returns a raw token twice, so it is found by being the newest one.
    const tokenId = (tokens[0] && tokens[0].id) || '';
    return finishLogin(url, me, token, tokenId);
}

// What the revoked token authorised on this installation, as opposed to the token itself.
// Revoking ends what the credential can do at the engine; this is what ends what it left behind
// here — a map, the titles it synced and a queued window all outlive it otherwise, and the next
// account to pair inherits them and sends them under its own bearer.
//
// `sites` is deliberately not in the list: those are host permissions the student granted through
// the browser's own consent dialog, and taking them back is a visible gesture of its own, not a
// side effect of signing out.
const ACCOUNT_KEYS = ['engineIds', 'titles', 'syncedTitles', 'queue', 'queueSent', 'status',
    'proposedSites'];

function clearAccountState() {
    return chrome.storage.local.remove(ACCOUNT_KEYS)
        // A suspension is one student's choice about their own measurement. The next account
        // must not start silently suspended by it.
        .then(() => chrome.storage.local.set({ paused: false }));
}

async function finishLogin(engineUrl, me, token, tokenId) {
    // Pairing a different account on the same installation leaves the same residue as a sign-out
    // that never happened — and it is reached by signing in twice without signing out, which no
    // gesture forbids. Both doors lead through the same clear.
    //
    // "A different account" is also the same address on another engine: the documents this
    // installation knows are that engine's. And under the lock, like every write to the queue:
    // a send in flight would otherwise write its cursor back over what is cleared.
    const previous = await getConfig();
    const changed = previous.email !== (me.email || '') || trimUrl(previous.engineUrl) !== trimUrl(engineUrl);
    // The token this one replaces is revoked rather than left behind: pairing again while
    // connected is offered by the options page, and each time left one more token alive that
    // never expires and that nothing here remembered.
    if (previous.token && previous.tokenId && previous.token !== token) {
        api(previous, 'DELETE', `/api/auth/tokens/${previous.tokenId}`, undefined, () => true).catch(() => {});
    }
    await withLock(() => finishLoginLocked(previous, changed, engineUrl, me, token, tokenId));
    return me;
}

async function finishLoginLocked(previous, changed, engineUrl, me, token, tokenId) {
    if (previous.email && changed) await clearAccountState();
    await chrome.storage.local.set({
        // Not a credential: it says a session exists, not whose. The content scripts read it to
        // know whether what they are about to count belongs to anyone.
        signedIn: true,
        config: {
            engineUrl: trimUrl(engineUrl), email: me.email || '',
            // The engine always computes a display name, and falls back to the e-mail itself
            // when the account has no first or last name. An engine too old to send it leaves
            // this empty, and the windows fall back to the e-mail on their own.
            displayName: me.display_name || '', token, tokenId, language: me.language || '',
        },
    });
    await setStatus({ state: 'idle' }); // clears any auth_error before the next send
    // Nothing to do about the proposed sites here: the `me` that got us this far carried the new
    // account's own list and has already written it over the previous one. An account that
    // belongs to no school writes an empty list, which is what keeps the school somebody was
    // logged into a minute ago from showing through.
}

// Explicit (popup) creation of a document's engine document; no-op if it already exists.
function createFileFor(documentId, documentName, editorTitle) {
    return withLock(async () => {
        const config = await getConfig();
        const { engineIds } = await getState();
        const existed = !!engineIds[documentId];
        const engineId = await ensureDocument(config, engineIds, { documentId, documentName }, editorTitle || documentName, true);
        return { engineId, existed };
    });
}

// --- A WINDOW, FROM THE SENSOR TO THE ENGINE ---

function whole(value) {
    return Number.isInteger(value) && value >= 0;
}

function plain(value) {
    return !!value && typeof value === 'object' && !Array.isArray(value);
}

// Whether a queue entry is a window this build can send: a session, and a window carrying
// everything the body makes mandatory. It is asked twice — of what a page hands over, which is
// about to go into a request made with the student's token, and of what the queue gives back,
// which may have been written by an older build in another shape. Either way the answer to
// "no" is the same: the entry is dropped, never repaired and never sent as something else.
//
// It checks the frame, not the figures: what a run or a histogram may hold is the engine's
// rule to apply, and a window it refuses is dropped by `drain` like any other refusal.
function sendable(item) {
    if (!plain(item) || typeof item.session !== 'string' || !SESSION_ID.test(item.session)) return false;
    const window = item.window;
    if (!plain(window)) return false;
    if (!whole(window.seq) || !whole(window.at) || !whole(window.mono) || !whole(window.ms)) return false;
    if (!WHY.has(window.why) || !whole(window.active)) return false;
    if (!Array.isArray(window.runs) || window.runs.length === 0 || !window.runs.every(Array.isArray)) return false;
    if (!plain(window.counts) || !plain(window.sum)) return false;
    // A block that is there is whole: `toWindow` copies its histogram and must find one.
    if (window.flight !== undefined && !(plain(window.flight) && Array.isArray(window.flight.bins))) return false;
    if (window.dwell !== undefined && !(plain(window.dwell) && Array.isArray(window.dwell.bins))) return false;
    if (window.text !== undefined && !(plain(window.text) && whole(window.text.len))) return false;
    return SUM_KEYS.every((key) => whole(window.sum[key]));
}

// What the queue keeps of the sensor's message: where the window goes, and the window. Null
// when the message is not a window in full.
function sealedWindow(message) {
    const { documentId, documentName, session, window } = message;
    const item = { documentId, documentName, session, window };
    // The routing fields are checked like the window: they go into storage and into a request
    // made with the student's token, and a message is the one input nobody else has checked.
    // A timeline longer than the engine takes is refused there; it is not stored here first.
    return typeof documentId === 'string' && documentId.length <= DOCUMENT_ID_MAX
        && typeof documentName === 'string' && sendable(item) && window.runs.length <= WINDOW_RUNS_MAX
        ? item : null;
}

// One window of the body, rebuilt key by key from what the queue gave back, in the one order
// the engine reads: `seq`, `at`, `mono`, `ms`, `why`, `offline` only when it is true, `active`,
// `runs`, `counts`, then the blocks this window has — an absent block is left out, never sent
// empty or null — and `sum` last. Changing this shape is a change of contract, settled on the
// engine's side first.
//
// A window measured and a window drained from the queue must leave as the same bytes.
function toWindow(item) {
    const from = item.window;
    /** @type {Record<string, any>} */
    const window = { seq: from.seq, at: from.at, mono: from.mono, ms: from.ms, why: from.why };
    if (item.offline) window.offline = true;
    window.active = from.active;
    window.runs = from.runs.map((run) => [...run]);
    window.counts = Object.fromEntries(COUNT_KEYS
        .filter((key) => typeof from.counts[key] === 'number')
        .map((key) => [key, from.counts[key]]));
    if (from.flight) {
        window.flight = { med: from.flight.med, mad: from.flight.mad, bins: [...from.flight.bins] };
    }
    if (from.dwell) window.dwell = { bins: [...from.dwell.bins], rollover: from.dwell.rollover };
    if (from.text) {
        window.text = { len: from.text.len };
        // How far the text moved since the previous reading: all four figures or none.
        if (TEXT_SPAN_KEYS.every((key) => whole(from.text[key]))) {
            for (const key of TEXT_SPAN_KEYS) window.text[key] = from.text[key];
            // Present only when the sensor computed it.
            if (whole(from.text.kept)) window.text.kept = from.text.kept;
        }
    }
    window.sum = Object.fromEntries(SUM_KEYS.map((key) => [key, from.sum[key]]));
    return window;
}

// The body: windows of **one** session, by increasing `seq`. `sent` is this machine's clock at
// the moment of this attempt, in milliseconds — it is written again on every one.
function toEnvelope(items) {
    return {
        session: items[0].session,
        sent: Date.now(),
        windows: items.map(toWindow),
    };
}

// Sends windows that leave together: one, or a batch that `nextBatch` put together.
async function pushWindows(config, state, items) {
    const item = items[0];
    // Two attempts: the first, and one more for a document recreated after a 404.
    for (let attempt = 0; attempt < 2; attempt++) {
        const engineId = await ensureDocument(config, state.engineIds, item);
        try {
            await api(config, 'POST', `/api/documents/${engineId}/metrics`, toEnvelope(items));
            return;
        } catch (err) {
            if (err.status !== 404 || attempt > 0) throw err;
            // file deleted on the engine side: we recreate one for this document
            delete state.engineIds[item.documentId];
            await chrome.storage.local.set({ engineIds: state.engineIds });
        }
    }
}

// Engine file associated with a document (null if not yet created or deleted on the engine side).
async function docInfo(documentId) {
    const { engineIds } = await getState();
    const engineId = engineIds[documentId];
    if (!engineId) return { engineId: null, file: null };
    try {
        return { engineId, file: await api(await getConfig(), 'GET', `/api/documents/${engineId}`, undefined, DOCUMENT_GONE) };
    } catch (err) {
        if (err.status !== 404) throw err;
        await withLock(async () => {
            const state = await getState();
            delete state.engineIds[documentId];
            await chrome.storage.local.set({ engineIds: state.engineIds });
        });
        return { engineId: null, file: null };
    }
}

// Assignments the student is enrolled in. Submitting a file to an assignment is reserved for
// students: for any other role (teacher, administrator, free account), no assignments.
async function listAssignments() {
    const config = await getConfig();
    const me = await readMe(config.engineUrl, config.token);
    if (me.role !== 'student') return [];
    return api(config, 'GET', '/api/assignments');
}

// Exports a Google Doc using the student's session. Done here rather than in the tab:
// Google redirects to googleusercontent.com, readable thanks to the extension's host permissions
// but not from the page. An expired session returns the login page (HTML).
async function exportGoogleDoc(documentId, format) {
    if (!/^[a-zA-Z0-9_-]+$/.test(documentId)) throw new HttpError(0, t('error.invalidGoogleDoc'));
    // Firefox (and Chrome when site access is restricted) doesn't automatically grant the manifest
    // hosts: without them, the export redirect is blocked by CORS.
    if (!(await chrome.permissions.contains({ origins: GOOGLE_EXPORT_ORIGINS }))) {
        throw new HttpError(0, t('error.exportPermission'));
    }
    let res;
    try {
        res = await fetch(`https://docs.google.com/document/d/${documentId}/export?format=${format}`, { credentials: 'include' });
    } catch (err) {
        throw new HttpError(0, t('error.exportBlocked', { message: err.message }));
    }
    if (!res.ok) throw new HttpError(0, t('error.exportRefused', { status: res.status }));
    if ((res.headers.get('Content-Type') || '').includes('text/html')) {
        throw new HttpError(0, t('error.exportExpired'));
    }
    return res;
}

// The text of the document, less line breaks, and its character count (like the engine's .docx
// count). The count is what a measurement window carries. The text is what the sensor compares
// with the previous export, to say how far the text moved between the two: three lengths, of
// which nothing of the text survives.
async function googleDocReading(documentId) {
    const text = (await (await exportGoogleDoc(documentId, 'txt')).text()).replace(/[\r\n\uFEFF\u200B]/g, '');
    return { volume: [...text].length, text };
}

// Whether the frame asking is the very document it asks about. The size of a Google Doc is
// answered to any sensor; its **text** only goes back to the page that already displays it —
// a sensor also runs in the pages a student added, and none of them has any business reading
// a document open in another tab.
function showsGoogleDoc(sender, documentId) {
    const shown = (sender?.url || '').match(/^https:\/\/docs\.google\.com\/document\/d\/([a-zA-Z0-9-_]+)/);
    return !!shown && shown[1] === documentId;
}

function toBase64(buffer) {
    const bytes = new Uint8Array(buffer);
    let binary = '';
    for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(binary);
}

// Sends a document's .docx to its engine document (replaces the already-sent document): the
// content comes from the popup (chosen file, Word Online), otherwise from the Google Docs export.
async function uploadDocx({ documentId, document }) {
    const { engineIds } = await getState();
    const engineId = engineIds[documentId];
    if (!engineId) throw new HttpError(404, t('error.noFile'));
    if (!document) {
        // Only Google Docs can be exported from here, and its ids are the only ones with no
        // prefix: every other editor names itself (`word:`, `overleaf:`) because it cannot.
        if (documentId.includes(':')) throw new HttpError(0, t('error.pickDocx'));
        document = toBase64(await (await exportGoogleDoc(documentId, 'docx')).arrayBuffer());
    }
    if (document.length > MAX_UPLOAD_BASE64) throw new HttpError(413, t('error.tooLarge'));
    return api(await getConfig(), 'PUT', `/api/documents/${engineId}`, { document }, undefined, UPLOAD_TIMEOUT_MS);
}

// An engine document id, as it goes into a path. Every id this agent handles was given to it by
// the engine and kept in `engineIds` — but this one arrives in a message, and a message is the
// one thing here whose shape nobody else has checked. A slash or a `..` in it would not be an id
// any more: it would be a different route, called with the student's token. The agents that read
// an id from somewhere other than their own storage share this shape, and `make check` compares
// them: the Word and LibreOffice agents read one out of the document itself.
const ENGINE_ID = /^[A-Za-z0-9_-]{1,64}$/;

function engineDocumentId(value) {
    if (!ENGINE_ID.test(String(value || ''))) throw new HttpError(0, t('error.noFile'));
    return value;
}

// The engine silently ignores an assignment the student isn't enrolled in: we detect it.
async function submitDocument(engineId, assignmentId) {
    engineDocumentId(engineId);
    const file = await api(await getConfig(), 'PUT', `/api/documents/${engineId}`, { assignment_id: assignmentId });
    if (file.assignment_id !== assignmentId) throw new HttpError(403, t('error.notEnrolled'));
    return file;
}

// Document opened without an engine document: we open the popup (once per document and per browser
// session) so the student creates their file and picks the assignment.
async function promptUnknownDocument(documentId, tab) {
    const config = await getConfig();
    const { engineIds, status } = await getState();
    if (!hasAuth(config) || status.state === 'auth_error' || engineIds[documentId]) return;
    const { prompted = [] } = await sessionStored('prompted');
    if (prompted.includes(documentId)) return;
    await chrome.storage.session.set({ prompted: [...prompted, documentId] });
    try {
        await chrome.action.openPopup({ windowId: tab.windowId });
    } catch (_) {
        // browser that refuses to open without a click (Firefox, Chrome < 127): badge on the tab
        await chrome.action.setBadgeText({ tabId: tab.id, text: 'NEW' });
        // Slate: this badge is a call to action, and slate is what actions are made of.
        await chrome.action.setBadgeBackgroundColor({ tabId: tab.id, color: '#1e293b' });
    }
}

// --- SITES ADDED BY THE STUDENT ---
//
// Every establishment has its own Moodle, its own Canvas, its own wiki: no manifest can name
// them, and asking for `https://*/*` up front would be asking every student for access to the
// whole web to serve a few. So the student adds the address themselves, from the options page —
// which is where the browser asks them for the permission, a request needing a user gesture
// that a service worker does not have — and this registers the content script for it.
//
// What is registered persists across restarts: this function reconciles, it does not install.
const SITE_SCRIPT_ID = 'certimens-sites';

//
// One at a time: the handler that changes the list calls this, and so does the storage listener
// that sees the list change. Two passes interleaved both unregistered, then both registered —
// and the second registration is refused, with the same id.
let siteScriptsSync = Promise.resolve();
function syncSiteScripts() {
    const run = siteScriptsSync.then(syncSiteScriptsOnce, syncSiteScriptsOnce);
    siteScriptsSync = run.catch(() => {});
    return run;
}

async function syncSiteScriptsOnce() {
    // Dynamic registration is Chrome 96+, Firefox 102+, Safari 16.4+. An older host keeps the
    // three editors of the manifest and simply has no sites: nothing here throws.
    if (!chrome.scripting || !chrome.scripting.registerContentScripts) return;
    const { sites = [] } = await stored('sites');
    // A permission revoked from the browser's own settings leaves the address in the list; it
    // must not leave a script registered for it.
    const granted = [];
    for (const match of sites) {
        if (await chrome.permissions.contains({ origins: [match] })) granted.push(match);
    }
    const registered = await chrome.scripting.getRegisteredContentScripts();
    if (registered.some((script) => script.id === SITE_SCRIPT_ID)) {
        await chrome.scripting.unregisterContentScripts({ ids: [SITE_SCRIPT_ID] });
    }
    if (granted.length === 0) return;
    await chrome.scripting.registerContentScripts([{
        id: SITE_SCRIPT_ID,
        matches: granted,
        js: ['content.js'],
        // Not every frame: the rich editors of Moodle and Canvas put their body in a
        // same-origin iframe, which the sensor attaches to itself. Injecting there as well
        // would put two sensors on the same keystrokes.
        allFrames: false,
        runAt: 'document_idle',
        persistAcrossSessions: true,
    }]);
}

// --- SITES THE SCHOOL PROPOSES ---
//
// A third source, beside the editors the manifest names and the addresses the student adds: the
// school tells the engine where its students write — its Moodle, its Canvas, its wiki — and the
// agent reads that list to **propose** those addresses.
//
// It proposes and never grants. `chrome.permissions.request` only answers to a gesture, which a
// service worker does not have and which no server will ever have either: the student confirms
// each origin in their browser's own dialog, from the options page. What this removes is the
// typing — which is where a student gets it wrong — and nothing else. The student is still free
// to add an address nobody proposed, and to refuse every one of these.
//
// An engine that does not know the route is an engine that proposes nothing: the refusal is
// swallowed and the last list read is kept, so a school's addresses do not disappear from the
// page because the network did.
const PROPOSED_MAX_AGE_MS = 24 * 60 * 60 * 1000;

// The list rides on `/api/auth/me` rather than on a route of its own, because an agent knows an
// account and never a school. So it costs no call at all: every `me` this agent already makes —
// the one that ends a pairing, the one behind the assignment list, the one the options page
// triggers — refreshes it on the way past. `refreshProposedSites` only exists for the days an
// agent asks nothing else.
async function noteProposedSites(me) {
    await chrome.storage.local.set({
        proposedSites: {
            // Only what this agent can actually ask a browser for. The list comes from a server,
            // and `https://*/*` or a `javascript:` in it would be a request for something the
            // student never agreed to read in a permission dialog.
            sites: (me?.writing_sites || []).map(proposedMatch).filter(Boolean).slice(0, 16),
            at: Date.now(),
        },
    });
}

// The account behind a token, and what its school proposes, which arrive together. Every read of
// `me` goes through here: one that skipped it would leave the list a day stale for no reason.
async function readMe(engineUrl, token) {
    const me = await readResponse(await engineFetch(engineBase(engineUrl) + '/api/auth/me', {
        headers: { 'Authorization': `Bearer ${token}` },
    }));
    await noteProposedSites(me);
    return me;
}

async function refreshProposedSites(force = false) {
    const config = await getConfig();
    if (!hasAuth(config)) return;
    const { proposedSites } = await stored('proposedSites');
    if (!force && proposedSites && Date.now() - proposedSites.at < PROPOSED_MAX_AGE_MS) return;
    try {
        await readMe(config.engineUrl, config.token);
    } catch (_) {
        // An engine out of reach, or one too old to carry the field: neither is worth a word to
        // the student, and neither is a reason to forget what the school proposed yesterday. A
        // `me` that answers without the field, on the other hand, is a school proposing nothing
        // — that is an answer, and it is recorded as one.
    }
}

// One proposed address, as the match pattern the permission will be asked for — or null when it
// is not an address this agent may ask for at all.
function proposedMatch(raw) {
    try {
        const url = new URL(String(raw));
        // https only, and the origin exactly: a wildcard host would have the student grant a
        // whole domain, and a path would promise a narrowing a permission cannot honour.
        if (url.protocol !== 'https:' || url.hostname.includes('*')) return null;
        return url.origin + '/*';
    } catch (_) {
        return null;
    }
}

async function setSites(sites) {
    await chrome.storage.local.set({ sites });
    await syncSiteScripts();
    return { sites };
}

// --- 3. QUEUE ---
// `reached` says whether the engine answered at all. An answer that is an error still keeps the
// queue waiting, but it is not an outage: only a window that waited for want of a network may
// say `offline`, and only those may leave together (see `enqueue` and `nextBatch`).
function failureStatus(err) {
    return err.status === 401
        ? { state: 'auth_error', message: t('sync.auth_error') }
        : { state: 'offline', message: err.message, reached: !!err.status };
}

// A window written while the engine was out of reach is stamped here, once, at the moment it
// is queued — not when it finally leaves. What tells us is our own last attempt, not
// navigator.onLine: a captive portal answers the link layer and never the engine, and the
// three other agents have no such API to begin with. An engine that answered that attempt with
// an error was reached: what queues behind it is not stamped, and leaves one window at a time.
function enqueue(item) {
    return withLock(async () => {
        const config = await getConfig();
        // A window measured with nobody signed in belongs to no account, and the queue would
        // hold it for whichever account pairs next, which would then send it under its own
        // bearer. The content scripts stop counting on the same signal; this is the side that
        // does not depend on a page having seen it yet.
        if (!hasAuth(config)) return;
        const state = await getState();
        // The queue is rewritten here anyway, so this is where it is compacted: what has already
        // been pushed is dropped and the cursor goes back to zero. One write per measured
        // window, which is what it has always cost.
        const pending = state.queue.slice(state.queueSent);
        const unreachable = state.status.state === 'offline' && !state.status.reached;
        pending.push(unreachable ? { ...item, offline: true } : item);
        await chrome.storage.local.set({ queue: pending.slice(-MAX_QUEUE), queueSent: 0 });
        // The oldest windows that a full queue has just pushed out, lost for good.
        await countEvent('queue.dropped', pending.length - MAX_QUEUE);
    });
}

// The windows that leave in the next request. A live window leaves alone. What waited out an
// outage leaves in batches: the windows that follow the head in the queue, as long as they
// were sealed by the same session of the same document, each stamped `offline`, with a `seq`
// that goes up — and no more than BATCH_MAX_WINDOWS of them. A batch holding one window that
// is not `offline` would be flagged by the engine, so one such window ends the batch. Only
// neighbours are batched: the cursor that keeps a window from leaving twice is a position in
// the queue.
function nextBatch(state, alone) {
    const head = state.queue[state.queueSent];
    const batch = [head];
    if (alone || !head.offline) return batch;
    for (let i = state.queueSent + 1; i < state.queue.length && batch.length < BATCH_MAX_WINDOWS; i++) {
        const next = state.queue[i];
        if (!sendable(next) || !next.offline || next.documentId !== head.documentId
                || next.session !== head.session || !(next.window.seq > batch[batch.length - 1].window.seq)) break;
        batch.push(next);
    }
    return batch;
}

function drain() {
    return withLock(async () => {
        const [config, state] = await Promise.all([getConfig(), getState()]);
        if (!hasAuth(config)) {
            await setStatus({ state: 'unconfigured' });
            return;
        }
        // Set when the engine refused a batch: its windows are then sent one at a time, until
        // the one it refuses has been found and dropped.
        let alone = false;
        while (state.queueSent < state.queue.length) {
            // An entry that is not a window of the body — queued by a build that sealed
            // another shape — is dropped where it stands: there is one body, and nothing is
            // translated into it.
            if (!sendable(state.queue[state.queueSent])) {
                state.queueSent++;
                await chrome.storage.local.set({ queueSent: state.queueSent });
                continue;
            }
            const batch = nextBatch(state, alone);
            try {
                await pushWindows(config, state, batch);
            } catch (err) {
                // Neither a 400 nor a 409 says anything of the window when it is the *document*
                // that could not be created (`creation`): the window waits.
                if ((err.status === 400 || err.status === 409) && !err.creation) {
                    // A refusal names one window, and a batch would take the others down with
                    // it: they are sent again one by one.
                    if (batch.length > 1) {
                        alone = true;
                        continue;
                    }
                    alone = false;
                    // measurement rejected by the engine: resending it would block the queue forever
                    // — and so would a number the engine already holds for another window (409).
                    // The window is named by its title, its number and its date, never by the
                    // whole item: for a site the student added, `documentId` is the page's
                    // address, query string and all, and that is not something to leave in a
                    // console.
                    console.warn('Certimens: measurement rejected', err.message,
                        batch[0].documentName, batch[0].window.seq, new Date(batch[0].window.at).toISOString());
                } else {
                    await setStatus(failureStatus(err));
                    return;
                }
            }
            // The cursor moves before the next send, so nothing is ever pushed twice — and it is
            // a number, so this write does not grow with the queue behind it.
            state.queueSent += batch.length;
            await chrome.storage.local.set({ queueSent: state.queueSent });
        }
        // Everything waiting has left: the array goes with it, in one write.
        if (state.queueSent > 0) {
            state.queue = [];
            state.queueSent = 0;
            await chrome.storage.local.set({ queue: [], queueSent: 0 });
        }
        try {
            await syncTitles(config, state);
        } catch (err) {
            await setStatus(failureStatus(err));
            return;
        }
        await setStatus({ state: 'synced' });
    });
}

// --- 4. BADGE ---
// The badge carries a state, not the brand: it uses the verdict colors, which sit outside the
// brand guidelines, rather than the slate and gold of the rest of the UI. Blue / amber / claret
// and not green / orange / red — ui.css says why, and these are the same three values.
async function refreshBadge() {
    const state = await getState();
    const { status, paused } = state;
    const queued = pendingCount(state);
    let text = 'ON';
    let color = '#1d4ed8';
    if (paused) {
        // Slate, not a verdict colour: a pause is a choice the student made, not a problem — but
        // it must be visible on every tab, all the time.
        text = 'II';
        color = '#1e293b';
    } else if (status.state === 'unconfigured' || status.state === 'auth_error') {
        text = 'OFF';
        color = '#881337';
    } else if (queued > 0) {
        text = String(Math.min(queued, 999));
        color = '#b45309';
    }
    await chrome.action.setBadgeText({ text });
    await chrome.action.setBadgeBackgroundColor({ color });
}

// --- 5. DEBUG MODE ---
// Switched on from the options page: the last measurement windows are kept, so what the sensor
// counts can be compared with what the engine displays. Counters only, never any text.
const DEBUG_LOG_MAX = 30;
const KEYSTROKE_RUNS = new Set(['type', 'erase', 'nav', 'other']);

// A window as the debug journal shows it: a handful of figures a tester can check by hand.
// The first three are read from the runs the way the engine reads them; nothing here is sent.
function debugValues(window) {
    const runs = window.runs;
    const count = (kind) => runs.filter((run) => run[0] === kind).length;
    /** @type {Record<string, number>} */
    const values = {
        keystrokes_total: runs.reduce((sum, run) => sum + (KEYSTROKE_RUNS.has(run[0]) ? run[1] : 0), 0),
        paste_events: count('paste'),
        self_paste_events: count('self'),
        immediate_corrections: window.counts.corrections,
        deferred_reformulations: window.counts.reformulations,
        macro_revisions: window.counts.revisions,
        navigation_jumps: window.counts.jumps,
        focus_losses: window.counts.exits,
        injected_chars_after_return: window.counts.back_chars,
        effective_time_ms: window.active,
    };
    if (window.flight) {
        values.flight_median_ms = window.flight.med;
        values.flight_mad_ms = window.flight.mad;
    }
    if (window.text) values.real_volume_chars = window.text.len;
    return values;
}

async function debugRecord(entry) {
    const { debug, debugLog = [] } = await stored(['debug', 'debugLog']);
    if (!debug) return;
    console.log('Certimens:', entry);
    await chrome.storage.local.set({ debugLog: [...debugLog, { at: new Date().toISOString(), ...entry }].slice(-DEBUG_LOG_MAX) });
}

// --- 6. PROBLEM REPORT ---
// "Signaler un problème" opens the help form of the Certimens space, prefilled with what this
// worker knows of the agent (report.js builds the block; docs/moteur.md says what goes in it).
// Built here and not in a page: the configuration, the queue, the status and the counters all
// live in this worker's storage, and a page handed the configuration would be handed the token.

// The browser and its major version, as the browser names itself, or `unknown` — never a guess.
// Firefox answers `getBrowserInfo`; Chromium names its brands (UA client hints), where the
// GREASE entry ("Not A;Brand") is noise and "Chromium" is only kept when nothing more precise is
// there (Chrome, Edge, Opera and Brave all list it); Safari has neither, and its user agent says
// `Version/18.2 … Safari/…`. A user agent that matches none of these is left unnamed.
const BRAND_NAMES = { 'Google Chrome': 'Chrome', 'Microsoft Edge': 'Edge' };

async function browserName() {
    const major = (version) => String(version || '').split('.')[0];
    try {
        /** @type {any} */
        const runtime = /** @type {any} */ (globalThis).browser?.runtime || chrome.runtime;
        if (typeof runtime.getBrowserInfo === 'function') {
            const info = await runtime.getBrowserInfo();
            if (info?.name && major(info.version)) return `${info.name} ${major(info.version)}`;
        }
    } catch (_) { /* not Firefox, or it would not say */ }
    const nav = typeof navigator === 'undefined' ? null : /** @type {any} */ (navigator);
    const brands = (nav?.userAgentData?.brands || [])
        .filter((entry) => entry && entry.brand && !/not.?a.?brand/i.test(entry.brand));
    const named = brands.find((entry) => entry.brand !== 'Chromium') || brands[0];
    if (named && major(named.version)) return `${BRAND_NAMES[named.brand] || named.brand} ${major(named.version)}`;
    const agent = String(nav?.userAgent || '');
    /** @type {Array<[RegExp, string]>} */
    const known = [[/\bEdg\/(\d+)/, 'Edge'], [/\bOPR\/(\d+)/, 'Opera'], [/\bFirefox\/(\d+)/, 'Firefox'],
        [/\bChrome\/(\d+)/, 'Chrome'], [/\bVersion\/(\d+)[\d.]* (?:Mobile\/\S+ )?Safari\//, 'Safari']];
    for (const [pattern, name] of known) {
        const found = pattern.exec(agent);
        if (found) return `${name} ${found[1]}`;
    }
    return null;
}

// The system as the browser names it: `linux x86-64`, `win x86-64`, `mac arm`.
async function platformName() {
    try {
        const info = await chrome.runtime.getPlatformInfo();
        return [info?.os, info?.arch].filter(Boolean).join(' ') || null;
    } catch (_) {
        return null;
    }
}

// The values of the block, named one by one: like `publicPairing`, a field added to the stored
// state later is not handed over by default. No token, no device code, no e-mail, no document.
async function reportValues() {
    const [config, state, { telemetry }] = await Promise.all([getConfig(), getState(), stored('telemetry')]);
    return {
        agent: agentDeclaration(),
        host: await browserName(),
        os: await platformName(),
        language: currentLanguage(),
        engine: reportEngine(config.engineUrl),
        signed_in: reportFlag(hasAuth(config)),
        paused: reportFlag(state.paused),
        status: reportStatus(state.status),
        queued: pendingCount(state),
        counters: reportCounters(telemetryEvents(telemetry)),
        at: reportTime(new Date()),
    };
}

async function reportLink() {
    const config = await getConfig();
    return reportUrl(config.engineUrl, await reportValues());
}

// --- 7. EVENTS ---
function logFailure(err) {
    console.warn('Certimens:', err);
}

// Fire-and-forget messages sent by the content script.
const NOTIFICATIONS = {
    CERTIMENS_METRICS(message) {
        // Checked before it is queued: what a page hands over goes into a request made with
        // the student's token. A message that is not a window in full is dropped.
        const item = sealedWindow(message);
        if (!item) {
            console.warn('Certimens: a page sent something that is not a measurement window, it is dropped.');
            return;
        }
        enqueue(item).then(drain).catch(logFailure);
        debugRecord({ documentName: item.documentName, reason: message.reason, values: debugValues(item.window) })
            .catch(logFailure);
    },
    CERTIMENS_DOC_OPENED(message, sender) {
        noteTitle(message.documentId, message.documentName).catch(logFailure);
        if (sender.tab) promptUnknownDocument(message.documentId, sender.tab).catch(logFailure);
    },
    CERTIMENS_DOC_TITLE(message) {
        noteTitle(message.documentId, message.documentName).catch(logFailure);
    },
};

// Requests from the popup, the options page and the content script. Each handler returns the
// response fields: the caller gets { ok: true, ...fields } or { ok: false, status, message }.
const REQUESTS = {
    async CERTIMENS_STATUS() {
        const [config, state] = await Promise.all([getConfig(), getState()]);
        return {
            engineUrl: config.engineUrl,
            email: config.email,
            displayName: config.displayName,
            language: config.language,
            configured: hasAuth(config),
            queued: pendingCount(state),
            documents: Object.keys(state.engineIds).length,
            status: state.status,
            paused: state.paused,
        };
    },
    // Suspending stops the measurement in every open document; the queue keeps going. The
    // content scripts flush their window when they see the key change.
    async CERTIMENS_SET_PAUSED(message) {
        await chrome.storage.local.set({ paused: !!message.paused });
        await refreshBadge();
        return { paused: !!message.paused };
    },
    async CERTIMENS_WHOAMI() {
        const config = await getConfig();
        const me = await readMe(config.engineUrl, config.token);
        drain();
        return { me };
    },
    // Pairing is driven here, not in the popup: the popup closes the moment the student
    // switches to the tab where they confirm the code, and a flow that died with it would never
    // finish. The state lives in storage and the retry alarm keeps asking.
    async CERTIMENS_PAIR_START(message) {
        const pairing = await startPairing(message.engineUrl);
        await chrome.storage.local.set({ pairing });
        return { pairing: publicPairing(pairing) };
    },
    // Asked by the popup whenever it opens, so coming back to it finishes the pairing at once
    // instead of waiting for the next alarm.
    async CERTIMENS_PAIR_STATE() {
        const me = await advancePairing();
        const { pairing } = await stored('pairing');
        return { me, pairing: pairing ? publicPairing(pairing) : null };
    },
    async CERTIMENS_PAIR_CANCEL() {
        await chrome.storage.local.remove('pairing');
        return {};
    },
    async CERTIMENS_LOGOUT() {
        const config = await getConfig();
        // Whether the engine really destroyed the credential, rather than whether we tried. The
        // local wipe happens either way — a token we keep is worse than one we cannot reach —
        // but a student told their token was revoked when it is still live has been told the
        // one thing that would have made them act.
        let revoked = false;
        if (config.token && config.tokenId) {
            try {
                await api(config, 'DELETE', `/api/auth/tokens/${config.tokenId}`);
                revoked = true;
            } catch (err) {
                // The engine no longer knows this token, or no longer accepts it: it is as dead
                // as a revocation would have made it. Anything else leaves it alive, and the
                // popup says so.
                revoked = err instanceof HttpError && (err.status === 401 || err.status === 404);
            }
        }
        // Under the lock, and the token first. The content scripts react to `signedIn` by
        // sealing their open window, whose `enqueue` then finds nobody signed in and keeps
        // nothing; written the other way round, that window read the token still in place,
        // queued itself after the wipe, and waited for whichever account paired next — which
        // sent it under its own bearer. Only the address and the language are kept, so the
        // next pairing starts where this one did rather than from nothing.
        await withLock(async () => {
            await chrome.storage.local.set({
                signedIn: false,
                config: { engineUrl: config.engineUrl, language: config.language },
            });
            await clearAccountState();
        });
        await refreshBadge();
        return { revoked };
    },
    // What a sensor needs to know before counting anything (see WHAT A CONTENT SCRIPT MAY READ).
    CERTIMENS_SENSOR_STATE: () => sensorState(),
    CERTIMENS_DOC_INFO: (message) => docInfo(message.documentId),
    async CERTIMENS_ASSIGNMENTS() {
        return { assignments: await listAssignments() };
    },
    async CERTIMENS_GDOCS_VOLUME(message, sender) {
        const { volume, text } = await googleDocReading(message.documentId);
        return showsGoogleDoc(sender, message.documentId) ? { volume, text } : { volume };
    },
    async CERTIMENS_UPLOAD_DOCX(message) {
        return { file: await uploadDocx(message) };
    },
    async CERTIMENS_SUBMIT_FILE(message) {
        return { file: await submitDocument(message.engineId, message.assignmentId) };
    },
    CERTIMENS_CREATE_FILE: (message) => createFileFor(message.documentId, message.documentName, message.editorTitle),
    async CERTIMENS_SITES() {
        const { sites = [], proposedSites } = await stored(['sites', 'proposedSites']);
        return {
            sites,
            // What the school proposes and the student has not taken up yet: one already added
            // is no longer a proposal, it is a site of theirs.
            proposed: (proposedSites?.sites || []).filter((match) => !sites.includes(match)),
        };
    },
    // Asked by the options page when it opens: the school may have named a new address since
    // the daily refresh, and the student is looking at the list right now.
    async CERTIMENS_REFRESH_SITES() {
        await refreshProposedSites(true);
        return REQUESTS.CERTIMENS_SITES();
    },
    // The permission has already been granted by the options page, where the student's click
    // stands for the gesture the browser requires; all that is left here is to register.
    async CERTIMENS_ADD_SITE(message) {
        const { sites = [] } = await stored('sites');
        if (sites.includes(message.match)) return { sites };
        return setSites([...sites, message.match]);
    },
    // Removing drops the permission too: an address taken out of the list must not leave the
    // extension holding access to it.
    async CERTIMENS_REMOVE_SITE(message) {
        const { sites = [] } = await stored('sites');
        // The permission goes whatever happens to the registration: an address taken out of
        // the list and still held is the one outcome this handler exists to prevent.
        try {
            return await setSites(sites.filter((match) => match !== message.match));
        } finally {
            try {
                await chrome.permissions.remove({ origins: [message.match] });
            } catch (_) { /* already gone, or a permission the browser will not give back */ }
        }
    },
    // "Signaler un problème", from the popup or the options page: the help form, in a tab of its
    // own. A window of ours only (see FROM_A_SENSOR): the block describes the agent, and a page a
    // sensor sits in has no business opening tabs on the engine's address.
    async CERTIMENS_REPORT() {
        await chrome.tabs.create({ url: await reportLink() });
        return {};
    },
};

// The requests a sensor is allowed to make, which are two: the volume of a Google Doc,
// read by an export the page itself cannot follow (Google redirects it to googleusercontent.com)
// and which this worker can, holding the host permissions; and the three booleans it starts
// from, where it can no longer read them from the storage itself.
//
// Everything else in `REQUESTS` belongs to a window of ours. The distinction is not idle:
// `CERTIMENS_PAIR_START` settles **which engine holds the session** — a pairing opened against
// another address, answered by a token, moves the account and everything measured with it — and
// the others end a session, send the copy, or take a site on. A content script runs in a page
// the student added, which is to say anywhere.
// A stack is read no further than this: a dozen frames fit in a fraction of it, and a message is
// only one more message that need not be read.
const MAX_REPORTED_STACK = 8000;

const FROM_A_SENSOR = new Set(['CERTIMENS_GDOCS_VOLUME', 'CERTIMENS_SENSOR_STATE']);

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    // Nothing on the web can post here today — no `externally_connectable`, and a content
    // script is a world of its own that no page reaches into. This is what keeps that true of
    // the day a key is added to the manifest or a sensor starts reading more of the page than
    // it does: who the caller is is checked here, once, and not in each handler.
    if (sender.id !== chrome.runtime.id) return false;
    // **Not `sender.tab`**: an extension page has one too, the options page being a tab by
    // declaration (`open_in_tab`) and the popup being one whenever it is opened by address.
    // Read that way, this worker answered nothing to its own windows. What tells the two apart
    // is where the sender was loaded from: our own origin, or the page the sensor sits in.
    const ourWindow = (sender.url || '').startsWith(chrome.runtime.getURL(''));

    // An uncaught exception in one of our pages or content scripts, with its type and stack so
    // that `countRuntimeError` keeps where it broke — and nothing else of it. From either side —
    // each reports only its own code's (pages.js, content.js).
    if (message.type === 'CERTIMENS_RUNTIME_ERROR') {
        const text = (/** @type {unknown} */ value) => (typeof value === 'string' ? value.slice(0, MAX_REPORTED_STACK) : '');
        countRuntimeError(text(message.name), text(message.stack));
        return false;
    }
    if (NOTIFICATIONS[message.type]) {
        // The sensor's, and the sensor runs in somebody else's page.
        if (ourWindow) return false;
        NOTIFICATIONS[message.type](message, sender);
        return false;
    }
    const handler = REQUESTS[message.type];
    if (!handler) return false;
    // Dropped without an answer rather than refused with one: the caller is not a window the
    // student is looking at, so there is nobody to tell.
    if (!ourWindow && !FROM_A_SENSOR.has(message.type)) return false;
    Promise.resolve()
        .then(() => handler(message, sender))
        .then(
            (fields) => sendResponse({ ok: true, ...fields }),
            (err) => sendResponse({ ok: false, status: err.status || 0, code: err.code || '', message: err.message }),
        );
    return true; // async response
});

// The language every message this worker words is in: the account's, the browser's until the
// student logs in. Applied on load rather than from init(), because a service worker is woken by
// an alarm or a message far more often than it is installed or started with the browser — and a
// worker that skipped this would word its refusals in French for an English account.
function applyStoredLanguage() {
    return getConfig().then((config) => setLanguage(config.language, chrome.i18n.getUILanguage()), () => {});
}

chrome.storage.onChanged.addListener((changes, area) => {
    // The sensors' own keys, to the sensors: only those of the area they used to read.
    if (area === 'local') tellSensors(changes).catch(logFailure);
    if (changes.config) applyStoredLanguage().then(drain);
    if (changes.paused) refreshBadge();
    if (changes.sites) syncSiteScripts().catch(logFailure);
});

chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name !== RETRY_ALARM) return;
    // The same minute tick carries both: the queue to send, and a pairing to finish. A student
    // who confirmed the code and closed the popup is connected within the minute, without the
    // extension having to hold anything open.
    advancePairing().catch(logFailure);
    refreshProposedSites().catch(logFailure);
    drain();
    // Throttled to TELEMETRY_FLUSH_MS inside: most minutes, this is one storage read.
    flushTelemetry().catch(logFailure);
});

// The alarm everything periodic hangs from. Created at install and at browser start — and
// checked every time the worker wakes, because neither is announced when an extension is
// disabled and enabled again, and Firefox keeps its alarms in memory: without this the queue,
// a pairing in flight and the counters all waited for the next restart of the browser.
function ensureAlarm() {
    return chrome.alarms.get(RETRY_ALARM).then((alarm) => {
        if (!alarm) chrome.alarms.create(RETRY_ALARM, { periodInMinutes: 1 });
    });
}
ensureAlarm().catch(logFailure);

function init() {
    chrome.alarms.create(RETRY_ALARM, { periodInMinutes: 1 });
    // Registrations survive a restart, but not an extension update: reconciling on every start
    // is what keeps a site added months ago still measured.
    syncSiteScripts().catch(logFailure);
    drain();
}

chrome.runtime.onInstalled.addListener((details) => {
    init();
    noteInstalled(details);
    if (details.reason === 'install') chrome.runtime.openOptionsPage();
});
chrome.runtime.onStartup.addListener(init);

applyStoredLanguage();
noteStarted().catch(() => {});
