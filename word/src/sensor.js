// Certimens — Word add-in, writing sensor (the counterpart of browser/content.js).
//
// An Office add-in does not receive the document's keystrokes: the sensor therefore tracks what
// changes. Each local edit (selection change, paragraph modified by the
// student) triggers a re-read of the document's text; the difference from the previous
// read tells what was inserted or deleted, and where. Co-authors' edits (Word on
// the web) are ignored: the text is also re-read when Word signals a remote edit,
// and every 5 s; with no local event since the last read, the re-read text simply
// becomes the new reference. No text is kept beyond the previous read and the one the last
// window reported (see spanSince), both in memory only, and none is sent: only numbers and
// categories go to the engine.
//
// What a window says is what was observed, once: the gestures in order (`runs`), the few counts
// only the sensor can classify (`counts`), the text read (`text`) and the session's running
// totals (`sum`). The engine deduces the rest — keystrokes, pastes, injected characters, pauses
// — from the runs, so none of those numbers is sent.
//
// Same definitions as the extension, with these differences:
// - a keystroke is an inserted or deleted character (a key with no effect on the text is not seen);
// - no rhythm (`flight`, `dwell`): Word events do not track each key, so a rhythm computed from
//   them would be wrong. A run is what one difference did, with no duration: what is dated here
//   is a Word event, not a key;
// - short silences are not resolved, for the same reason: only a silence longer than
//   SILENCE_RESOLUTION_MS becomes a `gap`, and the request says so (`unseen`, in agent.js);
// - no `exits`, and so neither `back_keys` nor `back_chars`: Word does not signal that you have
//   left the document, so there is no return to date anything from;
// - a deletion is a correction if it follows typing on the spot, a reformulation if it follows a
//   cursor move or once an unbroken run of deleting — in one difference or over several —
//   reaches a word's worth of characters, and a macro-revision if it spans a selection or more
//   than 15 characters (Cut included). A reformulation counts once for the gesture, not once
//   per character.

const FLUSH_KEYSTROKES = 200;       // flush at 200 keystrokes, like the extension
const IDLE_FLUSH_MS = 2000;         // flush after 2 s of inactivity
// What the engine is told about *why* a window was sealed, for each of the triggers that can
// seal one here. The engine cannot tell them apart on its own, and only `away` and `end` mean
// nobody was looking at the document. The wire vocabulary is six words and it is the same for
// the four agents (docs/mesures.md); the triggers on the left are this add-in's own, which are
// fewer: Office does not say when the document loses focus, so this agent never reports a
// departure. The word is mandatory in a window, so a trigger must be in the table before
// anything flushes on it — `make check` is what keeps one from going missing.
const WIRE_FLUSH_REASONS = {
    idle: 'idle',           // 2 s without activity: the writer stopped
    volume: 'volume',       // FLUSH_KEYSTROKES reached: the counter stopped, not the writer
    pause: 'end',           // measuring suspended
    logout: 'end',          // the student signed out: the session that measured it is over
    pagehide: 'end',        // the task pane is going away
};
// The shortest silence this sensor can vouch for. A silence is reported as it was observed and
// the engine is the one that reads a pause in its length; but below this, what is measured here
// is the spacing of Word's events and of the reads behind them, not a writer stopping. So only a
// silence **longer** than this becomes a `gap`, of its real length however long, and every
// request declares the shorter ones unseen.
const SILENCE_RESOLUTION_MS = 3000;
const ACTIVE_GAP_MAX_S = 60;       // beyond this a gap adds nothing to the effective time
const INJECTION_MIN_CHARS = 15;     // beyond this, an insertion made in one shot is a paste
// How many characters taken out in one difference stop being a typo and start being a phrase the
// writer decided against. A mis-hit letter costs one to a few; past this many it is a word or a
// clause coming out, which is a reformulation whatever key did it.
const ERASE_RUN_REFORMULATES = 6;
// How many moves before writing again count as having gone somewhere. One is a caret nudged by a
// character; two or more is a trip back into the text.
const NAV_STEPS_AWAY = 2;
// A text the student sends to a corrector (Scribens, Antidote, a translator) and pastes back is
// not an injection: it is their own writing, revised. What leaves the document is remembered as
// hashed word shingles — never as text — and an insertion that overlaps them enough is counted
// as the massive revision it is. Office gives no clipboard event, so what is remembered here is
// what the diff sees disappear — a cut, a replaced selection — **and what the student selects**:
// a Ctrl+C is invisible to an add-in, but the selection it was made on is not, and a block that
// was selected is by definition a block the document already held. Without it, the most ordinary
// gesture there is — copy a sentence of your own, paste it again further down — was counted as
// text imported from outside, and a document duplicating enough of itself was accused of never
// having been typed.
const SHINGLE_WORDS = 4;            // a shingle is four consecutive words
const SELF_PASTE_RATIO = 0.7;       // overlap above which an insertion is the student's own text
const SELF_PASTE_TTL_MS = 60 * 60 * 1000;  // how long what left the document stays comparable
const SELF_PASTE_MAX_COPIES = 20;   // only the last ones are kept: the memory is bounded
// A selection is hashed once it has stopped moving, and never in the callback that read it.
// Extending one with Shift+Arrow raises an event per press, and each read would be hashed whole:
// 137 ms for a dissertation selected entire, on a development machine — a student's is three to
// five times slower. The extension defers its copy handler for the same reason. 150 ms outlasts
// a key repeat and a mouse drag, and stays well under the gesture that follows a copy — move the
// cursor, paste — which is what has to find the block already remembered.
const SELECTION_SETTLE_MS = 150;
const MIN_READ_INTERVAL_MS = 250;   // at most one text read every 250 ms
const BASELINE_REFRESH_MS = 5000;   // baseline re-read (co-authors' edits)
// How far that re-read backs off while nothing changes. Word announces a co-author's edit
// (`onParagraphEvent`, non-local source) and that announcement re-reads straight away: the timer
// is only the net under the edits Word does not announce. In a document nobody shares — most of
// them — it finds the same text every five seconds for as long as the pane is open, and
// `body.text` on a long document is a round trip into Word for nothing. So the delay doubles
// while the document stands still, and the first thing that moves puts it back.
//
// What this widens is the net's mesh, and it is the reason the ceiling is 20 s and not a minute:
// edits that arrive unannounced are only mis-attributed once the student types again, and the
// window in which that can happen grows with this number.
const BASELINE_MAX_MS = 20000;
const TITLE_REFRESH_MS = 3000;
// Past this many words on either side, what a span kept is not worked out: the comparison is
// quadratic, and it runs when a window is sealed.
const TEXT_KEPT_MAX_WORDS = 2000;
// The most runs a window may hold: the engine refuses a longer one. A window that gets near it
// is sealed, exactly as one that reaches FLUSH_KEYSTROKES is — a run is never dropped, because
// the runs are the measurement: everything the engine counts, it counts from them.
const TIMELINE_MAX_RUNS = 512;
// The most runs that can be added between two looks at the ceiling: the caret moves read before
// a difference, the silence before it, what it removed, a restitution and the keystroke that
// restitution is scored as.
const RUNS_PER_DIFFERENCE = 5;
// A session is named by this many random bytes (128 bits), written in the URL-safe alphabet.
const SESSION_ID_BYTES = 16;
const BASE64URL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
// Word's structural characters (paragraph end, line break, cell) and invisible ones.
// eslint-disable-next-line no-control-regex -- these are precisely those control characters
const STRUCTURE_CHARS = /[\r\n\u000b\u000c\u0007\u200b\ufeff]/g;

