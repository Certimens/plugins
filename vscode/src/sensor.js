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
// - no paste_events: an insertion made in one shot is a paste, a snippet or a completion
//   accepted from IntelliSense or an AI assistant, and VS Code does not say which. The
//   characters still count as an injection (total_injected_chars) — only the *number of pastes*
//   is unmeasurable here, so it is not sent rather than sent wrong.

const FLUSH_KEYSTROKES = 200;       // flush at 200 keystrokes, like every other agent
const IDLE_FLUSH_MS = 2000;         // flush after 2 s of inactivity
const FLIGHT_MAX_MS = 800;          // beyond this, the gap between two keystrokes isn't a flight time
const PAUSE_MIN_S = 3;              // cognitive pause: inactivity between 3 s and PAUSE_MAX_S then resuming
// PAUSE_MAX_S bounds what counts as thinking rather than leaving; ACTIVE_GAP_MAX_S bounds a
// different rule (what a gap adds to effective time). They are two rules, not one: see the
// mesures-redaction skill.
const PAUSE_MAX_S = 300;
const ACTIVE_GAP_MAX_S = 60;        // beyond this a gap adds nothing to the effective time
const INJECTION_MIN_CHARS = 15;     // beyond this, an insertion made in one shot is an injection
// A move that lands within this delay of an edit is the cursor following what was just typed,
// not the student navigating: VS Code fires a selection change after every keystroke, and
// counting those would make navigation_jumps track total_keystrokes exactly.
const SELECTION_ECHO_MS = 50;

// Line breaks are excluded from every count, as they are everywhere else in the product: the
// engine counts a stored document the same way (document.TextCharCount).
const LINE_BREAKS = /[\r\n]/g;

const chars = (text) => [...text.replace(LINE_BREAKS, '')].length;

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
        start: null,
        last: null,
        activeMs: 0,
        keystrokes: 0,
        corrections: 0,
        reformulations: 0,
        navigation: 0,
        macroRevisions: 0,
        pauses: 0,
        injectedChars: 0,
        focusLosses: 0,
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
 * - `flushed(item)` receives a finished window, ready for the queue;
 * - `schedule(fn, ms)` / `cancel(id)` are the host's timers, so a test can drive the idle flush.
 */
class Sensor {
    constructor({ documentId, documentName, volume, flushed, schedule, cancel }) {
        this.documentId = documentId;
        this.documentName = documentName;
        this.volume = volume;
        this.flushed = flushed;
        this.schedule = schedule || (() => 0);
        this.cancel = cancel || (() => {});

        this.measure = newMeasure();
        this.lastKeystrokeTime = 0;
        this.lastEventTime = 0;
        this.lastActivityTime = 0;
        this.lastChangeTime = 0;
        // Where the cursor came from, and what the next deletion would erase. Both are settled by
        // the deletion that follows them (see change()).
        this.isNavigating = false;
        this.cameFromPointer = false;
        // Scope of the selection a keystroke would replace: 'all' for a block (mouse drag,
        // select-all), 'range' for a targeted span (Shift+navigation), null for none.
        this.selectionScope = null;
        this.idleTimer = null;
    }

    // --- 1. WINDOW ---
    // Any activity opens the window if needed, pushes back its end and restarts the idle timer.
    markActivity(now) {
        if (this.measure.start === null) this.measure.start = now;
        this.measure.last = now;
        this.cancel(this.idleTimer);
        this.idleTimer = this.schedule(() => this.flush('idle'), IDLE_FLUSH_MS);
    }

    // Resuming after 3 s to PAUSE_MAX_S of inactivity counts as a cognitive pause.
    trackPause(now) {
        if (this.lastEventTime > 0) {
            const gapS = (now - this.lastEventTime) / 1000;
            if (gapS > PAUSE_MIN_S && gapS <= PAUSE_MAX_S) this.measure.pauses++;
        }
        this.lastEventTime = now;
    }

    // Effective time: the real gap if <= 2 s, a flat 250 ms if < ACTIVE_GAP_MAX_S, nothing beyond.
    trackActiveTime(now) {
        if (this.lastActivityTime > 0) {
            const gap = now - this.lastActivityTime;
            if (gap <= 2000) this.measure.activeMs += gap;
            else if (gap < ACTIVE_GAP_MAX_S * 1000) this.measure.activeMs += 250;
        }
        this.lastActivityTime = now;
    }

    hasActivity() {
        return this.measure.keystrokes > 0 || this.measure.injectedChars > 0;
    }

    // A keystroke-sized change feeds the typing rhythm; an injection never does — a completion
    // accepted in one shot would otherwise read as an impossibly fast, impossibly regular typist.
    trackFlight(now) {
        if (this.lastKeystrokeTime > 0) {
            const flight = now - this.lastKeystrokeTime;
            if (flight < FLIGHT_MAX_MS) {
                this.measure.flights.push(flight);
                if (this.measure.flights.length > 500) this.measure.flights.shift();
            }
        }
        this.lastKeystrokeTime = now;
    }

