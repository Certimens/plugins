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
// What the engine says of its own pairing, bounded: [lowest, highest], in seconds.
const PAIRING_INTERVAL_S = [1, 60];
const PAIRING_EXPIRES_S = [30, 1800];
const clamp = (value, bounds, fallback) => Math.min(Math.max(Number(value) || fallback, bounds[0]), bounds[1]);
// How long a call may stay unanswered; an upload carries megabytes and is given longer.
const REQUEST_TIMEOUT_MS = 30 * 1000;
const UPLOAD_TIMEOUT_MS = 5 * 60 * 1000;
const MAX_QUEUE = 5000;
// The engine caps a request body at 25 MiB; in base64, the .docx grows by a third.
const MAX_UPLOAD_BASE64 = 24 * 1024 * 1024;
const DOCX_SLICE_BYTES = 4 * 1024 * 1024;
const STORAGE_PREFIX = 'certimens.';
// The document's identifier, in the .docx's own custom properties, under the exact name the
// LibreOffice agent writes: a file carried from Word to Writer is one document, not two.
const DOCUMENT_ID_PROPERTY = 'CertimensDocumentId';
// Where the file names the engine document it feeds, so that the same .docx opened elsewhere
// goes on filling the record it already has (see resumeEngineDocument).
const ENGINE_DOCUMENT_PROPERTY = 'CertimensEngineDocument';
// Custom properties are WordApi 1.3. Below that — no host that can run this add-in today, the
// shared runtime already ruling those out — the identity falls back to the add-in's own
// settings, which live in a part of the .docx no other editor reads: measurement goes on, and
// this document simply does not travel.
const DOCUMENT_ID_SETTING = 'certimensDocumentId';
// Each open document has its own instance of the add-in, but they all share the same
// localStorage: only one at a time drains the queue (the lease is renewed on every send).
const RUNTIME_ID = crypto.randomUUID();
const LEASE_MS = 30 * 1000;
// How long the windows of a document whose move the student has not confirmed yet stay held
// back (see HELD WINDOWS). Renewed at every drain by the pane that asked, so it only runs out
// when that pane is gone without a word: what it held then leaves as a copy's would.
const HOLD_MS = 10 * 60 * 1000;

// The most windows one request may carry. A window measured with the engine in reach leaves on
// its own; this is how fast a queue filled offline is caught up, in the order it was measured.
const BATCH_MAX_WINDOWS = 64;
// What this sensor cannot observe and the engine would otherwise deduce from the runs, declared
// in every request. Word delivers no keystroke, so a silence shorter than the sensor's
// resolution is never recorded (sensor.js, SILENCE_RESOLUTION_MS): without this word the engine
// would read their absence as a writer who never once searched for a word.
const UNSEEN = ['hesitations'];

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

// The one question every sensor asks before counting. Measurement belongs to a session: signing
// out revokes the token, and what the student writes afterwards is nobody's to send — the queue
// would hold it for whichever account pairs next. Read from storage on every call, like the
// pause and for the same reason.
function measuring() {
    return !isPaused() && load('signedIn', false);
}

function setPaused(paused) {
    save('paused', !!paused);
    statusListeners.forEach((listener) => listener());
}

const statusListeners = [];
function onStatusChange(listener) {
    statusListeners.push(listener);
}

// Written only when it says something new — every open document comes through here once a
// minute — but always announced: the line that shows it also counts the queue, which moved.
function setStatus(status) {
    const current = load('status', {});
    if (current.state !== status.state || current.message !== status.message
        || !!current.reached !== !!status.reached) save('status', status);
    statusListeners.forEach((listener) => listener());
}

// Every read/write of the queue goes through this lock: a send and a new measurement
// never step on each other (nor create two documents for the same one).
/** @type {Promise<unknown>} */
let lock = Promise.resolve();
/**
 * @template T
 * @param {() => T | Promise<T>} fn
 * @returns {Promise<T>}
 */
function withLock(fn) {
    const run = lock.then(fn, fn);
    lock = run.catch(() => {});
    return run;
}

// Drain lease shared across instances (see RUNTIME_ID): false if another instance holds it.
// `force` takes it whatever it says — signing out must send what is waiting before it clears
// it, and a window sent by two instances at once is a resend the engine takes for one.
function takeLease(force = false) {
    const lease = load('drainLease', null);
    const now = Date.now();
    if (!force && lease && lease.owner !== RUNTIME_ID && lease.until > now) return false;
    save('drainLease', { owner: RUNTIME_ID, until: now + LEASE_MS });
    return true;
}