// How many characters a text holds, counted in code points exactly as `[...text].length` does —
// and without the array that spreading one allocates, an element per character. This runs on the
// whole document at every window (`text.len` is read from the body already in hand), so
// the allocation is paid on the student's thread while they write. A text holding no high
// surrogate has as many code points as UTF-16 units, which a native scan answers in one pass.
// The count must stay identical: the engine counts a deposited document the same way.
const HIGH_SURROGATE = /[\uD800-\uDBFF]/;
const LOW_SURROGATE = /[\uDC00-\uDFFF]/;

function codePoints(text) {
    if (!HIGH_SURROGATE.test(text)) return text.length;
    let count = text.length;
    for (let i = 0; i < text.length - 1; i++) {
        const unit = text.charCodeAt(i);
        if (unit >= 0xd800 && unit <= 0xdbff) {
            const low = text.charCodeAt(i + 1);
            if (low >= 0xdc00 && low <= 0xdfff) {
                count--;
                i++;
            }
        }
    }
    return count;
}

const chars = (text) => codePoints(text.replace(STRUCTURE_CHARS, ''));

function newMeasure() {
    return {
        start: null,
        last: null,
        // The same two instants, read on the monotonic clock (see markActivity).
        monoStart: null,
        monoLast: null,
        // What happened, in order. See `record`.
        runs: [],
        // Whether a typed difference has already been recorded in this window: the silence that
        // precedes the first one belongs at the head of the runs, wherever it was measured.
        typed: false,
        activeMs: 0,
        // What only this sensor can classify: it depends on what preceded a deletion, which no
        // run says.
        corrections: 0,
        reformulations: 0,
        revisions: 0,
        jumps: 0,
    };
}

let measure = newMeasure();
// The last typed difference and the last activity of the open window, on the monotonic clock:
// they are only ever subtracted from, and a duration must not move with the machine's time.
let lastTypedMono = null;
let lastActivityMono = null;
// How far the writer has travelled since they last changed the text. It replaces a boolean: a
// deletion only needs to know the caret moved at all, but an *insertion* has to tell a real trip
// back through the text from a one-character nudge, and a boolean cannot. See NAV_STEPS_AWAY.
let navSteps = 0;
// Characters taken out in an unbroken run of deleting, and whether that run has already been
// read as a reformulation. Anything that is not a deletion ends the run. See
// ERASE_RUN_REFORMULATES.
let eraseRun = 0;
let eraseRunReformulated = false;
let rangeSelected = false;
// The selection waiting to be hashed, and the entry the last one left behind. Extending a
// selection with Shift+Arrow raises one event per press, and each of them is the same selection
// being adjusted: without this, the twenty slots above would fill with the prefixes of a single
// paragraph and evict the blocks the student is actually working with.
let pendingSelection = '';
let selectionTimer = null;
let lastSelectionEntry = null;
let idleTimer = null;

