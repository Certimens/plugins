// Certimens — VS Code extension, sending to the engine (the counterpart of
// extension/background.js and libreoffice/pythonpath/certimens_agent/engine.py).
//
// Each source file of the project is tied to its own engine file (created on the first window
// that carries real activity via POST /api/files, then remembered). Measurements go to
// POST /api/files/:id/metrics, authenticating as the student with an API token (Bearer) created
// at login and kept in the editor's secret storage, never in settings.json — a settings file is
// synchronised, committed and read over the shoulder.
//
// A file only reaches the engine once the student has actually written in it: opening a project
// of four hundred files must not create four hundred files on the engine.
//
// When offline, windows stay in a persisted queue and are resent every minute.

const DEFAULT_ENGINE_URL = 'https://monespace.certimens.fr';
const RETRY_MS = 60 * 1000;
const MAX_QUEUE = 5000;
// The engine caps a request body at 25 MiB; in base64 the source grows by a third.
const MAX_UPLOAD_BASE64 = 24 * 1024 * 1024;
// Metrics some deployed engines don't know: a 400 "metric_type_unknown" drops them rather than
// losing the whole window. paste_events is in the set although this agent never sends it — the
// set is the product's, not this agent's.
const EXTENDED_TYPES = new Set(['paste_events', 'focus_losses', 'median_flight_ms']);

const { t, dateLocale, setLanguage } = require('./i18n.js');

class HttpError extends Error {
    constructor(status, message, code) {
        super(message);
        this.status = status;
        // The engine names the rule that refused the request ({"code", "error"}): a 400 says
        // which one, instead of being read as "this engine is too old".
        this.code = code || '';
    }
}

function trimUrl(url) {
    return String(url || '').replace(/\/+$/, '');
}

/**
 * The engine client and its queue.
 *
 * It knows nothing of VS Code: the host hands it a `store` (a key/value map it persists), a
 * `secrets` (where the API token is kept) and the timers, which is what lets the queue be
 * exercised without an editor.
 */
class Engine {
    constructor({ store, secrets, userAgent, hostLanguage, fetch: fetchImpl, schedule, cancel }) {
        this.store = store;
        // The editor's display language, used until the account's own is known.
        this.hostLanguage = hostLanguage;
        this.secrets = secrets;
        this.userAgent = userAgent;
        this.fetch = fetchImpl || globalThis.fetch;
        this.schedule = schedule || setInterval;
        this.cancel = cancel || clearInterval;
        this.listeners = [];
        this.retryTimer = null;
        // Every read/write of the queue goes through this lock: a send and a new measurement
        // never step on each other, nor create two files for the same document.
        this.lock = Promise.resolve();
    }

    // --- 1. STORAGE ---
    state() {
        return {
            files: this.store.get('files', {}),
            // Path of each file in the project: the last one seen, and the one last sent to the
            // engine. A file renamed or moved in the project is renamed on the engine too.
            names: this.store.get('names', {}),
            syncedNames: this.store.get('syncedNames', {}),
            queue: this.store.get('queue', []),
            status: this.store.get('status', { state: 'idle' }),
            extendedUnsupported: this.store.get('extendedUnsupported', false),
        };
    }

    config() {
        // language: the account's own, sent by the engine at login, so the panel and every
        // message open in the language the student chose in their Certimens space.
        return { engineUrl: DEFAULT_ENGINE_URL, email: '', tokenId: '', language: '', ...this.store.get('config', {}) };
    }

    token() {
        return this.secrets.get('token');
    }

    async configured() {
        return !!(await this.token());
    }

