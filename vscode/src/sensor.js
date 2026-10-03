// Certimens — VS Code extension, writing sensor (the counterpart of browser/content.js and
// word/sensor.js).
//
// VS Code delivers neither keystrokes nor a DOM: it reports *what changed* in a document
// (`onDidChangeTextDocument`, one event per edit, carrying the inserted text and the length of
// what it replaced) and *how the cursor moved* (`onDidChangeTextEditorSelection`, with the kind
// of move: keyboard, mouse or command). That is more than Office gives — a move's origin is
// known, so the rule "a deletion settles the move that precedes it" holds here — and less than a
// browser gives, since no key is ever seen.
//
// One sensor per open document: a project is measured file by file, each file carrying its own
// windows, and the host (extension.js) ties each of them to its own engine document.
//
// Same definitions as the browser extension, with these differences:
// - a keystroke is an inserted or erased character, as in the Word add-in (a key with no effect
//   on the text is not seen);
// - flight times are the gaps between two keystroke-sized changes: typing fires one event per
//   character, so the rhythm is measurable, but a completion accepted in one shot is not a
//   keystroke and never enters the sample;
// - a block that lands in one shot is a `paste` run, whatever brought it: a paste, a snippet or
//   a completion accepted from IntelliSense or an AI assistant, and VS Code does not say which;
// - a block the document already held somewhere else is a `self` run instead (see
//   duplicatesInDocument): what the editor does give is the document. Copying a sentence of
//   one's own and pasting it again is not an import, and telling it as one made the engine
//   accuse a document of never having been typed.
//
// A window carries what this sensor observed, and nothing that can be worked out from it
// (docs/moteur.md): the ordered runs of gestures, the few classifications only the sensor can
// make, the distribution of the flight times, how far the text moved since the previous
// reading, and its rank in the session with the session's running sums. How many keystrokes,
// pastes, hesitations or pauses that makes is the engine's to derive from the runs — which is
// why no threshold for a hesitation or a pause lives here. Numbers and categories only: a run
// never says which characters, and never splits on one.

// The answer given for an event that brings no block worth looking for: shared, so that an
// ordinary keystroke allocates nothing on its way through.
const NO_DUPLICATES = new Set();

const FLUSH_KEYSTROKES = 200;       // flush at 200 keystrokes, like every other agent
const IDLE_FLUSH_MS = 2000;         // flush after 2 s of inactivity
// What the engine is told about *why* a window was sealed, for each of the triggers that can
// seal one. The engine cannot tell them apart on its own: a save cutting a burst in two looked,
// on its side, like a writer who never stops, and leaving the editor looked like a pause for
// thought. Only `away` and `end` mean nobody was looking at the document.
//
// The wire vocabulary is six words and it is the same for the four agents (docs/mesures.md);
// the triggers on the left are this extension's own, and it has the most of them — a command
// can seal a window here. `save` covers them all: an explicit action of the student's closed
// the window while they were still writing, which is the one thing the engine reads it for. A
// window must say why it closed, so a trigger missing from the table is sealed as `idle`, the
// word that claims the least — `make check` is what keeps one from going missing.
const WIRE_FLUSH_REASONS = {
    idle: 'idle',           // 2 s without activity: the writer stopped
    volume: 'volume',       // FLUSH_KEYSTROKES reached: the counter stopped, not the writer
    save: 'save',           // the file was saved mid-burst
    submit: 'save',         // handed in from the editor, and the student keeps writing
    rename: 'save',         // the file was renamed: this sensor retires, the writer does not
    manual: 'save',         // "send now", pressed by the student
    blur: 'away',           // the editor window lost focus (departure counted)
    close: 'end',           // the file was closed
    pause: 'end',           // measuring suspended
    logout: 'end',          // the student signed out: the session that measured it is over
    deactivate: 'end',      // VS Code is shutting down
};
const FLIGHT_MAX_MS = 800;          // beyond this, the gap between two keystrokes isn't a flight time
// The shortest silence between two counted keystrokes that is told as a `gap`. Every one of at
// least this long is, at its real length: whether it was a word being looked for, a thought or
// a departure is read by the engine from the duration, and by nobody here.
const GAP_MIN_MS = 1000;
const ACTIVE_GAP_MAX_S = 60;        // beyond this a gap adds nothing to the effective time
// Beyond this, an insertion made in one shot is a block (`paste`, or `self`) rather than
// typing — and the characters of a `paste` are what the session's `sum.chars` adds up.
const INJECTION_MIN_CHARS = 15;
// How many characters taken out in one edit stop being a typo and start being a phrase the writer
// decided against. A mis-hit letter costs one to a few; past this many it is a word or a clause
// coming out, which is a reformulation whatever key did it.
const ERASE_RUN_REFORMULATES = 6;
// How many moves before writing again count as having gone somewhere. One is a caret nudged by a
// character; two or more is a trip back into the text.
const NAV_STEPS_AWAY = 2;
// How long after coming back to the editor an injection still counts as "brought back from
// elsewhere". Leaving, consulting something, coming back and pasting is one gesture; fifteen
// seconds is long enough to find the line again and short enough not to catch an insertion made
// in the middle of a session that happens to follow a departure.
const RETURN_WINDOW_MS = 15 * 1000;
// A move that lands within this delay of an edit is the cursor following what was just typed,
// not the student navigating: VS Code fires a selection change after every keystroke, and
// counting those would make `counts.jumps` track the keystrokes exactly.
const SELECTION_ECHO_MS = 50;