let previousText = null;
// One entry per local event Word signalled since the last read: `{ at, mono }`, the same instant
// on the wall clock and on the monotonic one.
let pendingEvents = [];
let reading = false;
let lastReadAt = 0;
let sensorDocumentId = null;
// How many baseline re-reads in a row found the document exactly as they left it.
let baselineQuiet = 0;

// --- THE SESSION ---
// What ties the windows of one sitting together: a random name, a number per sealed window and
// the running totals of what those windows held. The engine reads a missing number, or totals
// its windows do not add up to, as a window that was measured and never arrived.
//
// A session is this sensor measuring this document, from the first thing it counts until the
// measurement stops — suspended, signed out, pane closed. Resuming opens another one. It lives in
// this instance's memory and nowhere else: two panes on the same document are two sensors, hence
// two sessions, and neither can number a window of the other's. Nothing in it comes from the
// account or the machine, and the only copy that outlives the sensor is the one a queued window
// carries.
//
// `since`, `len` and `text` are the last window that reported a text — its number, the size
// it gave, and the text itself, held until the next one is compared with it (see `spanSince`).
let session = null;

function newSessionId() {
    const bytes = crypto.getRandomValues(new Uint8Array(SESSION_ID_BYTES));
    let id = '';
    for (let i = 0; i < bytes.length; i += 3) {
        const chunk = (bytes[i] << 16) | ((bytes[i + 1] || 0) << 8) | (bytes[i + 2] || 0);
        id += BASE64URL[chunk >> 18] + BASE64URL[(chunk >> 12) & 63];
        if (i + 1 < bytes.length) id += BASE64URL[(chunk >> 6) & 63];
        if (i + 2 < bytes.length) id += BASE64URL[chunk & 63];
    }
    return id;
}

// `mono` is the monotonic reading of the event that opens the session: its zero.
//
// A silence never crosses a session: what was last typed belongs to the one before, and the
// time since then covers a suspension or a sign-out, not a writer thinking. So the first window
// of a session carries no head gap.
function openSession(mono) {
    lastTypedMono = null;
    session = {
        id: newSessionId(),
        zero: mono,
        seq: 0,
        keys: 0,
        chars: 0,
        pastes: 0,
        since: null,
        len: 0,
        text: null,
    };
}

// The measurement has stopped — here or in another pane, which is why this is asked on every
// event and every read rather than told. The window still open belongs to the session that is
// ending, so it is sealed first; what is counted next opens a new one.
function closeSession() {
    if (session !== null) flush('pause');
}

// Any activity opens the window if needed, pushes back its end and restarts the idle timer.
// Each instant is kept on both clocks: the wall clock dates the window, the monotonic one says
// how long it lasted whatever the wall clock was set to in between.
function markActivity(now, mono) {
    if (session === null) openSession(mono);
    if (measure.start === null) {
        measure.start = now;
        measure.monoStart = mono;
    }
    measure.last = now;
    measure.monoLast = mono;
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => flush('idle'), IDLE_FLUSH_MS);
}

// The silence that ended when typing resumed, in milliseconds — 0 before anything was typed.
//
// Typing, and nothing else: `analyse` calls this once per difference, and only for one that
// holds a keystroke, so `lastTypedMono` is the last time something was typed. A caret move, a
// click or a paste ends no silence: a gap is a silence between two keystrokes.
//
// `from` and `to` are the first and the last event of the typed difference: the silence ended
// at the first, and the next one starts at the last — the time the difference itself took is
// typing, not silence.
function silenceBefore(from, to) {
    const gap = lastTypedMono === null ? 0 : Math.round(from - lastTypedMono);
    lastTypedMono = to;
    return gap;
}

// --- THE RUNS ---
// Appends what one difference did to the window's runs, in order: the silence that came before
// it, then what it did. A run has one of three shapes, by kind:
//
// - `[kind, n, 0]` for keystrokes — `type` for what was inserted at the size of typing, `erase`
//   for what was removed, `other` for the single keystroke a restitution is scored as. The
//   duration is always 0: the instants this sensor holds are those of Word's events, not of
//   keys;
// - `[kind, n]` for what has no duration — `move` (the caret or the selection moving without
//   the text changing: one per event Word raised, and no keystroke), `paste` (characters come
//   from elsewhere) and `self` (the student's own text coming back);
// - `['gap', ms]` for a silence.
//
// Two runs of the same kind in a row are one run — typing read over three differences is one
// stretch of typing — and a `type` run is **never** cut on what was typed: a space, a line
// break and a letter are the same kind, so no run length says how long a word was. `paste` and
// `self` are not merged: one run is one gesture.
//
// `gap` is the silence between two typed differences, and only the ones this sensor can vouch
// for are recorded (see SILENCE_RESOLUTION_MS), at their real length. The one that precedes the
// first typed difference of the window goes to the head, even when a paste was read before it —
// it is the only run whose duration lies outside the window.
function record(gap, runs) {
    const recorded = measure.runs;
    if (gap > SILENCE_RESOLUTION_MS) {
        if (measure.typed) recorded.push(['gap', gap]);
        else recorded.unshift(['gap', gap]);
    }
    for (const run of runs) {
        const last = recorded[recorded.length - 1];
        const merges = run[0] === 'type' || run[0] === 'erase' || run[0] === 'other' || run[0] === 'move';
        if (merges && last && last[0] === run[0]) last[1] += run[1];
        else recorded.push(run);
    }
}