// Given back as soon as the drain is over. Held to its term, it made every other open document
// wait out the half-minute — then the next tick — before its own window could leave.
function releaseLease() {
    const lease = load('drainLease', null);
    if (lease && lease.owner === RUNTIME_ID) localStorage.removeItem(STORAGE_PREFIX + 'drainLease');
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
// The shape this add-in mints, and the only shape it adopts back out of a file.
const MINTED_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
// The shape of an engine document id, as it goes into an API path. Every other id this add-in
// handles was handed to it by the engine; this one is read out of the document, where whoever
// produced or last held the file could have written anything. A slash or a `..` in it would no
// longer be an id: it would be another route, called with the student's token. The agents that
// read one share this shape, and `make check` compares them.
const ENGINE_ID = /^[A-Za-z0-9_-]{1,64}$/;

// This file is a copy of one already held here: nothing it names may be taken back (see
// documentId and resumeEngineDocument). Each open document has its own instance of the add-in,
// so this is one document's answer and not the Word session's.
let duplicatedDocument = false;
// The question this pane has to ask, while it is unanswered: the file carries an identity bound
// to another location, and only the student knows whether it is that file renamed or moved, or
// a copy kept beside it (see MOVED OR COPIED). `original` is the identity the file carries,
// `bound` the location it is bound to, `source` this file's, `provisional` the identity this
// pane measures under until the answer.
/** @type {{ original: string, provisional: string, source: string, bound: string } | null} */
let relocation = null;
// The engine document already written into the file, so that writing it again is not attempted
// at every window close.
let stampedEngineId = '';

function hasCustomProperties() {
    return Office.context.requirements.isSetSupported('WordApi', '1.3');
}

// A custom property of the open document, '' when it carries none by that name.
async function readProperty(name) {
    return Word.run(async (context) => {
        const property = context.document.properties.customProperties.getItemOrNullObject(name);
        property.load('value');
        await context.sync();
        return property.isNullObject ? '' : String(property.value ?? '');
    });
}

// Writes a custom property of the open document, over whatever it held.
async function writeProperty(name, value) {
    await Word.run(async (context) => {
        context.document.properties.customProperties.add(name, value);
        await context.sync();
    });
}

// Where the identity is kept: the document's own custom properties, which Word writes into
// docProps/custom.xml of the .docx and every other editor reads under the same name.
//
// Neither of these two ever rejects. Reading the identity is the first thing the pane does, and
// a document Word will not answer for must cost the student their measurement, not their pane:
// an identity that cannot be read is minted again, and one that cannot be written lives for
// this sitting alone.
async function readIdentity() {
    if (!hasCustomProperties()) return Office.context.document.settings.get(DOCUMENT_ID_SETTING);
    try {
        return await readProperty(DOCUMENT_ID_PROPERTY);
    } catch (err) {
        console.warn('Certimens : identité du document illisible.', err);
        return '';
    }
}

async function writeIdentity(id) {
    if (!hasCustomProperties()) {
        const settings = Office.context.document.settings;
        settings.set(DOCUMENT_ID_SETTING, id);
        settings.saveAsync(() => {});
        return;
    }
    try {
        await writeProperty(DOCUMENT_ID_PROPERTY, id);
    } catch (err) {
        console.warn('Certimens : identité du document non écrite dans le fichier.', err);
    }
}

// Stable identifier for the document: created on first open and stored in its custom
// properties, it is written into the .docx on the next save.
//
// Because it travels inside the file, whatever the property holds was put there by whoever
// produced or last held that file. Two checks stand between it and the engine document it
// selects. **Shape**: a value this add-in could not have minted is a value it did not write, so
// it is replaced rather than adopted. **Binding**: an entry created for one file does not take
// in another — an ordinary duplicate of the student's own document carries the identity, with
// no attacker anywhere, and adopting it merged one file's keystrokes into another file's
// record, renamed that record after whichever file was touched last, and let the deposit
// button replace its content with the wrong file. Minting a fresh identity is also what gets
// the student the link prompt this path otherwise skips.
//
// A file bound elsewhere may also be **that very file, renamed or moved**, and Word gives an
// add-in no way to ask whether the old location still exists. So the student is asked, once
// per identity and location (see MOVED OR COPIED), and until they answer the file is measured
// as the copy it may be: a fresh identity, whose windows are held back rather than sent.
//
// Resolved once per pane: the pane and the sensor both ask, and on a document Word will not
// write to, two answers would be two identities — the pane linking one while the windows left
// under the other. The one exception is the student's answer that the file was moved, which
// hands both of them the original identity at once (`rejoin`).
let resolvedDocumentId = null;
function documentId() {
    resolvedDocumentId ??= resolveDocumentId();
    return resolvedDocumentId;
}

async function resolveDocumentId() {
    const stored = await readIdentity();
    const source = documentSource();
    let asked = null;
    if (typeof stored === 'string' && MINTED_ID.test(stored)) {
        if (binds(stored, source)) return stored;
        // Already answered for this location: moved, the binding follows without a word.
        const answer = (load('relocations', {})[stored] || {})[source];
        if (answer === 'same') {
            saveEntry('engineSources', stored, source);
            return stored;
        }
        // A copy of a file already held here, or the same file elsewhere: until the student
        // says it is the latter, what it names belongs to the original.
        duplicatedDocument = true;
        if (answer !== 'copy') asked = { original: stored, source, bound: load('engineSources', {})[stored] };
    }
    const id = crypto.randomUUID();
    // Held before anything can be measured under it: the sensor waits on this very promise.
    if (asked) {
        relocation = { ...asked, provisional: id };
        saveEntry('held', id, Date.now() + HOLD_MS);
    }
    await writeIdentity(id);
    if (source) saveEntry('engineSources', id, source);
    return id;
}

// --- MOVED OR COPIED ---
//
// `mémoire.docx` renamed `mémoire_v2.docx`, or moved to another SharePoint folder, presents the
// identity it has always carried from a location it was never bound to — exactly what a copy
// kept beside the original does. The LibreOffice agent asks the file system whether the old
// location still exists; an Office add-in cannot, so the student is asked instead.
//
// **Until they answer, nothing is decided and nothing leaves.** The measurement does not wait:
// it runs under the provisional identity minted above, and its windows queue as usual — but
// that identity is *held*, and the drain sends nothing of it (see HELD WINDOWS). A window sent
// before the answer would have had to go somewhere: to a new record, which "same document"
// would then have forked, or to the original's, which "a copy" would have polluted.
//
// - **The same document**: the queued windows are re-pointed to the original identity, the
//   binding moves to this location, the identity goes back into the file, and the record goes
//   on — renamed after the file by the ordinary title sync. The engine is asked first whether
//   that record is still this account's: a 403 or a 404 is a refusal, whatever was answered.
// - **A copy**, and no answer at all: what happened before this question existed. The
//   provisional identity stays, its windows are released, and its first one opens a record.
//
// The answer is remembered per identity and location, so a file answered for is not asked
// about at its next opening.
//
// **What the student is shown is what they would attach to.** The identity travels inside the
// file, so a file prepared by somebody else can carry it: the question names the record the
// file would rejoin, as the engine names it, and the file it was last seen as. The question is
// only ever asked for an identity this account has already linked here, so answering "same"
// can only reach one of this student's own records — never more easily than a file kept in
// place already does.

function rememberAnswer(id, source, answer) {
    const table = load('relocations', {});
    table[id] = { ...table[id], [source]: answer };
    save('relocations', table);
}

// Whether this pane still has the question to ask.
function movedDocumentPending() {
    return relocation !== null;
}

// Ends the question without moving anything: the provisional identity is this file's own, and
// its windows leave with the next drain. `answer` is remembered only when the student gave it.
function settleAsCopy(asked, answer = '') {
    if (relocation !== asked) return;
    relocation = null;
    saveEntry('held', asked.provisional, undefined);
    if (answer) rememberAnswer(asked.original, asked.source, answer);
}

// What to ask, or null when there is nothing to ask. Never rejects: a question the engine
// cannot be asked about is still put, without the record's name.
async function movedDocumentQuestion() {
    const asked = relocation;
    if (!asked) return null;
    const engineId = load('engineIds', {})[asked.original];
    // Signed out, or another account since: the identity no longer names anything here.
    if (!engineId) {
        settleAsCopy(asked);
        return null;
    }
    let name = '';
    try {
        const file = await api(getConfig(), 'GET', `/api/documents/${engineId}`, undefined, DOCUMENT_GONE);
        name = String(file?.name || '');
    } catch (err) {
        // Deleted, or not this account's: there is nothing to rejoin, so nothing to ask.
        if (DOCUMENT_GONE(err.status)) {
            settleAsCopy(asked);
            return null;
        }
    }
    if (relocation !== asked) return null;
    return { name, previous: asked.bound ? documentName(asked.bound) : '' };
}

// The student's answer. Resolves to the identity the pane now measures under, with the engine
// document it rejoined when it did (`file`), or `refused` when "same" could not be honoured.
// Rejects only when the engine could not be asked — the question then stays.
async function settleRelocation(same) {
    const asked = relocation;
    if (!asked) return null;
    if (same) {
        const engineId = load('engineIds', {})[asked.original];
        let file = null;
        if (engineId) {
            try {
                // The engine's ownership check is the authorisation, here as for a take-back.
                file = await api(getConfig(), 'GET', `/api/documents/${engineId}`, undefined, DOCUMENT_GONE);
            } catch (err) {
                if (!DOCUMENT_GONE(err.status)) throw err;
            }
        }
        if (relocation !== asked) return null;
        if (file && await withLock(() => rejoin(asked, file))) {
            await writeIdentity(asked.original);
            await stampEngineDocument(asked.original);
            drain();
            return { docId: asked.original, file, refused: false };
        }
    }
    settleAsCopy(asked, same ? '' : 'copy');
    drain();
    return { docId: asked.provisional, file: null, refused: same };
}

// Under the queue's lock, and synchronous from the first read to the last listener: a window
// is sealed either before (and re-pointed here) or after (under the original identity), never
// in between. False when it is too late — the hold ran out and the provisional identity already
// has a record of its own, which the windows already sent went to.
function rejoin(asked, file) {
    if (relocation !== asked || load('engineIds', {})[asked.provisional]) return false;
    const { original, provisional, source } = asked;
    // Every queued window of the provisional identity, the sent head included: their ids do not
    // change, so the cursor still points where it did.
    const queue = load('queue', []);
    save('queue', queue.map((item) => (item && item.documentId === provisional ? { ...item, documentId: original } : item)));
    saveEntry('engineSources', original, source);
    saveEntry('engineSources', provisional, undefined);
    saveEntry('held', provisional, undefined);
    saveEntry('titles', provisional, undefined);
    // The name the engine holds against the file's current one: the rename is then seen, and
    // propagated by the title sync like any other.
    saveEntry('syncedTitles', original, file.name || documentName());
    saveEntry('titles', original, documentName());
    rememberAnswer(original, source, 'same');
    duplicatedDocument = false;
    relocation = null;
    resolvedDocumentId = Promise.resolve(original);
    documentIdListeners.forEach((listener) => listener(original));
    return true;
}

// Told when the identity this pane measures under changes, which only a move confirmed by the
// student does: the pane and the sensor both hold it.
const documentIdListeners = [];
function onDocumentIdChange(listener) {
    documentIdListeners.push(listener);
}

// --- HELD WINDOWS ---
// The identities whose windows wait for the student's answer, each with the instant its hold
// runs out. Shared by every open document, since the queue is: whichever pane drains must hold
// them back. A hold that has run out is forgotten, and its windows leave as a copy's.
function heldDocuments() {
    const table = load('held', {});
    const now = Date.now();
    const expired = Object.keys(table).filter((id) => !(table[id] > now));
    if (expired.length) {
        expired.forEach((id) => delete table[id]);
        save('held', table);
    }
    return new Set(Object.keys(table));
}

// Takes the held windows out of what this drain sends. In storage they move behind the others,
// in their own order, so that the cursor — the id of the last window sent — never passes over
// one of them. Only rewritten when one of them stands in front of a window to send.
function holdBack(state) {
    const held = heldDocuments();
    if (!held.size) return;
    const isHeld = (item) => held.has(item.documentId);
    const waiting = state.queue.filter(isHeld);
    if (!waiting.length) return;
    const free = state.queue.filter((item) => !isHeld(item));
    const first = state.queue.findIndex(isHeld);
    if (state.queue.some((item, at) => at > first && !isHeld(item))) {
        save('queue', [...free, ...waiting]);
        save('queueSent', '');
    }
    state.queue = free;
}

// The engine document this file names, '' when it names none this add-in could use. The shape
// is checked here, at the one place the value enters the add-in, rather than where it is about
// to be interpolated into a path: it is read out of a file, and a file is the one input nobody
// else has checked.
async function engineDocumentOf() {
    if (!hasCustomProperties()) return '';
    const stored = await readProperty(ENGINE_DOCUMENT_PROPERTY).catch(() => '');
    return ENGINE_ID.test(stored) ? stored : '';
}

// Takes back the engine document this file names, instead of opening a second one.
//
// This is the whole point of writing that id into the file: a dissertation begun in Writer and
// carried on in Word, or the same file opened on the machine at home, is one piece of work and
// must stay one record. Nothing read there is trusted — the engine answers 404 or 403 for a
// document that is not this account's, which is the whole of the authorisation, since only the
// owner of a document ever writes to it.
//
// **Only a student resumes.** A teacher opening a copy handed in to them is allowed to read
// that document, so the engine would answer 200 here: their own keystrokes would then be
// measured into their student's record.
//
// A duplicate is the one case refused here rather than by the engine: `documentId` has already
// seen that this file carries an identity bound to another file on this machine, and the engine
// cannot tell the two apart — both are this student's own documents. Until, that is, the student
// says the file was moved rather than copied (see MOVED OR COPIED), which lifts it.
async function resumeEngineDocument(docId, source) {
    if (duplicatedDocument || !docId || load('engineIds', {})[docId]) return null;
    const config = getConfig();
    if (!hasAuth(config)) throw new HttpError(401, t('error.noToken'));
    const carried = await engineDocumentOf();
    if (!carried) return null;
    try {
        const me = await api(config, 'GET', '/api/auth/me');
        if (me.role !== 'student') return null;
        const file = await api(config, 'GET', `/api/documents/${carried}`, undefined, DOCUMENT_GONE);
        // Checked again, as the creation path does: whichever of the two writes first owns the
        // document, and the other leaves it alone. **Not under the queue's lock**: nothing
        // below awaits, so nothing can come in between — and the creation path, which holds
        // that lock, is waiting for this very promise (see pendingResume). Taking the lock
        // here was a deadlock: the queue stopped for good at the first window sealed while a
        // take-back was in flight, and at every opening after it.
        if (load('engineIds', {})[docId]) return null;
        saveEntry('engineIds', docId, carried);
        if (source) saveEntry('engineSources', docId, source);
        // The name the engine holds, not the one this file carries: a document renamed in
        // Word since it was last sent must still be seen as a rename and propagated.
        saveEntry('syncedTitles', docId, file.name || documentName());
        stampedEngineId = carried;
        return file;
    } catch (err) {
        // 404: the document was deleted. 403: it belongs to somebody else — a file a classmate
        // sent, which is a file like any other here and gets its own record.
        if (err.status === 403 || err.status === 404) return null;
        throw err;
    }
}

// The take-back in flight for this instance's document, if any (see ensureDocument).
//
// `settled` says the engine answered the question, one way or the other. A take-back that
// could not be asked — nobody signed in yet, no network — has decided nothing, and is asked
// again before a document is created in its place: the file opened on the machine at home
// *before* pairing, or opened offline, used to open a second record at its first window, and
// then had its property overwritten with it.
let resumeFor = { docId: '', promise: null, settled: false };

function startResume(docId) {
    const attempt = { docId, promise: resumeEngineDocument(docId, documentSource()), settled: false };
    attempt.promise.then(() => { attempt.settled = true; }, () => {});
    resumeFor = attempt;
    return attempt.promise;
}

// A window measured while the document was still being taken back must not open a second
// record beside the one it is about to rejoin.
async function pendingResume(docId) {
    if (!resumeFor.promise || resumeFor.docId !== docId) return '';
    await resumeFor.promise.catch(() => null);
    // Asked again when the first attempt could not be: if this one cannot either, its failure
    // is the caller's — the document is not created on a question left unanswered.
    if (!resumeFor.settled) await startResume(docId);
    return load('engineIds', {})[docId] || '';
}

// Writes into the file the engine document it feeds, so another editor finds it.
//
// Called with this instance's own document and no other: every document open in this Word has
// its own instance of the add-in, they share one queue, and the one holding the drain lease
// sends windows belonging to documents it does not have in hand.
async function stampEngineDocument(docId) {
    if (!docId || !hasCustomProperties()) return;
    const engineId = load('engineIds', {})[docId];
    if (!engineId || engineId === stampedEngineId) return;
    try {
        await writeProperty(ENGINE_DOCUMENT_PROPERTY, engineId);
        stampedEngineId = engineId;
    } catch (err) {
        console.warn('Certimens : identifiant du document non écrit dans le fichier.', err);
    }
}

// The file this document was read from, as the host names it. Empty while it has never been
// saved, which is a document with nothing to bind to.
function documentSource() {
    return Office.context.document.url || '';
}

// Whether an identity may be used for this file.
//
// An identity nothing has mapped yet binds to whichever file presents it first. A mapping made
// before this rule existed carries no file either: the first document to open after the update
// claims it, which is the only migration that does not re-link everything a student already
// has. The engine cannot see the collision — the creation call carries a name and the local
// identity never crosses the wire — so the refusal lives here, before the identity is adopted,
// and every consumer of it resolves through this one guarded path.
function binds(id, source) {
    if (!source) return true;
    const engineIds = load('engineIds', {});
    if (!engineIds[id]) return true;
    const bound = load('engineSources', {})[id];
    if (bound === source) return true;
    if (bound === undefined) {
        saveEntry('engineSources', id, source);
        return true;
    }
    return false;
}

// The document's name: its file name, without extension (empty until it has been saved). Given
// a location, the name of the file found there.
function documentName(url = documentSource()) {
    const raw = url.split(/[\\/]/).pop().split('?')[0];
    // Word on a desktop hands over a path, not an address: « Rapport 100% final.docx » is not
    // percent-encoded, and decoding it throws.
    let base = raw;
    try {
        base = decodeURIComponent(raw);
    } catch (_) { /* a plain file name, taken as it is */ }
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

// --- WHERE THE TOKEN MAY TRAVEL ---
//
// The student can point the pane at another engine, and that address decides where an API token
// **that never expires** is sent. Over `http:` it crosses the network in the clear, and a token
// read once is a token kept. Refusing `http:` outright would break the deployment it exists for
// — an establishment serving its engine on its own intranet — so the rule is about the host:
// plain `http:` is accepted exactly where the request cannot leave the building. A single label
// (`moteur`), but not an all-digit one; localhost and `127.0.0.0/8` or `::1`; `*.local`; the
// private ranges and IPv6 unique local. Everything else must be `https:`.
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

// The engine's address, checked on the way out. Every call the pane makes to an engine goes
// through here: the address comes from the student, and it may have been stored in this
// origin's localStorage before the rule existed.
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

// The JSON body of an engine response, or an HttpError carrying its error message.
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
        if (!ordinary(res.status, code)) countEvent(refusalEvent(res.status));
        throw new HttpError(res.status, REWORDED[code] ? t(REWORDED[code]) : message, code);
    }
    // The 201 from metrics returns the text "Created" (Fiber's SendStatus): only JSON is read.
    if (!(res.headers.get('Content-Type') || '').includes('application/json')) return null;
    return res.json();
}

