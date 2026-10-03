// Certimens — Word add-in, sends to the engine (the counterpart of browser/background.js).
//
// Each Word document is tied to a file on the engine (created on the first send via
// POST /api/documents, then remembered). Metrics are sent to POST /api/documents/:id/metrics,
// authenticating with an API token (Bearer) obtained by pairing (see PAIRING below) and kept in
// place of a password, which is never asked for. While offline, they stay in a queue
// (localStorage) resent every minute and when the network comes back. The engine allows the
// add-in's origin via CORS.

// The engine the pane talks to unless the student names another. Each agent declares it — the
// extension in `constants.js`, VS Code in `engine.js`, LibreOffice in `engine.py` — and
// `make check` compares the four: four autonomous agents, one address.
const DEFAULT_ENGINE_URL = 'https://monespace.certimens.fr';
// What changed, for the student who finds the pane different from yesterday. Declared by each
// agent in its own engine client, and compared by `make check`.
const RELEASE_NOTES_URL = 'https://github.com/certimens/plugins/releases';
const RETRY_MS = 60 * 1000;
// Added to the pairing interval each time the engine answers "too often" (RFC 8628 slow_down,
// or the rate limiter in front of it): asking at the same pace would only be refused again.
const SLOW_DOWN_MS = 5 * 1000;
const MAX_QUEUE = 5000;
// The engine caps a request body at 25 MiB; in base64, the .docx grows by a third.
const MAX_UPLOAD_BASE64 = 24 * 1024 * 1024;
const DOCX_SLICE_BYTES = 4 * 1024 * 1024;
const STORAGE_PREFIX = 'certimens.';
// The document's identifier, stored in its settings (it travels with the .docx file).
const DOCUMENT_ID_SETTING = 'certimensDocumentId';
// Each open document has its own instance of the add-in, but they all share the same
// localStorage: only one at a time drains the queue (the lease is renewed on every send).
const RUNTIME_ID = crypto.randomUUID();
const LEASE_MS = 30 * 1000;

// Metrics some deployed engines don't know, **newest generation first**: a 400
// "metric_type_unknown" drops one generation and the window is sent again, rather than dropping
// everything the engine was never asked about. An engine that knows the first generation but not
// the second keeps receiving the first. Both generations hold types this add-in never sends
// (focus_losses, the cadence): the set is the product's, not this agent's.
const EXTENDED_GENERATIONS = [
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
        // The engine names the rule that refused the request ({"code", "error"}).
        this.code = code || '';
    }
}

// --- 1. STORAGE ---
// localStorage on the add-in's origin: shared by every document open in this Word.
function load(key, fallback) {
    try {
        const raw = localStorage.getItem(STORAGE_PREFIX + key);
        return raw === null ? fallback : JSON.parse(raw);
    } catch (_) {
        return fallback;
    }
}

function save(key, value) {
    localStorage.setItem(STORAGE_PREFIX + key, JSON.stringify(value));
}

function getConfig() {
    // token: API token (Bearer) obtained by pairing — no password is ever asked for, so none is
    // stored. tokenId: its identifier, used to revoke the token on logout.
    // language: the account's own, read from GET /api/auth/me once paired, so the task pane opens
    // in the language the student chose in their Certimens space.
    return { engineUrl: DEFAULT_ENGINE_URL, email: '', displayName: '', token: '', tokenId: '', language: '', ...load('config', {}) };
}

function hasAuth(config) {
    return !!config.token;
}

// The version to announce, or '' when there is nothing to say. The pane reloads itself onto a
// new build without a word (the inline script in taskpane.html); this is what remembers which
// build the student was last shown, so the window can mention it once.
//
// **A pane that has never written the key is a first opening, not an update**: it records the
// build in silence. The same goes for every student already using the add-in the day this
// ships — nobody is told they updated to the version they have been running for a month.
//
// localStorage is shared by every document open in this Word, so the first pane to open says
// it and the others stay quiet. That is the right number of times to say it.
function updatedVersion(build) {
    if (!build) return '';
    const seen = load('seenVersion', '');
    if (seen === build) return '';
    save('seenVersion', build);
    return seen ? build : '';
}