// What the engine deduces from runs, deduced here by the same rules: the keystrokes are the
// `type`, `erase` and `other` runs added up, a paste is a `paste` run, and its characters are
// injected once there are more than INJECTION_MIN_CHARS of them. Nothing else in this file
// counts a keystroke or a paste: the session's totals, the ceiling that seals a window and the
// question of whether a window holds anything are all answered from here, so none of them can
// disagree with the runs the engine reads.
function tally(runs) {
    const sum = { keys: 0, chars: 0, pastes: 0 };
    for (const [kind, n] of runs) {
        if (kind === 'type' || kind === 'erase' || kind === 'other') {
            sum.keys += n;
        } else if (kind === 'paste') {
            sum.pastes++;
            if (n > INJECTION_MIN_CHARS) sum.chars += n;
        }
    }
    return sum;
}

// Effective time: the real gap if <= 2 s, a flat 250 ms if < ACTIVE_GAP_MAX_S, nothing beyond.
function trackActiveTime(mono) {
    if (lastActivityMono !== null) {
        const gap = mono - lastActivityMono;
        if (gap <= 2000) measure.activeMs += gap;
        else if (gap < ACTIVE_GAP_MAX_S * 1000) measure.activeMs += 250;
    }
    lastActivityMono = mono;
}

// A window is sealed for a keystroke or a paste, never for caret moves alone.
function hasActivity({ keys, pastes }) {
    return keys > 0 || pastes > 0;
}

// --- 1. WORD EVENTS ---
// A suspended measurement counts nothing, but keeps *reading*: the baseline goes on refreshing
// on its own timer (see BASELINE_REFRESH_MS), so what the student writes during the pause
// becomes the new reference instead of landing, all at once, in the first window after it.
function noteLocalEvent() {
    if (!measuring()) {
        closeSession();
        return;
    }
    pendingEvents.push({ at: Date.now(), mono: performance.now() });
    scheduleRead();
}

// Empty selection or not: deleting a selection is a macro-revision.
function onSelectionChanged() {
    if (!measuring()) return; // noteLocalEvent checks it too, but the selection read below must not run
    noteLocalEvent();
    Office.context.document.getSelectedDataAsync(Office.CoercionType.Text, (result) => {
        if (result.status !== Office.AsyncResultStatus.Succeeded) return;
        rangeSelected = chars(result.value) > 0;
        rememberSelection(result.value);
    });
}

// A selected block, remembered: it is the only trace a copy leaves in an add-in that never sees
// the clipboard. What it can excuse is bounded by what it is — text read out of the document
// itself — so it can only ever recognise the student's own words coming back, never a text from
// somewhere else. The text waits for the next turn and goes no further: what is kept, once the
// selection has settled, is fingerprints (SELECTION_SETTLE_MS).
function rememberSelection(text) {
    if (chars(text) <= INJECTION_MIN_CHARS) return;
    pendingSelection = text;
    clearTimeout(selectionTimer);
    selectionTimer = setTimeout(hashSelection, SELECTION_SETTLE_MS);
}

function hashSelection() {
    const text = pendingSelection;
    pendingSelection = '';
    if (!measuring()) return;       // suspended or signed out while the selection settled: nothing is kept
    const set = shingles(text);
    if (set.size === 0) return;     // nothing but punctuation: no words to recognise later
    // One selection being adjusted is one selection: extending or shrinking it leaves every
    // fingerprint of the shorter read inside the longer one. The entry is then updated in place
    // rather than replaced — replacing it would forget that the block has already come back, and
    // the next paste would count a second mass revision for what is only a duplication.
    if (lastSelectionEntry && ownText.includes(lastSelectionEntry) && oneContainsTheOther(set, lastSelectionEntry.shingles)) {
        lastSelectionEntry.shingles = set;
        lastSelectionEntry.seenAt = Date.now();
        return;
    }
    lastSelectionEntry = keepOwnText(set);
}

// Is one of these two sets of fingerprints contained in the other?
function oneContainsTheOther(a, b) {
    const [small, large] = a.size <= b.size ? [a, b] : [b, a];
    for (const hash of small) {
        if (!large.has(hash)) return false;
    }
    return true;
}

