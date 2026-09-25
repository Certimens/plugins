// Certimens — Word add-in, writing sensor (the counterpart of extension/content.js).
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
// - no flight times (mad_ms, median_flight_ms): Word events do not track each
//   key, so a rhythm computed from them would be wrong;
// - no focus_losses: Word does not signal that you have left the document;
// - a deletion is a correction if it follows typing, a reformulation if it follows a
//   cursor move, and a macro-revision if it spans a selection or more than 15
//   characters (Cut included).

const FLUSH_KEYSTROKES = 200;       // flush at 200 keystrokes, like the extension
const IDLE_FLUSH_MS = 2000;         // flush after 2 s of inactivity
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
const MIN_READ_INTERVAL_MS = 250;   // at most one text read every 250 ms
const BASELINE_REFRESH_MS = 5000;   // baseline re-read (co-authors' edits)
const TITLE_REFRESH_MS = 3000;
// Word's structural characters (paragraph end, line break, cell) and invisible ones.
// eslint-disable-next-line no-control-regex -- these are precisely those control characters
const STRUCTURE_CHARS = /[\r\n\u000b\u000c\u0007\u200b\ufeff]/g;

const chars = (text) => [...text.replace(STRUCTURE_CHARS, '')].length;

function newMeasure() {
    return {
        start: null,
        last: null,
        keystrokes: 0,
        activeMs: 0,
        injectedChars: 0,
        corrections: 0,
        reformulations: 0,
        macroRevisions: 0,
        navigation: 0,
        pauses: 0,
        pasteEvents: 0,
    };
}

let measure = newMeasure();
let lastEventTime = 0;
let lastActivityTime = 0;
let isNavigating = false;
let rangeSelected = false;
let idleTimer = null;

let previousText = null;
let pendingEvents = [];
let reading = false;
let lastReadAt = 0;
let sensorDocumentId = null;

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
function noteLocalEvent() {
    pendingEvents.push(Date.now());
    scheduleRead();
}

// Empty selection or not: deleting a selection is a macro-revision.
function onSelectionChanged() {
    noteLocalEvent();
    Office.context.document.getSelectedDataAsync(Office.CoercionType.Text, (result) => {
        if (result.status === Office.AsyncResultStatus.Succeeded) rangeSelected = chars(result.value) > 0;
    });
}

// A co-author's edit: re-read without being counted, so it is not attributed to the student.
function onParagraphEvent(event) {
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
        previousText = text;
    } catch (err) {
        console.warn('Certimens : lecture du document impossible.', err);
    }
    reading = false;
    if (pendingEvents.length > 0) scheduleRead();
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

    // Many characters at once for few events: a paste or a drag-and-drop.
    if (insertedChars > INJECTION_MIN_CHARS && insertedChars > 2 * events.length) {
        measure.pasteEvents++;
        measure.injectedChars += insertedChars;
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
        effective_time_seconds: Math.round(done.activeMs / 1000),
        total_keystrokes: done.keystrokes,
        total_injected_chars: done.injectedChars,
        immediate_corrections: done.corrections,
        deferred_reformulations: done.reformulations,
        navigation_jumps: done.navigation,
        macro_revisions: done.macroRevisions,
        cognitive_pauses: done.pauses,
        paste_events: done.pasteEvents,
    };
    if (previousText !== null) values.real_volume = chars(previousText);

    enqueue({
        documentId: sensorDocumentId,
        documentName: documentName(),
        reason,
        period: { start: new Date(done.start).toISOString(), end: new Date(end).toISOString() },
        values,
    });
}

// --- 4. STARTUP ---
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
    setInterval(scheduleRead, BASELINE_REFRESH_MS);
    watchTitle();
    window.addEventListener('pagehide', () => flush('pagehide'));
}