// --- HOW THIS AGENT NAMES ITSELF ---
//
// Every call to the engine carries `X-Certimens-Agent: <kind>/<version>`. The engine stores it
// beside each measurement — so whoever reads the copy is told it was written in Word and with
// which build of the add-in — and flags a push that names nothing, because every agent speaks up.
//
// It proves nothing, and it is not meant to: this file is served in the open and the header can
// be copied out of it. What it buys is **precision** the transport signature cannot give, and
// here that matters more than anywhere else: this pane and the engine's own editor are both
// pages in a browser, indistinguishable on the wire. Without the declaration, nothing could say
// which of the two wrote a copy.
//
// The version is stamped at build time, like the one the pane compares itself against. A
// checkout still holds the placeholder, which is the agent not knowing its own build: it then
// sends its kind alone, which the engine accepts — refusing the whole declaration over the part
// it does not know would throw away the part that is true.
//
// The header is custom, so this cross-origin pane **preflights** on it: the engine lists it among
// the headers it allows, and a deployment that did not would see every push die in the browser.
// The three other agents make the same declaration, with the same header and the same shape;
// `make check` compares the four.
const AGENT_HEADER = 'X-Certimens-Agent';
const AGENT_KIND = 'word';
const AGENT_BUILD = '{{VERSION}}';
const AGENT_VERSION_MAX = 32;