// A co-author's edit: re-read without being counted, so it is not attributed to the student.
// async: Office awaits what an event handler returns, and its contract is a promise.
async function onParagraphEvent(event) {
    if (event.source === Word.EventSource.local) noteLocalEvent();
    else scheduleRead();
}

// --- 2. READING AND DIFFERENCE ---
function scheduleRead() {
    if (reading) return; // the read in progress will be followed by another (see readText)
    reading = true;
    const wait = Math.max(0, lastReadAt + MIN_READ_INTERVAL_MS - Date.now());
    setTimeout(readText, wait);
}

async function readText() {
    const events = pendingEvents;
    pendingEvents = [];
    lastReadAt = Date.now();
    try {
        const text = await Word.run(async (context) => {
            const body = context.document.body;
            body.load('text');
            await context.sync();
            return body.text;
        });
        // The text just read is the reference from here on, **before** it is analysed: a window
        // sealed during the analysis reports the text its last difference produced, not the one
        // before it — otherwise what that difference inserted would turn up in the next
        // window's span, with the gesture that explains it left behind in this one.
        const before = previousText;
        previousText = text;
        if (before !== null && events.length > 0) analyse(before, text, events);
        // Suspended or signed out — possibly from another document's pane, which this one only
        // learns by asking. What was just analysed was noted while measuring, and closes with
        // the session it belongs to; the reads go on, and are no part of any session.
        if (!measuring()) closeSession();
        // A read that brings back the same text, with nothing of the student's behind it, is a
        // read that was not worth making: the baseline timer slows down. Anything at all —
        // a keystroke, a co-author — puts it back to its shortest delay.
        baselineQuiet = text === before && events.length === 0 ? baselineQuiet + 1 : 0;
    } catch (err) {
        console.warn('Certimens : lecture du document impossible.', err);
    }
    reading = false;
    if (pendingEvents.length > 0) scheduleRead();
}

// --- RESTITUTION OF ONE'S OWN TEXT ---
// Normalisation absorbs exactly what a corrector changes: case, accents, punctuation and
// spacing. What is left is the sequence of words, which a correction leaves nearly intact.
function normalizeWords(text) {
    const words = text.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase()
        .replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
    return words ? words.split(' ') : [];
}

// FNV-1a over the words of a shingle, read in place: `count` words starting at `from`, joined
// by one space. What is kept is a number, from which the words cannot be read back.
//
// The shingles of a text slide one word at a time, so slicing the window out and joining it
// allocated two objects per word. Reading the words where they are gives **the same number**:
// the bytes hashed are those of the same joined string, separator included. That number is a
// contract — the same text must hash the same in the four agents — so the suite pins known
// values rather than trusting the next rewrite.
function hashShingle(words, from, count) {
    let hash = 0x811c9dc5;
    for (let w = from; w < from + count; w++) {
        if (w > from) {
            hash ^= 32;     // the space the words used to be joined by
            hash = Math.imul(hash, 0x01000193) >>> 0;
        }
        const word = words[w];
        for (let i = 0; i < word.length; i++) {
            const code = word.codePointAt(i);
            hash ^= code;
            hash = Math.imul(hash, 0x01000193) >>> 0;
            if (code > 0xffff) i++;     // a surrogate pair is one code point
        }
    }
    return hash;
}

function shingles(text) {
    const words = normalizeWords(text);
    if (words.length === 0) return new Set();
    // Shorter than a shingle — a couple of words moved from one sentence to another — is hashed
    // whole rather than dropped. Without it, moving "developpement durable" inside the document
    // was an injection: nothing had been remembered when it left, so nothing could recognise it
    // coming back. One fingerprint over the whole sequence can only ever match a paste just as
    // short, so it still cannot excuse a text taken from somewhere else.
    if (words.length < SHINGLE_WORDS) return new Set([hashShingle(words, 0, words.length)]);
    const set = new Set();
    for (let i = 0; i + SHINGLE_WORDS <= words.length; i++) {
        set.add(hashShingle(words, i, SHINGLE_WORDS));
    }
    return set;
}

// What left the document, hashed: { seenAt, shingles, restituted }. seenAt is the last time the
// copy was seen — when it left, then each time it came back: a block the student keeps pasting
// stays comparable as long as they keep using it, and only a copy nothing comes back to ages out.
let ownText = [];

function rememberOwnText(text) {
    const set = shingles(text);
    if (set.size === 0) return;    // nothing but punctuation: no words to recognise later
    keepOwnText(set);
}

// The fingerprints kept, and the entry holding them: a caller that goes on following this block
// needs it, and nothing else ever hands it out.
function keepOwnText(set) {
    const entry = { seenAt: Date.now(), shingles: set, restituted: false };
    ownText.push(entry);
    if (ownText.length > SELF_PASTE_MAX_COPIES) forgetLeastRecent();
    return entry;
}

// The memory is bounded, and what goes is the copy nothing has come back to for the longest —
// not the oldest one. Taking five other blocks away in between would otherwise make the one the
// student is still pasting unrecognisable.
function forgetLeastRecent() {
    let oldest = 0;
    for (let i = 1; i < ownText.length; i++) {
        if (ownText[i].seenAt < ownText[oldest].seenAt) oldest = i;
    }
    ownText.splice(oldest, 1);
}