    async setStatus(status) {
        await this.store.set('status', { ...status, at: new Date().toISOString() });
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
            throw new HttpError(res.status, message, code);
        }
        // The metrics 201 returns the text "Created" (Fiber's SendStatus): only JSON is read.
        if (!(res.headers.get('Content-Type') || '').includes('application/json')) return null;
        return res.json();
    }

    // The User-Agent is set explicitly, and it is what the engine recognizes this agent by
    // (clientFamily, internal/file/adapters/inbound/http/ingestion.go): Node sends none of the
    // headers a browser adds on its own, so without it every push would be filed as coming from
    // a client the platform does not know.
    headers(token) {
        const headers = { 'Content-Type': 'application/json', 'User-Agent': this.userAgent };
        if (token) headers['Authorization'] = `Bearer ${token}`;
        return headers;
    }

    async request(method, url, body, token) {
        let res;
        try {
            res = await this.fetch(url, {
                method,
                headers: this.headers(token),
                body: body === undefined ? undefined : JSON.stringify(body),
            });
        } catch (err) {
            throw new HttpError(0, err.message || t('error.networkError'));
        }
        return this.read(res);
    }

    async api(method, path, body) {
        const token = await this.token();
        if (!token) throw new HttpError(401, t('error.noToken'));
        return this.request(method, trimUrl(this.config().engineUrl) + path, body, token);
    }

    /**
     * Exchanges an email and a password for an API token: log in (session token), then create a
     * token with no expiry, revocable from the Certimens space. The session token, now useless,
     * is revoked. The password is never stored.
     */
    async login({ engineUrl, email, password }) {
        const url = trimUrl(engineUrl || DEFAULT_ENGINE_URL);
        const me = await this.request('POST', url + '/api/auth/login', { email, password });
        const label = t('token.vscode', { date: new Date().toLocaleDateString(dateLocale()) });
        const token = await this.request('POST', url + '/api/auth/tokens', { label }, me.token);
        try {
            await this.request('POST', url + '/api/auth/logout', undefined, me.token);
        } catch (_) { /* network: the session token will expire on its own */ }

        setLanguage(me.language, this.hostLanguage);
        await this.secrets.set('token', token.token);
        await this.store.set('config', { engineUrl: url, email: me.email || email, tokenId: token.id, language: me.language || '' });
        // A new engine may well know the extended metrics the previous one refused.
        await this.store.set('extendedUnsupported', false);
        await this.setStatus({ state: 'idle' }); // clears any auth_error before the next send
        return me;
    }

    async logout() {
        const { tokenId } = this.config();
        if (tokenId) {
            try {
                await this.api('DELETE', `/api/auth/tokens/${tokenId}`);
            } catch (_) { /* already revoked or offline: the local token is wiped anyway */ }
        }
        await this.secrets.delete('token');
        await this.store.set('config', { engineUrl: this.config().engineUrl, email: this.config().email, language: this.config().language });
        await this.setStatus({ state: 'unconfigured' });
    }

    // --- 3. FILES ---
    // Creates the file's engine file if needed. The name sent is the project-relative path: an
    // absolute one would carry the student's account name to the engine for nothing.
    async ensureFile(files, item) {
        if (files[item.documentId]) return files[item.documentId];
        const file = await this.api('POST', '/api/files', { document_name: item.documentName });
        files[item.documentId] = file.id;
        await this.store.set('files', files);
        const syncedNames = this.store.get('syncedNames', {});
        syncedNames[item.documentId] = item.documentName;
        await this.store.set('syncedNames', syncedNames);
        return file.id;
    }

    // Propagates to the engine the files renamed or moved in the project since the last send.
    async syncNames(state) {
        for (const [documentId, name] of Object.entries(state.names)) {
            const fileId = state.files[documentId];
            if (!fileId || state.syncedNames[documentId] === name) continue;
            try {
                await this.api('PUT', `/api/files/${fileId}`, { document_name: name });
            } catch (err) {
                if (err.status !== 404) throw err; // 404: file deleted, recreated on the next send
            }
            state.syncedNames[documentId] = name;
            await this.store.set('syncedNames', state.syncedNames);
        }
    }

    // A file's path as last seen in the project (on open, then on every rename).
    noteName(documentId, documentName) {
        if (!documentId || !documentName) return Promise.resolve();
        return this.withLock(async () => {
            const names = this.store.get('names', {});
            if (names[documentId] === documentName) return;
            names[documentId] = documentName;
            await this.store.set('names', names);
        });
    }

    // Engine file of a project file (null when none was created yet, or it was deleted there).
    async fileInfo(documentId) {
        const fileId = this.store.get('files', {})[documentId];
        if (!fileId) return { fileId: null, file: null };
        try {
            return { fileId, file: await this.api('GET', `/api/files/${fileId}`) };
        } catch (err) {
            if (err.status !== 404) throw err;
            await this.forget(documentId);
            return { fileId: null, file: null };
        }
    }

    forget(documentId) {
        return this.withLock(async () => {
            const files = this.store.get('files', {});
            delete files[documentId];
            await this.store.set('files', files);
        });
    }

    // Explicit creation of a project file's engine file, from the panel; no-op if it exists.
    createFileFor(documentId, documentName) {
        return this.withLock(async () => {
            const files = this.store.get('files', {});
            const existed = !!files[documentId];
            const fileId = await this.ensureFile(files, { documentId, documentName });
            return { fileId, existed };
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
     * Sends a file's source to its engine file, replacing what was already sent. This is the one
     * place where the student's own text leaves the machine, and it only ever runs on an explicit
     * command: the measurement itself sends counters and nothing else.
     */
    async uploadDocument(documentId, text) {
        const fileId = this.store.get('files', {})[documentId];
        if (!fileId) throw new HttpError(404, t('error.noFile'));
        const document = Buffer.from(text, 'utf8').toString('base64');
        if (document.length > MAX_UPLOAD_BASE64) throw new HttpError(413, t('error.tooLarge'));
        return this.api('PUT', `/api/files/${fileId}`, { document });
    }

    // The engine silently ignores an assignment the student isn't enrolled in: we detect it.
    async submitFile(fileId, assignmentId) {
        const file = await this.api('PUT', `/api/files/${fileId}`, { assignment_id: assignmentId });
        if (file.assignment_id !== assignmentId) throw new HttpError(403, t('error.notEnrolled'));
        return file;
    }

    // --- 4. QUEUE ---
    metricsOf(item, dropExtended) {
        return Object.entries(item.values)
            .filter(([type]) => !(dropExtended && EXTENDED_TYPES.has(type)))
            .map(([type, value]) => ({ type, value, period: item.period }));
    }

    async pushItem(state, item) {
        for (let attempt = 0; attempt < 3; attempt++) {
            const fileId = await this.ensureFile(state.files, item);
            try {
                await this.api('POST', `/api/files/${fileId}/metrics`, { metrics: this.metricsOf(item, state.extendedUnsupported) });
                return;
            } catch (err) {
                if (err.status === 404) {
                    // file deleted on the engine side: we recreate one for this project file
                    delete state.files[item.documentId];
                    await this.store.set('files', state.files);
                } else if (err.status === 400 && err.code === 'metric_type_unknown' && !state.extendedUnsupported) {
                    // Only this code means the engine is older than the extended metrics. Any
                    // other 400 (an invalid period, a malformed body) must not latch this flag,
                    // or focus_losses and median_flight_ms would stop for good.
                    state.extendedUnsupported = true;
                    await this.store.set('extendedUnsupported', true);
                } else {
                    throw err;
                }
            }
        }
    }

    enqueue(item) {
        return this.withLock(async () => {
            const queue = this.store.get('queue', []);
            queue.push(item);
            await this.store.set('queue', queue.slice(-MAX_QUEUE));
        }).then(() => this.drain());
    }

    failureStatus(err) {
        return err.status === 401
            ? { state: 'auth_error', message: t('error.credentials') }
            : { state: 'offline', message: err.message };
    }

    drain() {
        return this.withLock(async () => {
            if (!(await this.configured())) {
                await this.setStatus({ state: 'unconfigured' });
                return;
            }
            const state = this.state();
            while (state.queue.length > 0) {
                const item = state.queue[0];
                try {
                    await this.pushItem(state, item);
                } catch (err) {
                    if (err.status === 400) {
                        // measurement refused by the engine: resending it would block the queue
                        // forever
                        console.warn('Certimens : mesure rejetée —', err.message);
                    } else {
                        await this.setStatus(this.failureStatus(err));
                        return;
                    }
                }
                state.queue.shift();
                await this.store.set('queue', state.queue);
            }
            try {
                await this.syncNames(state);
            } catch (err) {
                await this.setStatus(this.failureStatus(err));
                return;
            }
            await this.setStatus({ state: 'synced' });
        });
    }

    start() {
        this.retryTimer = this.schedule(() => this.drain(), RETRY_MS);
        return this.drain();
    }

    stop() {
        this.cancel(this.retryTimer);
    }
}

module.exports = { Engine, HttpError, trimUrl, DEFAULT_ENGINE_URL, MAX_UPLOAD_BASE64 };
