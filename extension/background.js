// Certimens — writing agent, background: pushes measurement windows to the engine.
//
// Each document (Google Docs or Word Online) is tied to an engine file (created on the first send via
// POST /api/files, then remembered). Measurements are sent to POST /api/files/:id/metrics,
// authenticating with an API token (Bearer) created at login and kept in place of the
// password. When offline, they stay in a persisted queue (chrome.storage.local) and are
// resent every minute.

const DEFAULT_ENGINE_URL = 'https://monespace.certimens.fr';
const RETRY_ALARM = 'certimens-retry';
const MAX_QUEUE = 5000;
// Google Docs export hosts: docs.google.com redirects to googleusercontent.com.
const GOOGLE_EXPORT_ORIGINS = ['https://docs.google.com/document/*', 'https://*.googleusercontent.com/*'];
// The engine caps a request body at 25 MiB; in base64, the .docx grows by a third.
const MAX_UPLOAD_BASE64 = 24 * 1024 * 1024;

// Metrics added by this agent: an older engine rejects them (400 "unknown metric
// type"), so we drop them rather than lose the whole window.
const EXTENDED_TYPES = new Set(['paste_events', 'focus_losses', 'median_flight_ms']);

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
async function getConfig() {
    const { config } = await chrome.storage.local.get('config');
    // token: API token (Bearer) kept in place of the password. tokenId: its id,
    // used to revoke it at logout. password: present only in an old config, migrated
    // on the next send (see authedConfig).
    return { engineUrl: DEFAULT_ENGINE_URL, email: '', token: '', tokenId: '', ...config };
}

// A config can authenticate if it carries a token, or an old password still to be migrated.
function hasAuth(config) {
    return !!(config.token || config.password);
}

async function getState() {
    const s = await chrome.storage.local.get(['files', 'titles', 'syncedTitles', 'queue', 'status', 'extendedUnsupported']);
    return {
        files: s.files || {},
        // Document title in the editor: the last one seen, and the one from the last send to the engine.
        titles: s.titles || {},
        syncedTitles: s.syncedTitles || {},
        queue: s.queue || [],
        status: s.status || { state: 'idle' },
        extendedUnsupported: !!s.extendedUnsupported,
    };
}

async function setStatus(status) {
    await chrome.storage.local.set({ status: { ...status, at: new Date().toISOString() } });
    await refreshBadge();
}

// Every read/write of the queue goes through this lock: a send and a new
// measurement never step on each other (nor create two files for the same document).
let lock = Promise.resolve();
function withLock(fn) {
    const run = lock.then(fn, fn);
    lock = run.catch(() => {});
    return run;
}

// --- 2. ENGINE API ---
// The engine authenticates every request with an API token (Bearer), created at login and
// kept in place of the password.
function trimUrl(url) {
    return url.replace(/\/+$/, '');
}

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
        throw new HttpError(res.status, message, code);
    }
    // The metrics 201 returns the text "Created" (Fiber's SendStatus): only JSON is read.
    if (!(res.headers.get('Content-Type') || '').includes('application/json')) return null;
    return res.json();
}

async function api(config, method, path, body) {
    return readResponse(await fetch(trimUrl(config.engineUrl) + path, {
        method,
        headers: {
            'Authorization': `Bearer ${config.token}`,
            'Content-Type': 'application/json',
        },
        body: body === undefined ? undefined : JSON.stringify(body),
    }));
}

// Gets an API token from an email/password: log in (session token), then
// create an API token with no expiry, revocable from the Certimens space. The session
// token, now useless, is revoked. Returns { me, token, tokenId }.
async function createApiToken(engineUrl, email, password) {
    const url = trimUrl(engineUrl);
    const me = await readResponse(await fetch(url + '/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
    }));
    const bearer = { 'Authorization': `Bearer ${me.token}`, 'Content-Type': 'application/json' };
    const token = await readResponse(await fetch(url + '/api/auth/tokens', {
        method: 'POST',
        headers: bearer,
        body: JSON.stringify({ label: `Agent navigateur (${new Date().toLocaleDateString('fr-FR')})` }),
    }));
    try {
        await fetch(url + '/api/auth/logout', { method: 'POST', headers: bearer });
    } catch (_) { /* network: the session token will expire on its own */ }
    return { me, token: token.token, tokenId: token.id };
}

