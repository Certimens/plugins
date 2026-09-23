// Certimens — Word add-in, sends to the engine (the counterpart of extension/background.js).
//
// Each Word document is tied to a file on the engine (created on the first send via
// POST /api/files, then remembered). Metrics are sent to POST /api/files/:id/metrics,
// authenticating with an API token (Bearer), created at login and kept in place of the
// password. While offline, they stay in a queue
// (localStorage) resent every minute and when the network comes back. The engine allows the
// add-in's origin via CORS (internal/api/server.go, wordAddinOrigins).

const RETRY_MS = 60 * 1000;
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

// Metrics added by the browser agents: an older engine rejects them (400 "unknown
// metric type"), so we drop them rather than lose the whole window.
const EXTENDED_TYPES = new Set(['paste_events', 'focus_losses', 'median_flight_ms']);

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
    // token: API token (Bearer) kept in place of the password. tokenId: its identifier,
    // used to revoke it on logout. password: legacy setting, migrated on the next send.
    return { engineUrl: DEFAULT_ENGINE_URL, email: '', token: '', tokenId: '', ...load('config', {}) };
}

// A config can authenticate if it carries a token, or a legacy password still to be migrated.
function hasAuth(config) {
    return !!(config.token || config.password);
}

function getState() {
    return {
        files: load('files', {}),
        // The document's title in Word: the last one seen, and the one last sent to the engine.
        titles: load('titles', {}),
        syncedTitles: load('syncedTitles', {}),
        queue: load('queue', []),
        status: load('status', { state: 'idle' }),
        extendedUnsupported: load('extendedUnsupported', false),
    };
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
// never step on each other (nor create two files for the same document).
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
                reject(new HttpError(0, `lecture du document impossible (${result.error.message})`));
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
                        reject(new HttpError(0, `lecture du document impossible (${slice.error.message})`));
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
// The engine authenticates every request with an API token (Bearer), created at login and
// kept in place of the password.
function trimUrl(url) {
    return url.replace(/\/+$/, '');
}

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
        throw new HttpError(res.status, message, code);
    }
    // The 201 from metrics returns the text "Created" (Fiber's SendStatus): only JSON is read.
    if (!(res.headers.get('Content-Type') || '').includes('application/json')) return null;
    return res.json();
}