// --- What a window is made of ---
// The most runs one window may hold. A window that would need one more is sealed first, the
// way it is at FLUSH_KEYSTROKES: the engine refuses a longer one outright.
const TIMELINE_MAX_RUNS = 512;
// Lower edges, in milliseconds, of the fourteen bins the flight times are counted in; the last
// one ends at FLIGHT_MAX_MS. The edges are the engine's: a histogram of another shape is refused.
const FLIGHT_BINS_MS = [0, 20, 40, 60, 80, 100, 130, 160, 200, 250, 320, 400, 500, 650];
// How many random bytes name a session: 128 bits, 22 URL-safe characters. Drawn by the host
// each time a sensor starts measuring, derived from nothing — neither the account, nor the
// machine, nor the file.
const SESSION_ID_BYTES = 16;
// The runs made of counted keystrokes: `[kind, n, ms]`, `n` keystrokes from the first to the
// last. Every other run is `[kind, n]`, a gesture with no duration — a block that lands or an
// undo is an instant, and a click or a caret move often falls inside a silence, where a
// duration of its own would tell the same stretch of time twice. A silence is `['gap', ms]`.
// This sensor writes no `nav`: it never sees the key that moved the caret (see `move`).
const KEYSTROKE_RUNS = new Set(['type', 'erase', 'other']);
// The runs that are never merged with the one before: a block is one run per gesture however
// many follow each other, and a silence is one run per silence.
const SINGLE_RUNS = new Set(['paste', 'self', 'gap']);
// How many UTF-16 units two readings of the text are compared by at a time (see spanBetween).
const SCAN_BLOCK = 1024;
// Beyond this many words on either side of a span, what the two sides share is not looked for:
// the comparison grows with the product of the two, and the contract bounds it here.
const TEXT_KEPT_MAX_WORDS = 2000;

// Line breaks are excluded from every count, as they are everywhere else in the product: the
// engine counts a stored document the same way (document.TextCharCount).
const LINE_BREAKS = /[\r\n]/g;

// How many characters a text holds, counted in code points exactly as `[...text].length` does —
// and without the array that spreading one allocates, an element per character. The host calls
// this on the whole file at every window (`volume()` in extension.js), so on a large file the
// allocation is paid in the extension host while the student types. A text holding no high
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

const chars = (text) => codePoints(text.replace(LINE_BREAKS, ''));

// How many values fall in each bin, the bins being given by their lower edges. The order of the
// values is lost on purpose: a distribution says how someone types, never what.
function binOf(value, edges) {
    let bin = edges.length - 1;
    while (bin > 0 && value < edges[bin]) bin--;
    return bin;
}

// Trailing empty bins are not sent: `[0, 2, 9]` stands for `[0, 2, 9, 0, …]`.
function histogram(values, edges) {
    const bins = new Array(edges.length).fill(0);
    for (const value of values) bins[binOf(value, edges)]++;
    let length = bins.length;
    while (length > 0 && bins[length - 1] === 0) length--;
    return bins.slice(0, length);
}

const twoDecimals = (value) => Math.round(value * 100) / 100;

// The words of a stretch of text, each with the spacing that follows it: `[id, chars, space]`
// three by three, `id` standing for the word (the same word, the same number, in `ids`) and the
// two others for lengths counted the way `chars()` counts. Null past `limit` words — the
// reading stops there, so a stretch of any size costs no more than `limit` words to turn down.
function wordsOf(text, ids, limit) {
    const words = [];
    const word = /(\S+)(\s*)/g;
    for (let found = word.exec(text); found; found = word.exec(text)) {
        if (words.length >= limit * 3) return null;
        let id = ids.get(found[1]);
        if (id === undefined) ids.set(found[1], id = ids.size);
        words.push(id, codePoints(found[1]), chars(found[2]));
    }
    return words;
}

/**
 * Of what a span inserted, how many characters were already in what it removed, in the same
 * order: the heaviest sequence of words the two sides share, each word weighing its characters
 * and the spacing that follows it on both sides.
 *
 * A span is a hull — two edits far apart make one span, and everything untouched between them
 * is in `removed` and in `inserted` alike. This is what tells that from a text replaced by
 * another of the same size. Words are compared, never kept: the numbers standing for them live
 * for the length of this call, and what leaves is one length.
 *
 * The cost is the product of the two word counts, hence the bound; null when it is passed.
 */
function keptBetween(removed, inserted) {
    if (!removed || !inserted) return 0;
    const ids = new Map();
    const before = wordsOf(removed, ids, TEXT_KEPT_MAX_WORDS);
    const after = before && wordsOf(inserted, ids, TEXT_KEPT_MAX_WORDS);
    if (!before || !after) return null;
    const columns = after.length / 3;
    let previous = new Uint32Array(columns + 1);
    let current = new Uint32Array(columns + 1);
    for (let i = 0; i < before.length; i += 3) {
        const id = before[i];
        for (let j = 0; j < columns; j++) {
            let best = previous[j + 1] > current[j] ? previous[j + 1] : current[j];
            if (after[j * 3] === id) {
                const together = previous[j] + before[i + 1] + Math.min(before[i + 2], after[j * 3 + 2]);
                if (together > best) best = together;
            }
            current[j + 1] = best;
        }
        [previous, current] = [current, previous];
    }
    return previous[columns];
}