// Config guaranteed to carry a token. An old password-based config is migrated once here:
// its password is exchanged for a token, then wiped from storage.
//
// The in-flight migration is shared: drain() and a popup request can reach this at the same
// time, and each would otherwise create an API token, with only the last one recorded — the
// other would stay valid on the engine with no way for the student to revoke it.
let migration = null;
async function authedConfig() {
    const config = await getConfig();
    if (config.token || !config.password) return config;
    if (!migration) {
        migration = (async () => {
            const { me, token, tokenId } = await createApiToken(config.engineUrl, config.email, config.password);
            const migrated = { engineUrl: trimUrl(config.engineUrl), email: me.email || config.email, token, tokenId };
            await chrome.storage.local.set({ config: migrated });
            return migrated;
        })().finally(() => { migration = null; });
    }
    return migration;
}

// Creates the document's engine file if needed. editorTitle is the document title in
// the editor at that moment: it serves as the reference for detecting a later rename, even if the
// file was given another name in the popup.
async function ensureFile(config, files, item, editorTitle = item.documentName) {
    if (files[item.documentId]) return files[item.documentId];
    const file = await api(config, 'POST', '/api/files', { document_name: item.documentName });
    files[item.documentId] = file.id;
    const { syncedTitles = {} } = await chrome.storage.local.get('syncedTitles');
    syncedTitles[item.documentId] = editorTitle;
    await chrome.storage.local.set({ files, syncedTitles });
    return file.id;
}

// Propagates to the engine any documents renamed in the editor (Google Docs, Word Online).
// The name chosen in the popup is kept as long as the document title doesn't change.
async function syncTitles(config, state) {
    for (const [documentId, title] of Object.entries(state.titles)) {
        const fileId = state.files[documentId];
        if (!fileId || state.syncedTitles[documentId] === title) continue;
        try {
            await api(config, 'PUT', `/api/files/${fileId}`, { document_name: title });
        } catch (err) {
            if (err.status !== 404) throw err; // 404: file deleted, recreated on the next send
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

// Login from the popup: the password is exchanged for an API token, the only thing kept
// (the engine accepts the rest only if the credentials are valid).
async function login({ engineUrl, email, password }) {
    const { me, token, tokenId } = await createApiToken(engineUrl, email, password);
    // A new engine may well know the extended metrics the previous one refused.
    await chrome.storage.local.set({ config: { engineUrl: trimUrl(engineUrl), email: me.email || email, token, tokenId }, extendedUnsupported: false });
    await setStatus({ state: 'idle' }); // clears any auth_error before the next send
    return me;
}

// Explicit (popup) creation of a document's engine file; no-op if it already exists.
function createFileFor(documentId, documentName, editorTitle) {
    return withLock(async () => {
        const config = await authedConfig();
        const { files } = await getState();
        const existed = !!files[documentId];
        const fileId = await ensureFile(config, files, { documentId, documentName }, editorTitle || documentName);
        return { fileId, existed };
    });
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
                await chrome.storage.local.set({ files: state.files });
            } else if (err.status === 400 && err.code === 'metric_type_unknown' && !state.extendedUnsupported) {
                // Only this code means the engine is older than the extended metrics. Any other
                // 400 (an invalid period, a malformed body) used to latch this flag too, and the
                // browser then stopped sending paste_events, focus_losses and median_flight_ms
                // for good — the engine showed no "sorties du document" ever again.
                state.extendedUnsupported = true;
                await chrome.storage.local.set({ extendedUnsupported: true });
                console.warn('Certimens: moteur sans les mesures étendues, elles ne sont plus envoyées.');
            } else {
                throw err;
            }
        }
    }
}