    // --- 2. EDITOR EVENTS ---
    /**
     * The document changed. `changes` is VS Code's contentChanges, reduced to what a rule needs:
     * `{ text, rangeLength }` — what was inserted, and how many characters it replaced.
     *
     * `reason` is 'undo', 'redo' or ''. An undo is counted as the correction it is and its
     * changes are *not* replayed: the browser sensor counts Ctrl+Z as one keystroke and one
     * immediate correction without ever seeing what it restored, and counting the restored text
     * here would make one undo weigh a whole paragraph.
     */
    change(changes, reason, now) {
        this.markActivity(now);
        this.trackPause(now);
        this.trackActiveTime(now);
        this.lastChangeTime = now;

        if (reason === 'undo' || reason === 'redo') {
            this.measure.keystrokes++;
            this.measure.corrections++;
            this.selectionScope = null;
            this.isNavigating = false;
            this.cameFromPointer = false;
            this.afterEdit();
            return;
        }

        for (const change of changes) {
            const deleted = change.rangeLength || 0;
            const insertedChars = chars(change.text || '');
            if (deleted === 0 && !change.text) continue;

            // A single change carrying both is a replacement: the deletion below scores what was
            // erased, at the scale of what it spanned.
            if (change.text) {
                if (insertedChars > INJECTION_MIN_CHARS) {
                    this.measure.injectedChars += insertedChars;
                } else {
                    // A line break inserts nothing visible and is still a keystroke.
                    this.measure.keystrokes += insertedChars || 1;
                    this.trackFlight(now);
                }
            }

            if (deleted > 0) this.erase(deleted, now);
        }
        this.afterEdit();
    }

    // A deletion of `deleted` characters, scored by what it spans and by what preceded it.
    erase(deleted, now) {
        const block = this.selectionScope === 'all' || deleted > INJECTION_MIN_CHARS;
        const count = block ? 1 : Math.max(deleted, 1);
        this.measure.keystrokes += count;
        if (count === 1) this.trackFlight(now);

        if (block) this.measure.macroRevisions++;
        else if (this.selectionScope === 'range') this.measure.reformulations++;
        else if (this.cameFromPointer) this.measure.macroRevisions++;
        else if (this.isNavigating) this.measure.reformulations += count;
        else this.measure.corrections += count;

        // The move is spent on this deletion: what follows is erased on the spot and counts as
        // immediate corrections. Without this reset, a single click turned a whole burst of
        // deletions into revisions and immediate_corrections stayed at zero.
        this.selectionScope = null;
        this.isNavigating = false;
        this.cameFromPointer = false;
    }

    afterEdit() {
        if (this.measure.keystrokes >= FLUSH_KEYSTROKES) this.flush('volume');
    }

    /**
     * The cursor or the selection moved. `kind` is 'keyboard', 'mouse' or 'command' (VS Code's
     * TextEditorSelectionChangeKind), `selected` whether the selection it leaves is non-empty.
     *
     * A move that immediately follows an edit is the cursor trailing the text that was just
     * typed, not a navigation: VS Code reports one per keystroke.
     */
    move(kind, selected, now) {
        if (now - this.lastChangeTime <= SELECTION_ECHO_MS) return;
        this.markActivity(now);
        this.trackPause(now);
        this.trackActiveTime(now);

        this.measure.navigation++;
        this.isNavigating = true;
        // A pointer move is the one that makes a following deletion a mass revision: the student
        // went somewhere else in the file to rework it.
        this.cameFromPointer = kind === 'mouse';
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
        this.flush('blur');
    }

    // --- 3. FLUSH ---
    flush(reason) {
        this.cancel(this.idleTimer);
        this.lastActivityTime = 0;
        if (!this.hasActivity()) {
            // Moves alone: their counters carry over to the next window, but not their time,
            // otherwise the period would swallow the inactivity that follows.
            this.measure.start = null;
            this.measure.last = null;
            return null;
        }
        const done = this.measure;
        this.measure = newMeasure();

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
            focus_losses: done.focusLosses,
        };
        // Without at least two flight times the rhythm isn't measurable: nothing is sent rather
        // than a 0 that would skew the average.
        if (done.flights.length >= 2) {
            values.mad_ms = Math.round(medianAbsoluteDeviation(done.flights) * 100) / 100;
            values.median_flight_ms = Math.round(median(done.flights) * 100) / 100;
        }
        const volume = this.volume ? this.volume() : null;
        if (volume !== null && volume !== undefined) values.real_volume = volume;

        const item = {
            documentId: this.documentId,
            documentName: this.documentName,
            reason,
            period: { start: new Date(done.start).toISOString(), end: new Date(end).toISOString() },
            values,
        };
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
    INJECTION_MIN_CHARS,
    SELECTION_ECHO_MS,
};