function getState() {
    return {
        engineIds: load('engineIds', {}),
        // The document's title in Word: the last one seen, and the one last sent to the engine.
        titles: load('titles', {}),
        syncedTitles: load('syncedTitles', {}),
        // The windows still waiting. The stored array keeps the ones already pushed at its head
        // until something compacts it, and nothing outside `drain` ever sees them.
        queue: pending(load('queue', [])),
        status: load('status', { state: 'idle' }),
        // How many generations the engine has refused. An install that met an older engine
        // before generations existed carries a boolean, which meant "everything known then":
        // the first generation, which is the last of the list.
        extendedDropped: typeof load('extendedDropped', null) === 'number'
            ? load('extendedDropped', 0)
            : (load('extendedUnsupported', false) ? EXTENDED_GENERATIONS.length : 0),
    };
}

// --- SUSPENDED MEASUREMENT ---
// Read from storage on every call rather than cached: each open document runs its own instance
// of the add-in, and they share this origin's localStorage but not their memory. A pause set in
// one document has to reach the sensors of the others, which only ever look here.
//
// Suspending stops the *measurement*, not the sending: a window already measured is the
// engine's, and the queue keeps draining.
function isPaused() {
    return load('paused', false);
}

function setPaused(paused) {
    save('paused', !!paused);
    statusListeners.forEach((listener) => listener());
}

const statusListeners = [];
function onStatusChange(listener) {
    statusListeners.push(listener);
}

function setStatus(status) {
    save('status', { ...status, at: new Date().toISOString() });
    statusListeners.forEach((listener) => listener());
}

// Every read/write of the queue goes through this lock: a send and a new measurement
// never step on each other (nor create two documents for the same one).
let lock = Promise.resolve();
function withLock(fn) {
    const run = lock.then(fn, fn);
    lock = run.catch(() => {});
    return run;
}

// Drain lease shared across instances (see RUNTIME_ID): false if another instance holds it.
function takeLease() {
    const lease = load('drainLease', null);
    const now = Date.now();
    if (lease && lease.owner !== RUNTIME_ID && lease.until > now) return false;
    save('drainLease', { owner: RUNTIME_ID, until: now + LEASE_MS });
    return true;
}

// Writes to one entry of a shared table: re-read just before, so as not to overwrite what
// another instance has just written to it.
function saveEntry(key, id, value) {
    const table = load(key, {});
    if (value === undefined) delete table[id];
    else table[id] = value;
    save(key, table);
}

// --- 2. WORD DOCUMENT ---
// Stable identifier for the document: created on first open and stored in its settings, it
// is written into the .docx on the next save.
function documentId() {
    const settings = Office.context.document.settings;
    let id = settings.get(DOCUMENT_ID_SETTING);
    if (!id) {
        id = crypto.randomUUID();
        settings.set(DOCUMENT_ID_SETTING, id);
        settings.saveAsync(() => {});
    }
    return id;
}

// The document's name: its file name, without extension (empty until it has been saved).
function documentName() {
    const url = Office.context.document.url || '';
    const base = decodeURIComponent(url.split(/[\\/]/).pop().split('?')[0]);
    return base.replace(/\.(docx|docm|doc|dotx)$/i, '').trim() || 'Document Word';
}

function isWordOnline() {
    return Office.context.platform === Office.PlatformType.OfficeOnline;
}

// The open document's .docx content, read in slices (getFileAsync), as base64.
function readDocx() {
    return new Promise((resolve, reject) => {
        Office.context.document.getFileAsync(Office.FileType.Compressed, { sliceSize: DOCX_SLICE_BYTES }, (result) => {
            if (result.status !== Office.AsyncResultStatus.Succeeded) {
                reject(new HttpError(0, t('error.docRead', { message: result.error.message })));
                return;
            }
            const file = result.value;
            const chunks = [];
            const next = (index) => {
                if (index === file.sliceCount) {
                    file.closeAsync();
                    resolve(toBase64(chunks));
                    return;
                }
                file.getSliceAsync(index, (slice) => {
                    if (slice.status !== Office.AsyncResultStatus.Succeeded) {
                        file.closeAsync();
                        reject(new HttpError(0, t('error.docRead', { message: slice.error.message })));
                        return;
                    }
                    chunks.push(slice.value.data);
                    next(index + 1);
                });
            };
            next(0);
        });
    });
}

function toBase64(chunks) {
    let binary = '';
    for (const chunk of chunks) {
        const bytes = Uint8Array.from(chunk);
        for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    }
    return btoa(binary);
}