// Engine file associated with a document (null if not yet created or deleted on the engine side).
async function docInfo(documentId) {
    const { files } = await getState();
    const fileId = files[documentId];
    if (!fileId) return { fileId: null, file: null };
    try {
        return { fileId, file: await api(await authedConfig(), 'GET', `/api/files/${fileId}`) };
    } catch (err) {
        if (err.status !== 404) throw err;
        await withLock(async () => {
            const state = await getState();
            delete state.files[documentId];
            await chrome.storage.local.set({ files: state.files });
        });
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

// Exports a Google Doc using the student's session. Done here rather than in the tab:
// Google redirects to googleusercontent.com, readable thanks to the extension's host permissions
// but not from the page. An expired session returns the login page (HTML).
async function exportGoogleDoc(documentId, format) {
    if (!/^[a-zA-Z0-9_-]+$/.test(documentId)) throw new HttpError(0, 'document Google Docs invalide');
    // Firefox (and Chrome when site access is restricted) doesn't automatically grant the manifest
    // hosts: without them, the export redirect is blocked by CORS.
    if (!(await chrome.permissions.contains({ origins: GOOGLE_EXPORT_ORIGINS }))) {
        throw new HttpError(0, "autorisez l'extension à lire les exports Google Docs (bouton « Envoyer le .docx »)");
    }
    let res;
    try {
        res = await fetch(`https://docs.google.com/document/d/${documentId}/export?format=${format}`, { credentials: 'include' });
    } catch (err) {
        throw new HttpError(0, `export Google Docs bloqué (${err.message})`);
    }
    if (!res.ok) throw new HttpError(0, `export Google Docs refusé (${res.status})`);
    if ((res.headers.get('Content-Type') || '').includes('text/html')) {
        throw new HttpError(0, 'export Google Docs refusé (session Google expirée ?)');
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

// Sends a document's .docx to its engine file (replaces the already-sent document): the
// content comes from the popup (chosen file, Word Online), otherwise from the Google Docs export.
async function uploadDocx({ documentId, document }) {
    const { files } = await getState();
    const fileId = files[documentId];
    if (!fileId) throw new HttpError(404, "ce document n'a pas encore de fichier Certimens");
    if (!document) {
        if (documentId.startsWith('word:')) throw new HttpError(0, 'choisissez le fichier .docx téléchargé depuis Word');
        document = toBase64(await (await exportGoogleDoc(documentId, 'docx')).arrayBuffer());
    }
    if (document.length > MAX_UPLOAD_BASE64) throw new HttpError(413, 'document trop volumineux (18 Mo maximum)');
    return api(await authedConfig(), 'PUT', `/api/files/${fileId}`, { document });
}

// The engine silently ignores an assignment the student isn't enrolled in: we detect it.
async function submitFile(fileId, assignmentId) {
    const file = await api(await authedConfig(), 'PUT', `/api/files/${fileId}`, { assignment_id: assignmentId });
    if (file.assignment_id !== assignmentId) throw new HttpError(403, "vous n'êtes pas rattaché à ce devoir");
    return file;
}

// Document opened without an engine file: we open the popup (once per document and per browser
// session) so the student creates their file and picks the assignment.
async function promptUnknownDocument(documentId, tab) {
    const config = await getConfig();
    const { files, status } = await getState();
    if (!hasAuth(config) || status.state === 'auth_error' || files[documentId]) return;
    const { prompted = [] } = await chrome.storage.session.get('prompted');
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

// --- 3. QUEUE ---
function failureStatus(err) {
    return err.status === 401
        ? { state: 'auth_error', message: 'Identifiants refusés par le moteur.' }
        : { state: 'offline', message: err.message };
}

function enqueue(item) {
    return withLock(async () => {
        const { queue } = await getState();
        queue.push(item);
        await chrome.storage.local.set({ queue: queue.slice(-MAX_QUEUE) });
    });
}

function drain() {
    return withLock(async () => {
        const state = await getState();
        if (!hasAuth(await getConfig())) {
            await setStatus({ state: 'unconfigured' });
            return;
        }
        let config;
        try {
            config = await authedConfig();
        } catch (err) {
            await setStatus(failureStatus(err));
            return;
        }
        while (state.queue.length > 0) {
            const item = state.queue[0];
            try {
                await pushItem(config, state, item);
            } catch (err) {
                if (err.status === 400) {
                    // measurement rejected by the engine: resending it would block the queue forever
                    console.warn('Certimens: mesure rejetée', err.message, item);
                } else {
                    await setStatus(failureStatus(err));
                    return;
                }
            }
            state.queue.shift();
            await chrome.storage.local.set({ queue: state.queue });
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
// The badge carries a state, not the brand: it uses the verdict colors the engine keeps outside
// its brand guidelines (green / orange / red), not the slate and gold of the rest of the UI.
async function refreshBadge() {
    const { queue, status } = await getState();
    let text = 'ON';
    let color = '#137333';
    if (status.state === 'unconfigured' || status.state === 'auth_error') {
        text = 'OFF';
        color = '#c5221f';
    } else if (queue.length > 0) {
        text = String(Math.min(queue.length, 999));
        color = '#b06000';
    }
    await chrome.action.setBadgeText({ text });
    await chrome.action.setBadgeBackgroundColor({ color });
}

// --- 5. DEBUG MODE ---
// Switched on from the options page: the last measurement windows are kept, so what the sensor
// counts can be compared with what the engine displays. Counters only, never any text.
const DEBUG_LOG_MAX = 30;

async function debugRecord(entry) {
    const { debug, debugLog = [] } = await chrome.storage.local.get(['debug', 'debugLog']);
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
        const { documentId, documentName, period, values, reason } = message;
        enqueue({ documentId, documentName, period, values }).then(drain).catch(logFailure);
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
            configured: hasAuth(config),
            queued: state.queue.length,
            documents: Object.keys(state.files).length,
            status: state.status,
            extendedDropped: state.extendedUnsupported,
        };
    },
    async CERTIMENS_WHOAMI() {
        const me = await api(await authedConfig(), 'GET', '/api/auth/me');
        drain();
        return { me };
    },
    async CERTIMENS_LOGIN(message) {
        return { me: await login(message) };
    },
    async CERTIMENS_LOGOUT() {
        const config = await getConfig();
        if (config.token && config.tokenId) {
            try {
                await api(config, 'DELETE', `/api/auth/tokens/${config.tokenId}`);
            } catch (_) { /* already revoked or offline: the local token is wiped anyway */ }
        }
        await chrome.storage.local.set({ config: { engineUrl: config.engineUrl, email: config.email } });
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
        return { file: await submitFile(message.fileId, message.assignmentId) };
    },
    CERTIMENS_CREATE_FILE: (message) => createFileFor(message.documentId, message.documentName, message.editorTitle),
};

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (NOTIFICATIONS[message.type]) {
        NOTIFICATIONS[message.type](message, sender);
        return false;
    }
    const handler = REQUESTS[message.type];
    if (!handler) return false;
    Promise.resolve()
        .then(() => handler(message, sender))
        .then(
            (fields) => sendResponse({ ok: true, ...fields }),
            (err) => sendResponse({ ok: false, status: err.status || 0, message: err.message }),
        );
    return true; // async response
});

chrome.storage.onChanged.addListener((changes) => {
    if (changes.config) drain();
});

chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === RETRY_ALARM) drain();
});

function init() {
    chrome.alarms.create(RETRY_ALARM, { periodInMinutes: 1 });
    drain();
}

chrome.runtime.onInstalled.addListener((details) => {
    init();
    if (details.reason === 'install') chrome.runtime.openOptionsPage();
});
chrome.runtime.onStartup.addListener(init);
