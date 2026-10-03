// Certimens — Word add-in, writing sensor (the counterpart of browser/content.js).
//
// An Office add-in does not receive the document's keystrokes: the sensor therefore tracks what
// changes. Each local edit (selection change, paragraph modified by the
// student) triggers a re-read of the document's text; the difference from the previous
// read tells what was inserted or deleted, and where. Co-authors' edits (Word on
// the web) are ignored: the text is also re-read when Word signals a remote edit,
// and every 5 s; with no local event since the last read, the re-read text simply
// becomes the new reference. No text is kept beyond the previous read, nor
// sent: only counters go to the engine.
//
// Same definitions as the extension, with these differences:
// - a keystroke is an inserted or deleted character (a key with no effect on the text is not seen);
// - no flight times (flight_mad_ms, flight_median_ms): Word events do not track each
//   key, so a rhythm computed from them would be wrong;
// - no focus_losses, and so no injected_chars_after_return either: Word does not signal that
//   you have left the document, so there is no return to date a paste from;
// - a deletion is a correction if it follows typing, a reformulation if it follows a
//   cursor move, and a macro-revision if it spans a selection or more than 15
//   characters (Cut included).

const FLUSH_KEYSTROKES = 200;       // flush at 200 keystrokes, like the extension
const IDLE_FLUSH_MS = 2000;         // flush after 2 s of inactivity
// What the engine is told about *why* a window was sealed, for each of the triggers that can
// seal one here. The engine cannot tell them apart on its own, and only `away` and `end` mean
// nobody was looking at the document. The wire vocabulary is six words and it is the same for
// the four agents (docs/mesures.md); the triggers on the left are this add-in's own, which are
// fewer: Office does not say when the document loses focus, so this agent never reports a
// departure. A trigger missing from the table sends nothing, which the engine reads as an agent
// that did not say — `make check` is what keeps one from going missing.
const WIRE_FLUSH_REASONS = {
    idle: 'idle',           // 2 s without activity: the writer stopped
    volume: 'volume',       // FLUSH_KEYSTROKES reached: the counter stopped, not the writer
    pause: 'end',           // measuring suspended
    logout: 'end',          // the student signed out: the session that measured it is over
    pagehide: 'end',        // the task pane is going away
};
const PAUSE_MIN_S = 3;              // cognitive pause: inactivity between 3 s and PAUSE_MAX_S then resuming
// PAUSE_MAX_S bounds what counts as thinking rather than leaving. It was 60 s, which made every
// deliberation longer than a minute count as **nothing at all** — neither a pause nor effective
// time — although pausing one to five minutes over a paragraph is the clearest mark of someone
// actually composing. Beyond five minutes the student has left the document, which is not
// cognitive friction. ACTIVE_GAP_MAX_S stays at 60 s: it bounds a different rule (what a gap adds
// to effective time), and the two were only ever the same number by accident.
const PAUSE_MAX_S = 300;
const ACTIVE_GAP_MAX_S = 60;       // beyond this a gap adds nothing to the effective time
const INJECTION_MIN_CHARS = 15;     // beyond this, an insertion made in one shot is a paste
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
// Word's structural characters (paragraph end, line break, cell) and invisible ones.
// eslint-disable-next-line no-control-regex -- these are precisely those control characters
const STRUCTURE_CHARS = /[\r\n\u000b\u000c\u0007\u200b\ufeff]/g;

// How many characters a text holds, counted in code points exactly as `[...text].length` does —
// and without the array that spreading one allocates, an element per character. This runs on the
// whole document at every window (`real_volume_chars` is read from the body already in hand), so
// the allocation is paid on the student's thread while they write. A text holding no high
// surrogate has as many code points as UTF-16 units, which a native scan answers in one pass.
// The count must stay identical: the engine counts a deposited document the same way.
const HIGH_SURROGATE = /[\uD800-\uDBFF]/;

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
        keystrokes: 0,
        activeMs: 0,
        injectedChars: 0,
        maxInjectedChars: 0,
        corrections: 0,
        reformulations: 0,
        macroRevisions: 0,
        navigation: 0,
        pauses: 0,
        pasteEvents: 0,
        selfPasteEvents: 0,
        selfPasteChars: 0,
    };
}

let measure = newMeasure();
let lastEventTime = 0;
let lastActivityTime = 0;
let isNavigating = false;
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
let pendingEvents = [];
let reading = false;
let lastReadAt = 0;
let sensorDocumentId = null;
// How many baseline re-reads in a row found the document exactly as they left it.
let baselineQuiet = 0;

// Any activity opens the window if needed, pushes back its end and restarts the idle timer.
function markActivity(now) {
    if (measure.start === null) measure.start = now;
    measure.last = now;
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => flush('idle'), IDLE_FLUSH_MS);
}

// Resuming after 3 s to PAUSE_MAX_S of inactivity counts as a cognitive pause.
function trackPause(now) {
    if (lastEventTime > 0) {
        const gapS = (now - lastEventTime) / 1000;
        if (gapS > PAUSE_MIN_S && gapS <= PAUSE_MAX_S) measure.pauses++;
    }
    lastEventTime = now;
}