/** The declaration this agent sends: its kind, and its build when it was stamped with one. */
function agentDeclaration() {
    if (AGENT_BUILD.includes('{')) return AGENT_KIND;
    const label = AGENT_BUILD.replace(/[^A-Za-z0-9._+-]/g, '').slice(0, AGENT_VERSION_MAX);
    return label ? `${AGENT_KIND}/${label}` : AGENT_KIND;
}

// Every call the add-in's work makes to the engine — pairing, documents, measurements,
// assignments — leaves through here, and a call that got no answer at all is counted. The
// telemetry send does not (see SELF-TELEMETRY): its own failures are not counted.
//
// None of them waits for ever: `fetch` has no limit of its own, a captive portal holds a
// connection for minutes, and the queue's lock is held across the call. The oldest webviews
// Office still runs in have no `AbortSignal.timeout`; there the call waits as it always did.
function timeoutSignal(ms) {
    return typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function'
        ? AbortSignal.timeout(ms) : undefined;
}

async function request(url, init, timeout = REQUEST_TIMEOUT_MS) {
    try {
        return await fetch(url, { ...init, signal: timeoutSignal(timeout) });
    } catch (err) {
        countEvent('network.failure');
        const timedOut = err && err.name === 'TimeoutError';
        throw new HttpError(0, timedOut ? t('error.networkError') : err.message || t('error.networkError'));
    }
}

// What every call carries: the declaration, and the token once there is one.
function requestHeaders(token) {
    const headers = { 'Content-Type': 'application/json', [AGENT_HEADER]: agentDeclaration() };
    if (token) headers['Authorization'] = `Bearer ${token}`;
    return headers;
}

async function api(config, method, path, body, ordinary = undefined, timeout = REQUEST_TIMEOUT_MS) {
    return readResponse(await request(engineBase(config.engineUrl) + path, {
        method,
        headers: requestHeaders(config.token),
        body: body === undefined ? undefined : JSON.stringify(body),
    }, timeout), ordinary);
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
    const url = engineBase(engineUrl);
    const res = await readResponse(await request(url + '/api/auth/device', {
        method: 'POST',
        headers: requestHeaders(),
        body: JSON.stringify({ client: t('pair.clientWord') }),
    }));
    return {
        engineUrl: url,
        deviceCode: res.device_code,
        userCode: res.user_code,
        verificationUri: verificationUri(res.verification_uri, url),
        verificationUriComplete: verificationUri(res.verification_uri_complete || res.verification_uri, url),
        // Clamped before they pace a loop: an interval of a millisecond would turn the poll
        // into a flood, a validity of a year into a poll for a year.
        expiresAt: Date.now() + clamp(res.expires_in, PAIRING_EXPIRES_S, 600) * 1000,
        interval: clamp(res.interval, PAIRING_INTERVAL_S, 5) * 1000,
    };
}