// --- 3. ENGINE API ---
// The engine authenticates every request with an API token (Bearer), obtained by pairing and
// kept in place of a password.
function trimUrl(url) {
    return url.replace(/\/+$/, '');
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

// The JSON body of an engine response, or an HttpError carrying its error message.
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
    // The 201 from metrics returns the text "Created" (Fiber's SendStatus): only JSON is read.
    if (!(res.headers.get('Content-Type') || '').includes('application/json')) return null;
    return res.json();
}

async function request(url, init) {
    try {
        return await fetch(url, init);
    } catch (err) {
        throw new HttpError(0, err.message || t('error.networkError'));
    }
}

async function api(config, method, path, body) {
    return readResponse(await request(trimUrl(config.engineUrl) + path, {
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
// No password is ever asked for. The add-in asks the engine for a pair of codes, shows the short
// one, and polls with the long one until the student confirms it in their Certimens space. It
// then receives an API token, the only thing kept.
//
// An account that signs in through Google, through an establishment's provider or from a Moodle
// launch has **no password at all**, so there was nothing to type; and a password field inside a
// task pane is the exact shape a counterfeit add-in would take.

// The address the engine says to open, kept only if it is one a browser should follow.
//
// It is a string from a server whose address the student is free to change, and it ends up in an
// `href` — in a page that holds the API token in its localStorage, and that has no Content
// Security Policy of its own to refuse a `javascript:` for us. A refusal falls back to the
// engine's own device page: the pairing is still valid, only the shortcut is lost.
function verificationUri(value, engineUrl) {
    try {
        const url = new URL(value);
        if (url.protocol === 'https:' || url.protocol === 'http:') return url.href;
    } catch (_) { /* not an absolute URL at all */ }
    return engineUrl + '/device';
}

// Opens an authorization and returns what to show, plus what to poll with.
async function startPairing(engineUrl) {
    const url = trimUrl(engineUrl);
    const res = await readResponse(await request(url + '/api/auth/device', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ client: t('pair.clientWord') }),
    }));
    return {
        engineUrl: url,
        deviceCode: res.device_code,
        userCode: res.user_code,
        verificationUri: verificationUri(res.verification_uri, url),
        verificationUriComplete: verificationUri(res.verification_uri_complete || res.verification_uri, url),
        expiresAt: Date.now() + (res.expires_in || 600) * 1000,
        interval: (res.interval || 5) * 1000,
    };
}

// Asks once. Returns the API token, or null while nobody has confirmed yet; every other refusal
// throws, because each means something the student has to be told.
async function pollPairing(pairing) {
    let res;
    try {
        res = await readResponse(await request(trimUrl(pairing.engineUrl) + '/api/auth/device/token', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ device_code: pairing.deviceCode }),
        }));
    } catch (err) {
        // Nobody has confirmed yet, or we asked again too soon: both are "keep waiting". A 429
        // says the same thing from the layer in front of the engine — the exchange is alive on
        // the other side, and this add-in is one caller too many on this address. Either way the
        // next attempt waits five seconds longer, as RFC 8628 has it.
        if (err instanceof HttpError
            && (err.code === 'device_slow_down' || err.status === 429)) {
            pairing.interval += SLOW_DOWN_MS;
            return null;
        }
        if (err instanceof HttpError && err.code === 'device_authorization_pending') return null;
        throw err;
    }
    return res.token;
}

// Creates the document's engine document if needed. editorTitle is the document's name in Word at
// that moment: it serves as the reference for detecting a later rename, even if the file was
// given a different name in the task pane.
async function ensureDocument(config, engineIds, item, editorTitle = item.documentName) {
    if (engineIds[item.documentId]) return engineIds[item.documentId];
    const file = await api(config, 'POST', '/api/documents', { name: item.documentName });
    engineIds[item.documentId] = file.id;
    saveEntry('engineIds', item.documentId, file.id);
    saveEntry('syncedTitles', item.documentId, editorTitle);
    return file.id;
}

// Propagates to the engine documents that were renamed in Word. The name chosen in the task
// pane is kept as long as the document's name does not change.
async function syncTitles(config, state) {
    for (const [docId, title] of Object.entries(state.titles)) {
        const engineId = state.engineIds[docId];
        if (!engineId || state.syncedTitles[docId] === title) continue;
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
        state.syncedTitles[docId] = title;
        saveEntry('syncedTitles', docId, title);
    }
}

function noteTitle(docId, title) {
    if (load('titles', {})[docId] === title) return Promise.resolve();
    saveEntry('titles', docId, title);
    return drain();
}