// Effective time: the real gap if <= 2 s, a flat 250 ms if < ACTIVE_GAP_MAX_S, nothing beyond.
function trackActiveTime(now) {
    if (lastActivityTime > 0) {
        const gap = now - lastActivityTime;
        if (gap <= 2000) measure.activeMs += gap;
        else if (gap < ACTIVE_GAP_MAX_S * 1000) measure.activeMs += 250;
    }
    lastActivityTime = now;
}

function hasActivity() {
    return measure.keystrokes > 0 || measure.pasteEvents > 0;
}

// --- 1. WORD EVENTS ---
// A suspended measurement counts nothing, but keeps *reading*: the baseline goes on refreshing
// on its own timer (see BASELINE_REFRESH_MS), so what the student writes during the pause
// becomes the new reference instead of landing, all at once, in the first window after it.
function noteLocalEvent() {
    if (!measuring()) return;
    pendingEvents.push(Date.now());
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
        if (previousText !== null && events.length > 0) analyse(previousText, text, events);
        // A read that brings back the same text, with nothing of the student's behind it, is a
        // read that was not worth making: the baseline timer slows down. Anything at all —
        // a keystroke, a co-author — puts it back to its shortest delay.
        baselineQuiet = text === previousText && events.length === 0 ? baselineQuiet + 1 : 0;
        previousText = text;
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

// What changed between two reads: the deleted text and the inserted text at the same spot.
function difference(before, after) {
    let start = 0;
    const max = Math.min(before.length, after.length);
    while (start < max && before[start] === after[start]) start++;
    let end = 0;
    while (end < max - start && before[before.length - 1 - end] === after[after.length - 1 - end]) end++;
    return {
        deleted: before.slice(start, before.length - end),
        inserted: after.slice(start, after.length - end),
    };
}

function analyse(before, after, events) {
    for (const time of events) {
        markActivity(time);
        trackPause(time);
        trackActiveTime(time);
    }
    const { deleted, inserted } = difference(before, after);
    const deletedChars = chars(deleted);
    const insertedChars = chars(inserted);

    if (deleted.length === 0 && inserted.length === 0) {
        // cursor or selection moved without touching the text
        measure.navigation += events.length;
        isNavigating = true;
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
            // The student's own text, revised. When it replaces something, the deletion below
            // already scores the revision and its keystroke; when it lands on its own (the
            // paragraph was erased a moment earlier), it is scored here. Coming back a second
            // time, it is a duplication: the keystroke stays, the revision is not counted again.
            if (deleted.length === 0) {
                if (!own.again) measure.macroRevisions++;
                measure.keystrokes++;
            }
            // Counted so the engine can tell a revision through a corrector from a revision
            // made by hand: both weigh as a mass revision, and only this says which one it was.
            measure.selfPasteEvents++;
            // And how much came back, not only how often: four restitutions say nothing about
            // whether a paragraph or a third of the document went through the corrector.
            measure.selfPasteChars += insertedChars;
        } else {
            measure.pasteEvents++;
            measure.injectedChars += insertedChars;
            // The largest single injection, which the total alone hides: twenty insertions of a
            // hundred characters and one of two thousand give the same total.
            if (insertedChars > measure.maxInjectedChars) measure.maxInjectedChars = insertedChars;
        }
    } else {
        measure.keystrokes += insertedChars;
        if (inserted.length > 0 && insertedChars === 0) measure.keystrokes++; // Enter
    }

    if (deleted.length > 0) {
        const block = rangeSelected || deletedChars > INJECTION_MIN_CHARS;
        const count = block ? 1 : Math.max(deletedChars, 1);
        measure.keystrokes += count;
        if (block) measure.macroRevisions++;
        else if (isNavigating) measure.reformulations += count;
        else measure.corrections += count;
    }
    isNavigating = false;
    rangeSelected = false;

    if (measure.keystrokes >= FLUSH_KEYSTROKES) flush('volume');
}

// --- 3. FLUSH TO THE QUEUE ---
function flush(reason) {
    clearTimeout(idleTimer);
    lastActivityTime = 0;
    if (!hasActivity()) {
        // Movements alone: their counters carry over to the next window, but not their
        // time, otherwise the period would swallow the inactivity that follows.
        measure.start = null;
        measure.last = null;
        return;
    }
    const done = measure;
    measure = newMeasure();

    const end = Math.max(done.last, done.start + 1000); // the engine requires end > start
    const values = {
        effective_time_ms: done.activeMs,
        keystrokes_total: done.keystrokes,
        injected_chars_total: done.injectedChars,
        immediate_corrections: done.corrections,
        deferred_reformulations: done.reformulations,
        navigation_jumps: done.navigation,
        macro_revisions: done.macroRevisions,
        cognitive_pauses: done.pauses,
        paste_events: done.pasteEvents,
        self_paste_events: done.selfPasteEvents,
        self_paste_chars_total: done.selfPasteChars,
        injected_chars_max: done.maxInjectedChars,
    };
    if (previousText !== null) values.real_volume_chars = chars(previousText);

    enqueue({
        documentId: sensorDocumentId,
        documentName: documentName(),
        // The file this identity was read from: what binds the engine document created for this
        // window to one file rather than to any file that happens to carry the same identity.
        documentSource: documentSource(),
        reason,
        flush: WIRE_FLUSH_REASONS[reason],
        period: { start: new Date(done.start).toISOString(), end: new Date(end).toISOString() },
        values,
    });
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
    sensorDocumentId = documentId();
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