// Is this insertion the student's own text coming back? Containment rather than a symmetric
// similarity: they may paste back one corrected paragraph out of the three they took away.
// Returns null when the text is not theirs, otherwise { again }: true from the second return of
// the same block, which is a duplication and not a revision.
function matchOwnText(text) {
    const now = Date.now();
    ownText = ownText.filter((copy) => now - copy.seenAt < SELF_PASTE_TTL_MS);
    const set = shingles(text);
    if (set.size === 0) return null;
    let seen = 0;
    const from = [];
    for (const hash of set) {
        const copy = ownText.find((candidate) => candidate.shingles.has(hash));
        if (!copy) continue;
        seen++;
        if (!from.includes(copy)) from.push(copy);
    }
    if (seen / set.size < SELF_PASTE_RATIO) return null;
    const again = from.every((copy) => copy.restituted);
    for (const copy of from) {
        copy.seenAt = now;
        copy.restituted = true;
    }
    return { again };
}

// What changed between two reads: the deleted text and the inserted text at the same spot, and
// how much the two reads share before it (`start`) and after it (`end`), in UTF-16 units.
function difference(before, after) {
    let start = 0;
    const max = Math.min(before.length, after.length);
    while (start < max && before[start] === after[start]) start++;
    let end = 0;
    while (end < max - start && before[before.length - 1 - end] === after[after.length - 1 - end]) end++;
    return {
        deleted: before.slice(start, before.length - end),
        inserted: after.slice(start, after.length - end),
        start,
        end,
    };
}

// --- THE SPAN OF WHAT CHANGED ---
// What the engine is told is where the text of this window differs from the text of the last
// window that reported one: how much they share at the head (`at`), and so how much went (`cut`)
// and how much came (`add`) between that and what they share at the tail. Lengths, never text.
//
// Between two sealed windows the text is read many times, so the comparison cannot be made on
// the previous read alone. The session therefore holds one more text for as long as a window is
// open: the one the last window reported (`session.text`). It is the same rule as for the
// previous read — in memory only, never sent, replaced at each sealing and let go when the
// session closes — and it costs no copy: it is the very string the previous read was.
//
// The span is an envelope: two places edited far apart make one span from the first to the
// last, with the untouched text between them counted as removed and as inserted. `kept` is what
// tells the two apart — see `keptChars`.
//
// Every read ends up in it, the baseline ones included: a co-author's text is text that arrived
// without a gesture of this student's, and it is reported as exactly that. What is read while
// the measurement is suspended is not: there is no session then, and the next one has nothing
// to compare its first window with.
//
// Returns null when no window of this session has reported a text yet: a first reading has
// nothing to be compared with, and the window then gives the size alone. Counted the way the
// size is — code points, Word's structural characters left out — so that the previous size,
// less what was cut, plus what was added, is this one.
function spanSince(text) {
    if (session.since === null) return null;
    const before = session.text;
    if (before === text) return { since: session.since, at: session.len, cut: 0, add: 0, kept: 0 };
    let { start, end } = difference(before, text);
    // Two different characters outside the basic plane can share their first half: a shared
    // head must not end, nor a shared tail begin, in the middle of one.
    if (start > 0 && HIGH_SURROGATE.test(text[start - 1])) start--;
    if (end > 0 && LOW_SURROGATE.test(text[text.length - end])) end--;
    const gone = before.slice(start, before.length - end);
    const come = text.slice(start, text.length - end);
    const span = { since: session.since, at: chars(text.slice(0, start)), cut: chars(gone), add: chars(come) };
    const kept = keptChars(gone, come);
    if (kept !== null) span.kept = kept;
    return span;
}

// A text cut into words, each with the blanks that follow it, so that the pieces add up to the
// text: what is kept is then counted whole, separators included. Null past TEXT_KEPT_MAX_WORDS.
const WORD_PIECE = /\s+|\S+\s*/g;

function wordPieces(text) {
    const pieces = text.match(WORD_PIECE) || [];
    return pieces.length > TEXT_KEPT_MAX_WORDS ? null : pieces;
}

// How many of the characters that came were already among those that went, in the same order:
// a longest common subsequence over words, counted in characters. It is what lets the engine
// read an envelope — of two paragraphs touched at their two ends, almost everything was there
// before. Null when either side is too long to compare: the engine then reads the growth alone.
//
// The comparison is made on numbers: each distinct word is given one, and the words themselves
// go no further than this function. One row of the table is kept at a time.
function keptChars(gone, come) {
    if (gone.length === 0 || come.length === 0) return 0;
    const before = wordPieces(gone);
    const after = wordPieces(come);
    if (before === null || after === null) return null;
    const ids = new Map();
    const idOf = (piece) => {
        if (!ids.has(piece)) ids.set(piece, ids.size);
        return ids.get(piece);
    };
    const left = before.map(idOf);
    const right = after.map(idOf);
    const weight = after.map(chars);
    let row = new Int32Array(right.length + 1);
    let next = new Int32Array(right.length + 1);
    for (let i = 0; i < left.length; i++) {
        for (let j = 0; j < right.length; j++) {
            next[j + 1] = left[i] === right[j]
                ? row[j] + weight[j]
                : Math.max(row[j + 1], next[j]);
        }
        [row, next] = [next, row];
    }
    return row[right.length];
}

