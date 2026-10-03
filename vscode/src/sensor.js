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
//   characters still count as an injection (injected_chars_total) — only the *number of pastes*
//   is unmeasurable here, so it is not sent rather than sent wrong;
// - no self_paste_events either, for the same reason, but self_paste_chars_total **is** sent:
//   what the editor does give is the document, so an insertion the document already held
//   somewhere else is recognised as a duplication (see duplicatesInDocument). Copying a
//   sentence of one's own and pasting it again is not an import, and counting it as one made
//   the engine accuse a document of never having been typed.

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
// trigger missing from the table sends nothing, which the engine reads as an agent that did not
// say — `make check` is what keeps one from going missing.
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
    deactivate: 'end',      // VS Code is shutting down
};
const FLIGHT_MAX_MS = 800;          // beyond this, the gap between two keystrokes isn't a flight time
const PAUSE_MIN_S = 3;              // cognitive pause: inactivity between 3 s and PAUSE_MAX_S then resuming
// PAUSE_MAX_S bounds what counts as thinking rather than leaving; ACTIVE_GAP_MAX_S bounds a
// different rule (what a gap adds to effective time). They are two rules, not one: see the
// mesures-redaction skill.
const PAUSE_MAX_S = 300;
const ACTIVE_GAP_MAX_S = 60;        // beyond this a gap adds nothing to the effective time
const INJECTION_MIN_CHARS = 15;     // beyond this, an insertion made in one shot is an injection
// How long after coming back to the editor an injection still counts as "brought back from
// elsewhere". Leaving, consulting something, coming back and pasting is one gesture; fifteen
// seconds is long enough to find the line again and short enough not to catch an insertion made
// in the middle of a session that happens to follow a departure.
const RETURN_WINDOW_MS = 15 * 1000;
// A silence of one to three seconds between two keystroke-sized changes: the writer is looking
// for a word. Shorter is a flight time, longer is a cognitive pause — the band between the two
// was measured nowhere, and it is the one thing someone retyping a finished text does not
// produce.
const HESITATION_MIN_MS = 1000;
const HESITATION_MAX_MS = 3000;
// A move that lands within this delay of an edit is the cursor following what was just typed,
// not the student navigating: VS Code fires a selection change after every keystroke, and
// counting those would make navigation_jumps track keystrokes_total exactly.
const SELECTION_ECHO_MS = 50;

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
        selfPasteChars: 0,
        maxInjectedChars: 0,
        injectedCharsAfterReturn: 0,
        focusLosses: 0,
        flights: [],
        hesitations: 0,
        keystrokesAfterReturn: 0,
    };
}

/**
 * One document's measurement. It knows nothing of VS Code: the host translates events into the
 * four calls below, which is what keeps the rules testable without an editor.
 *
 * - `documentId` / `documentName` identify the file for the engine (a workspace-relative path,
 *   never an absolute one: it would carry the student's account name);
 * - `volume()` returns the document's current character count, read by the host at flush time;
 * - `text()` returns the document's current text, read only when a block arrives in one shot —
 *   it is what tells a duplication of the document from an import into it. Nothing is kept: the
 *   text is read, searched and dropped within the call. A host that does not provide it keeps
 *   the previous behaviour, and the agent then sends no restitution volume at all;
 * - `flushed(item)` receives a finished window, ready for the queue;
 * - `schedule(fn, ms)` / `cancel(id)` are the host's timers, so a test can drive the idle flush.
 */
