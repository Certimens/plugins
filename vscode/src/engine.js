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

const DEFAULT_ENGINE_URL = 'https://monespace.certimens.fr';
// What changed, for the student who finds the extension different from yesterday: the
// Marketplace updates it in the background and says nothing. Declared by each agent in its own
// engine client, and compared by `make check`.
const RELEASE_NOTES_URL = 'https://github.com/certimens/plugins/releases';
const RETRY_MS = 60 * 1000;
// Added to the pairing interval each time the engine answers "too often" (RFC 8628 slow_down,
// or the rate limiter in front of it): asking at the same pace would only be refused again.
const SLOW_DOWN_MS = 5 * 1000;
const MAX_QUEUE = 5000;
// The engine caps a request body at 25 MiB; in base64 the source grows by a third.
const MAX_UPLOAD_BASE64 = 24 * 1024 * 1024;
// Metrics some deployed engines don't know, **newest generation first**: a 400
// "metric_type_unknown" drops one generation and the window is sent again, rather than dropping
// everything the engine was never asked about. An engine that knows the first generation but not
// the second keeps receiving the first. paste_events and self_paste_events are in the list
// although this agent never sends them — the list is the product's, not this agent's.
const EXTENDED_GENERATIONS = [
    ['self_paste_events', 'injected_chars_max', 'injected_chars_after_return'],
    ['paste_events', 'focus_losses', 'flight_median_ms'],
];

// The types no longer sent, once `dropped` generations have been refused.
function droppedTypes(dropped) {
    return new Set(EXTENDED_GENERATIONS.slice(0, dropped).flat());
}

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
 * `secrets` (where the API token is kept) and the timers, which is what lets the queue be
 * exercised without an editor.
 */
