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
const ACCOUNT_KEYS = ['engineIds', 'names', 'syncedNames', 'queue', 'queueSent', 'status'];
// The engine caps a request body at 25 MiB; in base64 the source grows by a third.
const MAX_UPLOAD_BASE64 = 24 * 1024 * 1024;
const { t, dateLocale, setLanguage } = require('./i18n.js');

class HttpError extends Error {
    constructor(status, message, code) {
        super(message);
        this.status = status;
        // The engine names the rule that refused the request ({"code", "error"}).
        this.code = code || '';
        // Set on a 409 answered to a measurement: the engine already holds this rank of this
        // session with another start or another duration. Final, like a 400 — sending it again
        // changes nothing.
        this.conflict = false;
    }
}

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
     * @param {string} [host.version] the extension's own build, declared to the engine.
     * @param {string} host.hostLanguage the editor's display language, until the account's is known.
     * @param {typeof globalThis.fetch} [host.fetch] Node's own, unless a test hands over another.
     * @param {Function} [host.schedule] setInterval, unless a test drives the clock.
     * @param {Function} [host.cancel] clearInterval, likewise.
     */
    constructor({ store, secrets, userAgent, version, hostLanguage, fetch: fetchImpl, schedule, cancel }) {
        this.store = store;
        // The editor's display language, used until the account's own is known.
        this.hostLanguage = hostLanguage;
        this.secrets = secrets;
        this.userAgent = userAgent;
        this.version = version || '';
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
        return this.request(method, engineBase(this.config().engineUrl) + path, body, token);
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
            const res = await this.request('POST', engineBase(pairing.engineUrl) + '/api/auth/device/token', {
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
        const url = engineBase(engineUrl || DEFAULT_ENGINE_URL);
        const me = await this.request('GET', url + '/api/auth/me', undefined, token);
        const tokens = await this.request('GET', url + '/api/auth/tokens', undefined, token);
        // The id of this very token, so signing out revokes it; the engine never returns a raw
        // token twice, so it is found by being the newest one.
        const tokenId = (tokens[0] && tokens[0].id) || '';

        setLanguage(me.language, this.hostLanguage);
        // Signing in again as somebody else, without signing out first, leaves exactly the
        // residue a sign-out would have cleared — and no gesture forbids it. Same door.
        if (this.config().email && this.config().email !== (me.email || '')) await this.clearAccountState();
        await this.secrets.set('token', token);
        // Not a credential: it says a session exists, not whose. The host reads it on every
        // editor event, where it cannot await the secret store.
        await this.store.set('signedIn', true);
        // displayName: computed by the engine, which falls back to the e-mail when the account
        // has no name. An engine too old to send it leaves it empty, and the panel falls back.
        await this.store.set('config', {
            engineUrl: url, email: me.email || '',
            displayName: me.display_name || '', tokenId, language: me.language || '',
        });
        await this.setStatus({ state: 'idle' }); // clears any auth_error before the next send
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
            } catch (_) { /* offline, or already revoked: said as it is, by the caller */ }
        }
        await this.secrets.delete('token');
        // The host reads this synchronously to know whether to keep measuring, so it goes first.
        await this.store.set('signedIn', false);
        await this.clearAccountState();
        await this.store.set('config', { engineUrl: this.config().engineUrl, language: this.config().language });
        await this.setStatus({ state: 'unconfigured' });
        return revoked;
    }

    /**
     * Everything the revoked token authorised on this installation, as opposed to the token
     * itself. Revoking ends what the credential can do at the engine; this ends what it left
     * behind here. The map, the names it synced and a queued window all outlive it otherwise,
     * and the next account to pair inherits them and sends them under its own bearer.
     */
    async clearAccountState() {
        for (const key of ACCOUNT_KEYS) await this.store.set(key, undefined);
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
     * command: the measurement itself sends numbers and categories, and nothing else.
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
                if (err.status === 409) err.conflict = true;
                if (err.status !== 404 || attempt > 0) throw err;
                // file deleted on the engine side: we recreate one for this project file
                delete state.engineIds[item.documentId];
                await this.store.set('engineIds', state.engineIds);
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
            // Set when a batch has just been refused: its first window then goes alone.
            let alone = false;
            while (sent < state.queue.length) {
                if (!sendable(state.queue[sent])) {
                    // Not a window of the body this client sends: dropped, and the queue moves on.
                    console.warn('Certimens: a queued entry is not a measurement window — dropped');
                    await this.store.set('queueSent', state.queueSent + ++sent);
                    continue;
                }
                const batch = alone ? [state.queue[sent]] : this.batchFrom(state.queue, sent);
                alone = false;
                try {
                    await this.pushBatch(state, batch);
                } catch (err) {
                    if (err.status !== 400 && !err.conflict) {
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
                // it is a number, so this write does not grow with the queue behind it.
                sent += batch.length;
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

module.exports = { Engine, HttpError, trimUrl, engineUrlAllowed, deadlinePassed, formatDeadline, DEFAULT_ENGINE_URL, RELEASE_NOTES_URL, MAX_UPLOAD_BASE64, BATCH_MAX_WINDOWS };