// `count` more characters out of the run. Returns true the one time the run crosses
// ERASE_RUN_REFORMULATES: that difference is read as a reformulation, and the ones after it as
// nothing — a word taken out in one difference crosses it on its own, Backspace hammered through
// it over several differences crosses it on the way.
function extendEraseRun(count) {
    eraseRun += count;
    if (eraseRun < ERASE_RUN_REFORMULATES || eraseRunReformulated) return false;
    eraseRunReformulated = true;
    return true;
}

// Anything that is not a deletion ends the run, so the next one is judged on its own length.
function endEraseRun() {
    eraseRun = 0;
    eraseRunReformulated = false;
}

function analyse(before, after, events) {
    for (const event of events) {
        markActivity(event.at, event.mono);
        trackActiveTime(event.mono);
    }
    // Whether this difference was typed — a character, a line break, a deletion — rather than
    // pasted or merely walked through. Only then can it end a silence: see silenceBefore.
    let typed = false;
    // What this difference adds to the runs: what it removed, then what it put in. A
    // difference has no order of its own, and that one is the gesture's — a selection typed or
    // pasted over, a Backspace and the letter after it.
    let erased = null;
    const added = [];
    const { deleted, inserted } = difference(before, after);
    const deletedChars = chars(deleted);
    const insertedChars = chars(inserted);

    if (deleted.length === 0 && inserted.length === 0) {
        // cursor or selection moved without touching the text
        measure.jumps += events.length;
        record(0, [['move', events.length]]);
        navSteps += events.length;
        endEraseRun();
        return;
    }

    // What disappears from the document may come back corrected: a cut, or the selection this
    // very insertion replaces. Remembered before the insertion is judged, so that "select the
    // paragraph, paste the corrected one" is recognised in the single difference it makes. Only
    // a block is worth remembering: a backspace carries no shingle, and hashing one character on
    // every keystroke is work for nothing.
    if (deletedChars > INJECTION_MIN_CHARS) rememberOwnText(deleted);

    // Many characters at once for few events: a paste or a drag-and-drop.
    if (insertedChars > INJECTION_MIN_CHARS && insertedChars > 2 * events.length) {
        const own = matchOwnText(inserted);
        if (own) {
            // The student's own text, revised: a `self` run of its size, which is what lets the
            // engine tell a revision through a corrector from one made by hand, and how much
            // came back. When it replaces something, the deletion below already scores the
            // revision and its keystroke; when it lands on its own (the paragraph was erased a
            // moment earlier), it is scored here. Coming back a second time, it is a
            // duplication: the keystroke stays, the revision is not counted again.
            added.push(['self', insertedChars]);
            if (deleted.length === 0) {
                if (!own.again) measure.revisions++;
                added.push(['other', 1, 0]);
            }
        } else {
            // One run per paste, at its own size: twenty insertions of a hundred characters and
            // one of two thousand add up alike, and only the runs tell them apart.
            added.push(['paste', insertedChars]);
        }
    } else if (inserted.length > 0) {
        // Enter inserts nothing but structure and is one keystroke — of the same kind as the
        // letters around it, so the run it joins says nothing about where a paragraph ended.
        added.push(['type', Math.max(insertedChars, 1), 0]);
        typed = true;
        // Writing again after travelling back through the text is a reformulation even when
        // nothing was deleted first: inserting the word that was missing, or typing the new
        // wording in front of the old one. A difference that also deletes is judged below
        // instead, so the one act of replacing a span is never charged twice.
        if (deleted.length === 0 && navSteps >= NAV_STEPS_AWAY) measure.reformulations++;
    }

    // Writing ends the run: what is deleted next is judged on its own length.
    if (inserted.length > 0) endEraseRun();

    if (deleted.length > 0) {
        const block = rangeSelected || deletedChars > INJECTION_MIN_CHARS;
        const count = block ? 1 : Math.max(deletedChars, 1);
        erased = ['erase', count, 0];
        typed = true;
        if (block) {
            measure.revisions++;
            endEraseRun();
        } else if (navSteps > 0) {
            // The trip is spent on this one deletion, and so is the run: what follows is being
            // deleted on the spot and reads as an immediate correction again.
            measure.reformulations++;
            endEraseRun();
        } else if (extendEraseRun(count)) {
            // **One gesture, one revision**, not one per character. A run long enough to be a
            // word is read the same way whether or not the caret was moved first: past that
            // length it is not a mis-hit letter being repaired. It is read once; the rest of
            // the run is not counted again.
            measure.reformulations++;
        } else if (!eraseRunReformulated) {
            measure.corrections += count;
        }
    }
    navSteps = 0;
    rangeSelected = false;

    // Once per difference: at most one silence for at least one keystroke.
    const gap = typed ? silenceBefore(events[0].mono, events[events.length - 1].mono) : 0;
    record(gap, erased ? [erased, ...added] : added);
    if (typed) measure.typed = true;

    // Two ceilings, reached the same way: the window is sealed before the next difference
    // could take it over either. Sealing early is the only answer to a window that grows too
    // long — its runs are never trimmed.
    if (tally(measure.runs).keys >= FLUSH_KEYSTROKES
        || measure.runs.length > TIMELINE_MAX_RUNS - RUNS_PER_DIFFERENCE) flush('volume');
}

