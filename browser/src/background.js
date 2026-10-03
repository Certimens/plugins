// Certimens — writing agent, background: pushes measurement windows to the engine.
//
// Each document (Google Docs or Word Online) is tied to an engine document (created on the first send via
// POST /api/documents, then remembered). Measurements are sent to POST /api/documents/:id/metrics,
// authenticating with an API token (Bearer) obtained by pairing (see PAIRING below) and kept in
// place of a password, which is never asked for. When offline, they stay in a persisted queue
// (chrome.storage.local) and are resent every minute.

// The constants the pages share with this worker, then the shared dictionary. Chrome runs this
// as a service worker and imports them here; Firefox runs it as an event page and loads them
// from the manifest's background.scripts, where importScripts does not exist.
if (typeof importScripts === 'function') importScripts('constants.js', 'i18n.js');

const RETRY_ALARM = 'certimens-retry';
const MAX_QUEUE = 5000;
// The engine caps a request body at 25 MiB; in base64, the .docx grows by a third.
const MAX_UPLOAD_BASE64 = 24 * 1024 * 1024;

// Metrics some deployed engines don't know, **newest generation first**: a 400
// "metric_type_unknown" drops one generation and the window is sent again, rather than dropping
// everything the engine was never asked about. An engine that knows the older generations but
// not the newest keeps receiving the ones it reads, which a single flat set used to cost it.
const EXTENDED_GENERATIONS = [
    ['self_paste_chars_total', 'lexical_hesitations', 'keystrokes_after_return'],
    ['self_paste_events', 'injected_chars_max', 'injected_chars_after_return'],
    ['paste_events', 'focus_losses', 'flight_median_ms'],
];

// The types no longer sent, once `dropped` generations have been refused.
function droppedTypes(dropped) {
    return new Set(EXTENDED_GENERATIONS.slice(0, dropped).flat());
}