/**
 * How far a text moved between two readings: the longest prefix and the longest suffix they
 * share, and what lies between the two on each side. Lengths, in the unit `chars()` counts in
 * (code points, line breaks left out) — so that the volume of one reading is the volume of the
 * other, less `cut`, plus `add`, exactly. `volume` is that of `after`, already counted.
 *
 * Neither cut may fall inside a surrogate pair: the two halves would then be counted once each
 * and the sum would be one too many.
 */
function spanBetween(before, after, volume) {
    if (before === after) return { at: volume, cut: 0, add: 0, kept: 0 };
    const shortest = Math.min(before.length, after.length);
    // Block by block first, which the runtime compares natively, then unit by unit inside the
    // block where the two part: this runs at every sealed window, on the whole file.
    let head = 0;
    while (head + SCAN_BLOCK <= shortest
        && before.slice(head, head + SCAN_BLOCK) === after.slice(head, head + SCAN_BLOCK)) head += SCAN_BLOCK;
    while (head < shortest && before.charCodeAt(head) === after.charCodeAt(head)) head++;
    if (head > 0) {
        const unit = before.charCodeAt(head - 1);
        if (unit >= 0xd800 && unit <= 0xdbff) head--;
    }
    const room = shortest - head;
    let tail = 0;
    while (tail + SCAN_BLOCK <= room
        && before.slice(before.length - tail - SCAN_BLOCK, before.length - tail)
            === after.slice(after.length - tail - SCAN_BLOCK, after.length - tail)) tail += SCAN_BLOCK;
    while (tail < room
        && before.charCodeAt(before.length - 1 - tail) === after.charCodeAt(after.length - 1 - tail)) tail++;
    if (tail > 0) {
        const unit = after.charCodeAt(after.length - tail);
        if (unit >= 0xdc00 && unit <= 0xdfff) tail--;
    }
    const gone = before.slice(head, before.length - tail);
    const come = after.slice(head, after.length - tail);
    const add = chars(come);
    // Only the shorter of the two shared ends is counted; the other is what is left of the
    // volume. Someone writing at the end of a long file pays for a few characters, not the file.
    const at = head <= tail ? chars(after.slice(0, head)) : volume - add - chars(after.slice(after.length - tail));
    const span = { at, cut: chars(gone), add };
    const kept = keptBetween(gone, come);
    return kept === null ? span : { ...span, kept };
}