// Completes a pairing: reads who the token belongs to, and keeps it in place of a password.
async function adoptToken(engineUrl, token) {
    const url = trimUrl(engineUrl);
    const bearer = { 'Authorization': `Bearer ${token}` };
    const me = await readResponse(await request(url + '/api/auth/me', { headers: bearer }));
    const tokens = await readResponse(await request(url + '/api/auth/tokens', { headers: bearer }));
    // The id of this very token, so signing out revokes it. The engine never returns a raw
    // token twice, so it is found by being the newest one.
    const tokenId = (tokens[0] && tokens[0].id) || '';
    // displayName: the engine computes it, and falls back to the e-mail when the account has
    // no name. An engine too old to send it leaves it empty, and the pane falls back too.
    save('config', {
        engineUrl: url, email: me.email || '',
        displayName: me.display_name || '', token, tokenId, language: me.language || '',
    });
    // A new engine may well know the extended metrics the previous one refused. Without this the
    // latch in pushItem was permanent: one send to an engine predating them and this add-in stopped
    // reporting pastes and cadence **for good**, even once the engine knew them and even after the
    // student signed in to another one. The three other agents already clear it here. Nothing
    // surfaced it either, because a metric that is never sent is indistinguishable, engine-side,
    // from one this sensor cannot take.
    save('extendedDropped', 0);
    setStatus({ state: 'idle' }); // clears any pending auth_error before the next send
    drain();
    return me;
}

async function logout() {
    const config = getConfig();
    if (config.token && config.tokenId) {
        try {
            await api(config, 'DELETE', `/api/auth/tokens/${config.tokenId}`);
        } catch (_) { /* already revoked or offline: the local token is erased anyway */ }
    }
    save('config', { engineUrl: config.engineUrl, email: config.email, language: config.language });
    setStatus({ state: 'unconfigured' });
}

// Explicit creation (from the task pane) of a document's engine document; a no-op if it already exists.
function createFileFor(docId, name, editorTitle) {
    return withLock(async () => {
        const { engineIds } = getState();
        const existed = !!engineIds[docId];
        const engineId = await ensureDocument(getConfig(), engineIds, { documentId: docId, documentName: name }, editorTitle || name);
        return { engineId, existed };
    });
}

// Engine file linked to a document (null if not yet created or deleted on the engine side).
async function docInfo(docId) {
    const engineId = getState().engineIds[docId];
    if (!engineId) return { engineId: null, file: null };
    try {
        return { engineId, file: await api(getConfig(), 'GET', `/api/documents/${engineId}`) };
    } catch (err) {
        if (err.status !== 404) throw err;
        saveEntry('engineIds', docId, undefined);
        return { engineId: null, file: null };
    }
}

// Assignments the student is enrolled in. Submitting a file to an assignment is reserved for
// students: for any other role (teacher, administrator, free account), no assignments.
async function listAssignments() {
    const config = getConfig();
    const me = await api(config, 'GET', '/api/auth/me');
    if (me.role !== 'student') return [];
    return api(config, 'GET', '/api/assignments');
}

// Sends the open document's .docx to its engine document (replaces the document already sent).
async function uploadDocx(docId) {
    const engineId = getState().engineIds[docId];
    if (!engineId) throw new HttpError(404, t('error.noFile'));
    const document = await readDocx();
    if (document.length > MAX_UPLOAD_BASE64) throw new HttpError(413, t('error.tooLarge'));
    return api(getConfig(), 'PUT', `/api/documents/${engineId}`, { document });
}

// The engine silently ignores an assignment the student is not enrolled in: we detect it.
async function submitDocument(engineId, assignmentId) {
    const file = await api(getConfig(), 'PUT', `/api/documents/${engineId}`, { assignment_id: assignmentId });
    if (file.assignment_id !== assignmentId) throw new HttpError(403, t('error.notEnrolled'));
    return file;
}

// --- 4. QUEUE ---
function failureStatus(err) {
    return err.status === 401
        ? { state: 'auth_error', message: t('sync.auth_error') }
        : { state: 'offline', message: err.message };
}