// Asks once. Returns the API token, or null while nobody has confirmed yet; every other refusal
// throws, because each means something the student has to be told.
async function pollPairing(pairing) {
    let res;
    try {
        res = await readResponse(await request(engineBase(pairing.engineUrl) + '/api/auth/device/token', {
            method: 'POST',
            headers: requestHeaders(),
            body: JSON.stringify({ device_code: pairing.deviceCode }),
        }), PAIRING_WAIT);
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
//
// `chosen`: the name was typed by the student in the pane. A name the account already holds is
// then *said* (409 `document_name_taken`, reworded). Otherwise the document is being created
// from a sealed window, with nobody watching, and takes a free name made from the file's — read
// as a refusal of the window, that 409 threw away every measurement of the second file called
// « Mémoire », for good and without a word.
async function ensureDocument(config, engineIds, item, editorTitle = item.documentName, chosen = false) {
    if (engineIds[item.documentId]) return engineIds[item.documentId];
    const resumed = await pendingResume(item.documentId);
    if (resumed) {
        engineIds[item.documentId] = resumed;
        return resumed;
    }
    const file = await createDocument(config, item.documentName, chosen);
    engineIds[item.documentId] = file.id;
    saveEntry('engineIds', item.documentId, file.id);
    // The file the identity was read from, so no other file can later present it and be handed
    // this engine document.
    if (item.documentSource) saveEntry('engineSources', item.documentId, item.documentSource);
    saveEntry('syncedTitles', item.documentId, editorTitle);
    return file.id;
}

// The longest name the engine takes for a document.
const DOCUMENT_NAME_MAX = 255;

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
    const clipped = name.slice(0, DOCUMENT_NAME_MAX);
    try {
        try {
            return await api(config, 'POST', '/api/documents', { name: clipped });
        } catch (err) {
            if (chosen || err.code !== 'document_name_taken') throw err;
        }
        return await api(config, 'POST', '/api/documents', { name: freeName(clipped) });
    } catch (err) {
        err.creation = true;
        throw err;
    }
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
    const url = engineBase(engineUrl);
    const me = await readResponse(await request(url + '/api/auth/me', { headers: requestHeaders(token) }));
    const tokens = await readResponse(await request(url + '/api/auth/tokens', { headers: requestHeaders(token) }));
    // The id of this very token, so signing out revokes it. The engine never returns a raw
    // token twice, so it is found by being the newest one.
    const tokenId = (tokens[0] && tokens[0].id) || '';
    // displayName: the engine computes it, and falls back to the e-mail when the account has
    // no name. An engine too old to send it leaves it empty, and the pane falls back too.
    // Signing in again as somebody else — another account, or the same address on another
    // engine — without signing out first, leaves exactly the residue a sign-out would have
    // cleared, and no gesture forbids it. Same door. Under the lock: a send in flight would
    // otherwise write its cursor back over what is cleared.
    await withLock(() => {
        const previous = getConfig();
        const changed = previous.email !== (me.email || '') || trimUrl(previous.engineUrl) !== url;
        if (previous.email && changed) clearAccountState();
        save('config', {
            engineUrl: url, email: me.email || '',
            displayName: me.display_name || '', token, tokenId, language: me.language || '',
        });
        // Not a credential: it says a session exists, not whose. Every open document's sensor
        // reads it, on the same origin and with no memory shared between them.
        save('signedIn', true);
        setStatus({ state: 'idle' }); // clears any pending auth_error before the next send
    });
    drain();
    return me;
}

async function logout() {
    const config = getConfig();
    // The windows still open belong to the session that is ending: they are sealed and sent
    // while the token that measured them is still valid, because what is cleared below is
    // cleared for good. One left in the queue would otherwise be sent under the next account's
    // bearer, towards this account's documents.
    // Whatever another pane's lease says: what has not left by the end of this will not leave.
    await drain(true);
    // Whether the engine really destroyed the credential, rather than whether we tried. The
    // local erase happens either way, but a student told their token was revoked when it is
    // still live has been told the one thing that would have made them act.
    let revoked = false;
    if (config.token && config.tokenId) {
        try {
            await api(config, 'DELETE', `/api/auth/tokens/${config.tokenId}`);
            revoked = true;
        } catch (err) {
            // The engine no longer knows this token, or no longer accepts it: it is as dead as
            // a revocation would have made it. Anything else leaves it alive, and the caller
            // says so.
            revoked = err.status === 401 || err.status === 404;
        }
    }
    // Under the lock, like every write to the queue: a send in flight finishes first.
    await withLock(() => {
        // Read by every open document's sensor, which is why it is written before the rest.
        save('signedIn', false);
        clearAccountState();
        save('config', { engineUrl: config.engineUrl, language: config.language });
        setStatus({ state: 'unconfigured' });
    });
    return revoked;
}

// Everything the revoked token authorised on this installation, as opposed to the token itself.
// Revoking ends what the credential can do at the engine; this ends what it left behind here —
// the map, the titles it synced, a queued window and the drain lease all outlive it otherwise,
// and the next account to pair inherits them and sends them under its own bearer. The lease
// matters as much as the rest: a departed owner holding it blocks the next account's queue
// outright, on an origin every open document shares. The answers about moved files and the
// holds waiting on one are about this account's records, and go with them.
const ACCOUNT_KEYS = ['engineIds', 'engineSources', 'titles', 'syncedTitles', 'queue', 'status', 'drainLease',
    'relocations', 'held'];

function clearAccountState() {
    for (const key of ACCOUNT_KEYS) localStorage.removeItem(STORAGE_PREFIX + key);
    // The question this pane had to ask was about the previous account's record: unasked, the
    // file is a copy, as it would have been had nobody answered.
    relocation = null;
    // A suspension is one student's choice about their own measurement. The next account must
    // not start silently suspended by it.
    save('paused', false);
}

// Explicit creation (from the task pane) of a document's engine document; a no-op if it already
// exists. Called by the pane with its own document, which is what lets it stamp the file here
// rather than waiting for the next window to close.
async function createFileFor(docId, name, editorTitle) {
    const created = await withLock(async () => {
        const engineIds = load('engineIds', {});
        const existed = !!engineIds[docId];
        const engineId = await ensureDocument(getConfig(), engineIds, { documentId: docId, documentName: name }, editorTitle || name, true);
        return { engineId, existed };
    });
    await stampEngineDocument(docId);
    return created;
}

// Engine file linked to a document (null if not yet created or deleted on the engine side).
async function docInfo(docId) {
    const engineId = load('engineIds', {})[docId];
    if (!engineId) return { engineId: null, file: null };
    try {
        return { engineId, file: await api(getConfig(), 'GET', `/api/documents/${engineId}`, undefined, DOCUMENT_GONE) };
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
    const engineId = load('engineIds', {})[docId];
    if (!engineId) throw new HttpError(404, t('error.noFile'));
    const document = await readDocx();
    if (document.length > MAX_UPLOAD_BASE64) throw new HttpError(413, t('error.tooLarge'));
    return api(getConfig(), 'PUT', `/api/documents/${engineId}`, { document }, undefined, UPLOAD_TIMEOUT_MS);
}

// The engine silently ignores an assignment the student is not enrolled in: we detect it.
async function submitDocument(engineId, assignmentId) {
    const file = await api(getConfig(), 'PUT', `/api/documents/${engineId}`, { assignment_id: assignmentId });
    if (file.assignment_id !== assignmentId) throw new HttpError(403, t('error.notEnrolled'));
    return file;
}

// --- 4. QUEUE ---
// `reached` says the engine answered, whatever it answered: it is what keeps a refusal from
// being read as an outage when the next window is queued (see enqueue).
function failureStatus(err) {
    return err.status === 401
        ? { state: 'auth_error' }
        : { state: 'offline', reached: !!err.status };
}

// --- THE BODY ---
// There is one body, and the engine refuses anything else: an unknown key, a missing one, a run
// that has not the shape of its kind. So what leaves is **rebuilt key by key** from the queued
// window rather than forwarded: it was read back from `localStorage`, where nothing promises
// the keys come back in the order they were written, and where the routing fields the queue
// needs (the document, its name, the entry's id) sit beside the measurement.
//
// The key order is the engine's, at every level, and so is what is absent: `offline` only when
// it is true, the span of `text` only when the sensor compared two readings, `kept` only when
// it was worked out — never empty, never null. Nothing here is text: numbers, and the engine's
// own words.

function toWindow(item) {
    const sealed = { seq: item.seq, at: item.at, mono: item.mono, ms: item.ms, why: item.why };
    if (item.offline) sealed.offline = true;
    sealed.active = item.active;
    // Already in the shape of their kind, as the sensor recorded them: an array comes back from
    // storage in the order it went in.
    sealed.runs = item.runs;
    // Only what this sensor can classify: a key it cannot measure is absent, never zero.
    sealed.counts = {
        corrections: item.counts.corrections,
        reformulations: item.counts.reformulations,
        revisions: item.counts.revisions,
        jumps: item.counts.jumps,
    };
    if (item.text) {
        sealed.text = { len: item.text.len };
        // The span, when this reading was compared with the one before it: whole or not at all.
        if (typeof item.text.since === 'number') {
            sealed.text.since = item.text.since;
            sealed.text.at = item.text.at;
            sealed.text.cut = item.text.cut;
            sealed.text.add = item.text.add;
            // Left out when the sensor did not work it out, which is not the same as nothing kept.
            if (typeof item.text.kept === 'number') sealed.text.kept = item.text.kept;
        }
    }
    sealed.sum = { keys: item.sum.keys, chars: item.sum.chars, pastes: item.sum.pastes };
    return sealed;
}

// The request that carries them: windows of one session, in the order they were sealed. `sent`
// is this machine's clock when the body is built, so every attempt carries its own.
function toEnvelope(items) {
    return {
        session: items[0].session,
        sent: Date.now(),
        unseen: UNSEEN,
        windows: items.map(toWindow),
    };
}

// Whether a queued entry is a window this build can send. The queue is in `localStorage` and
// outlives the code that filled it: an entry in any other shape cannot be turned into the body,
// and is dropped rather than sent to be refused.
function isWindow(item) {
    return !!item && typeof item.session === 'string' && Number.isInteger(item.seq)
        && Number.isInteger(item.at) && Number.isInteger(item.mono) && Number.isInteger(item.ms)
        && typeof item.why === 'string' && Number.isInteger(item.active)
        && Array.isArray(item.runs) && item.runs.length > 0
        && !!item.counts && !!item.sum;
}

// How many windows at the head of the queue leave in one request. More than one only for a
// queue filled offline — every window of a batch has waited for the network, and one that
// waited for any other reason goes alone — and only as far as the windows are the same
// session's, for the same document, in the order they were numbered: two panes measuring at
// once fill the queue in turns, and each one's windows then leave a few at a time rather than
// mixed.
function batchSize(queue) {
    const first = queue[0];
    if (!first.offline) return 1;
    let size = 1;
    while (size < queue.length && size < BATCH_MAX_WINDOWS) {
        const next = queue[size];
        if (!next.offline || next.session !== first.session
            || next.documentId !== first.documentId || !(next.seq > queue[size - 1].seq)) break;
        size++;
    }
    return size;
}

// Sends `item`, with the windows of `rest` in the same request. Returns how many windows left.
async function pushItem(config, state, item, rest = []) {
    // Two attempts: the second is for a document deleted on the engine side, which is created
    // again. Any other refusal is the caller's to read.
    for (let attempt = 0; attempt < 2; attempt++) {
        const engineId = await ensureDocument(config, state.engineIds, item);
        try {
            await api(config, 'POST', `/api/documents/${engineId}/metrics`, toEnvelope([item, ...rest]));
            break;
        } catch (err) {
            if (err.status !== 404 || attempt > 0) throw err;
            delete state.engineIds[item.documentId];
            saveEntry('engineIds', item.documentId, undefined);
        }
    }
    return 1 + rest.length;
}

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

// The windows still waiting: everything after the last one the engine took, less any entry
// that is not a window this build can send (see isWindow) — every writer of the queue goes
// through here, so such an entry is gone from storage at the next write. An id no longer in the
// queue means the queue was compacted under us, and what is left is taken as waiting.
//
// That reading is the right one, not a fallback: a compaction writes the queue first and clears
// the cursor second, so an instance reading between the two sees exactly the windows that have
// not left — which is what it then takes them for. The cap (`MAX_QUEUE`) is the one case where
// it could over-read, and it drops the head, which is the sent end: sending a window twice is
// recoverable, dropping one is not.
function pending(queue) {
    const id = sentThrough();
    const at = id ? queue.findIndex((item) => item && item.id === id) : -1;
    return (at < 0 ? queue : queue.slice(at + 1)).filter(isWindow);
}

// Drops what has already been pushed and forgets the cursor with it.
function compact() {
    save('queue', pending(load('queue', [])));
    save('queueSent', '');
}

// A window written while the engine was out of reach is stamped here, once, at the moment it
// is queued — not when it finally leaves. What tells us is our own last attempt, not
// navigator.onLine: a captive portal answers the link layer and never the engine. **Out of
// reach, not refused**: an engine that answered an error was there, and a window that waits
// behind its refusal was not written offline.
function enqueue(item) {
    // A window sealed after the session ended — the idle timer of a keystroke typed while
    // signing out, in this pane or another — is nobody's to send: queued, it would wait for
    // whichever account pairs next.
    if (!load('signedIn', false)) return Promise.resolve();
    const status = load('status', { state: 'idle' });
    const offline = status.state === 'offline' && !status.reached;
    // The array is rewritten here anyway, so this is also where it is compacted: one full write
    // per measured window, which is what it has always cost.
    const queue = pending(load('queue', []));
    queue.push({ ...item, id: crypto.randomUUID(), ...(offline && { offline: true }) });
    save('queue', queue.slice(-MAX_QUEUE));
    save('queueSent', '');
    // The oldest windows that a full queue has just pushed out, lost for good.
    countEvent('queue.dropped', queue.length - MAX_QUEUE);
    // A token the engine refused is not tried again at every window: the loop asks once a
    // minute, and pairing again clears the state.
    return status.state === 'auth_error' ? Promise.resolve() : drain();
}

// `force`: see takeLease.
function drain(force = false) {
    return withLock(async () => {
        const config = getConfig();
        const state = getState();
        if (!hasAuth(config)) {
            setStatus({ state: 'unconfigured' });
            return;
        }
        // The pane waiting on the student keeps its hold alive, at every drain it runs.
        if (relocation) saveEntry('held', relocation.provisional, Date.now() + HOLD_MS);
        let sent = false;
        // Windows of a refused batch still to be sent one at a time.
        let alone = 0;
        let sorted = false;
        while (state.queue.length > 0) {
            if (!takeLease(force)) return; // another instance is draining the queue
            // Once, with the lease in hand: the held windows are moved in storage. A forced
            // drain is a sign-out, which sends everything — no answer is a copy's answer.
            if (!sorted && !force) {
                sorted = true;
                holdBack(state);
                if (!state.queue.length) break;
            }
            const item = state.queue[0];
            const size = alone > 0 ? 1 : batchSize(state.queue);
            let left;
            try {
                left = await pushItem(config, state, item, state.queue.slice(1, size));
            } catch (err) {
                // A 409 is the engine holding this number of this session with another instant
                // or another duration: like a 400, it is an answer no later attempt will
                // change, and neither makes this agent send anything differently.
                // Neither says anything of the window when it is the *document* that could not
                // be created: the window waits.
                const refused = (err.status === 400 || err.status === 409) && !err.creation;
                if (refused && size > 1) {
                    // One window the engine will not take must not cost the others their place:
                    // the batch goes again window by window, and only the one refused is lost.
                    alone = size;
                    continue;
                }
                if (refused) {
                    // measurement rejected by the engine: resending it would block the queue
                    // forever. The window is named by its title, its number and its instant,
                    // which is what identifies it — the whole item adds nothing a console
                    // should carry.
                    console.warn('Certimens: measurement rejected', err.message,
                        item.documentName, item.seq, item.at);
                    left = 1;
                } else {
                    setStatus(failureStatus(err));
                    return;
                }
            }
            if (alone > 0) alone--;
            // The cursor moves before the next send, so nothing is ever pushed twice.
            const last = state.queue[left - 1];
            state.queue.splice(0, left);
            save('queueSent', last.id);
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
    }).catch((err) => console.warn('Certimens:', err)).then(releaseLease);
}

// What another pane changed in the storage they share. `storage` only fires in the panes that
// did not write, which is exactly who has to be told: the session (a pairing, a sign-out) or
// what the status line shows (a suspension, the sending state).
function watchOtherPanes(onSession, onStatus) {
    window.addEventListener('storage', (event) => {
        const key = (event.key || '').slice(STORAGE_PREFIX.length);
        if (key === 'config' || key === 'signedIn') onSession();
        else if (key === 'paused' || key === 'status') onStatus();
    });
}

function startAgent() {
    setInterval(() => {
        drain();
        // Throttled to TELEMETRY_FLUSH_MS inside: most minutes, this is one storage read.
        flushTelemetry().catch(() => {});
    }, RETRY_MS);
    window.addEventListener('online', () => drain());
    // The document closing with the question unanswered: a copy, released now rather than when
    // its hold runs out.
    window.addEventListener('pagehide', () => {
        if (relocation) settleAsCopy(relocation);
    });
    drain();
}

// --- SELF-TELEMETRY ---
//
// What happens to the add-in without anything being pushed — an install, an update, an exception
// in its own code, a call that never reached the engine — is invisible from the engine. So the
// add-in counts those, and sends the counters (docs/moteur.md, "Ce que l'agent dit de lui-même").
//
// **Counters, and where our own code broke**: a word of the vocabulary below and a number, plus,
// for an exception of the add-in's own scripts, its type and the frames of its stack that are the
// add-in's files (`faultOf`). Never a message, never a URL — an exception text in a writing tool
// can quote what the student wrote, and no text of theirs leaves the machine. A name outside the
// list is not counted.
//
// The three constants are the contract's, in the table's order; the three other agents declare
// the same, and `make check` compares the four with docs/moteur.md.
const TELEMETRY_EVENTS = ['installed', 'updated', 'started', 'error.runtime', 'error.engine',
    'error.rejected', 'error.auth', 'network.failure', 'queue.dropped'];
const TELEMETRY_FLUSH_MS = 15 * 60 * 1000;
const TELEMETRY_MAX_COUNT = 10000;
const TELEMETRY_PATH = '/api/plugins/telemetry';
const TELEMETRY_MAX_FAULTS = 10;
const TELEMETRY_MAX_FRAMES = 12;

// Where the add-in's own code broke, as the report carries it: the exception's type and the
// frames of its stack that are this add-in's files, innermost first, as
// `function@file.js:line:column`. **Never the message.** The add-in is not minified, so a file, a
// line and a function name are a position in the published source of this build and nothing else.
//
// `base` is the folder the pane is served from: a frame anywhere else — Office.js, the host's — is
// not ours and is skipped, and one of ours keeps its bare file name, never the address.
//
// Both stack dialects: V8's `    at fn (url:1:2)` (Word on Windows and the web in Edge or Chrome)
// and the `fn@url:1:2` of Safari (Word on Mac) and Firefox. In V8's, only the `at` lines are read:
// the lines before them are the message, which may run over several lines and say anything.
const FAULT_TYPE = /^[A-Za-z][A-Za-z0-9]{0,47}$/;
const FAULT_FILE = /^[A-Za-z0-9_-]{1,64}\.(?:js|mjs|cjs)$/;
const FAULT_FUNCTION = /^[A-Za-z_$<][A-Za-z0-9_$.<>]{0,79}$/;
const V8_FRAME = /^\s+at (?:async )?(?:(.+?) \()?(.+?):(\d+):(\d+)\)?$/;
const GECKO_FRAME = /^(?:(.*)@)?(.+?):(\d+):(\d+)$/;

/**
 * @param {string} type the exception's `name`
 * @param {string} stack the exception's `stack`
 * @param {string} base the URL of the folder the pane is served from
 * @returns {{ type: string, frames: string[] }}
 */
function faultOf(type, stack, base) {
    const frames = [];
    const text = typeof stack === 'string' ? stack : '';
    const v8 = /\n\s+at /.test(text);
    for (const line of text.split('\n')) {
        if (frames.length >= TELEMETRY_MAX_FRAMES) break;
        const match = (v8 ? V8_FRAME : GECKO_FRAME).exec(line);
        if (!match || !base || !match[2].startsWith(base)) continue;
        const file = match[2].slice(base.length);
        if (!FAULT_FILE.test(file)) continue;
        const name = (match[1] || '').replace(/^(?:new |async\*)/, '');
        frames.push(`${FAULT_FUNCTION.test(name) ? name + '@' : ''}${file}:${match[3]}:${match[4]}`);
    }
    return { type: typeof type === 'string' && FAULT_TYPE.test(type) ? type : 'Other', frames };
}

// The counters live in localStorage (`telemetry`, with `telemetryAt` for the last attempt and
// `telemetryVersion` for the build last started), beside the queue. They are not account state:
// they name no account, so signing out keeps them, and an `installed` counted before the first
// pairing leaves after it.
//
// Every open document runs its own instance over this same storage. A count is one synchronous
// read and write, so two instances can only lose an increment by counting in the very same
// instant from two processes — a counter one short, which is not worth a lease. The send is
// what must not happen twice, and it is claimed (`telemetryAt`) before it leaves.
function countEvent(name, n = 1) {
    if (!TELEMETRY_EVENTS.includes(name) || !(n > 0)) return;
    try {
        const counts = load('telemetry', {});
        counts[name] = Math.min((counts[name] || 0) + n, TELEMETRY_MAX_COUNT);
        save('telemetry', counts);
    } catch (_) { /* storage full or refused: a counter is not worth a failure in what it counts */ }
}

// An exception of the add-in's own code: counted as `error.runtime`, and kept as a fault under
// `telemetryFaults`, one entry per distinct fault with its count, at most TELEMETRY_MAX_FAULTS of
// them. A fault past that is still counted, just not located: the first ten of a broken build say
// where it breaks. `error` is what the window handed over; only what `faultOf` keeps of it is
// stored, and sent. Something thrown that is not an error has no stack: type `Other`, no frame.
function countRuntimeError(/** @type {any} */ error) {
    countEvent('error.runtime');
    const real = error && typeof error === 'object' && typeof error.stack === 'string';
    const fault = faultOf(real ? String(error.name) : '', real ? error.stack : '', paneBase());
    const key = faultKey(fault);
    try {
        const faults = load('telemetryFaults', []);
        const kept = Array.isArray(faults) ? faults : [];
        const known = kept.find((/** @type {any} */ f) => faultKey(f) === key);
        if (known) known.count = Math.min((known.count || 0) + 1, TELEMETRY_MAX_COUNT);
        else if (kept.length < TELEMETRY_MAX_FAULTS) kept.push({ ...fault, count: 1 });
        else return;
        save('telemetryFaults', kept);
    } catch (_) { /* storage full or refused: counted above, just not located */ }
}

/** @param {{ type: string, frames: string[] }} fault */
function faultKey(fault) {
    return [fault.type, ...(fault.frames || [])].join('\n');
}

// The folder the pane is served from, which every script of the add-in sits directly in.
function paneBase() {
    try {
        return new URL('.', location.href).href;
    } catch (_) {
        return '';
    }
}

// The event an engine refusal counts as.
function refusalEvent(status) {
    if (status === 401) return 'error.auth';
    return status >= 500 ? 'error.engine' : 'error.rejected';
}

// The body's `events`, in the vocabulary's order: only whole positive counts of known words.
// Null when there is nothing to say.
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
// request was in flight — here or in another document's instance — stays for the next one.
function forgetSent(events, faults) {
    const counts = load('telemetry', {});
    for (const [name, value] of Object.entries(events)) {
        const left = (counts[name] || 0) - value;
        if (left > 0) counts[name] = left;
        else delete counts[name];
    }
    save('telemetry', counts);
    if (!faults) return;
    const sent = new Map(faults.map((f) => [faultKey(f), f.count]));
    const stored = load('telemetryFaults', []);
    const left = (Array.isArray(stored) ? stored : [])
        .map((/** @type {any} */ f) => ({ ...f, count: (f.count || 0) - (sent.get(faultKey(f)) || 0) }))
        .filter((/** @type {any} */ f) => f.count > 0);
    save('telemetryFaults', left);
}

// Sends the counters, at most every TELEMETRY_FLUSH_MS, on the minute the retry loop already
// spends — and only paired, with something to say. Reset on a 204 and on nothing else that
// succeeds; dropped on a 400 or 413 (resending the same body will not mend it) and on a 401 (the
// token is gone); kept for next time on a 5xx, another refusal or no answer at all. None of this
// call's own failures is counted: an unreachable engine would otherwise grow the counter that
// says it is unreachable.
async function flushTelemetry() {
    const config = getConfig();
    if (!hasAuth(config)) return;
    const at = load('telemetryAt', 0);
    const now = Date.now();
    // A clock set back is not a reason to wait until it catches up again.
    if (at && now >= at && now - at < TELEMETRY_FLUSH_MS) return;
    const events = telemetryEvents(load('telemetry', {}));
    if (!events) return;
    const faults = telemetryFaults(load('telemetryFaults', []));
    // Claimed before it leaves: the other documents' instances see it and stay quiet.
    save('telemetryAt', now);
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
    if (res.status === 204 || res.status === 400 || res.status === 413 || res.status === 401) forgetSent(events, faults);
}

// The pane opening: `started` every time — each document has its own instance, and each is a
// start — and `installed` or `updated` against the build last recorded here. Word announces
// neither: the add-in is a page, and its build is what the page was served with.
//
// **A storage that has never recorded a build is an install — unless the add-in has already
// left a trace in it.** The day this ships, every student already using the add-in holds no
// recorded build, and must read as updated rather than newly installed. Called before
// `updatedVersion`, which writes one of those traces on the very first opening.
function noteLaunch() {
    const build = AGENT_BUILD.includes('{') ? '' : AGENT_BUILD;
    const recorded = load('telemetryVersion', null);
    if (recorded === null) {
        const known = ['seenVersion', 'config', 'queue', 'engineIds']
            .some((key) => localStorage.getItem(STORAGE_PREFIX + key) !== null);
        countEvent(known ? 'updated' : 'installed');
    } else if (recorded !== build) {
        countEvent('updated');
    }
    try {
        save('telemetryVersion', build);
    } catch (_) { /* recorded next time */ }
    countEvent('started');
}

// The add-in's own uncaught exceptions, counted as `error.runtime`. The pane is the add-in's own
// page, so listening on its window is mostly listening to ourselves — mostly: Office.js runs in
// it too, loaded from Microsoft's CDN, and its errors are the host's, not ours.
//
// - An `error` counts when the script it was thrown in is served from the pane's own origin
//   (taskpane.js, agent.js, the inline cache recovery…). One from office.js names Microsoft's
//   origin; one from a cross-origin script the browser does not detail at all ("Script error.",
//   no file name), and it is left out with them.
// - A rejection nobody caught has no file name, only a reason: it counts when that reason's
//   stack goes through one of our own scripts. A rejection made of something other than an
//   error, or built entirely inside Office.js, is not ours to count.
//
// What is read of the error decides whether to count it; of what is counted, only the fault —
// its type and our own frames (`faultOf`) — is kept, never the message.
function watchErrors() {
    const own = location.origin + '/';
    window.addEventListener('error', (event) => {
        if (typeof event?.filename === 'string' && event.filename.startsWith(own)) countRuntimeError(event.error);
    });
    window.addEventListener('unhandledrejection', (event) => {
        const stack = event?.reason?.stack;
        if (typeof stack === 'string' && stack.includes(own)) countRuntimeError(event.reason);
    });
}

// --- PROBLEM REPORT ---
// "Signaler un problème" opens the help form of the Certimens space, prefilled with what this
// pane knows of the agent (report.js, linked from the extension, builds the block;
// docs/moteur.md says what goes in it). The values are named one by one: no token, no device
// code, no e-mail, and nothing of the document — neither its name nor its address.

// Office's own words for the platform, read as the system it runs on. The web gives no system,
// and Office does not say which one is behind a browser: `unknown` rather than a guess.
const REPORT_OS = { PC: 'Windows', Mac: 'macOS', iOS: 'iOS', Android: 'Android' };

// Word, the platform and the build, as Office names them: `Word PC 16.0.18129.20158`,
// `Word OfficeOnline 16.0.…`. Null when Office has not said (a Word too old for diagnostics).
function officeDiagnostics() {
    try {
        return Office.context.diagnostics || null;
    } catch (_) {
        return null;
    }
}

function reportValues() {
    const config = getConfig();
    const state = getState();
    const diagnostics = officeDiagnostics();
    const host = diagnostics ? [diagnostics.host, diagnostics.platform, diagnostics.version].filter(Boolean).join(' ') : '';
    return {
        agent: agentDeclaration(),
        host: host || null,
        os: (diagnostics && REPORT_OS[diagnostics.platform]) || null,
        language: currentLanguage(),
        engine: reportEngine(config.engineUrl),
        signed_in: reportFlag(hasAuth(config)),
        paused: reportFlag(isPaused()),
        status: reportStatus(state.status),
        queued: state.queue.length,
        counters: reportCounters(telemetryEvents(load('telemetry', {}))),
        at: reportTime(new Date()),
    };
}

function reportLink() {
    return reportUrl(getConfig().engineUrl, reportValues());
}