// --- 3. FLUSH TO THE QUEUE ---
function flush(reason) {
    clearTimeout(idleTimer);
    lastActivityMono = null;
    // The measurement is stopping: whatever is sealed below is the last window of its session.
    const ends = WIRE_FLUSH_REASONS[reason] === 'end';
    const held = tally(measure.runs);
    if (!hasActivity(held)) {
        // Movements alone seal nothing and take no number: their run and their count carry
        // over to the next window, but not their time, otherwise that window would swallow the
        // inactivity that follows — and report more effective time than it lasted.
        measure.start = null;
        measure.last = null;
        measure.monoStart = null;
        measure.monoLast = null;
        measure.activeMs = 0;
        if (ends) session = null;
        return;
    }
    const done = measure;
    measure = newMeasure();

    // Sealing: the window takes its number and the session's totals take what it held, in
    // this one step and whether or not the window ever leaves — a window that is numbered when
    // it is sent is a window nobody misses when it is not.
    const seq = session.seq++;
    session.keys += held.keys;
    session.chars += held.chars;
    session.pastes += held.pastes;
    // The text in hand is the one the window's last difference was read from. The first
    // window of a session has nothing to be compared with and gives its size alone; every
    // other one says how it differs from the last text reported, and the next one will be
    // compared with this.
    const len = chars(previousText);
    const text = { len, ...spanSince(previousText) };
    session.since = seq;
    session.len = len;
    session.text = previousText;
    // From the first to the last activity, on the monotonic clock. The engine takes no window
    // shorter than a second: one made of a single instant is sent as one second.
    const ms = Math.max(Math.round(done.monoLast - done.monoStart), 1000);

    enqueue({
        documentId: sensorDocumentId,
        documentName: documentName(),
        // The file this identity was read from: what binds the engine document created for this
        // window to one file rather than to any file that happens to carry the same identity.
        documentSource: documentSource(),
        // What the queue keeps of the session: its name. The rest is the window as the engine
        // reads it — its place in the session, the instant it opened on the wall clock and on
        // the monotonic one counted from the start of the session, how long it lasted, why it
        // was sealed, and what it holds.
        session: session.id,
        seq,
        at: Math.round(done.start),
        mono: Math.round(done.monoStart - session.zero),
        ms,
        why: WIRE_FLUSH_REASONS[reason],
        active: Math.min(Math.round(done.activeMs), ms),
        runs: done.runs,
        counts: {
            corrections: done.corrections,
            reformulations: done.reformulations,
            revisions: done.revisions,
            jumps: done.jumps,
        },
        text,
        sum: { keys: session.keys, chars: session.chars, pastes: session.pastes },
    });
    if (ends) session = null;

    // The engine document is created on the first send, from whichever instance holds the drain
    // lease and has no document in hand: the file is stamped here instead, by the one that owns
    // it, and after the window is queued. A localStorage read when there is nothing to do.
    stampEngineDocument(sensorDocumentId);
}

// --- 4. STARTUP ---
// The baseline re-read, on a delay that grows while the document stands still. A timer that
// reschedules itself rather than an interval: the delay is not a constant any more.
function watchBaseline() {
    const tick = () => {
        scheduleRead();
        setTimeout(tick, Math.min(BASELINE_REFRESH_MS * 2 ** baselineQuiet, BASELINE_MAX_MS));
    };
    setTimeout(tick, BASELINE_REFRESH_MS);
}

function watchTitle() {
    let title = null;
    const check = () => {
        const current = documentName();
        if (current === title) return;
        title = current;
        noteTitle(sensorDocumentId, current);
    };
    check();
    setInterval(check, TITLE_REFRESH_MS);
}

async function startSensor() {
    sensorDocumentId = await documentId();
    Office.context.document.addHandlerAsync(Office.EventType.DocumentSelectionChanged, onSelectionChanged);
    // Modified paragraphs, with the author of the edit (local or co-author): WordApi 1.6.
    if (Office.context.requirements.isSetSupported('WordApi', '1.6')) {
        await Word.run(async (context) => {
            context.document.onParagraphChanged.add(onParagraphEvent);
            context.document.onParagraphAdded.add(onParagraphEvent);
            context.document.onParagraphDeleted.add(onParagraphEvent);
            await context.sync();
        });
    }
    reading = true;
    await readText(); // first read: the reference, nothing is counted
    watchBaseline();
    watchTitle();
    window.addEventListener('pagehide', () => {
        if (measuring()) flush('pagehide');
    });
}