class Engine {
    /**
     * @param {object} host what the editor provides; the last three are the tests' seams.
     * @param {{get: Function, set: Function}} host.store persisted key/value map.
     * @param {{get: Function, set: Function, delete: Function}} host.secrets where the API token lives.
     * @param {string} host.userAgent how this agent announces itself (see docs/moteur.md).
     * @param {string} host.hostLanguage the editor's display language, until the account's is known.
     * @param {typeof globalThis.fetch} [host.fetch] Node's own, unless a test hands over another.
     * @param {Function} [host.schedule] setInterval, unless a test drives the clock.
     * @param {Function} [host.cancel] clearInterval, likewise.
     */
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
        // never step on each other, nor create two documents for the same file.
        this.lock = Promise.resolve();
    }

    // --- 1. STORAGE ---
    state() {
        // The queue is stored whole and read from its cursor: the windows already pushed stay at
        // the head of the array until something compacts it, and everything outside this method
        // only ever sees what is still waiting. Draining used to rewrite the array after each
        // window — a day caught up offline wrote megabytes thousands of times — and what it
        // writes now is `queueSent`, a number.
        const stored = this.store.get('queue', []);
        const queueSent = this.store.get('queueSent', 0);
        return {
            engineIds: this.store.get('engineIds', {}),
            // Path of each file in the project: the last one seen, and the one last sent to the
            // engine. A file renamed or moved in the project is renamed on the engine too.
            names: this.store.get('names', {}),
            syncedNames: this.store.get('syncedNames', {}),
            queue: stored.slice(queueSent),
            // Where that slice starts, which is what `drain` moves. Absent on an install that
            // predates it, which reads as nothing sent yet and is exactly right.
            queueSent,
            status: this.store.get('status', { state: 'idle' }),
            // How many generations the engine has refused. An install that met an older engine
            // before generations existed carries a boolean, which meant "everything known
            // then": the first generation, which is the last of the list.
            extendedDropped: typeof this.store.get('extendedDropped', null) === 'number'
                ? this.store.get('extendedDropped', 0)
                : (this.store.get('extendedUnsupported', false) ? EXTENDED_GENERATIONS.length : 0),
        };
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
            throw new HttpError(res.status, REWORDED[code] ? t(REWORDED[code]) : message, code);
        }
        // The metrics 201 returns the text "Created" (Fiber's SendStatus): only JSON is read.
        if (!(res.headers.get('Content-Type') || '').includes('application/json')) return null;
        return res.json();
    }

    // The User-Agent is set explicitly, and it is what the engine recognizes this agent by
    // (its client family): Node sends none of the headers a browser adds on its own, so without
    // it every push would be filed as coming from a client the platform does not know.
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
     * Opens a pairing: the engine answers with a short code to show and a long one to poll with.
     * No password is asked for anywhere — an account that signs in through Google, through its
     * establishment's provider or from a Moodle launch has none, and a password box in an editor
     * is the exact shape a counterfeit extension would take.
     */
    async startPairing(engineUrl) {
        const url = trimUrl(engineUrl || DEFAULT_ENGINE_URL);
        const res = await this.request('POST', url + '/api/auth/device', { client: t('pair.clientVscode') });
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

    /**
     * Asks once whether a pairing has been confirmed. Returns the API token, or null while
     * nobody has confirmed yet; every other refusal throws, because each means something the
     * student has to be told.
     */
    async pollPairing(pairing) {
        try {
            const res = await this.request('POST', trimUrl(pairing.engineUrl) + '/api/auth/device/token', {
                device_code: pairing.deviceCode,
            });
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
        const url = trimUrl(engineUrl || DEFAULT_ENGINE_URL);
        const me = await this.request('GET', url + '/api/auth/me', undefined, token);
        const tokens = await this.request('GET', url + '/api/auth/tokens', undefined, token);
        // The id of this very token, so signing out revokes it; the engine never returns a raw
        // token twice, so it is found by being the newest one.
        const tokenId = (tokens[0] && tokens[0].id) || '';

        setLanguage(me.language, this.hostLanguage);
        await this.secrets.set('token', token);
        // displayName: computed by the engine, which falls back to the e-mail when the account
        // has no name. An engine too old to send it leaves it empty, and the panel falls back.
        await this.store.set('config', {
            engineUrl: url, email: me.email || '',
            displayName: me.display_name || '', tokenId, language: me.language || '',
        });
        // A new engine may well know the extended metrics the previous one refused.
        await this.store.set('extendedDropped', 0);
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
    // Creates the file's engine document if needed. The name sent is the project-relative path: an
    // absolute one would carry the student's account name to the engine for nothing.
    async ensureDocument(engineIds, item) {
        if (engineIds[item.documentId]) return engineIds[item.documentId];
        const file = await this.api('POST', '/api/documents', { name: item.documentName });
        engineIds[item.documentId] = file.id;
        await this.store.set('engineIds', engineIds);
        const syncedNames = this.store.get('syncedNames', {});
        syncedNames[item.documentId] = item.documentName;
        await this.store.set('syncedNames', syncedNames);
        return file.id;
    }

    // Propagates to the engine the files renamed or moved in the project since the last send.
    async syncNames(state) {
        for (const [documentId, name] of Object.entries(state.names)) {
            const engineId = state.engineIds[documentId];
            if (!engineId || state.syncedNames[documentId] === name) continue;
            try {
                await this.api('PUT', `/api/documents/${engineId}`, { name });
            } catch (err) {
                // 404: file deleted, recreated on the next send. deadline_passed: the copy is
                // frozen, so this rename will not land — noting it as synced anyway is what
                // stops it being retried at every drain, and the sending status going red over
                // a refusal nobody here can act on. A rename made after the teacher pushes the
                // deadline does go through; this one stays as it was when the window shut.
                if (err.status !== 404 && err.code !== 'deadline_passed') throw err;
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
        const engineId = this.store.get('engineIds', {})[documentId];
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
            const engineIds = this.store.get('engineIds', {});
            delete engineIds[documentId];
            await this.store.set('engineIds', engineIds);
        });
    }

    // Explicit creation of a project file's engine document, from the panel; no-op if it exists.
    createFileFor(documentId, documentName) {
        return this.withLock(async () => {
            const engineIds = this.store.get('engineIds', {});
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
     * command: the measurement itself sends counters and nothing else.
     */
    async uploadDocument(documentId, text) {
        const engineId = this.store.get('engineIds', {})[documentId];
        if (!engineId) throw new HttpError(404, t('error.noFile'));
        const document = Buffer.from(text, 'utf8').toString('base64');
        if (document.length > MAX_UPLOAD_BASE64) throw new HttpError(413, t('error.tooLarge'));
        return this.api('PUT', `/api/documents/${engineId}`, { document });
    }

    // The engine silently ignores an assignment the student isn't enrolled in: we detect it.
    async submitDocument(engineId, assignmentId) {
        const file = await this.api('PUT', `/api/documents/${engineId}`, { assignment_id: assignmentId });
        if (file.assignment_id !== assignmentId) throw new HttpError(403, t('error.notEnrolled'));
        return file;
    }

    // --- 4. QUEUE ---
    // The engine accepts one exact shape for a measurement: `{type, value, period}`, and the
    // same with `offline` appended when — and only when — the window was written while the
    // engine was out of reach. The period is rebuilt key by key rather than forwarded as it
    // arrives: `item` was read back from the editor's store, and nothing promises the object that comes
    // back carries its keys in the order they were written — a round trip could hand back
    // `{end, start}`. Changing this shape is a change of contract, settled on the engine's
    // side first.
    metricsOf(item, dropped) {
        const refused = droppedTypes(dropped);
        const period = { start: item.period.start, end: item.period.end };
        return Object.entries(item.values)
            .filter(([type]) => !refused.has(type))
            .map(([type, value]) => (item.offline
                ? { type, value, period, offline: true }
                : { type, value, period }));
    }

    async pushItem(state, item) {
        // One attempt per generation that may have to be dropped, plus one for a document
        // recreated after a 404, plus the first.
        for (let attempt = 0; attempt < EXTENDED_GENERATIONS.length + 2; attempt++) {
            const engineId = await this.ensureDocument(state.engineIds, item);
            try {
                await this.api('POST', `/api/documents/${engineId}/metrics`, { metrics: this.metricsOf(item, state.extendedDropped) });
                return;
            } catch (err) {
                if (err.status === 404) {
                    // file deleted on the engine side: we recreate one for this project file
                    delete state.engineIds[item.documentId];
                    await this.store.set('engineIds', state.engineIds);
                } else if (err.status === 400 && err.code === 'metric_type_unknown'
                           && state.extendedDropped < EXTENDED_GENERATIONS.length) {
                    // Only this code means the engine is older than one generation of metrics.
                    // Any other 400 (an invalid period, a malformed body) must not latch this,
                    // or focus_losses and flight_median_ms would stop for good.
                    state.extendedDropped++;
                    await this.store.set('extendedDropped', state.extendedDropped);
                } else {
                    throw err;
                }
            }
        }
    }

    // A window written while the engine was out of reach is stamped here, once, at the moment
    // it is queued — not when it finally leaves. What tells us is our own last attempt: the
    // extension host has no reliable "am I online" of its own.
    enqueue(item) {
        return this.withLock(async () => {
            // The array is rewritten here anyway, so this is where it is compacted: what has
            // already been pushed is dropped and the cursor goes back to zero. One write per
            // measured window, which is what it has always cost.
            const pending = this.store.get('queue', []).slice(this.store.get('queueSent', 0));
            const offline = this.store.get('status', { state: 'idle' }).state === 'offline';
            pending.push(offline ? { ...item, offline: true } : item);
            await this.store.set('queue', pending.slice(-MAX_QUEUE));
            await this.store.set('queueSent', 0);
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
            let sent = 0;
            while (sent < state.queue.length) {
                const item = state.queue[sent];
                try {
                    await this.pushItem(state, item);
                } catch (err) {
                    if (err.status === 400) {
                        // measurement refused by the engine: resending it would block the queue
                        // forever
                        console.warn('Certimens: measurement rejected —', err.message);
                    } else {
                        await this.setStatus(this.failureStatus(err));
                        return;
                    }
                }
                // The cursor moves before the next send, so nothing is ever pushed twice — and
                // it is a number, so this write does not grow with the queue behind it.
                sent++;
                await this.store.set('queueSent', state.queueSent + sent);
            }
            // Everything waiting has left: the array goes with it.
            if (sent > 0) {
                await this.store.set('queue', []);
                await this.store.set('queueSent', 0);
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

module.exports = { Engine, HttpError, trimUrl, deadlinePassed, formatDeadline, DEFAULT_ENGINE_URL, RELEASE_NOTES_URL, MAX_UPLOAD_BASE64 };