function median(values) {
    if (values.length === 0) return 0;
    const sorted = [...values].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

// Median absolute deviation (MAD) of flight times: regularity of the typing rhythm.
function medianAbsoluteDeviation(values) {
    if (values.length < 2) return 0;
    const med = median(values);
    return median(values.map((v) => Math.abs(v - med)));
}

function newMeasure() {
    return {
        // The wall clock at the first activity: what dates the window, and nothing else.
        start: null,
        // The first and the last activity on the monotonic clock: what the window lasts.
        monoStart: null,
        monoLast: null,
        // The runs of gestures, in the order they happened: `{ kind, n, at, end }` for
        // keystrokes, `at` and `end` being the instants of the first and the last of them;
        // `{ kind, n }` for a gesture with no duration; `{ kind: 'gap', ms }` for a silence.
        runs: [],
        activeMs: 0,
        // What the session's sums add up, counted where the runs they come from are written:
        // the keystrokes of the `type`, `erase` and `other` runs, the `paste` runs and their
        // characters. They also say whether the window holds anything worth sealing, and when
        // it is full.
        keystrokes: 0,
        pastes: 0,
        injectedChars: 0,
        // What only the sensor can classify (`counts`).
        corrections: 0,
        reformulations: 0,
        navigation: 0,
        macroRevisions: 0,
        injectedCharsAfterReturn: 0,
        focusLosses: 0,
        keystrokesAfterReturn: 0,
        flights: [],
    };
}

/**
 * One document's measurement. It knows nothing of VS Code: the host translates events into the
 * four calls below, which is what keeps the rules testable without an editor.
 *
 * - `documentId` / `documentName` identify the file for the engine (a workspace-relative path,
 *   never an absolute one: it would carry the student's account name);
 * - `volume()` returns the document's current character count, read by the host at flush time;
 * - `text()` returns the document's current text. It is read when a block arrives in one shot
 *   — it is what tells a duplication of the document from an import into it — and that reading
 *   is searched and dropped within the call. It is read again when a window is sealed, in place
 *   of `volume()` and never in addition to it: that reading is
 *   kept in memory until the next window replaces it, for the one purpose of measuring how far
 *   the text moved in between (see `read`). It is never written anywhere and never sent, and it
 *   is released when the session ends. A host that does not provide `text()` recognises no
 *   duplication and sends the size alone, without a span;
 * - `newSession()` returns a fresh random identifier (SESSION_ID_BYTES bytes, URL-safe), and
 *   `monotonic()` a reading in milliseconds of a clock that never goes back. Both are the
 *   host's, like the timers: this file stays free of any API;
 * - `flushed(item)` receives a finished window, ready for the queue;
 * - `schedule(fn, ms)` / `cancel(id)` are the host's timers, so a test can drive the idle flush.
 */
/** @typedef {{ line: number, character: number }} Caret */

// Whether a keyboard move went one character along the line, or one line up or down — where an
// arrow goes — rather than further. Without both positions nothing can be said, and a nudge is
// the reading that charges nothing.
function isNudge(from, to) {
    if (!from || !to) return true;
    const lines = Math.abs(to.line - from.line);
    return lines === 1 || (lines === 0 && Math.abs(to.character - from.character) === 1);
}

class Sensor {
    constructor({ documentId, documentName, volume, text, flushed, schedule, cancel, newSession, monotonic }) {
        this.documentId = documentId;
        this.documentName = documentName;
        this.volume = volume;
        this.text = text;
        this.flushed = flushed;
        this.schedule = schedule || (() => 0);
        this.cancel = cancel || (() => {});
        this.newSession = newSession || (() => '');
        this.monotonic = monotonic || (() => (typeof performance === 'undefined' ? Date.now() : performance.now()));

        // The session: one stretch of measuring this file, from the first activity after the
        // sensor was created — or after measuring was suspended, signed out of, or shut down —
        // until the next such end. Its windows are numbered from 0 in the order they are
        // sealed, and the sums run over all of them, including the ones that never reach the
        // engine: that is what makes a withheld window visible. Nothing of it is persisted by
        // the sensor.
        /** @type {string | null} */
        this.session = null;
        this.sessionZero = 0;
        this.seq = 0;
        this.sum = { keys: 0, chars: 0, pastes: 0 };
        // The previous reading of the text and the window that carried it: `{ body, seq }`.
        // Kept in memory only, replaced at each sealed window, released with the session.
        /** @type {{ body: string, seq: number } | null} */
        this.reading = null;

        this.measure = newMeasure();
        // The wall instant of the event being handled (see `tick`): it dates a window, and
        // measures nothing.
        this.wall = 0;
        // Two instants, for two rules, both on the monotonic clock like every instant below.
        // The last keystroke-sized change is what a flight time is measured from; the last
        // counted keystroke of any kind — an undo or a block erased at once are keystrokes
        // too — is what a silence is measured from.
        this.lastFlightTime = null;
        this.lastKeystrokeTime = null;
        this.lastActivityTime = null;
        this.lastChangeTime = null;
        // How far the writer has travelled since they last changed the text, settled by the
        // edit that follows (see change()). It replaces a boolean: an erase only needs to know
        // the caret moved at all, but an *insertion* has to tell a real trip back through the
        // text from a one-character nudge, and a boolean cannot. See NAV_STEPS_AWAY.
        this.navSteps = 0;
        // Where the caret was last seen, so that a keyboard move can be measured: the editor
        // says where the caret went, never which key sent it there.
        /** @type {Caret | null} */
        this.caret = null;
        // Characters taken out in an unbroken run of erasing, and whether that run has already
        // been read as a reformulation. Anything that is not an erase ends the run. See
        // ERASE_RUN_REFORMULATES.
        this.eraseRun = 0;
        this.eraseRunReformulated = false;
        // Scope of the selection a keystroke would replace: 'all' for a block (mouse drag,
        // select-all), 'range' for a targeted span (Shift+navigation), null for none.
        this.selectionScope = null;
        // The editor was left (a counted focus loss), then came back: the instant of the return
        // is what tells an injection brought back from elsewhere from one made while writing.
        this.away = false;
        this.lastReturnTime = null;
        this.idleTimer = null;
    }

    // --- 1. CLOCKS ---
    // **Every duration is measured on the monotonic clock**: how long a window, a run and a
    // silence last, the flight times, the effective time, and the delays the rules compare
    // (the echo of a keystroke, the seconds after a return). The wall clock only dates a window
    // (`at`) — set back or forward mid-session, it moves no duration. Each editor event is
    // given by the host with the wall instant it happened at; this notes it and answers the
    // monotonic instant everything below calls `now`.
    tick(wall) {
        this.wall = wall;
        return this.monotonic();
    }

    // --- 1b. WINDOW ---
    // Any activity opens the window if needed, pushes back its end and restarts the idle timer.
    markActivity(now) {
        if (this.session === null) this.startSession(now);
        if (this.measure.start === null) {
            this.measure.start = this.wall;
            this.measure.monoStart = now;
        }
        this.measure.monoLast = now;
        this.cancel(this.idleTimer);
        this.idleTimer = this.schedule(() => this.flush('idle'), IDLE_FLUSH_MS);
    }

    // Effective time: the real gap if <= 2 s, a flat 250 ms if < ACTIVE_GAP_MAX_S, nothing beyond.
    trackActiveTime(now) {
        if (this.lastActivityTime !== null) {
            const gap = now - this.lastActivityTime;
            if (gap <= 2000) this.measure.activeMs += gap;
            else if (gap < ACTIVE_GAP_MAX_S * 1000) this.measure.activeMs += 250;
        }
        this.lastActivityTime = now;
    }

    // What makes a window worth sealing: a keystroke or a block. Moves alone do not.
    hasActivity() {
        return this.measure.keystrokes > 0 || this.measure.pastes > 0;
    }

    // A keystroke-sized change feeds the typing rhythm; a block never does — a completion
    // accepted in one shot would otherwise read as an impossibly fast, impossibly regular typist.
    trackFlight(now) {
        if (this.lastFlightTime !== null) {
            const flight = now - this.lastFlightTime;
            if (flight < FLIGHT_MAX_MS) {
                this.measure.flights.push(flight);
                if (this.measure.flights.length > 500) this.measure.flights.shift();
            }
        }
        this.lastFlightTime = now;
    }

    // `n` counted keystrokes of one `kind` — 'type', 'erase', or 'other' for a keystroke that is
    // neither (an undo, a block of the document's own text put down).
    //
    // Every keystroke passes through here and nowhere else, and that is what holds the window
    // together: the runs the engine adds the keystrokes up from, the session's `sum.keys`, and
    // the silences are all written by this one function. A silence of GAP_MIN_MS or more since
    // the previous counted keystroke is told first, so a `gap` precedes the keystroke that ends
    // it — whatever was clicked or pasted in between, which ends no silence.
    //
    // Whether the keystroke lands in the seconds after coming back to the editor is noted here
    // too. It is the mirror of `back_chars`, and the gesture it catches is leaving the editor,
    // reading something, coming back and **typing** it: a deletion and an undo are keystrokes
    // as well, so `back_keys` stays a subset of the keystrokes.
    countKeystrokes(n, now, kind) {
        if (this.lastKeystrokeTime !== null) {
            const silence = Math.round(now - this.lastKeystrokeTime);
            if (silence >= GAP_MIN_MS) this.gap(silence, now);
        }
        this.lastKeystrokeTime = now;
        this.run(kind, n, now);
        this.measure.keystrokes += n;
        if (this.lastReturnTime !== null && now - this.lastReturnTime < RETURN_WINDOW_MS) {
            this.measure.keystrokesAfterReturn += n;
        }
    }

    // --- 2. RUNS ---
    // `n` more gestures of `kind`, at `now`: they extend the run in progress when it is of the
    // same kind, and open a new one otherwise. A run is only ever closed by a gesture of another
    // kind or by a silence — never by what was typed, so a `type` run says nothing of where the
    // words end.
    run(kind, n, now) {
        const timed = KEYSTROKE_RUNS.has(kind);
        const last = this.measure.runs[this.measure.runs.length - 1];
        if (last && last.kind === kind && !SINGLE_RUNS.has(kind)) {
            last.n += n;
            if (timed) last.end = now;
            return;
        }
        this.makeRoom(now);
        this.measure.runs.push(timed ? { kind, n, at: now, end: now } : { kind, n });
    }

    // A silence of `ms` that ends at `now`, where the keystroke that ends it is counted.
    //
    // It runs from one counted keystroke to the next, so no run of keystrokes overlaps it: the
    // durations of a window never tell the same stretch of time twice. The one silence that
    // began before the window did — the one that preceded its first keystroke — goes to the
    // head of the runs, where the engine reads it apart, even when a click or a block opened
    // the window before the keystroke came.
    gap(ms, now) {
        // Room for two: a silence is never sealed apart from the keystroke that ends it.
        this.makeRoom(now, 2);
        const silence = { kind: 'gap', ms };
        if (now - ms < this.measure.monoStart) this.measure.runs.unshift(silence);
        else this.measure.runs.push(silence);
    }

    // The window holds as many runs as one may: it is sealed where it stands and the gesture
    // opens the next one, exactly as at FLUSH_KEYSTROKES — the counter stopped, not the writer.
    // Sealed even when it holds nothing but caret moves and clicks, which alone would have
    // waited for the next window: its runs are what it carries, and none of them is dropped.
    makeRoom(now, needed = 1) {
        if (this.measure.runs.length + needed <= TIMELINE_MAX_RUNS) return;
        this.flush('volume', true);
        this.markActivity(now);
    }

    // --- 3. SESSION ---
    startSession(now) {
        this.session = this.newSession();
        this.sessionZero = now;
        this.seq = 0;
        this.sum = { keys: 0, chars: 0, pastes: 0 };
        this.reading = null;
        // A silence never crosses a session: it is measured from the last keystroke of this
        // one, so its first window has no silence at its head. The time spent not measuring
        // is not a silence between two keystrokes — nor a flight time.
        this.lastFlightTime = null;
        this.lastKeystrokeTime = null;
    }

    // Measuring stopped: what follows belongs to another session, and the reading of the text
    // kept for the next comparison is released here.
    endSession() {
        this.session = null;
        this.reading = null;
    }

    /**
     * The `text` block of the window being sealed: the size of the document as it stands, and
     * how far it moved since the previous sealed window.
     *
     * One reading, where there has always been one — the host's `getText()` rebuilds the whole
     * file, so the span is computed on the string the size is counted on, never on a second
     * one. That string is then kept, in memory, until the next window replaces it: it is the only
     * text this sensor holds beyond a call, and it leaves neither the process nor the machine.
     *
     * The block is the size alone when there is no fresh pair of readings to compare — the first
     * window of a session, or a host that only hands over a count — and null when nothing could
     * be read at all, in which case the window says nothing of the text rather than a zero.
     */
    read(seq) {
        const text = this.text ? this.text() : null;
        if (typeof text !== 'string') {
            const len = this.volume ? this.volume() : null;
            return Number.isInteger(len) ? { len } : null;
        }
        const len = chars(text);
        const previous = this.reading;
        this.reading = { body: text, seq };
        if (!previous) return { len };
        const { at, cut, add, kept } = spanBetween(previous.body, text, len);
        const block = { len, since: previous.seq, at, cut, add };
        // Optional, and last: absent when the comparison was too large to be made.
        return kept === undefined ? block : { ...block, kept };
    }

    // --- 4. EDITOR EVENTS ---
    /**
     * The document changed. `changes` is VS Code's contentChanges, reduced to what a rule needs:
     * `{ text, rangeLength }` — what was inserted, and how many characters it replaced.
     *
     * `reason` is 'undo', 'redo' or ''. An undo is counted as the correction it is and its
     * changes are *not* replayed: the browser sensor counts Ctrl+Z as one keystroke and one
     * immediate correction without ever seeing what it restored, and counting the restored text
     * here would make one undo weigh a whole paragraph.
     */
    change(changes, reason, wall) {
        const now = this.tick(wall);
        this.markActivity(now);
        this.trackActiveTime(now);
        this.lastChangeTime = now;

        if (reason === 'undo' || reason === 'redo') {
            // One keystroke that neither inserts nor erases a character of its own: 'other'.
            // The undo is then named for what it is; a redo counts the same keystroke here and
            // is not named, the runs having no word for it.
            this.countKeystrokes(1, now, 'other');
            if (reason === 'undo') this.run('undo', 1, now);
            this.measure.corrections++;
            this.selectionScope = null;
            this.navSteps = 0;
            this.endEraseRun();
            this.afterEdit();
            return;
        }

        // Which of the blocks this event brings the document already held, answered once for
        // the whole event: reading the document rebuilds the file as a string, and one gesture
        // can carry a hundred changes.
        const duplicated = this.duplicatesInDocument(changes);

        for (const change of changes) {
            const deleted = change.rangeLength || 0;
            const insertedChars = chars(change.text || '');
            if (deleted === 0 && !change.text) continue;

            // A single change carrying both is a replacement: the deletion below scores what was
            // erased, at the scale of what it spanned.
            if (change.text) {
                if (insertedChars > INJECTION_MIN_CHARS && duplicated.has(change.text)) {
                    // The document's own text, put back into it: a sentence copied and pasted
                    // again, a heading reused, a block moved. It is weighed as the gesture it is
                    // — one keystroke for the block, as a deletion at the scale of a selection
                    // is, and only when it does not replace something the erase below already
                    // scores — and told as a `self` run of its size, never as a `paste`.
                    if (deleted === 0) this.countKeystrokes(1, now, 'other');
                    this.run('self', insertedChars, now);
                } else if (insertedChars > INJECTION_MIN_CHARS) {
                    // One `paste` run per block, written in the branch that adds it to the
                    // session's sums: the engine reads the number of pastes, their characters
                    // and the largest of them from these runs.
                    // The run first: writing it may seal a full window, and the block is
                    // then counted in the window that holds its run.
                    this.run('paste', insertedChars, now);
                    this.measure.pastes++;
                    this.measure.injectedChars += insertedChars;
                    // Brought back from outside: the student left the editor, and what landed
                    // on their return came from wherever they went.
                    if (this.lastReturnTime !== null && now - this.lastReturnTime < RETURN_WINDOW_MS) {
                        this.measure.injectedCharsAfterReturn += insertedChars;
                    }
                } else {
                    // A line break inserts nothing visible and is still a keystroke.
                    this.trackFlight(now);
                    this.countKeystrokes(insertedChars || 1, now, 'type');
                    // Writing again after travelling back through the text is a reformulation
                    // even when nothing was erased first: inserting the word that was missing,
                    // or typing the new wording in front of the old one. Without this, going
                    // back and typing produced jumps and no reformulation at all. An edit that
                    // also deletes is judged by `erase` instead, so replacing a span is never
                    // charged twice.
                    if (deleted === 0 && this.navSteps >= NAV_STEPS_AWAY) this.measure.reformulations++;
                }
                // Whatever was inserted ends the run, and — unless the same change also deletes,
                // in which case `erase` below is what spends it — the trip: writing is writing
                // on the spot again, whether or not it was charged. Reset only when charged, a
                // single nudge survived into the next deletion and turned a typo repaired on the
                // spot into a reformulation. The three other sensors reset here unconditionally.
                this.endEraseRun();
                if (deleted === 0) this.navSteps = 0;
            }

            if (deleted > 0) this.erase(deleted, now);
        }
        this.afterEdit();
    }

    /**
     * Which of the blocks this event inserts were already somewhere in the document?
     *
     * The three other agents answer this by remembering what **leaves** the document — a Ctrl+C,
     * a cut — and matching what comes in against it. VS Code gives neither the clipboard nor the
     * content of what a change replaces, so that road is closed; what it does give is the
     * document itself, and a text the document already held cannot have been imported by the
     * gesture that put it there a second time. The test is exact rather than fingerprinted: a
     * duplication is a copy, and anything a corrector has reworded is no longer a duplication —
     * it stays an injection, which is the conservative side to err on.
     *
     * The whole event is answered at once, and each distinct block only once: one gesture can
     * carry several changes (pasting at five cursors inserts the same text five times), and
     * `text()` rebuilds the entire file as a string every time it is called. Those five
     * occurrences are the paste's own, so they cannot be what excuses it — the document has to
     * hold **one more** than the event brought.
     *
     * The document is read as it stands *after* the change, which is what VS Code delivers, and
     * nothing of it is kept: it is read, searched and dropped inside this call.
     */
    duplicatesInDocument(changes) {
        if (!this.text) return NO_DUPLICATES;
        // Nothing big enough to be an injection — an ordinary keystroke, which is what this runs
        // on — and the document is neither read nor walked.
        let brought = null;
        for (const change of changes) {
            if (chars(change.text || '') <= INJECTION_MIN_CHARS) continue;
            if (!brought) brought = new Map();
            brought.set(change.text, (brought.get(change.text) || 0) + 1);
        }
        if (!brought) return NO_DUPLICATES;
        const body = this.text();
        if (!body) return NO_DUPLICATES;
        const duplicated = new Set();
        for (const [text, count] of brought) {
            let found = 0;
            for (let at = body.indexOf(text); at !== -1; at = body.indexOf(text, at + 1)) {
                if (++found > count) {
                    duplicated.add(text);
                    break;
                }
            }
        }
        return duplicated;
    }

    // A deletion of `deleted` characters, scored by what it spans and by what preceded it.
    erase(deleted, now) {
        const block = this.selectionScope === 'all' || deleted > INJECTION_MIN_CHARS;
        const count = block ? 1 : Math.max(deleted, 1);
        if (count === 1) this.trackFlight(now);
        this.countKeystrokes(count, now, 'erase');

        if (block) {
            this.measure.macroRevisions++;
            this.endEraseRun();
        } else if (this.selectionScope === 'range' || this.navSteps > 0) {
            // A plain click is in here rather than among the mass revisions: clicking into a
            // word three lines up and taking its ending off is a local retouch, and filing it as
            // a restructuring at five times the weight was the single largest reason
            // `counts.reformulations` never moved. A drag arrives as `selectionScope === 'all'`
            // and is still a block.
            //
            // The trip is spent on this one deletion, and so is the run: what follows is being
            // erased on the spot and reads as an immediate correction again.
            this.measure.reformulations++;
            this.endEraseRun();
        } else if (this.extendEraseRun(count)) {
            // **One gesture, one revision.** Taking a word out — Ctrl+Backspace, a line
            // command, or Backspace hammered through it one change at a time — used to arrive as
            // one count *per character*, which is how this counter could be large for a trivial
            // edit and empty for a real one. The run is read once; the rest of it is not counted
            // again.
            this.measure.reformulations++;
        } else if (!this.eraseRunReformulated) {
            this.measure.corrections += count;
        }

        // The move is spent on this deletion: what follows is erased on the spot and counts as
        // immediate corrections. Without this reset, a single click turned a whole burst of
        // deletions into revisions and `counts.corrections` stayed at zero.
        this.selectionScope = null;
        this.navSteps = 0;
    }

    // `count` more characters out of the run. Returns true the one time the run crosses
    // ERASE_RUN_REFORMULATES: that change is read as a reformulation, and the ones after it as
    // nothing. A word taken out in a single change crosses it on its own.
    extendEraseRun(count) {
        this.eraseRun += count;
        if (this.eraseRun < ERASE_RUN_REFORMULATES || this.eraseRunReformulated) return false;
        this.eraseRunReformulated = true;
        return true;
    }

    // Anything that is not an erase ends the run, so the next one is judged on its own length.
    endEraseRun() {
        this.eraseRun = 0;
        this.eraseRunReformulated = false;
    }

    afterEdit() {
        if (this.measure.keystrokes >= FLUSH_KEYSTROKES) this.flush('volume');
    }

    /**
     * The cursor or the selection moved. `kind` is 'keyboard', 'mouse' or 'command' (VS Code's
     * TextEditorSelectionChangeKind), `selected` whether the selection it leaves is non-empty,
     * `caret` where the primary cursor now is.
     *
     * A move that immediately follows an edit is the cursor trailing the text that was just
     * typed, not a navigation: VS Code reports one per keystroke.
     *
     * @param {string} kind
     * @param {boolean} selected
     * @param {number} wall the wall-clock instant of the event
     * @param {Caret | null} [caret]
     */
    move(kind, selected, wall, caret = null) {
        const now = this.tick(wall);
        // The caret is remembered even when the move is not counted: the next keyboard move is
        // measured from wherever the text just left it.
        const from = this.caret;
        if (caret) this.caret = caret;
        if (this.lastChangeTime !== null && now - this.lastChangeTime <= SELECTION_ECHO_MS) return;
        this.markActivity(now);
        this.trackActiveTime(now);

        // A move the mouse made is a click in the document. A move the keyboard made is a
        // `move`, not a `nav`: a `nav` run is made of counted keystrokes, and a caret move is
        // not one here — the editor never delivers the key, only where the caret went. A move a
        // command made (go to definition, find) is neither, and is not written.
        if (kind === 'mouse') this.run('click', 1, now);
        else if (kind === 'keyboard') this.run('move', 1, now);
        // Counted after its run is written, so that a move which seals a full window is a jump
        // of the window that holds it.
        this.measure.navigation++;
        // A click or a command (go to definition, find) is a trip. A keyboard move is a nudge
        // when it went where an arrow goes, and a jump otherwise — Home, End, a page, or an
        // arrow with Ctrl/Alt crossing a word. The editor never says which key moved the caret,
        // only where it went, so the distance is what tells them apart where the browser sensor
        // reads the key.
        this.navSteps += kind === 'keyboard' && isNudge(from, caret) ? 1 : NAV_STEPS_AWAY;
        // Select-all and "select every occurrence" arrive as commands, a drag as a pointer move:
        // both span a block. Shift+arrow is a keyboard move over a targeted span.
        if (!selected) this.selectionScope = null;
        else this.selectionScope = kind === 'keyboard' ? 'range' : 'all';
    }

    // The window lost focus: the student left the editor. Unlike Word, VS Code says so.
    //
    // Leaving takes no timestamp: it is not an activity, so the window still ends at the last
    // real one — the browser sensor closes the same way.
    blur() {
        if (!this.hasActivity()) return;
        this.measure.focusLosses++;
        this.away = true;
        this.flush('blur');
    }

    // Back in the editor after having left it. Nothing is counted here and no window is opened:
    // the return only dates what follows it, and only a departure that was counted opens one.
    focus() {
        if (!this.away) return;
        this.away = false;
        this.lastReturnTime = this.monotonic();
    }

    // --- 5. FLUSH ---
    // Seals the window in progress and hands it over, in the shape it leaves in. `force` seals a
    // window that holds runs but neither a keystroke nor a block (see makeRoom).
    flush(reason, force = false) {
        this.cancel(this.idleTimer);
        this.lastActivityTime = null;
        const why = WIRE_FLUSH_REASONS[reason] || 'idle';
        // Only these triggers mean measuring stopped, and with it the session.
        const ends = why === 'end';
        if (!force && !this.hasActivity()) {
            // Moves alone: their runs and their counts carry over to the next window, but not
            // their time, otherwise the window would swallow the inactivity that follows.
            this.measure.start = null;
            this.measure.monoStart = null;
            this.measure.monoLast = null;
            if (ends) this.endSession();
            return null;
        }
        const done = this.measure;
        this.measure = newMeasure();

        // Numbered and added to the session's sums here, in the one operation that seals the
        // window — not where it is sent: a window that never leaves is still counted, and the
        // next one says so by its rank and by sums the received windows do not reach.
        const seq = this.seq++;
        this.sum.keys += done.keystrokes;
        this.sum.chars += done.injectedChars;
        this.sum.pastes += done.pastes;

        // The key order is the contract's. `at` is the wall clock at the first activity; `mono`
        // is the same instant on the clock that never goes back, counted from the start of the
        // session, and `ms` runs to the last activity on that clock — a second at least, which
        // is what a window of a single instant is sent as.
        const window = {
            seq,
            at: Math.round(done.start),
            mono: Math.round(done.monoStart - this.sessionZero),
            ms: Math.max(Math.round(done.monoLast - done.monoStart), 1000),
            why,
            active: Math.round(done.activeMs),
            runs: done.runs.map((run) => {
                if (run.kind === 'gap') return ['gap', run.ms];
                if (!KEYSTROKE_RUNS.has(run.kind)) return [run.kind, run.n];
                return [run.kind, run.n, Math.max(0, Math.round(run.end - run.at))];
            }),
            counts: {
                corrections: done.corrections,
                reformulations: done.reformulations,
                revisions: done.macroRevisions,
                jumps: done.navigation,
                exits: done.focusLosses,
                back_keys: done.keystrokesAfterReturn,
                back_chars: done.injectedCharsAfterReturn,
            },
        };
        // Without at least two flight times the rhythm isn't measurable: nothing is sent rather
        // than a 0 that would skew the average. No `dwell`: no key is seen, so no release.
        if (done.flights.length >= 2) {
            window.flight = {
                med: twoDecimals(median(done.flights)),
                mad: twoDecimals(medianAbsoluteDeviation(done.flights)),
                bins: histogram(done.flights, FLIGHT_BINS_MS),
            };
        }
        const text = this.read(seq);
        if (text) window.text = text;
        window.sum = { keys: this.sum.keys, chars: this.sum.chars, pastes: this.sum.pastes };

        // What the queue holds: the window as it leaves, the session it belongs to, and the
        // file it measured — which the engine client turns into an address, never into a field.
        const item = {
            documentId: this.documentId,
            documentName: this.documentName,
            session: this.session,
            window,
        };
        if (ends) this.endSession();
        if (this.flushed) this.flushed(item);
        return item;
    }
}

module.exports = {
    Sensor,
    chars,
    median,
    medianAbsoluteDeviation,
    FLUSH_KEYSTROKES,
    IDLE_FLUSH_MS,
    WIRE_FLUSH_REASONS,
    INJECTION_MIN_CHARS,
    SELECTION_ECHO_MS,
    TIMELINE_MAX_RUNS,
    FLIGHT_BINS_MS,
    SESSION_ID_BYTES,
};