async function request(url, init) {
    try {
        return await fetch(url, init);
    } catch (err) {
        throw new HttpError(0, err.message || 'erreur réseau');
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

// Obtains an API token from an email/password: log in (session token), then create a
// non-expiring API token, revocable from the Certimens workspace. The session token, no
// longer needed, is revoked. Returns { me, token, tokenId }.
async function createApiToken(engineUrl, email, password) {
    const url = trimUrl(engineUrl);
    const me = await readResponse(await request(url + '/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
    }));
    const bearer = { 'Authorization': `Bearer ${me.token}`, 'Content-Type': 'application/json' };
    const token = await readResponse(await request(url + '/api/auth/tokens', {
        method: 'POST',
        headers: bearer,
        body: JSON.stringify({ label: `Complément Word (${new Date().toLocaleDateString('fr-FR')})` }),
    }));
    try {
        await request(url + '/api/auth/logout', { method: 'POST', headers: bearer });
    } catch (_) { /* network: the session token will expire on its own */ }
    return { me, token: token.token, tokenId: token.id };
}

// A config guaranteed to carry a token. A legacy password-based config is migrated once here:
// its password is exchanged for a token, then erased from local storage.
//
// Two guards against creating more than one API token, which would leave one valid on the
// engine with no way for the student to revoke it: the in-flight migration is shared inside
// this instance, and because every open document runs its own instance over the same
// localStorage, a token that lost the race is revoked instead of being dropped.
let migration = null;
async function authedConfig() {
    const config = getConfig();
    if (config.token || !config.password) return config;
    if (!migration) {
        migration = (async () => {
            const { me, token, tokenId } = await createApiToken(config.engineUrl, config.email, config.password);
            const fresh = getConfig();
            if (fresh.token) {
                // another instance migrated first: revoke the token we just created
                try {
                    await api({ ...fresh, token, tokenId }, 'DELETE', `/api/auth/tokens/${tokenId}`);
                } catch (_) { /* offline: the duplicate stays revocable from the Certimens space */ }
                return fresh;
            }
            const migrated = { engineUrl: trimUrl(config.engineUrl), email: me.email || config.email, token, tokenId };
            save('config', migrated);
            return migrated;
        })().finally(() => { migration = null; });
    }
    return migration;
}

// Creates the document's engine file if needed. editorTitle is the document's name in Word at
// that moment: it serves as the reference for detecting a later rename, even if the file was
// given a different name in the task pane.
async function ensureFile(config, files, item, editorTitle = item.documentName) {
    if (files[item.documentId]) return files[item.documentId];
    const file = await api(config, 'POST', '/api/files', { document_name: item.documentName });
    files[item.documentId] = file.id;
    saveEntry('files', item.documentId, file.id);
    saveEntry('syncedTitles', item.documentId, editorTitle);
    return file.id;
}

// Propagates to the engine documents that were renamed in Word. The name chosen in the task
// pane is kept as long as the document's name does not change.
async function syncTitles(config, state) {
    for (const [docId, title] of Object.entries(state.titles)) {
        const fileId = state.files[docId];
        if (!fileId || state.syncedTitles[docId] === title) continue;
        try {
            await api(config, 'PUT', `/api/files/${fileId}`, { document_name: title });
        } catch (err) {
            if (err.status !== 404) throw err; // 404: file deleted, recreated on the next send
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

// Login from the task pane: the password is exchanged for an API token, the only thing kept.
async function login({ engineUrl, email, password }) {
    const { me, token, tokenId } = await createApiToken(engineUrl, email, password);
    save('config', { engineUrl: trimUrl(engineUrl), email: me.email || email, token, tokenId });
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
    save('config', { engineUrl: config.engineUrl, email: config.email });
    setStatus({ state: 'unconfigured' });
}

// Explicit creation (from the task pane) of a document's engine file; a no-op if it already exists.
function createFileFor(docId, name, editorTitle) {
    return withLock(async () => {
        const { files } = getState();
        const existed = !!files[docId];
        const fileId = await ensureFile(await authedConfig(), files, { documentId: docId, documentName: name }, editorTitle || name);
        return { fileId, existed };
    });
}

// Engine file linked to a document (null if not yet created or deleted on the engine side).
async function docInfo(docId) {
    const fileId = getState().files[docId];
    if (!fileId) return { fileId: null, file: null };
    try {
        return { fileId, file: await api(await authedConfig(), 'GET', `/api/files/${fileId}`) };
    } catch (err) {
        if (err.status !== 404) throw err;
        saveEntry('files', docId, undefined);
        return { fileId: null, file: null };
    }
}

// Assignments the student is enrolled in. Submitting a file to an assignment is reserved for
// students: for any other role (teacher, administrator, free account), no assignments.
async function listAssignments() {
    const config = await authedConfig();
    const me = await api(config, 'GET', '/api/auth/me');
    if (me.role !== 'student') return [];
    return api(config, 'GET', '/api/assignments');
}

// Sends the open document's .docx to its engine file (replaces the document already sent).
async function uploadDocx(docId) {
    const fileId = getState().files[docId];
    if (!fileId) throw new HttpError(404, "créez d'abord le fichier Certimens");
    const document = await readDocx();
    if (document.length > MAX_UPLOAD_BASE64) throw new HttpError(413, 'document trop volumineux (18 Mo maximum)');
    return api(await authedConfig(), 'PUT', `/api/files/${fileId}`, { document });
}

// The engine silently ignores an assignment the student is not enrolled in: we detect it.
async function submitFile(fileId, assignmentId) {
    const file = await api(await authedConfig(), 'PUT', `/api/files/${fileId}`, { assignment_id: assignmentId });
    if (file.assignment_id !== assignmentId) throw new HttpError(403, "vous n'êtes pas rattaché à ce devoir");
    return file;
}

// --- 4. QUEUE ---
function failureStatus(err) {
    return err.status === 401
        ? { state: 'auth_error', message: 'Identifiants refusés par le moteur.' }
        : { state: 'offline', message: err.message };
}

function toMetrics(item, dropExtended) {
    return Object.entries(item.values)
        .filter(([type]) => !(dropExtended && EXTENDED_TYPES.has(type)))
        .map(([type, value]) => ({ type, value, period: item.period }));
}

async function pushItem(config, state, item) {
    for (let attempt = 0; attempt < 3; attempt++) {
        const fileId = await ensureFile(config, state.files, item);
        try {
            await api(config, 'POST', `/api/files/${fileId}/metrics`, { metrics: toMetrics(item, state.extendedUnsupported) });
            return;
        } catch (err) {
            if (err.status === 404) {
                // file deleted on the engine side: we recreate one for this document
                delete state.files[item.documentId];
                saveEntry('files', item.documentId, undefined);
            } else if (err.status === 400 && err.code === 'metric_type_unknown' && !state.extendedUnsupported) {
                // Only this code means the engine predates the extended metrics; any other 400
                // (an invalid period, a malformed body) must not silence them for good.
                state.extendedUnsupported = true;
                save('extendedUnsupported', true);
            } else {
                throw err;
            }
        }
    }
}

function enqueue(item) {
    const queue = load('queue', []);
    queue.push({ ...item, id: crypto.randomUUID() });
    save('queue', queue.slice(-MAX_QUEUE));
    return drain();
}

function dequeue(id) {
    save('queue', load('queue', []).filter((item) => item.id !== id));
}

function drain() {
    return withLock(async () => {
        const state = getState();
        if (!hasAuth(getConfig())) {
            setStatus({ state: 'unconfigured' });
            return;
        }
        let config;
        try {
            config = await authedConfig();
        } catch (err) {
            setStatus(failureStatus(err));
            return;
        }
        while (state.queue.length > 0) {
            if (!takeLease()) return; // another instance is draining the queue
            const item = state.queue[0];
            try {
                await pushItem(config, state, item);
            } catch (err) {
                if (err.status === 400) {
                    // measurement rejected by the engine: resending it would block the queue forever
                    console.warn('Certimens: mesure rejetée', err.message, item);
                } else {
                    setStatus(failureStatus(err));
                    return;
                }
            }
            state.queue.shift();
            dequeue(item.id);
        }
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