// The engine accepts one exact shape for a measurement: `{type, value, period}`, and the
// same with `offline` appended when — and only when — the window was written while the
// engine was out of reach. The period is rebuilt key by key rather than forwarded as it
// arrives: `item` was read back from the queue in `localStorage`, and nothing promises the object that comes
// back carries its keys in the order they were written — a round trip could hand back
// `{end, start}`. Changing this shape is a change of contract, settled on the engine's
// side first.
function toMetrics(item, dropped) {
    const refused = droppedTypes(dropped);
    const period = { start: item.period.start, end: item.period.end };
    return Object.entries(item.values)
        .filter(([type]) => !refused.has(type))
        .map(([type, value]) => (item.offline
            ? { type, value, period, offline: true }
            : { type, value, period }));
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
                saveEntry('engineIds', item.documentId, undefined);
            } else if (err.status === 400 && err.code === 'metric_type_unknown'
                       && state.extendedDropped < EXTENDED_GENERATIONS.length) {
                // Only this code means the engine predates one generation of metrics; any other
                // 400 (an invalid period, a malformed body) must not silence them for good.
                state.extendedDropped++;
                save('extendedDropped', state.extendedDropped);
            } else {
                throw err;
            }
        }
    }
}

// A window written while the engine was out of reach is stamped here, once, at the moment it
// is queued — not when it finally leaves. What tells us is our own last attempt, not
// navigator.onLine: a captive portal answers the link layer and never the engine.
// How far the queue has been pushed: the **id** of the last window the engine took, not a count.
// The three other agents hold a count, and can: each has a queue to itself. Here every open
// document runs its own instance of the add-in over the same localStorage, so a count would move
// under whichever instance is draining the moment another one queues a window — which is why
// removing a window was an id-based filter in the first place. An id does not move.
//
// Writing this between two sends is what stops a window ever being pushed twice, and it is a
// short string: rewriting the whole queue to say the same thing cost a full serialization per
// window, so a day caught up offline wrote the array thousands of times over.
function sentThrough() {
    return load('queueSent', '');
}

// The windows still waiting: everything after the last one the engine took. An id no longer in
// the queue means the queue was compacted under us, and what is left is taken as waiting.
//
// That reading is the right one, not a fallback: a compaction writes the queue first and clears
// the cursor second, so an instance reading between the two sees exactly the windows that have
// not left — which is what it then takes them for. The cap (`MAX_QUEUE`) is the one case where
// it could over-read, and it drops the head, which is the sent end: sending a window twice is
// recoverable, dropping one is not.
function pending(queue) {
    const id = sentThrough();
    const at = id ? queue.findIndex((item) => item.id === id) : -1;
    return at < 0 ? queue : queue.slice(at + 1);
}

// Drops what has already been pushed and forgets the cursor with it.
function compact() {
    save('queue', pending(load('queue', [])));
    save('queueSent', '');
}

function enqueue(item) {
    const offline = load('status', { state: 'idle' }).state === 'offline';
    // The array is rewritten here anyway, so this is also where it is compacted: one full write
    // per measured window, which is what it has always cost.
    const queue = pending(load('queue', []));
    queue.push({ ...item, id: crypto.randomUUID(), ...(offline && { offline: true }) });
    save('queue', queue.slice(-MAX_QUEUE));
    save('queueSent', '');
    return drain();
}

function drain() {
    return withLock(async () => {
        const config = getConfig();
        const state = getState();
        if (!hasAuth(config)) {
            setStatus({ state: 'unconfigured' });
            return;
        }
        let sent = false;
        while (state.queue.length > 0) {
            if (!takeLease()) return; // another instance is draining the queue
            const item = state.queue[0];
            try {
                await pushItem(config, state, item);
            } catch (err) {
                if (err.status === 400) {
                    // measurement rejected by the engine: resending it would block the queue forever
                    console.warn('Certimens: measurement rejected', err.message, item);
                } else {
                    setStatus(failureStatus(err));
                    return;
                }
            }
            // The cursor moves before the next send, so nothing is ever pushed twice.
            state.queue.shift();
            save('queueSent', item.id);
            sent = true;
        }
        // Everything waiting has left: the array goes with it, in one write. Only when something
        // did leave — this runs on every retry tick, in every open document.
        if (sent) compact();
        try {
            await syncTitles(config, state);
        } catch (err) {
            setStatus(failureStatus(err));
            return;
        }
        setStatus({ state: 'synced' });
    }).catch((err) => console.warn('Certimens:', err));
}

function startAgent() {
    setInterval(drain, RETRY_MS);
    window.addEventListener('online', drain);
    drain();
}