class Sensor {
    constructor({ documentId, documentName, volume, text, flushed, schedule, cancel }) {
        this.documentId = documentId;
        this.documentName = documentName;
        this.volume = volume;
        this.text = text;
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
        // The editor was left (a counted focus loss), then came back: the instant of the return
        // is what tells an injection brought back from elsewhere from one made while writing.
        this.away = false;
        this.lastReturnTime = 0;
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
            } else if (flight >= HESITATION_MIN_MS && flight <= HESITATION_MAX_MS) {
                this.measure.hesitations++;
            }
        }
        this.lastKeystrokeTime = now;
    }

    // A keystroke, and whether it lands in the seconds after coming back to the editor.
    //
    // The mirror of injected_chars_after_return, and the gesture it catches is the one no counter
    // saw until now: leave the editor, read something, come back and **type** it. Pasting after a
    // return was measured; typing after one was the whole second-screen vector, invisible. Every
    // keystroke passes through here — a deletion and an undo are keystrokes too, as they are in
    // the three other agents — so the counter stays a subset of keystrokes_total.
    countKeystrokes(n, now) {
        this.measure.keystrokes += n;
        if (this.lastReturnTime && now - this.lastReturnTime < RETURN_WINDOW_MS) {
            this.measure.keystrokesAfterReturn += n;
        }
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
            this.countKeystrokes(1, now);
            this.measure.corrections++;
            this.selectionScope = null;
            this.isNavigating = false;
            this.cameFromPointer = false;
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
                    // scores — and never as an injection. The *count* of such gestures is not
                    // sent: this agent cannot tell a paste from an accepted completion, and
                    // self_paste_events is what the engine scores as a revision.
                    this.measure.selfPasteChars += insertedChars;
                    if (deleted === 0) this.countKeystrokes(1, now);
                } else if (insertedChars > INJECTION_MIN_CHARS) {
                    this.measure.injectedChars += insertedChars;
                    // The largest single injection, which the total alone hides: twenty
                    // insertions of a hundred characters and one of two thousand give the same
                    // total. Here it is also the size of what was accepted in one gesture.
                    if (insertedChars > this.measure.maxInjectedChars) this.measure.maxInjectedChars = insertedChars;
                    // Brought back from outside: the student left the editor, and what landed
                    // on their return came from wherever they went.
                    if (this.lastReturnTime && now - this.lastReturnTime < RETURN_WINDOW_MS) {
                        this.measure.injectedCharsAfterReturn += insertedChars;
                    }
                } else {
                    // A line break inserts nothing visible and is still a keystroke.
                    this.countKeystrokes(insertedChars || 1, now);
                    this.trackFlight(now);
                }
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
        this.countKeystrokes(count, now);
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
        this.away = true;
        this.flush('blur');
    }

    // Back in the editor after having left it. Nothing is counted here and no window is opened:
    // the return only dates what follows it, and only a departure that was counted opens one.
    focus(now) {
        if (!this.away) return;
        this.away = false;
        this.lastReturnTime = now;
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
            effective_time_ms: done.activeMs,
            keystrokes_total: done.keystrokes,
            injected_chars_total: done.injectedChars,
            immediate_corrections: done.corrections,
            deferred_reformulations: done.reformulations,
            navigation_jumps: done.navigation,
            macro_revisions: done.macroRevisions,
            cognitive_pauses: done.pauses,
            injected_chars_max: done.maxInjectedChars,
            injected_chars_after_return: done.injectedCharsAfterReturn,
            focus_losses: done.focusLosses,
            lexical_hesitations: done.hesitations,
            keystrokes_after_return: done.keystrokesAfterReturn,
        };
        // Without at least two flight times the rhythm isn't measurable: nothing is sent rather
        // than a 0 that would skew the average.
        if (done.flights.length >= 2) {
            values.flight_mad_ms = Math.round(medianAbsoluteDeviation(done.flights) * 100) / 100;
            values.flight_median_ms = Math.round(median(done.flights) * 100) / 100;
        }
        // Only an agent that can recognise a duplication reports the volume of them: a 0 from
        // one that cannot would say "none came back", which is not what it measured.
        if (this.text) values.self_paste_chars_total = done.selfPasteChars;
        const volume = this.volume ? this.volume() : null;
        if (volume !== null && volume !== undefined) values.real_volume_chars = volume;

        const item = {
            documentId: this.documentId,
            documentName: this.documentName,
            reason,
            flush: WIRE_FLUSH_REASONS[reason],
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
    WIRE_FLUSH_REASONS,
    INJECTION_MIN_CHARS,
    SELECTION_ECHO_MS,
};