class HttpError extends Error {
    constructor(status, message, code) {
        super(message);
        this.status = status;
        // The engine names the rule that refused the request ({"code", "error"}): a 400 says
        // which one, instead of being read as "this engine is too old".
        this.code = code || '';
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
    const s = await stored(['engineIds', 'titles', 'syncedTitles', 'queue', 'queueSent', 'status', 'extendedDropped', 'extendedUnsupported', 'paused']);
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
        // How many generations the engine has refused. An install that met an older engine
        // before generations existed carries a boolean, which meant "everything known then":
        // the first generation, which is the last of the list.
        extendedDropped: typeof s.extendedDropped === 'number'
            ? s.extendedDropped
            : (s.extendedUnsupported ? EXTENDED_GENERATIONS.length : 0),
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
    // The two ends of a pairing that will not complete. Passed on as they come, the student
    // would read the engine's English sentence at the one moment they are waiting on a screen.
    device_code_expired: 'pair.expired',
    device_denied: 'pair.denied',
};

// JSON body of an engine response, or an HttpError carrying its error message.
async function readResponse(res) {
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

async function api(config, method, path, body) {
    return readResponse(await fetch(engineBase(config.engineUrl) + path, {
        method,
        headers: {
            'Authorization': `Bearer ${config.token}`,
            'Content-Type': 'application/json',
        },
        body: body === undefined ? undefined : JSON.stringify(body),
    }));
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
// verificationUriComplete, expiresAt, interval }.
async function startPairing(engineUrl) {
    const url = engineBase(engineUrl);
    const res = await readResponse(await fetch(url + '/api/auth/device', {
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
        expiresAt: Date.now() + (res.expires_in || 600) * 1000,
        // Kept for the record rather than used: here the asking is done by the retry alarm,
        // whose minute is already far longer than the interval the engine asks for. The three
        // other agents, which schedule their own, do widen it when told to slow down.
        interval: (res.interval || 5) * 1000,
    };
}

// Asks once whether the pairing has been confirmed. Returns the API token, or null while the
// answer is "not yet" — every other refusal throws, because they each mean something the student
// has to be told: the code expired, or somebody refused it.
async function pollPairing(pairing) {
    let res;
    try {
        res = await readResponse(await fetch(engineBase(pairing.engineUrl) + '/api/auth/device/token', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ device_code: pairing.deviceCode }),
        }));
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
async function ensureDocument(config, engineIds, item, editorTitle = item.documentName) {
    if (engineIds[item.documentId]) return engineIds[item.documentId];
    const file = await api(config, 'POST', '/api/documents', { name: item.documentName });
    engineIds[item.documentId] = file.id;
    const { syncedTitles = {} } = await stored('syncedTitles');
    syncedTitles[item.documentId] = editorTitle;
    await chrome.storage.local.set({ engineIds, syncedTitles });
    return file.id;
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
            // 404: file deleted, recreated on the next send. deadline_passed: the copy is
            // frozen, so this rename will not land — noting it as synced anyway is what stops it
            // being retried at every drain, and the sending status going red over a refusal
            // nobody here can act on. A rename made after the teacher pushes the deadline does
            // go through; this one stays as it was when the window shut.
            if (err.status !== 404 && err.code !== 'deadline_passed') throw err;
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
async function advancePairing() {
    const { pairing } = await stored('pairing');
    if (!pairing) return null;
    if (Date.now() >= pairing.expiresAt) {
        await chrome.storage.local.remove('pairing');
        // Said rather than swallowed: a card that silently goes back to its button leaves the
        // student holding a code nobody wants any more, with nothing to tell them so.
        throw new HttpError(0, t('pair.expired'), 'device_code_expired');
    }
    let token;
    try {
        token = await pollPairing(pairing);
    } catch (err) {
        await chrome.storage.local.remove('pairing');
        throw err;
    }
    if (!token) return null;
    await chrome.storage.local.remove('pairing');
    return adoptToken(pairing.engineUrl, token);
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
    const tokens = await readResponse(await fetch(url + '/api/auth/tokens', {
        headers: { 'Authorization': `Bearer ${token}` },
    }));
    // The id of this very token, so logging out revokes it rather than leaving it live. The
    // engine never returns a raw token twice, so it is found by being the newest one.
    const tokenId = (tokens[0] && tokens[0].id) || '';
    return finishLogin(url, me, token, tokenId);
}

async function finishLogin(engineUrl, me, token, tokenId) {
    // A new engine may well know the extended metrics the previous one refused.
    await chrome.storage.local.set({
        config: {
            engineUrl: trimUrl(engineUrl), email: me.email || '',
            // The engine always computes a display name, and falls back to the e-mail itself
            // when the account has no first or last name. An engine too old to send it leaves
            // this empty, and the windows fall back to the e-mail on their own.
            displayName: me.display_name || '', token, tokenId, language: me.language || '',
        },
        extendedDropped: 0,
    });
    await setStatus({ state: 'idle' }); // clears any auth_error before the next send
    // Nothing to do about the proposed sites here: the `me` that got us this far carried the new
    // account's own list and has already written it over the previous one. An account that
    // belongs to no school writes an empty list, which is what keeps the school somebody was
    // logged into a minute ago from showing through.
    return me;
}

// Explicit (popup) creation of a document's engine document; no-op if it already exists.
function createFileFor(documentId, documentName, editorTitle) {
    return withLock(async () => {
        const config = await getConfig();
        const { engineIds } = await getState();
        const existed = !!engineIds[documentId];
        const engineId = await ensureDocument(config, engineIds, { documentId, documentName }, editorTitle || documentName);
        return { engineId, existed };
    });
}

// The engine accepts one exact shape for a measurement: `{type, value, period}`, with `offline`
// appended when — and only when — the window was written while the engine was out of reach, and
// `reason` last, which says which trigger sealed the window. The period is rebuilt key by key
// rather than forwarded as it arrives: `item` was read back from `chrome.storage.local`, and
// nothing promises the object that comes back carries its keys in the order they were written —
// a round trip could hand back `{end, start}`. Changing this shape is a change of contract,
// settled on the engine's side first.
//
// `reason` is omitted rather than sent empty for a window queued before this agent knew how to
// say it: the engine reads a missing one as "the agent did not say", and reads an empty string
// as a value outside its vocabulary.
//
// A window measured and a window drained from the queue must leave as the same bytes.
function toMetrics(item, dropped) {
    const refused = droppedTypes(dropped);
    const period = { start: item.period.start, end: item.period.end };
    return Object.entries(item.values)
        .filter(([type]) => !refused.has(type))
        .map(([type, value]) => {
            const metric = item.offline
                ? { type, value, period, offline: true }
                : { type, value, period };
            return item.flush ? { ...metric, reason: item.flush } : metric;
        });
}

async function pushItem(config, state, item) {
    // One attempt per generation that may have to be dropped, plus one for a document recreated
    // after a 404, plus the first.
    for (let attempt = 0; attempt < EXTENDED_GENERATIONS.length + 2; attempt++) {
        const engineId = await ensureDocument(config, state.engineIds, item);
        try {
            await api(config, 'POST', `/api/documents/${engineId}/metrics`, { metrics: toMetrics(item, state.extendedDropped) });
            return;
        } catch (err) {
            if (err.status === 404) {
                // file deleted on the engine side: we recreate one for this document
                delete state.engineIds[item.documentId];
                await chrome.storage.local.set({ engineIds: state.engineIds });
            } else if (err.status === 400 && err.code === 'metric_type_unknown'
                       && state.extendedDropped < EXTENDED_GENERATIONS.length) {
                // Only this code means the engine is older than one generation of metrics. Any
                // other 400 (an invalid period, a malformed body) used to latch this too, and
                // the browser then stopped sending paste_events, focus_losses and
                // flight_median_ms for good — the engine showed no "sorties du document" ever
                // again.
                state.extendedDropped++;
                await chrome.storage.local.set({ extendedDropped: state.extendedDropped });
                console.warn('Certimens: engine without one generation of measurements, it is no longer sent.');
            } else {
                throw err;
            }
        }
    }
}

// Engine file associated with a document (null if not yet created or deleted on the engine side).
async function docInfo(documentId) {
    const { engineIds } = await getState();
    const engineId = engineIds[documentId];
    if (!engineId) return { engineId: null, file: null };
    try {
        return { engineId, file: await api(await getConfig(), 'GET', `/api/documents/${engineId}`) };
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

// Character count of the document, excluding line breaks (like the engine's .docx count).
async function googleDocVolume(documentId) {
    const text = await (await exportGoogleDoc(documentId, 'txt')).text();
    return [...text.replace(/[\r\n\uFEFF\u200B]/g, '')].length;
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
    return api(await getConfig(), 'PUT', `/api/documents/${engineId}`, { document });
}

// An engine document id, as it goes into a path. Every id this agent handles was given to it by
// the engine and kept in `engineIds` — but this one arrives in a message, and a message is the
// one thing here whose shape nobody else has checked. A slash or a `..` in it would not be an id
// any more: it would be a different route, called with the student's token.
const ENGINE_ID = /^[A-Za-z0-9_-]+$/;

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

async function syncSiteScripts() {
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
    const me = await readResponse(await fetch(engineBase(engineUrl) + '/api/auth/me', {
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
function failureStatus(err) {
    return err.status === 401
        ? { state: 'auth_error', message: t('sync.auth_error') }
        : { state: 'offline', message: err.message };
}

// A window written while the engine was out of reach is stamped here, once, at the moment it
// is queued — not when it finally leaves. What tells us is our own last attempt, not
// navigator.onLine: a captive portal answers the link layer and never the engine, and the
// three other agents have no such API to begin with.
function enqueue(item) {
    return withLock(async () => {
        const state = await getState();
        // The queue is rewritten here anyway, so this is where it is compacted: what has already
        // been pushed is dropped and the cursor goes back to zero. One write per measured
        // window, which is what it has always cost.
        const pending = state.queue.slice(state.queueSent);
        pending.push(state.status.state === 'offline' ? { ...item, offline: true } : item);
        await chrome.storage.local.set({ queue: pending.slice(-MAX_QUEUE), queueSent: 0 });
    });
}

function drain() {
    return withLock(async () => {
        const [config, state] = await Promise.all([getConfig(), getState()]);
        if (!hasAuth(config)) {
            await setStatus({ state: 'unconfigured' });
            return;
        }
        while (state.queueSent < state.queue.length) {
            const item = state.queue[state.queueSent];
            try {
                await pushItem(config, state, item);
            } catch (err) {
                if (err.status === 400) {
                    // measurement rejected by the engine: resending it would block the queue forever.
                    // The window is named by its title and its period, never by the whole item:
                    // for a site the student added, `documentId` is the page's address, query
                    // string and all, and that is not something to leave in a console.
                    console.warn('Certimens: measurement rejected', err.message,
                        item.documentName, item.period);
                } else {
                    await setStatus(failureStatus(err));
                    return;
                }
            }
            // The cursor moves before the next send, so nothing is ever pushed twice — and it is
            // a number, so this write does not grow with the queue behind it.
            state.queueSent++;
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

async function debugRecord(entry) {
    const { debug, debugLog = [] } = await stored(['debug', 'debugLog']);
    if (!debug) return;
    console.log('Certimens:', entry);
    await chrome.storage.local.set({ debugLog: [...debugLog, { at: new Date().toISOString(), ...entry }].slice(-DEBUG_LOG_MAX) });
}

// --- 6. EVENTS ---
function logFailure(err) {
    console.warn('Certimens:', err);
}

// Fire-and-forget messages sent by the content script.
const NOTIFICATIONS = {
    CERTIMENS_METRICS(message) {
        const { documentId, documentName, period, values, reason, flush } = message;
        enqueue({ documentId, documentName, period, values, flush }).then(drain).catch(logFailure);
        debugRecord({ documentName, reason, values }).catch(logFailure);
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
            extendedDropped: state.extendedDropped > 0,
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
        if (config.token && config.tokenId) {
            try {
                await api(config, 'DELETE', `/api/auth/tokens/${config.tokenId}`);
            } catch (_) { /* already revoked or offline: the local token is wiped anyway */ }
        }
        await chrome.storage.local.set({ config: { engineUrl: config.engineUrl, email: config.email, language: config.language } });
        return {};
    },
    CERTIMENS_DOC_INFO: (message) => docInfo(message.documentId),
    async CERTIMENS_ASSIGNMENTS() {
        return { assignments: await listAssignments() };
    },
    async CERTIMENS_GDOCS_VOLUME(message) {
        return { volume: await googleDocVolume(message.documentId) };
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
        const result = await setSites(sites.filter((match) => match !== message.match));
        try {
            await chrome.permissions.remove({ origins: [message.match] });
        } catch (_) { /* already gone, or a permission the browser will not give back */ }
        return result;
    },
};

// The requests a sensor is allowed to make, which is one: the volume of a Google Doc,
// read by an export the page itself cannot follow (Google redirects it to googleusercontent.com)
// and which this worker can, holding the host permissions.
//
// Everything else in `REQUESTS` belongs to a window of ours. The distinction is not idle:
// `CERTIMENS_PAIR_START` settles **which engine holds the session** — a pairing opened against
// another address, answered by a token, moves the account and everything measured with it — and
// the others end a session, send the copy, or take a site on. A content script runs in a page
// the student added, which is to say anywhere.
const FROM_A_SENSOR = new Set(['CERTIMENS_GDOCS_VOLUME']);

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

chrome.storage.onChanged.addListener((changes) => {
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
});

function init() {
    chrome.alarms.create(RETRY_ALARM, { periodInMinutes: 1 });
    // Registrations survive a restart, but not an extension update: reconciling on every start
    // is what keeps a site added months ago still measured.
    syncSiteScripts().catch(logFailure);
    drain();
}

chrome.runtime.onInstalled.addListener((details) => {
    init();
    if (details.reason === 'install') chrome.runtime.openOptionsPage();
});
chrome.runtime.onStartup.addListener(init);

applyStoredLanguage();
