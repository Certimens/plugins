// Counting rules of the browser sensor (src/content.js).
//
// The same rules are covered on the Python side by the LibreOffice agent's test_measure.py: the two
// implementations are independent and must agree (see the mesures-redaction skill). What is
// tested here and nowhere else is what only the browser can see — a selection swept with the
// mouse.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { browserGlobals, clock, load, trusted } from './helpers/sandbox.mjs';

const INTERNALS = ['measure', 'onKeyDown', 'onMouseDown', 'onMouseUp', 'onCopy', 'recordInjection', 'rememberOwnText',
    'flush', 'selectionScope', 'shingles', 'codePoints', 'onProbeInput', 'onTopProbeInput', 'editor',
    'onKeyUp', 'textSpan', 'session', 'wireRun'];

// What the engine reads in the runs of a window (docs/moteur.md, "Ce que le moteur déduit du
// déroulé"). The sensor no longer counts any of this: it writes the runs, and these figures —
// how many keystrokes, pastes, injected characters, restitutions, hesitations and pauses — are
// worked out on the other side. The tests read a window the way the engine will, so a rule
// about "a pause" is still asserted as one, on the only thing that now says it.
const KEYSTROKE_KINDS = ['type', 'erase', 'nav', 'other'];

function read(runs) {
    const of = (...kinds) => runs.filter(([kind]) => kinds.includes(kind));
    const total = (list) => list.reduce((sum, [, n]) => sum + n, 0);
    const pastes = of('paste');
    const biggest = Math.max(0, ...pastes.map(([, n]) => n));
    // Spread first: a list made in the sensor's realm is not deep-equal to one made in this.
    const gaps = [...of('gap')].map(([, ms]) => ms);
    return {
        keystrokes: total(of(...KEYSTROKE_KINDS)),
        pasteEvents: pastes.length,
        injectedChars: total(pastes.filter(([, n]) => n > 15)),
        maxInjectedChars: biggest > 15 ? biggest : 0,
        selfPasteEvents: of('self').length,
        selfPasteChars: total(of('self')),
        hesitations: gaps.filter((ms) => ms >= 1000 && ms <= 3000).length,
        pauses: gaps.filter((ms) => ms > 3000 && ms <= 300000).length,
        gaps,
    };
}

// The WOPISrc of Word Online's editing iframe: without it the sensor has no document to
// announce, and stays waiting instead of measuring.
const WOPI = '?WOPISrc=https%3A%2F%2Fexample.sharepoint.com%2F_vti_bin%2Fwopi.ashx%2Ffiles%2FABC';

/**
 * A page, reduced to what the sensor reads of it: the body class and the `generator` tag (which
 * say the platform), the displayed title, and the input areas.
 *
 * `areas` maps a **fragment** of selector to the elements it finds: the sensor queries now the
 * generic rule (`textarea, [contenteditable]…`), now the platform's
 * (`#id_onlinetext_editoreditable`), and a test must be able to tell the two apart.
 */
function fakePage({ bodyClass = '', generator = '', heading = '', areas = {} } = {}) {
    return {
        bodyClass,
        select(selector) {
            if (selector.includes('generator')) return generator ? { content: generator } : null;
            if (selector.includes('h1') || selector.includes('h2')) return heading ? { textContent: heading } : null;
            return null;
        },
        selectAll(selector) {
            for (const [fragment, elements] of Object.entries(areas)) {
                if (selector.includes(fragment)) return elements;
            }
            return [];
        },
    };
}

function sensor({ hostname = 'docs.google.com', href, stored, areas, page, storageRead } = {}) {
    const time = clock();
    // Without a full address, the Word Online sensor still needs its WOPISrc.
    const search = hostname === 'docs.google.com' || href ? undefined : WOPI;
    const { globals, storage, listeners, sent, ask } = browserGlobals(time, { hostname, href, search, stored, storageRead });
    // The input areas of a page, for a site the student added: that is where their text is,
    // and where the volume is read from. `reads` counts the reads: re-reading the document is
    // the most expensive thing the sensor does, and the cap that holds it back is only visible
    // by counting.
    const reads = { areas: 0 };
    if (areas) {
        globals.document.querySelectorAll = (selector) => {
            if (!selector.includes('textarea')) return [];
            reads.areas++;
            return areas;
        };
    }
    // The blur handler defers its work by one turn: without that, focus moving to the input
    // iframe would count as leaving. The test holds that queue.
    const deferred = [];
    globals.setTimeout = (fn) => deferred.push(fn);
    if (page) {
        globals.document.body = { className: page.bodyClass };
        globals.document.querySelector = (selector) => page.select(selector);
        globals.document.querySelectorAll = (selector) => page.selectAll(selector);
    }
    // What the sensor printed. Collected rather than let through: what the debug mode may say
    // is a rule — counters and categories, never the student's text — and a rule nobody reads
    // is a rule that drifts. `console.warn` is left alone, it carries the editor's own alarms.
    const logs = [];
    globals.console = { ...console, log: (...args) => logs.push(args) };
    // The monotonic clock the sensor dates a window on beside the wall clock. It follows the
    // test's clock, from a zero of its own — the page has been open for a while — and `skew`
    // is how far the two have drifted apart: what a student setting their clock back produces.
    const mono = { skew: 0 };
    globals.performance = { now: () => time.now - 1_000_000 + 4321.5 + mono.skew };
    // Where a session id is drawn from. The real generator: what is asserted is its shape.
    globals.crypto = { getRandomValues: (bytes) => webcrypto.getRandomValues(bytes) };
    const internals = load(new URL('../src/content.js', import.meta.url), { globals, expose: INTERNALS });
    const press = (key, modifiers = {}) => {
        internals.onKeyDown({ key, isTrusted: true, repeat: false, ctrlKey: false, metaKey: false, shiftKey: false, ...modifiers });
        time.advance(0.15);
    };
    return {
        time,
        mono,
        press,
        storage,
        sent,
        reads,
        globals,
        logs,
        // The probe's lines, the arguments of each one as console.log received them: the format
        // string first, then the values the browser would substitute into it.
        probed: () => logs.filter((args) => String(args[0]).includes('input probe')),
        // What the browser would do on the next turn: the sensor defers what need not be paid
        // for inside an event handler.
        flushDeferred: () => deferred.splice(0).forEach((fn) => fn()),
        ask,
        internals,
        // The sensor reads its suspended state asynchronously at load: one turn of the microtask
        // queue is what it takes for the answer to arrive.
        settled: () => Promise.resolve(),
        type: (count = 1) => {
            for (let i = 0; i < count; i++) press('a');
        },
        // Ctrl+A, or Cmd+A on a Mac: both reach the sensor by the same path.
        selectAll: ({ meta = false } = {}) => press('a', meta ? { metaKey: true } : { ctrlKey: true }),
        click: (at = { x: 100, y: 100 }) => {
            internals.onMouseDown({ isTrusted: true, clientX: at.x, clientY: at.y });
            internals.onMouseUp({ isTrusted: true, clientX: at.x, clientY: at.y });
            time.advance(0.15);
        },
        drag: (from = { x: 100, y: 100 }, to = { x: 300, y: 180 }) => {
            internals.onMouseDown({ isTrusted: true, clientX: from.x, clientY: from.y });
            internals.onMouseUp({ isTrusted: true, clientX: to.x, clientY: to.y });
            time.advance(0.15);
        },
        paste: (text) => {
            internals.recordInjection(text);
            time.advance(0.15);
        },
        // Ctrl+C in the document: what the sensor keeps of it is a set of hashes.
        copy: (text) => {
            internals.rememberOwnText(text);
            time.advance(0.15);
        },
        // Leaving the document and coming back through the **window's focus**: that is the
        // path of Google Docs, Overleaf and an added site, where the whole page is the
        // document.
        //
        // Every one of these drivers hands the listener a trusted event, because a browser
        // never hands it anything else: the content script now drops what the page dispatched
        // itself, and driving these with no event at all is precisely what let the missing
        // guard ship.
        leaveWindow: () => {
            globals.document.hasFocus = () => false;
            listeners.get('window:blur')(trusted());
            deferred.splice(0).forEach((fn) => fn());   // what the browser would do next turn
            time.advance(1);
        },
        comeBackWindow: ({ seconds = 1 } = {}) => {
            globals.document.hasFocus = () => true;
            listeners.get('window:focus')(trusted());
            time.advance(seconds);
        },
        // Leaving the document and coming back through the page being hidden: that is Word
        // Online's path, where a click in the Microsoft 365 header makes the iframe lose focus
        // without leaving the document.
        leave: () => {
            globals.document.visibilityState = 'hidden';
            listeners.get('visibilitychange')(trusted());
            time.advance(1);
        },
        comeBack: ({ seconds = 1 } = {}) => {
            globals.document.visibilityState = 'visible';
            listeners.get('visibilitychange')(trusted());
            time.advance(seconds);
        },
        // Switching tab, as a browser really does it: **both** signals fire, and the deferred
        // check of the blur path is throttled in the now hidden tab — so the test runs it on
        // the way back, which is when Chrome gets round to it.
        leaveTab: () => {
            globals.document.visibilityState = 'hidden';
            globals.document.hasFocus = () => false;
            listeners.get('visibilitychange')(trusted());
            listeners.get('window:blur')(trusted());
            time.advance(1);
        },
        comeBackTab: ({ seconds = 1 } = {}) => {
            globals.document.visibilityState = 'visible';
            globals.document.hasFocus = () => true;
            listeners.get('visibilitychange')(trusted());
            listeners.get('window:focus')(trusted());
            deferred.splice(0).forEach((fn) => fn());   // the throttled timer, run at last
            time.advance(seconds);
        },
        // What a measured page can do entirely by itself: dispatch an event carrying one of
        // these names on a target it shares with the content script. A constructed event is
        // never trusted, and that flag is the only thing that tells it from the student's own
        // gesture.
        forgeDeparture: () => {
            globals.document.visibilityState = 'hidden';
            globals.document.hasFocus = () => false;
            listeners.get('visibilitychange')({ isTrusted: false });
            listeners.get('window:blur')({ isTrusted: false });
            deferred.splice(0).forEach((fn) => fn());
        },
        forgeReturn: () => {
            globals.document.visibilityState = 'visible';
            globals.document.hasFocus = () => true;
            listeners.get('window:focus')({ isTrusted: false });
        },
        forgeKeystroke: () => listeners.get('keydown')({ isTrusted: false, key: 'a' }),
        // The window in progress: what the sensor counts itself (corrections, revisions,
        // departures…), and, under the names the tests have always used, what the engine will
        // read in its runs (keystrokes, pastes, pauses…) — see `read`.
        get counters() {
            const measure = internals.measure;
            const derived = read(measure.runs.map((run) => internals.wireRun(run)));
            return new Proxy(measure, { get: (target, key) => (key in derived ? derived[key] : target[key]) });
        },
    };
}

test('replacing a selection is a deletion', async (t) => {
    await t.test('typing over a Ctrl+A is a mass revision', () => {
        const s = sensor();
        s.selectAll();
        s.type();
        assert.equal(s.counters.macroRevisions, 1);
        assert.equal(s.counters.reformulations, 0);
    });

    await t.test('typing over a Shift+arrow selection is a reformulation', () => {
        const s = sensor();
        s.press('ArrowRight', { shiftKey: true });
        s.type();
        assert.equal(s.counters.reformulations, 1);
        assert.equal(s.counters.macroRevisions, 0);
    });

    await t.test('pasting over a selection is a revision and an injection', () => {
        const s = sensor();
        s.selectAll();
        s.paste('x'.repeat(500));
        assert.equal(s.counters.macroRevisions, 1);
        assert.equal(s.counters.injectedChars, 500);
    });

    await t.test('erasing a selection is counted at its scale', () => {
        const s = sensor();
        s.selectAll();
        s.press('Backspace');
        assert.equal(s.counters.macroRevisions, 1);
        assert.equal(s.counters.corrections, 0);
    });

    await t.test('a selection is spent only once', () => {
        const s = sensor();
        s.selectAll();
        s.type(3);
        assert.equal(s.counters.macroRevisions, 1);
    });

    await t.test('Shift alone selects nothing (it is also how capitals are typed)', () => {
        const s = sensor();
        s.press('A', { shiftKey: true });
        s.press('B', { shiftKey: true });
        assert.equal(s.counters.macroRevisions, 0);
        assert.equal(s.counters.reformulations, 0);
    });

    await t.test('a modifier key alone does not count', () => {
        // It writes nothing, and the tiny gap it leaves before the letter it modifies would
        // pass for an impossibly fast keystroke — which is exactly what flight_mad_ms and
        // flight_median_ms are there to tell apart. Word and VS Code, which count characters,
        // never see any: the rule is the same in the four agents.
        const s = sensor();
        s.press('Shift');
        s.press('A', { shiftKey: true });
        s.press('Control');
        assert.equal(s.counters.keystrokes, 1);
    });

    await t.test('nor does a dead key: it writes nothing by itself', () => {
        // `^` waits for the `e` it will turn into `ê`. Counting it gave two keystrokes where
        // Word and VS Code, which count characters, count one.
        const s = sensor();
        s.press('Dead');
        s.press('e');
        assert.equal(s.counters.keystrokes, 1);
    });

    await t.test('a keystroke taken by a composition counts, and nothing else is read from it', () => {
        // The accent palette macOS opens on a held letter, or an IME. The arrows walking that
        // palette were counted as navigation jumps — and told the next deletion it was a
        // deferred reformulation, for someone who had never left their line.
        const s = sensor();
        s.press('e');
        s.press('ArrowRight', { isComposing: true });
        s.press('ArrowRight', { isComposing: true });
        s.press('Enter', { isComposing: true });

        assert.equal(s.counters.keystrokes, 4, 'these keys write: they count');
        assert.equal(s.counters.navigation, 0, 'but they are not moves');
    });

    await t.test('and the deletion that follows stays an immediate correction', () => {
        const s = sensor();
        s.press('e');
        s.press('ArrowRight', { isComposing: true });
        s.press('Backspace');

        assert.equal(s.counters.corrections, 1);
        assert.equal(s.counters.reformulations, 0);
    });

    await t.test('a composition does not enter the typing rhythm', () => {
        // Flight times are there to tell a human keystroke from a catch-up; a burst from an IME
        // is neither.
        const s = sensor();
        s.press('a');
        s.press('b');
        const before = s.internals.measure.flights.length;
        s.press('c', { isComposing: true });
        s.press('Process');   // ce que Chrome envoie quand l’IME avale la touche

        assert.equal(s.internals.measure.flights.length, before);
        assert.equal(s.counters.keystrokes, 4);
    });

    await t.test('and that holds for all of them, not just the four one has in mind', () => {
        // `Meta` is Cmd on a Mac and the Windows key elsewhere; `OS` is what old Firefoxes sent
        // for the same one. `Fn` only exists on a laptop keyboard and its event depends on the
        // browser — all the more reason to name it: a key forgotten here would count as a
        // keystroke it never was.
        const s = sensor();
        for (const key of ['Meta', 'OS', 'Alt', 'AltGraph', 'CapsLock', 'Fn', 'FnLock',
            'NumLock', 'ScrollLock', 'Symbol', 'SymbolLock', 'Hyper', 'Super']) {
            s.press(key);
        }
        assert.equal(s.counters.keystrokes, 0);
        assert.equal(s.counters.navigation, 0);
    });

    await t.test('a modifier key does not settle the click preceding it', () => {
        const s = sensor();
        s.click();
        s.press('Shift');
        s.press('Backspace');
        assert.equal(s.counters.reformulations, 1);
        assert.equal(s.counters.corrections, 0);
        assert.equal(s.counters.macroRevisions, 0);
    });

    await t.test('a move without Shift cancels the selection', () => {
        const s = sensor();
        s.selectAll();
        s.press('ArrowRight');
        s.type();
        assert.equal(s.counters.macroRevisions, 0);
    });

    await t.test('a click cancels the selection', () => {
        const s = sensor();
        s.selectAll();
        s.click();
        s.type();
        assert.equal(s.counters.macroRevisions, 0);
    });
});

test('cut and undo settle the selection themselves', async (t) => {
    await t.test('cutting is not charged twice', () => {
        const s = sensor();
        s.selectAll();
        s.press('x', { ctrlKey: true });   // the cut erases the selection
        s.type();                          // and we write in its place
        assert.equal(s.counters.macroRevisions, 1);
    });

    await t.test('cut then paste is a single block move', () => {
        const s = sensor();
        s.selectAll();
        s.press('x', { ctrlKey: true });
        s.paste('x'.repeat(500));
        assert.equal(s.counters.macroRevisions, 1);
    });

    await t.test('undo leaves no selection pending', () => {
        const s = sensor();
        s.selectAll();
        s.press('z', { ctrlKey: true });
        s.type();
        assert.equal(s.counters.macroRevisions, 0);
    });

    await t.test('redo is not undo', () => {
        // Shift is what tells them apart. Cmd/Ctrl+Shift+Z puts back what the student had
        // removed: it is the opposite of a correction, and counting it as one inflated
        // `immediate_corrections` for anyone who hesitates out loud.
        const s = sensor();
        s.press('z', { ctrlKey: true });
        assert.equal(s.counters.corrections, 1, 'undo stays a correction');
        s.press('z', { ctrlKey: true, shiftKey: true });
        assert.equal(s.counters.corrections, 1, 'redo adds none');
    });

    await t.test('and redo settles the selection all the same', () => {
        // It collapses in both cases: left pending, it would be spent a second time by the next
        // keystroke.
        const s = sensor();
        s.selectAll();
        s.press('z', { ctrlKey: true, shiftKey: true });
        s.type();
        assert.equal(s.counters.macroRevisions, 0);
    });

    await t.test('on a Mac it is Cmd and the rules are the same', () => {
        // Cmd arrives as `metaKey`, read everywhere Ctrl is.
        const s = sensor();
        s.selectAll({ meta: true });
        s.press('z', { metaKey: true });
        assert.equal(s.counters.corrections, 1);
        s.press('z', { metaKey: true, shiftKey: true });
        assert.equal(s.counters.corrections, 1);
        s.press('x', { metaKey: true });
        assert.equal(s.counters.macroRevisions, 1, 'Cmd+X cuts like Ctrl+X');
    });

    await t.test('copying keeps the selection', () => {
        const s = sensor();
        s.selectAll();
        s.press('c', { ctrlKey: true });
        s.type();
        assert.equal(s.counters.macroRevisions, 1);
    });
});

test('the mouse', async (t) => {
    await t.test('a selection swept with the mouse weighs like a Ctrl+A', () => {
        const s = sensor();
        s.drag();
        s.type();
        assert.equal(s.counters.macroRevisions, 1);
    });

    await t.test('a motionless click stays a click, not a selection', () => {
        const s = sensor();
        s.click();
        s.type();
        assert.equal(s.counters.macroRevisions, 0);
        assert.equal(s.counters.navigation, 1);
    });

    await t.test('a tremble of a few pixels is not a sweep', () => {
        const s = sensor();
        s.drag({ x: 100, y: 100 }, { x: 102, y: 101 });
        s.type();
        assert.equal(s.counters.macroRevisions, 0);
    });
});

test('a deletion settles the move preceding it', async (t) => {
    // A plain click is a local retouch, not a restructuring: clicking into a word three lines up
    // and taking its ending off is the deferred reformulation the counter is named for. It was
    // the single largest reason that counter never fired — on a mouse-driven editor every
    // deferred edit took the click branch and was filed as a mass revision at five times the
    // weight. Mass revisions are now the block gestures alone (a dragged or Ctrl+A selection
    // replaced, and Ctrl+X), which is what makes that weight defensible.
    await t.test('the first after a click is a reformulation, the next ones immediate', () => {
        const s = sensor();
        s.type(3);
        s.click();
        for (let i = 0; i < 4; i++) s.press('Backspace');
        assert.equal(s.counters.reformulations, 1);
        assert.equal(s.counters.corrections, 3);
        assert.equal(s.counters.macroRevisions, 0);
    });

    // The three shapes the rule used to drop into `immediate_corrections`. None of them touches
    // an arrow before erasing, and that was the only door into the reformulation branch.
    await t.test('a word erased, a long run and an insertion after a trip are reformulations', () => {
        const s = sensor();
        s.type(3);
        s.press('Backspace', { ctrlKey: true });
        s.type(1);
        for (let i = 0; i < 9; i++) s.press('Backspace');
        s.press('ArrowLeft');
        s.press('ArrowLeft');
        s.type(4);
        assert.equal(s.counters.reformulations, 3);
        // Only the erases before the run crossed the threshold; past it the run is one gesture.
        assert.equal(s.counters.corrections, 5);
        assert.equal(s.counters.macroRevisions, 0);
    });

    // The widening must not turn ordinary typing into reformulation: a mis-hit letter repaired
    // on the spot and a caret nudged by one arrow are what immediate corrections are for.
    await t.test('a typo fixed on the spot and a single arrow press are left alone', () => {
        const s = sensor();
        s.type(7);
        s.press('Backspace');
        s.press('Backspace');
        s.type(2);
        s.press('ArrowLeft');
        s.type(1);
        assert.equal(s.counters.corrections, 2);
        assert.equal(s.counters.reformulations, 0);
        assert.equal(s.counters.macroRevisions, 0);
    });

    // Holding the key down repeats it, and a repeat is not a keystroke: a held Backspace is one
    // deletion. But the characters it takes out are a run like any other, and past a word's
    // worth it is a phrase going out — the two sensors that read the text see exactly that.
    await t.test('a key held down is one deletion, and the phrase it takes out one reformulation', () => {
        const s = sensor();
        s.type(3);
        s.press('Backspace');
        for (let i = 0; i < 8; i++) s.press('Backspace', { repeat: true });
        assert.equal(s.counters.keystrokes, 4);
        assert.equal(s.counters.corrections, 1);
        assert.equal(s.counters.reformulations, 1);
    });

    // An arrow is a nudge; Home, a page, or an arrow with Ctrl/Cmd/Option crosses a word or a
    // line in one press, and writing after one of those is writing somewhere else.
    await t.test('a jump is a trip on its own, an arrow is not', () => {
        for (const [key, modifiers] of [['Home', {}], ['PageDown', {}], ['ArrowLeft', { ctrlKey: true }], ['ArrowLeft', { altKey: true }]]) {
            const s = sensor();
            s.type(3);
            s.press(key, modifiers);
            s.type(1);
            assert.equal(s.counters.reformulations, 1, key);
        }
        const s = sensor();
        s.type(3);
        s.press('ArrowUp');
        s.type(1);
        assert.equal(s.counters.reformulations, 0);
    });

    await t.test('the first after an arrow is a deferred reformulation', () => {
        const s = sensor();
        s.type(3);
        s.press('ArrowLeft');
        s.press('Backspace');
        s.press('Backspace');
        assert.equal(s.counters.reformulations, 1);
        assert.equal(s.counters.corrections, 1);
    });
});

// The sensor writes every silence of a second or more between two keystrokes, at its real
// length, and classifies none: what follows is what the engine reads in those lengths.
test('a silence is written at its length, and the engine reads a pause in it', async (t) => {
    await t.test('a two-minute interruption is a pause', () => {
        const s = sensor();
        s.type();
        s.time.advance(120);
        s.type();
        assert.equal(s.counters.pauses, 1);
    });

    await t.test('past the cap, the student has left the document', () => {
        const s = sensor();
        s.type();
        s.time.advance(360);
        s.type();
        assert.equal(s.counters.pauses, 0);
        // It is still written, uncapped: the sensor does not decide what a silence was.
        assert.deepEqual(s.counters.gaps, [360150]);
    });

    await t.test('a silence under a second is typing flow: nothing is written', () => {
        const s = sensor();
        s.type();
        s.time.advance(0.8);
        s.type();
        assert.deepEqual(s.counters.gaps, []);
    });

    await t.test('from one second on it is written, to the millisecond', () => {
        const s = sensor();
        s.type();
        s.time.advance(0.85);       // 1000 ms since the keystroke, with the 150 ms `press` takes
        s.type();
        assert.deepEqual(s.counters.gaps, [1000]);
    });

    await t.test('effective time keeps its own 60 s cap', () => {
        const s = sensor();
        s.type();
        const before = s.counters.activeMs;
        s.time.advance(120);
        s.type();
        assert.equal(s.counters.pauses, 1);
        assert.equal(s.counters.activeMs, before, 'a long silence is not credited as typing time');
    });
});

// A silence is what lies between two counted keystrokes. A click, a paste, a spelling chosen in
// the corrector and the paste shortcut all end a stretch of inactivity without counting a
// keystroke: none of them writes a silence, and none restarts one.
test('a silence lies between two keystrokes', async (t) => {
    await t.test('a silence ended by anything but a keystroke is not one', () => {
        const s = sensor();
        s.type();
        s.time.advance(10);
        s.click();
        s.time.advance(10);
        s.paste('x'.repeat(500));
        s.time.advance(10);
        s.press('v', { ctrlKey: true });
        assert.deepEqual(s.counters.gaps, []);
        assert.equal(s.counters.keystrokes, 1);
    });

    await t.test('a window holding only a paste reports no pause', () => {
        // The window the engine was sent: typing closed 2 s after it stopped, so the paste that
        // came after a silence opened one with no keystroke in it — and one pause.
        const s = sensor();
        s.type();
        s.internals.flush('idle');
        s.time.advance(10);
        s.press('v', { ctrlKey: true });
        s.paste('x'.repeat(500));
        assert.equal(s.counters.keystrokes, 0);
        assert.deepEqual(s.counters.gaps, []);
    });

    await t.test('the silence spent clicking is still one pause when typing resumes', () => {
        const s = sensor();
        s.type();
        s.time.advance(10);
        s.click();
        s.time.advance(10);
        s.click();
        s.time.advance(10);
        s.type();
        assert.equal(s.counters.pauses, 1, 'one thought, not three');
        assert.deepEqual(s.counters.gaps, [30450], 'and one silence, from keystroke to keystroke');
    });
});

test('measuring while paused', async (t) => {
    await t.test('counts nothing when it is already paused at load', async () => {
        // A document opened during a pause must start suspended, not measure until it is told.
        const s = sensor({ stored: { paused: true } });
        await s.settled();
        s.type(5);
        s.click();
        s.paste('a text pasted during the pause');
        assert.equal(s.counters.keystrokes, 0);
        assert.equal(s.counters.injectedChars, 0);
        assert.equal(s.counters.navigation, 0);
    });

    await t.test('empties the current window at the moment it is paused', async () => {
        const s = sensor();
        await s.settled();
        s.type(3);
        assert.equal(s.counters.keystrokes, 3);
        s.storage.change({ paused: true });
        // The window has gone: what was measured already belongs to the engine, and nothing
        // piles up behind a paused sensor.
        assert.equal(s.counters.keystrokes, 0);
        s.type(5);
        assert.equal(s.counters.keystrokes, 0);
    });

    await t.test('counts again as soon as it resumes', async () => {
        const s = sensor({ stored: { paused: true } });
        await s.settled();
        s.type(2);
        s.storage.change({ paused: false });
        s.type(4);
        assert.equal(s.counters.keystrokes, 4);
    });
});

// Measurement belongs to a session. Signing out revokes the token at the engine, and what the
// student writes afterwards is nobody's to send: the queue would keep it for whichever account
// pairs next, which is what used to happen — the first student's windows left under the second
// student's bearer, towards the first student's document, with neither of them told.
test('nothing is measured outside a session', async (t) => {
    await t.test('a page loaded with nobody signed in counts nothing', async () => {
        const s = sensor({ stored: { signedIn: false } });
        await s.settled();
        s.type(5);
        assert.equal(s.counters.keystrokes, 0);
    });

    await t.test('signing out empties the window and stops the counting', async () => {
        const s = sensor();
        await s.settled();
        s.type(3);
        assert.equal(s.counters.keystrokes, 3);
        s.storage.change({ signedIn: false });
        assert.equal(s.counters.keystrokes, 0);
        s.type(5);
        assert.equal(s.counters.keystrokes, 0);
    });

    await t.test('leaving the document is not counted either', async () => {
        const s = sensor({ stored: { signedIn: false } });
        await s.settled();
        s.leaveTab();
        s.comeBackTab();
        assert.equal(s.counters.focusLosses, 0);
    });

    await t.test('pairing again starts the counting', async () => {
        const s = sensor({ stored: { signedIn: false } });
        await s.settled();
        s.type(2);
        s.storage.change({ signedIn: true });
        s.type(4);
        assert.equal(s.counters.keystrokes, 4);
    });
});

// Both flags are read from storage, and the read is a round trip to the browser process while
// every listener is already live. Starting at "measuring" meant a page opened during a
// suspension measured until the answer came back, and kept what it had counted: the correcting
// path assigns and never seals the window. Starting closed is what makes the window empty.
test('the sensor starts closed and opens on the stored value', async (t) => {
    // A storage double whose read never answers — a browser that is slow, or an extension
    // reloaded under the page's feet.
    const silent = () => ({ then: () => {} });

    await t.test('nothing is counted before the read has answered', () => {
        const s = sensor({ storageRead: silent });
        s.type(5);
        s.leaveTab();
        assert.equal(s.counters.keystrokes, 0);
        assert.equal(s.counters.focusLosses, 0);
    });

    await t.test('a read that fails leaves the sensor quiet, not measuring', () => {
        const s = sensor({ storageRead: () => ({ then: (_ok, onError) => onError(new Error('no')) }) });
        s.type(5);
        assert.equal(s.counters.keystrokes, 0);
    });
});

// A student's paragraph, and what a spell-checker gives back: the same words, a few of them
// fixed. Written out rather than generated, so that what the rule is tested against is readable.
const WRITTEN = `La mesure de la rédaction repose sur des compteurs et jamais sur le texte lui même.
Chaque fenêtre de mesure part vers le moteur avec sa période et ses valeurs.
L'étudiant garde son texte sur son poste, ce qui est la promesse du produit.
Aucune touche n'est enregistrée et aucun caractère ne quitte l'ordinateur de l'étudiant.
Les quatre agents partagent la même définition des mesures et chacun l'implémente seul.`;

// Scribens fixes "lui même" → "lui-même", an accent and two agreements: four words out of
// seventy-six.
const CORRECTED = `La mesure de la rédaction repose sur des compteurs et jamais sur le texte lui-même.
Chaque fenêtre de mesure part vers le moteur avec sa période et ses valeurs.
L'étudiant garde son texte sur son poste, ce qui est la promesse du produit.
Aucune touche n'est enregistrée et aucun caractère ne quitte l'ordinateur de l'étudiant.
Les quatre agents partagent la même définition des mesures et chacun l'implémente seul.`;

const FOREIGN = `L'intelligence artificielle transforme radicalement les méthodes de travail
contemporaines dans presque tous les secteurs économiques connus, et cette évolution rapide
soulève des questions inédites pour les établissements d'enseignement supérieur français.`;

test('text run through a corrector is not an injection', async (t) => {
    await t.test('copied then pasted back corrected: a revision, not a paste', () => {
        const s = sensor();
        s.copy(WRITTEN);
        s.paste(CORRECTED);
        assert.equal(s.counters.pasteEvents, 0, 'this is not a paste of foreign text');
        assert.equal(s.counters.injectedChars, 0, 'one\'s own words are not an injection');
        assert.equal(s.counters.macroRevisions, 1, 'it is a mass revision');
        assert.equal(s.counters.keystrokes, 1, 'the replaced block counts as one keystroke');
    });

    await t.test('over a selection, the revision is counted only once', () => {
        const s = sensor();
        s.copy(WRITTEN);
        s.selectAll();
        s.paste(CORRECTED);
        assert.equal(s.counters.macroRevisions, 1);
        assert.equal(s.counters.injectedChars, 0);
    });

    await t.test('foreign text stays an injection, even after copying one\'s own', () => {
        const s = sensor();
        s.copy(WRITTEN);
        s.paste(FOREIGN);
        assert.equal(s.counters.pasteEvents, 1);
        assert.equal(s.counters.injectedChars, [...FOREIGN.replace(/[\r\n]/g, '')].length);
        assert.equal(s.counters.macroRevisions, 0);
    });

    await t.test('with nothing copied, a paste is an injection', () => {
        const s = sensor();
        s.paste(CORRECTED);
        assert.equal(s.counters.pasteEvents, 1);
        assert.ok(s.counters.injectedChars > 0);
    });

    await t.test('past the hour, the copied text is no longer recognised', () => {
        const s = sensor();
        s.copy(WRITTEN);
        s.time.advance(3601);
        s.paste(CORRECTED);
        assert.equal(s.counters.pasteEvents, 1, 'the round trip no longer looks like one');
        assert.ok(s.counters.injectedChars > 0);
    });

    await t.test('pasted back several times, one\'s own text never becomes a paste', () => {
        const s = sensor();
        s.copy(WRITTEN);
        s.paste(CORRECTED);
        s.time.advance(500);
        s.paste(CORRECTED);
        s.time.advance(500);
        s.paste(CORRECTED);
        assert.equal(s.counters.pasteEvents, 0, 'the same block, pasted three times, stays theirs');
        assert.equal(s.counters.injectedChars, 0);
        assert.equal(s.counters.macroRevisions, 1, 'it was revised once: the rest is duplication');
        assert.equal(s.counters.keystrokes, 3, 'each paste counts as one keystroke');
    });

    await t.test('the hour runs from the last paste, not from the copy', () => {
        const s = sensor();
        s.copy(WRITTEN);
        s.time.advance(2000);
        s.paste(CORRECTED);
        s.time.advance(2000);       // more than an hour after the copy, 2000 s after the paste
        s.paste(CORRECTED);
        assert.equal(s.counters.pasteEvents, 0, 'what is still in use stays comparable');
    });

    await t.test('what is pasted back survives the memory filling up', () => {
        // The memory holds SELF_PASTE_MAX_COPIES exits (docs/mesures.md); the number is written
        // here rather than read from the shipped code, like the generations in the worker's
        // suite. Filling it is the whole point: below the bound nothing is ever forgotten, and
        // the test would pass without telling which copy goes.
        const MAX_COPIES = 20;
        const s = sensor();
        s.copy(WRITTEN);
        for (let i = 0; i < MAX_COPIES - 1; i++) {
            s.copy(`block ${i} with nothing to do with what the student writes`);
        }
        s.paste(CORRECTED);         // the block becomes the most recently seen again
        s.copy('one block too many, with nothing to do with what the student writes');
        s.paste(CORRECTED);
        assert.equal(s.counters.pasteEvents, 0, 'the least recently seen copy is the one forgotten');
    });

    await t.test('moving one\'s text by drag and drop is not an injection', () => {
        const s = sensor();
        s.copy(WRITTEN);        // what the browser signals at the start of the drag
        s.paste(WRITTEN);       // the drop, seen as a paste
        assert.equal(s.counters.injectedChars, 0);
        assert.equal(s.counters.pasteEvents, 0);
    });

    await t.test('moving a couple of words is not an injection either', () => {
        // The four-word floor used to drop short copies, and a phrase moved from one sentence
        // to another came back as someone else's text.
        const s = sensor();
        s.copy('developpement durable');
        s.paste('developpement durable');
        assert.equal(s.counters.pasteEvents, 0);
        assert.equal(s.counters.injectedChars, 0);
        assert.equal(s.counters.selfPasteEvents, 1);
    });

    await t.test('a short copy cannot excuse a long paste', () => {
        // The fingerprint of a text shorter than a shingle only ever matches a text just as
        // short: copying three words of one's own does not launder a dissertation.
        const s = sensor();
        s.copy('trois mots seulement');
        s.paste(CORRECTED);
        assert.equal(s.counters.pasteEvents, 1);
    });
});

test('the biggest paste, and what arrives after a return', async (t) => {
    await t.test('one run per paste: the biggest stays readable, whatever came last', () => {
        // Twenty pastes of a hundred characters and a single one of two thousand give the same
        // total: a run per gesture is what says something arrived in one block.
        const s = sensor();
        s.paste('x'.repeat(100));
        s.paste('y'.repeat(2000));
        s.paste('z'.repeat(40));
        assert.equal(s.counters.injectedChars, 2140);
        assert.equal(s.counters.maxInjectedChars, 2000);
    });

    await t.test('a paste that is too short enters it no more than the total', () => {
        const s = sensor();
        s.paste('trois mots ici');
        assert.equal(s.counters.injectedChars, 0);
        assert.equal(s.counters.maxInjectedChars, 0);
    });

    await t.test('what is pasted right after a return is counted apart', () => {
        // Leaving, going to look something up, coming back and pasting is a single gesture.
        const s = sensor({ hostname: 'word-edit.officeapps.live.com' });
        s.type(3);
        s.leave();
        s.comeBack();
        s.paste('w'.repeat(800));
        assert.equal(s.counters.injectedChars, 800);
        assert.equal(s.counters.injectedCharsAfterReturn, 800, 'a strict subset of the total');
    });

    await t.test('past the delay, a paste becomes a paste like any other', () => {
        const s = sensor({ hostname: 'word-edit.officeapps.live.com' });
        s.type(3);
        s.leave();
        s.comeBack({ seconds: 20 });   // past RETURN_WINDOW_MS
        s.paste('w'.repeat(800));
        assert.equal(s.counters.injectedChars, 800);
        assert.equal(s.counters.injectedCharsAfterReturn, 0);
    });

    await t.test('without having left, there is no return', () => {
        // A focus change inside the page is not leaving the document, and must therefore not
        // date what follows.
        const s = sensor({ hostname: 'word-edit.officeapps.live.com' });
        s.type(3);
        s.comeBack();
        s.paste('w'.repeat(800));
        assert.equal(s.counters.injectedCharsAfterReturn, 0);
    });

    await t.test('a restitution is counted for itself', () => {
        // Without this counter, the engine sees a mass revision without being able to tell
        // whether the student rewrote their paragraph by hand or ran it through a corrector.
        const s = sensor();
        const text = 'le capteur observe la manière dont le texte est écrit, pas le texte';
        s.copy(text);
        s.paste(text);
        assert.equal(s.counters.selfPasteEvents, 1);
        assert.equal(s.counters.pasteEvents, 0);
        assert.equal(s.counters.injectedChars, 0);
    });

    await t.test('a foreign text is not', () => {
        const s = sensor();
        s.copy('le capteur observe la manière dont le texte est écrit, pas le texte');
        s.paste('une réponse entièrement rédigée ailleurs, qui ne reprend rien de ce qui précède');
        assert.equal(s.counters.selfPasteEvents, 0);
        assert.equal(s.counters.pasteEvents, 1);
    });
});

test('Overleaf', async (t) => {
    // A third editor: one entry in `EDITORS`, and nothing else anywhere. What this test holds
    // is that the common rules count there as everywhere — and that what Overleaf does not
    // allow to be measured is not sent wrong.
    const overleaf = () => sensor({
        hostname: 'www.overleaf.com',
        href: 'https://www.overleaf.com/project/5f2b1c0a9d4e7b3a1c0a9d4e',
    });

    await t.test('the window goes out, without a volume rather than with a wrong one', async () => {
        // CodeMirror only renders the visible lines: counting the DOM's characters would give a
        // fraction of the document, moving with the scrollbar. The Overleaf entry therefore
        // returns `null`, and the window goes without a `text` block — the engine tells
        // absence from zero.
        const s = overleaf();
        s.type(5);
        assert.equal(s.counters.keystrokes, 5, 'the sensor does measure this page');

        await s.internals.flush('test');

        assert.equal(s.counters.keystrokes, 0, 'the window was emptied without error');
    });

    await t.test('the counting rules there are those of the other editors', () => {
        const s = overleaf();
        s.selectAll();
        s.paste('x'.repeat(500));
        assert.equal(s.counters.macroRevisions, 1);
        assert.equal(s.counters.injectedChars, 500);
        assert.equal(s.counters.maxInjectedChars, 500);
    });

    await t.test('a deletion after a click is a deferred reformulation', () => {
        const s = overleaf();
        s.type(3);
        s.click();
        s.press('Backspace');
        assert.equal(s.counters.reformulations, 1);
        assert.equal(s.counters.macroRevisions, 0);
    });
});

test('a site the student added', async (t) => {
    // No manifest can name every institution's Moodle: the student adds the address, the
    // browser asks them for permission, and the service worker registers the script. On the
    // sensor's side, it is a fourth entry of `EDITORS`, and nothing else.
    const moodle = (areas) => sensor({
        hostname: 'moodle.mon-etablissement.fr',
        href: 'https://moodle.mon-etablissement.fr/mod/assign/view.php?id=42',
        areas,
    });

    await t.test('the document is the page, identified down to its assignment', async () => {
        const s = moodle();
        s.type(4);
        await s.internals.flush('test');
        const window_ = s.sent.find((message) => message.type === 'CERTIMENS_METRICS');
        // The id stays local (it only serves to find the engine's document again); without the
        // query string, two assignments of the same Moodle would be the same document.
        assert.equal(window_.documentId, 'site:moodle.mon-etablissement.fr/mod/assign/view.php?id=42');
    });

    await t.test('the volume is read from the longest input area', async () => {
        // A page carries several — a search, a comment — and the assignment is the long one.
        // Nothing is virtualised here, unlike Overleaf: the text is in the field.
        const s = moodle([{ value: 'une recherche' }, { value: 'x'.repeat(2000) }]);
        s.type(4);
        await s.internals.flush('test');
        const window_ = s.sent.find((message) => message.type === 'CERTIMENS_METRICS');
        assert.equal(window_.window.text.len, 2000);
    });

    await t.test('a page with no input area does not send a volume of zero', async () => {
        // The engine tells a missing measurement from the value zero: a zero would read as an
        // empty document.
        const s = moodle([]);
        s.type(4);
        await s.internals.flush('test');
        const window_ = s.sent.find((message) => message.type === 'CERTIMENS_METRICS');
        assert.equal('text' in window_.window, false);
    });

    await t.test('the counting rules there are those of the other editors', () => {
        const s = moodle();
        s.type(3);
        s.click();
        s.press('Backspace');
        assert.equal(s.counters.reformulations, 1);
        assert.equal(s.counters.macroRevisions, 0);
    });
});

test('how each editor hands the copy in', async (t) => {
    // Four editors, four ways of handing the document in, and it is the `EDITORS` entry that
    // says so — not a chain of `if`s in the popup. An editor added without its hand-in mode
    // would silently fall back on another's.
    const announced = (options) => sensor(options).ask({ type: 'CERTIMENS_ACTIVE_DOC' });

    await t.test('Google Docs exports the document itself', () => {
        assert.equal(announced().deposit, 'export');
    });

    await t.test('Word Online has a downloaded copy picked', () => {
        // The editing iframe has no access to the file: the WOPI token is not exposed there.
        assert.equal(announced({ hostname: 'word-edit.officeapps.live.com' }).deposit, 'pick');
    });

    await t.test('Overleaf too', () => {
        // The sources are not reachable from the page.
        assert.equal(announced({
            hostname: 'www.overleaf.com',
            href: 'https://www.overleaf.com/project/5f2b1c0a9d4e7b3a1c0a9d4e',
        }).deposit, 'pick');
    });

    await t.test('an added site sends the page\'s text', () => {
        // On a Moodle "online text" assignment there is no file to pick: the copy is in the
        // page.
        assert.equal(announced({
            hostname: 'moodle.mon-etablissement.fr',
            href: 'https://moodle.mon-etablissement.fr/mod/assign/view.php?id=42',
        }).deposit, 'text');
    });

    await t.test('and that mode alone hands over the page\'s text', () => {
        // The promise is that nothing leaves the machine without a gesture; here it is also the
        // only editor the question makes sense for.
        const docs = sensor();
        assert.equal(docs.ask({ type: 'CERTIMENS_PAGE_TEXT' }).text, null);

        const moodle = sensor({
            hostname: 'moodle.mon-etablissement.fr',
            href: 'https://moodle.mon-etablissement.fr/mod/assign/view.php?id=42',
            page: fakePage({ areas: { textarea: [{ value: 'ma dissertation' }] } }),
        });
        assert.equal(moodle.ask({ type: 'CERTIMENS_PAGE_TEXT' }).text, 'ma dissertation');
    });
});

test('recognising the platform of an added site', async (t) => {
    // A fingerprint goes stale: all it does is **refine**. A page nobody recognises keeps the
    // generic behaviour, and the sensor works there exactly the same.
    const onPage = (page) => sensor({
        hostname: 'moodle.mon-etablissement.fr',
        href: 'https://moodle.mon-etablissement.fr/mod/assign/view.php?id=42',
        page,
    });

    await t.test('Moodle is recognised by the route it writes in the page body', () => {
        const s = onPage(fakePage({ bodyClass: 'path-mod-assign limitedwidth', heading: 'Dissertation : le consentement' }));
        const doc = s.ask({ type: 'CERTIMENS_ACTIVE_DOC' });
        assert.equal(doc.platform, 'Moodle');
        // The assignment's title, and not "Devoir : … | Mon établissement".
        assert.equal(doc.name, 'Dissertation : le consentement');
    });

    await t.test('or by the tag it leaves in the header', () => {
        const s = onPage(fakePage({ generator: 'Moodle 4.4' }));
        assert.equal(s.ask({ type: 'CERTIMENS_ACTIVE_DOC' }).platform, 'Moodle');
    });

    await t.test('Canvas too', () => {
        const s = onPage(fakePage({ bodyClass: 'context-course ic-app', heading: 'Essai final' }));
        assert.equal(s.ask({ type: 'CERTIMENS_ACTIVE_DOC' }).platform, 'Canvas');
    });

    await t.test('the assignment field wins over the longest area of the page', () => {
        // A long forum message further down the page would beat the copy itself.
        const s = onPage(fakePage({
            bodyClass: 'path-mod-assign',
            areas: {
                onlinetext: [{ innerText: 'ma copie' }],
                textarea: [{ value: 'x'.repeat(5000) }],
            },
        }));
        assert.equal(s.ask({ type: 'CERTIMENS_PAGE_TEXT' }).text, 'ma copie');
    });

    await t.test('a page nobody recognises keeps the generic rule', () => {
        const s = onPage(fakePage({ areas: { textarea: [{ value: 'court' }, { value: 'le plus long des deux' }] } }));
        const doc = s.ask({ type: 'CERTIMENS_ACTIVE_DOC' });
        assert.equal(doc.platform, null);
        assert.equal(s.ask({ type: 'CERTIMENS_PAGE_TEXT' }).text, 'le plus long des deux');
    });
});

test('a departure is counted once, and every round trip counts', async (t) => {
    // Switching tab fires `visibilitychange` **and** `blur`. The blur path cannot decide on the
    // spot — it has to let the browser settle before asking `document.hasFocus()` — and a hidden
    // tab does not get that turn for up to a second, because timers are throttled there. A
    // student who came straight back is focused again by then, so the deferred check bailed out
    // and nothing at all was counted: that is why the engine showed no departure for anybody
    // working in two tabs.
    await t.test('a tab switch counts one departure, not two', () => {
        const s = sensor();
        s.leaveTab();
        s.comeBackTab();
        assert.equal(s.counters.focusLosses, 1);
    });

    await t.test('two round trips count two', () => {
        // `awayFrom` guards against the two signals of one departure, not against the next
        // departure: coming back clears it.
        const s = sensor();
        s.leaveTab();
        s.comeBackTab();
        s.leaveTab();
        s.comeBackTab();
        assert.equal(s.counters.focusLosses, 2);
    });

    await t.test('and the return still dates what is pasted', () => {
        const s = sensor();
        s.type(3);
        s.leaveTab();
        s.comeBackTab();
        s.paste('w'.repeat(800));
        assert.equal(s.counters.injectedCharsAfterReturn, 800);
    });

    await t.test('Word Online: the hidden page counts, the lost focus alone does not', () => {
        // A click in the Microsoft 365 header blurs the editing iframe without leaving.
        const s = sensor({ hostname: 'word-edit.officeapps.live.com' });
        s.leaveWindow();
        assert.equal(s.counters.focusLosses, 0);
        s.leaveTab();
        s.comeBackTab();
        assert.equal(s.counters.focusLosses, 1);
    });
});

test('the return to the document has two paths, and both date what follows', async (t) => {
    // `blurMeansLeaving` splits the four editors in two: where the whole page is the document
    // (Google Docs, Overleaf, an added site), the window's focus is what says the departure; in
    // Word Online's iframe, it is the page being hidden. The hiding path is covered above; this
    // one is the other half.
    await t.test('Google Docs: leave through the window, come back, paste', () => {
        const s = sensor();
        s.type(3);
        s.leaveWindow();
        s.comeBackWindow();
        s.paste('w'.repeat(800));
        assert.equal(s.counters.injectedChars, 800);
        assert.equal(s.counters.injectedCharsAfterReturn, 800);
    });

    await t.test('an added site, likewise', () => {
        const s = sensor({
            hostname: 'moodle.mon-etablissement.fr',
            href: 'https://moodle.mon-etablissement.fr/mod/assign/view.php?id=42',
        });
        s.type(3);
        s.leaveWindow();
        s.comeBackWindow();
        s.paste('w'.repeat(800));
        assert.equal(s.counters.injectedCharsAfterReturn, 800);
    });

    await t.test('but a focus that never left the document dates nothing', () => {
        // The deferral exists for that: moving focus to the input iframe is not leaving.
        const s = sensor();
        s.type(3);
        s.comeBackWindow();
        s.paste('w'.repeat(800));
        assert.equal(s.counters.injectedCharsAfterReturn, 0);
    });
});

test('what the sensor takes from the student\'s own thread', async (t) => {
    // The sensor runs in the page while one writes: what it takes there is taken from the next
    // keystroke. These rules are only visible by counting — none of them changes a counter.

    const moodle = (areas) => sensor({
        hostname: 'moodle.mon-etablissement.fr',
        href: 'https://moodle.mon-etablissement.fr/mod/assign/view.php?id=42',
        areas,
    });

    await t.test('the document is not read again at every window', async () => {
        // Reading the volume means `innerText` on the whole editing panel: a synchronous
        // layout. A window closes several times a minute, the document is read again every five
        // seconds.
        const s = moodle([{ value: 'x'.repeat(2000) }]);
        s.type(4);
        await s.internals.flush('test');
        const first = s.reads.areas;
        assert.ok(first > 0, 'the first window reads the document');

        s.time.advance(1);
        s.type(4);
        await s.internals.flush('test');
        assert.equal(s.reads.areas, first, 'the second, a second later, reuses the read');

        s.time.advance(6);
        s.type(4);
        await s.internals.flush('test');
        assert.ok(s.reads.areas > first, 'past the delay, the document is read again');
    });

    await t.test('a window that reuses the read still carries the volume', async () => {
        // Capping the read must not remove the measurement: it would be the engine losing
        // the size of the text every other window.
        const s = moodle([{ value: 'x'.repeat(2000) }]);
        s.type(4);
        await s.internals.flush('test');
        s.time.advance(1);
        s.type(4);
        await s.internals.flush('test');
        const windows = s.sent.filter((message) => message.type === 'CERTIMENS_METRICS');
        assert.equal(windows.length, 2);
        assert.equal(windows[1].window.text.len, 2000);
    });

    await t.test('a read that fails does not freeze the next one', async () => {
        // A reader returning `null` could read nothing: the last known value goes out again, but
        // its age does not move — otherwise the next window would camp five seconds on a
        // failure.
        const s = moodle([{ value: 'x'.repeat(2000) }]);
        s.type(4);
        await s.internals.flush('test');
        const first = s.reads.areas;
        s.time.advance(6);
        s.globals.document.querySelectorAll = () => [];   // the page no longer has a field
        s.type(4);
        await s.internals.flush('test');
        s.time.advance(1);
        s.globals.document.querySelectorAll = (selector) => {
            if (!selector.includes('textarea')) return [];
            s.reads.areas++;
            return [{ value: 'x'.repeat(2000) }];
        };
        s.type(4);
        await s.internals.flush('test');
        assert.ok(s.reads.areas > first, 'the next window retries instead of waiting out the delay');
    });

    await t.test('copying does not hash inside the handler', async () => {
        // Ctrl+A then Ctrl+C on a whole dissertation is tens of milliseconds of fingerprints:
        // the selection is read in the handler, it is hashed on the next turn. Between a copy
        // and its return from a corrector there are seconds.
        const s = sensor();
        const written = 'le candidat developpe une argumentation nuancee appuyee sur des references precises';
        s.globals.document.getSelection = () => written;
        s.internals.onCopy({ isTrusted: true, target: null });
        s.internals.recordInjection(written);
        assert.equal(s.counters.selfPasteEvents, 0, 'nothing is kept yet');

        s.flushDeferred();
        s.flushDeferred();      // the second look, a moment later
        s.internals.recordInjection(written);
        assert.equal(s.counters.selfPasteEvents, 1, 'on the next turn, the text is recognised');
    });

    await t.test('a selection staged only after the handler is still remembered', () => {
        // Google Docs draws its text on a canvas and puts what is copied into its hidden input
        // iframe **once the copy handler has returned**: read on the spot, the selection is
        // empty. Only a *second* Ctrl+C used to be remembered — the one that found the text the
        // first had staged — so a phrase moved inside one's own document came back as an
        // injection unless the student happened to copy it twice.
        const s = sensor();
        const written = 'le candidat developpe une argumentation nuancee appuyee sur des references';
        let staged = '';
        s.globals.document.getSelection = () => staged;
        s.internals.onCopy({ isTrusted: true, target: null });
        staged = written;
        s.flushDeferred();
        s.flushDeferred();
        s.internals.recordInjection(written);
        assert.equal(s.counters.selfPasteEvents, 1, 'the copy was given up on too early');
    });

    await t.test('Docs\'s one-character stand-in does not pass for the copied text', () => {
        // What the hidden iframe holds when the copy handler runs is a single placeholder
        // character; the text itself lands there a moment later. Keeping the first non-empty
        // selection kept that character, and only a *second* Ctrl+C — finding the real text the
        // first had left behind — was ever remembered. The longest of the reads wins.
        const s = sensor();
        const written = 'le candidat developpe une argumentation nuancee appuyee sur des references';
        let staged = '\u200b';
        s.globals.document.getSelection = () => staged;
        s.internals.onCopy({ isTrusted: true, target: null });
        staged = written;
        s.flushDeferred();
        s.flushDeferred();
        s.internals.recordInjection(written);
        assert.equal(s.counters.selfPasteEvents, 1, 'the placeholder was taken for the copy');
    });

    await t.test('a copy that stays unreadable is given up on, not retried for ever', () => {
        const s = sensor();
        s.globals.document.getSelection = () => '';
        s.internals.onCopy({ isTrusted: true, target: null });
        s.flushDeferred();
        s.flushDeferred();
        s.internals.recordInjection('le candidat developpe une argumentation nuancee');
        assert.equal(s.counters.selfPasteEvents, 0);
        assert.equal(s.counters.pasteEvents, 1, 'a paste nobody can excuse is a paste');
    });
});

test('the fingerprints are a contract between the four agents', async (t) => {
    // A paste is only recognised as the student's own text if the four agents hash the same
    // text onto the same number. The values below come from the Python implementation
    // (libreoffice/.../measure.py) as much as from this one: they are pinned so that a rewrite
    // of `hashShingle` — faster, even "equivalent" — cannot move them silently.
    const { shingles, codePoints } = sensor().internals;

    await t.test('four words give a known fingerprint', () => {
        assert.deepEqual([...shingles('Le candidat developpe une')], [1761045176]);
    });

    await t.test('case, accents and punctuation do not move it', () => {
        // That is exactly what a corrector changes, and what the normalisation absorbs.
        assert.deepEqual([...shingles('LE CANDIDAT DÉVELOPPÉ UNE')], [1761045176]);
        assert.deepEqual([...shingles('le, candidat; developpe  une!')], [1761045176]);
    });

    await t.test('the window slides by one word', () => {
        assert.deepEqual([...shingles('le candidat developpe une argumentation')],
            [1761045176, 821320551]);
    });

    await t.test('fewer than four words are hashed whole', () => {
        // A couple of words moved inside the document leaves one fingerprint instead of none.
        // Pinned like the others: the Python agent must give this very number.
        assert.deepEqual([...shingles('trois mots seulement')], [1996698289]);
        assert.deepEqual([...shingles('developpement durable')], [4152169010]);
    });

    await t.test('without a word there is nothing to hash', () => {
        assert.deepEqual([...shingles('!!! ...')], []);
    });

    await t.test('a character outside the basic plane shifts nothing', () => {
        assert.deepEqual([...shingles('je rends 😀 ce devoir')], [2526758823]);
    });

    await t.test('counting characters means counting code points', () => {
        // The engine counts a submitted copy the same way: `text.len` compares to it.
        for (const text of ['', 'abc', 'a😀b', '😀😀', 'été', '\uD83D', 'x\uD83Dy']) {
            assert.equal(codePoints(text), [...text].length, JSON.stringify(text));
        }
    });
});

// Three things the model could not see without them: a word being searched for (a short
// silence, written as it is), a restitution's volume (the size of its run), and what gets typed
// on coming back from somewhere else (the one of the three the sensor counts itself).
test('the proof of life, the volume restituted, and what is typed on returning', async (t) => {
    await t.test('a silence of one to three seconds is a word search', () => {
        const s = sensor();
        s.type();
        s.time.advance(1.6);        // too long to be a flight time, too short to be a pause
        s.type();
        assert.equal(s.counters.hesitations, 1);
        assert.equal(s.counters.pauses, 0, 'and it is not counted twice as a cognitive pause');
    });

    await t.test('a fluent keystroke is not one', () => {
        const s = sensor();
        s.type();
        s.time.advance(0.2);
        s.type();
        assert.equal(s.counters.hesitations, 0);
    });

    // The band exists because neither neighbouring rule covers it: below 800 ms it is a flight
    // time, past 3 s it is a cognitive pause. A silence of four seconds belongs to the pause.
    await t.test('a real pause stays a pause', () => {
        const s = sensor();
        s.type();
        s.time.advance(4);
        s.type();
        assert.equal(s.counters.hesitations, 0);
        assert.equal(s.counters.pauses, 1);
    });

    await t.test('a restitution is counted in characters as well as in gestures', () => {
        // The volume a restitution carries is the volume it would have been accused of: the same
        // text, pasted by someone who never wrote it, counts exactly that many injected
        // characters. Four restitutions say nothing about whether a paragraph or a third of the
        // document came back, and only this counter does.
        const stranger = sensor();
        stranger.paste(CORRECTED);

        const s = sensor();
        s.copy(WRITTEN);
        s.paste(CORRECTED);
        assert.equal(s.counters.selfPasteEvents, 1);
        assert.equal(s.counters.selfPasteChars, stranger.counters.injectedChars);
        assert.ok(s.counters.selfPasteChars > 0);
        assert.equal(s.counters.injectedChars, 0, 'and it is still not an injection');
    });

    await t.test('typing just after a return to the document is counted apart', () => {
        const s = sensor();
        s.leaveWindow();
        s.comeBackWindow();
        s.type(5);
        assert.equal(s.counters.keystrokesAfterReturn, 5,
            'leave, read, come back and type: the gesture no counter saw');
        assert.equal(s.counters.keystrokes, 5, 'it is a subset of the keystrokes, never an addition');
    });

    await t.test('typing long after a return is ordinary writing', () => {
        const s = sensor();
        s.leaveWindow();
        s.comeBackWindow({ seconds: 20 });  // past RETURN_WINDOW_MS
        s.type(5);
        assert.equal(s.counters.keystrokesAfterReturn, 0);
    });
});

// The one keystroke left out of `keystrokes_after_return`, and why. It is the invariant
// docs/mesures.md states, so it is held here rather than left to a reader's trust.
test('a restitution is not "typed after a return"', async (t) => {
    await t.test('the block it stands for counts as a keystroke, but not as typing', () => {
        const s = sensor();
        s.copy(WRITTEN);
        s.leaveWindow();
        s.comeBackWindow();
        s.paste(CORRECTED);
        assert.equal(s.counters.selfPasteEvents, 1, 'their own text came back');
        assert.equal(s.counters.keystrokes, 1, 'which is one keystroke, for the block it replaces');
        assert.equal(s.counters.keystrokesAfterReturn, 0,
            'pasting back is not typing: counting it would inflate the one counter that asks whether they typed on returning');
    });
});

// One gesture, one figure — whatever pastes it. Ctrl+V was counted where keys are read, and the
// block it posed was counted again where pastes are read: a restitution cost two keystrokes from
// the keyboard and one from the menu, an injection one from the keyboard and none from the menu.
// Neither the suite nor the engine could see it, the suite because `paste()` is the menu's path.
test('a paste weighs what it posed, not the key that posed it', async (t) => {
    await t.test('a restitution is one keystroke, from the keyboard as from the menu', () => {
        const keyboard = sensor();
        keyboard.copy(WRITTEN);
        keyboard.press('v', { ctrlKey: true });
        keyboard.paste(CORRECTED);

        const menu = sensor();
        menu.copy(WRITTEN);
        menu.paste(CORRECTED);

        assert.equal(keyboard.counters.selfPasteEvents, 1);
        assert.equal(keyboard.counters.keystrokes, 1, 'the block posed, and nothing for the key');
        assert.equal(keyboard.counters.keystrokes, menu.counters.keystrokes);
        assert.equal(keyboard.counters.macroRevisions, menu.counters.macroRevisions);
    });

    await t.test('an injection is no keystroke at all', () => {
        // What comes from elsewhere is weighed in characters, never in keystrokes: Word and VS
        // Code have always counted it that way, and the browser did too — but only when the
        // paste came from the menu.
        const s = sensor();
        s.press('v', { ctrlKey: true });
        s.paste(FOREIGN);
        assert.equal(s.counters.pasteEvents, 1);
        assert.ok(s.counters.injectedChars > 0);
        assert.equal(s.counters.keystrokes, 0);
    });

    // Cmd is read everywhere Ctrl is: a shortcut named on one side only would make a student on
    // a Mac a student who never pastes. Shift is not excluded either — "paste without
    // formatting" is a paste, and on macOS it is the one a browser gives for free.
    await t.test('Cmd+V, and pasting without formatting, are pastes too', () => {
        const shortcuts = [
            { ctrlKey: true },
            { metaKey: true },
            { ctrlKey: true, shiftKey: true },
            { metaKey: true, shiftKey: true },
            { metaKey: true, altKey: true, shiftKey: true },
        ];
        for (const modifiers of shortcuts) {
            const s = sensor();
            s.copy(WRITTEN);
            s.press('v', modifiers);
            s.paste(CORRECTED);
            assert.equal(s.counters.keystrokes, 1, JSON.stringify(modifiers));
        }
    });

    await t.test('and Shift+Insert, on the keyboards that have one', () => {
        const s = sensor();
        s.copy(WRITTEN);
        s.press('Insert', { shiftKey: true });
        s.paste(CORRECTED);
        assert.equal(s.counters.keystrokes, 1);
    });

    // It carries no Ctrl, so it used to spend the pending selection in the key handler — and the
    // paste handler then counted a revision for a block that had replaced nothing.
    await t.test('Shift+Insert over a selection is one revision, not two', () => {
        const s = sensor();
        s.copy(WRITTEN);
        s.selectAll();
        s.press('Insert', { shiftKey: true });
        s.paste(CORRECTED);
        assert.equal(s.counters.macroRevisions, 1);
    });

    await t.test('Ctrl+C stays an ordinary keystroke', () => {
        // It puts nothing into the document, so no paste handler counts it anywhere else.
        const s = sensor();
        s.press('c', { ctrlKey: true });
        assert.equal(s.counters.keystrokes, 1);
    });

    await t.test('and a lone V is a letter like any other', () => {
        const s = sensor();
        s.press('v');
        assert.equal(s.counters.keystrokes, 1);
    });
});

// A window is not a burst of typing: it is a span the agent decided to close, and the engine
// cannot tell the four triggers apart on its own. A save cutting a burst in two looked, on its
// side, like a writer who never stops; a departure to another tab looked like a pause for
// thought. The sensor has always known which one fired — here it says so.
test('why the window was sealed travels with it', async (t) => {
    const reasonOf = (s) => s.sent.filter((message) => message.type === 'CERTIMENS_METRICS').at(-1).window.why;
    // A flush reads the document's volume before it sends, so a window sealed by a handler
    // rather than awaited directly leaves after a few turns of the microtask queue.
    const settle = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };

    await t.test('two seconds of silence: the writer stopped', async () => {
        const s = sensor();
        s.type(4);
        await s.internals.flush('idle');
        assert.equal(reasonOf(s), 'idle');
    });

    await t.test('the keystroke ceiling: the counter stopped, not the writer', async () => {
        const s = sensor();
        s.type(4);
        await s.internals.flush('volume');
        assert.equal(reasonOf(s), 'volume');
    });

    await t.test('a save in the middle of a burst', async () => {
        const s = sensor();
        s.type(4);
        s.press('s', { ctrlKey: true });
        await settle();
        assert.equal(reasonOf(s), 'save');
    });

    await t.test('leaving the document is an absence, not a silence', async () => {
        const s = sensor();
        s.type(4);
        s.leaveTab();
        await settle();
        assert.equal(reasonOf(s), 'away');
    });

    await t.test('measuring suspended ends the sitting', async () => {
        const s = sensor();
        s.type(4);
        await s.internals.flush('pause');
        assert.equal(reasonOf(s), 'end');
    });

    // A trigger this table does not know has no word: the sensor never invents one outside the
    // engine's vocabulary. `why` being mandatory, the worker drops such a window rather than
    // send it (tests/background.test.mjs) — and `make check` keeps a trigger from going missing.
    await t.test('a trigger the table does not know is given no word', async () => {
        const s = sensor();
        s.type(4);
        await s.internals.flush('something-new');
        assert.equal(reasonOf(s), undefined);
    });
});

// The insertion probe (src/content.js, "THE INSERTION PROBE"): a debug-mode investigation into
// what an accepted completion announces, if anything. It measures nothing, and the two things
// worth holding are exactly that — that it stays quiet, and that what it prints is a count and
// never the text that was inserted.
test('the insertion probe', async (t) => {
    const suggestion = { type: 'beforeinput', inputType: 'insertReplacementText', data: 'une phrase entière proposée', isTrusted: true };

    await t.test('says nothing at all while the debug mode is off', async () => {
        const s = sensor();
        await s.settled();
        s.internals.onProbeInput(suggestion);
        assert.deepEqual(s.probed(), []);
    });

    await t.test('says nothing either while measuring is suspended', async () => {
        const s = sensor({ stored: { debug: true, paused: true } });
        await s.settled();
        s.internals.onProbeInput(suggestion);
        assert.deepEqual(s.probed(), []);
    });

    await t.test('prints how many characters arrived, and never which ones', async () => {
        const s = sensor({ stored: { debug: true } });
        await s.settled();
        s.type(1);
        s.internals.onProbeInput(suggestion);
        const [line] = s.probed();
        assert.ok(line, 'the probe printed nothing');
        assert.ok(line.includes('insertReplacementText'), 'the gesture is not named');
        assert.ok(line.includes(27), 'the number of characters inserted is not printed');
        const printed = line.map(String).join(' ');
        assert.ok(!printed.includes('phrase'), 'the inserted text reached the console');
    });

    await t.test('counts nothing: a probed insertion is not a measurement', async () => {
        const s = sensor({ stored: { debug: true } });
        await s.settled();
        s.type(3);
        s.internals.onProbeInput(suggestion);
        assert.equal(s.internals.measure.keystrokes, 3);
        assert.equal(s.internals.measure.injectedChars, 0);
        assert.equal(s.internals.measure.pasteEvents, 0);
    });

    // In the page rather than in an iframe, the probe follows the same rule as every other
    // handler there: a keystroke outside the editing area — a search box, a comment — is not
    // writing, and the probe has nothing to learn from it.
    await t.test('in the page, it only watches the editing area', async () => {
        const s = sensor({ stored: { debug: true } });
        await s.settled();
        const target = (inside) => Object.assign(new s.globals.Element(), { closest: () => (inside ? {} : null) });
        s.internals.onTopProbeInput({ ...suggestion, target: target(false) });
        assert.deepEqual(s.probed(), []);
        s.internals.onTopProbeInput({ ...suggestion, target: target(true) });
        assert.equal(s.probed().length, 1);
    });
});

// A spelling chosen in the editor's corrector (src/content.js, recordSpellCorrection). The rule
// comes from the engine's own editor, which counts it: an agent that did not would report the
// same student as less thorough for having used a feature of their word processor.
test('a spelling chosen in the corrector', async (t) => {
    // The editing area and the corrector's popup, as the sensor reads them: `closest` answers
    // for the one the click is in.
    const clickIn = (s, where) => {
        const target = Object.assign(new s.globals.Element(), {
            closest: (selector) => (selector === MENU ? (where === 'menu' ? {} : null) : (where ? {} : null)),
        });
        s.internals.onMouseDown({ isTrusted: true, clientX: 100, clientY: 100, target });
        s.time.advance(0.15);
    };
    const MENU = '.test-correction-menu';
    const corrector = async () => {
        const s = sensor();
        await s.settled();
        s.internals.editor.correctionMenu = MENU;
        return s;
    };

    await t.test('is the immediate correction it is, and not a jump through the document', async () => {
        const s = await corrector();
        s.type(4);
        clickIn(s, 'menu');
        assert.equal(s.internals.measure.corrections, 1);
        assert.equal(s.internals.measure.navigation, 0, 'the click counted as a navigation jump');
        assert.equal(s.internals.measure.keystrokes, 4, 'a keystroke was invented for the word');
    });

    await t.test('spends the right click that opened the menu', async () => {
        const s = await corrector();
        s.type(4);
        clickIn(s, 'area');          // the right click on the misspelled word: a jump, as any click
        clickIn(s, 'menu');          // the spelling picked in the menu
        s.press('Backspace');
        assert.equal(s.internals.measure.navigation, 1);
        assert.equal(s.internals.measure.macroRevisions, 0,
            'the deletion after a correction was read as a mass revision');
        assert.equal(s.internals.measure.corrections, 2, 'the correction and the deletion');
    });

    await t.test('ends no cognitive pause: it is not a keystroke', async () => {
        const s = await corrector();
        s.type(4);
        s.time.advance(10);
        clickIn(s, 'menu');
        assert.deepEqual(s.counters.gaps, []);
    });

    await t.test('an editor whose corrector is unknown counts clicks as it always did', async () => {
        const s = sensor();
        await s.settled();
        s.internals.editor.correctionMenu = null;
        clickIn(s, 'area');
        assert.equal(s.internals.measure.navigation, 1);
        assert.equal(s.internals.measure.corrections, 0);
    });

    await t.test('measuring suspended, nothing of it is counted', async () => {
        const s = sensor({ stored: { paused: true } });
        await s.settled();
        s.internals.editor.correctionMenu = MENU;
        clickIn(s, 'menu');
        assert.equal(s.internals.measure.corrections, 0);
    });
});


// The content script listens on the same document and window as the page it measures, so a page
// can dispatch `visibilitychange`, `focus`, `blur` and `pagehide` itself. The counting handlers
// always refused an untrusted event; the four lifecycle ones did not, and a thousand forged
// pairs took `focus_losses` from zero to a thousand — a number chosen by the page's author,
// arriving under the student's own token, in the record this product exists to produce.
test('an event the page forged is not a measurement', async (t) => {
    await t.test('forged departures and returns move no counter', () => {
        const s = sensor();
        s.type();
        for (let i = 0; i < 1000; i++) {
            s.forgeDeparture();
            s.forgeReturn();
        }
        assert.equal(s.counters.focusLosses, 0);
    });

    await t.test('the student leaving for real still counts, once', () => {
        const s = sensor();
        s.type();
        s.forgeDeparture();
        s.leaveTab();
        s.comeBackTab();
        assert.equal(s.counters.focusLosses, 1);
    });

    await t.test('a forged keystroke counts nothing either', () => {
        const s = sensor();
        s.forgeKeystroke();
        assert.equal(s.counters.keystrokes, 0);
    });
});

// --- THE WINDOW AS IT IS SENT ---
//
// A window is numbered within a session and carries the ordered runs of what happened, the
// counts only the sensor can classify, the distribution of the rhythm and how far the text
// moved (docs/moteur.md, "Le corps de mesure"). The engine checks a handful of relations on
// it: a window that breaks one is flagged, and the student with it. So they are asserted here
// on what the sensor really sends, relation by relation, and on the sessions where they are
// the hardest to hold.

// Copied out of the sensor's context: what it sent is compared here with literals of this one,
// and an array made in another realm is not deep-equal to one made in this. Each window comes
// with the session it was sealed in and the trigger that sealed it (`reason`, this agent's own
// word, which never leaves the browser — `why` is what the engine is told).
const windowsOf = (s) => JSON.parse(JSON.stringify(s.sent.filter((message) => message.type === 'CERTIMENS_METRICS')))
    .map((message) => ({ ...message.window, session: message.session, reason: message.reason }));
const FLIGHT_EDGES = [0, 20, 40, 60, 80, 100, 130, 160, 200, 250, 320, 400, 500, 650];
const DWELL_EDGES = [0, 20, 40, 60, 80, 100, 120, 150, 200, 300];
const binOf = (edges, value) => edges.findLastIndex((edge) => value >= edge);
const INSTANT_KINDS = ['click', 'paste', 'self', 'copy', 'undo', 'fix'];
const WINDOW_KEYS = ['seq', 'at', 'mono', 'ms', 'why', 'active', 'runs', 'counts', 'flight', 'dwell', 'text', 'sum'];
const COUNT_KEYS = ['corrections', 'reformulations', 'revisions', 'jumps', 'exits', 'back_keys', 'back_chars'];
// A histogram as the engine reads it back: the zeros at its tail are not sent.
const padded = (bins, edges) => edges.map((_, bin) => bins[bin] || 0);
// The runs without their durations: a silence has nothing else, so it is told by its kind.
const shape = (runs) => runs.map(([kind, n]) => (kind === 'gap' ? ['gap'] : [kind, n]));

/** The shape of one window, and every relation the engine checks on it, asserted on what was sent. */
function assertRelations(window_) {
    const { runs, counts, flight, dwell, sum } = window_;
    const whole = (value) => Number.isInteger(value) && value >= 0;

    // The frame: the keys of the body, in its order, and nothing else.
    const keys = Object.keys(window_).filter((key) => !['session', 'reason'].includes(key));
    assert.deepEqual(keys, WINDOW_KEYS.filter((key) => key in window_), 'the keys, in the order of the body');
    for (const key of ['seq', 'at', 'mono', 'ms', 'active']) assert.ok(whole(window_[key]), `${key}: ${window_[key]}`);
    assert.ok(window_.ms >= 1000, 'a window lasts a second at least');
    assert.ok(['idle', 'volume', 'save', 'focus', 'away', 'end'].includes(window_.why), `why: ${window_.why}`);
    assert.deepEqual(Object.keys(counts), COUNT_KEYS);
    assert.ok(Object.values(counts).every(whole));
    assert.deepEqual(Object.keys(sum), ['keys', 'chars', 'pastes']);

    // The runs: three shapes, by kind.
    assert.ok(runs.length >= 1 && runs.length <= 512, `${runs.length} runs`);
    for (const run of runs) {
        const [kind, ...cells] = run;
        if (kind === 'gap') assert.ok(cells.length === 1 && whole(cells[0]) && cells[0] >= 1000, `gap: ${cells}`);
        else if (KEYSTROKE_KINDS.includes(kind)) assert.ok(cells.length === 2 && cells.every(whole) && cells[0] >= 1, `${kind}: ${cells}`);
        else assert.ok(INSTANT_KINDS.includes(kind) && cells.length === 1 && whole(cells[0]), `${kind}: ${cells}`);
    }
    runs.forEach(([kind], i) => {
        if (i === 0 || ['gap', 'paste', 'self'].includes(kind)) return;
        assert.notEqual(kind, runs[i - 1][0], `two consecutive ${kind} runs`);
    });
    // A session's first window carries no silence at its head: a silence never crosses a session.
    if (window_.seq === 0) assert.notEqual(runs[0][0], 'gap', 'a first window headed by a silence');

    // The durations of the runs, the head silence aside, fit in the window.
    const timed = runs.slice(runs[0][0] === 'gap' ? 1 : 0)
        .reduce((total, [kind, n, ms]) => total + (kind === 'gap' ? n : ms || 0), 0);
    assert.ok(timed <= window_.ms + 1000, `the runs last ${timed} ms in a window of ${window_.ms} ms`);

    // The running totals are at least what the window holds, and exactly that in the first.
    const held = read(runs);
    const own = { keys: held.keystrokes, chars: held.injectedChars, pastes: held.pasteEvents };
    for (const key of Object.keys(own)) {
        assert.ok(sum[key] >= own[key], `sum.${key} below what the window holds`);
        if (window_.seq === 0) assert.equal(sum[key], own[key], `sum.${key} of a first window`);
    }
    assert.ok(counts.back_keys <= held.keystrokes && counts.back_chars <= held.injectedChars, 'after a return: a subset');

    // The rhythm: holds against the `type` keystrokes, the median against its histogram.
    const typed = runs.filter(([kind]) => kind === 'type').reduce((total, [, n]) => total + n, 0);
    const holds = dwell.bins.reduce((total, n) => total + n, 0);
    assert.deepEqual(Object.keys(dwell), ['bins', 'rollover']);
    assert.ok(dwell.bins.length <= 10 && dwell.bins.at(-1) !== 0, 'no zero at the tail of a histogram');
    assert.ok(holds <= typed + 2, 'no more holds than type keystrokes, the keys still down aside');
    assert.ok(dwell.rollover <= holds + 2, 'no more overlaps than holds');
    if (flight) {
        assert.deepEqual(Object.keys(flight), ['med', 'mad', 'bins']);
        assert.ok(flight.bins.length <= 14 && flight.bins.at(-1) !== 0, 'no zero at the tail of a histogram');
        // The median read back off the histogram. With an even number of flight times it is
        // the mean of the two in the middle, so it lies between their two bins — which may be
        // far apart when a window holds two flight times, one fast and one slow.
        const flights = flight.bins.reduce((total, n) => total + n, 0);
        assert.ok(flights >= 2, 'no rhythm without two flight times');
        const binAt = (rank) => {
            let seen = 0;
            return flight.bins.findIndex((n) => (seen += n) > rank);
        };
        const low = FLIGHT_EDGES[binAt(Math.floor((flights - 1) / 2))];
        const high = [...FLIGHT_EDGES, 800][binAt(Math.floor(flights / 2)) + 1];
        assert.ok(flight.med >= low && flight.med <= high, 'median off the histogram');
    }

    // The text: its size alone, or its size with the whole span.
    if (window_.text) {
        const span = Object.keys(window_.text);
        assert.ok(['len', 'len,since,at,cut,add', 'len,since,at,cut,add,kept'].includes(span.join()), span.join());
        assert.ok(Object.values(window_.text).every(whole));
        if ('since' in window_.text) assert.ok(window_.text.since < window_.seq, 'compared with an earlier window');
    }
}

const settle = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };

// A text the student wrote, and what a corrector sends back: the same words, less a comma.
const OWN = 'La transition énergétique suppose, à terme, une transformation profonde des modes de production actuels.';

test('the runs say what happened, in order', async (t) => {
    await t.test('a sitting with everything in it', async () => {
        const s = sensor();
        s.type(20);
        s.time.advance(1.6);                    // a word searched for
        s.type(6);
        s.press('ArrowLeft');
        s.press('ArrowLeft');
        s.press('ArrowLeft');
        s.press('Backspace');
        s.press('Backspace');
        s.type(3);
        s.paste('x'.repeat(240));               // from elsewhere
        s.paste('court');                       // from elsewhere too, below the injection floor
        s.copy(OWN);
        s.paste(OWN.replace(',', ''));          // their own text, back from a corrector
        s.type(2);
        s.press('z', { ctrlKey: true });        // undone
        s.click();
        s.time.advance(4);                      // a pause
        s.type(5);
        await s.internals.flush('idle');

        const [window_] = windowsOf(s);
        assertRelations(window_);
        assert.deepEqual(shape(window_.runs), [
            ['type', 20], ['gap'], ['type', 6], ['nav', 3], ['erase', 2], ['type', 3],
            ['paste', 240], ['paste', 5], ['other', 1], ['self', OWN.length - 1],
            ['type', 2], ['other', 1], ['undo', 1], ['gap'], ['click', 1], ['type', 5],
        ]);
        // Only keystrokes and silences last. A click, a paste, a restitution and an undo are
        // instants, sent without a duration; and the keystroke a restitution stands for lasts
        // nothing: it was never on the keyboard's clock.
        for (const run of window_.runs) {
            if (['click', 'paste', 'self', 'undo'].includes(run[0])) assert.equal(run.length, 2, run[0]);
        }
        assert.deepEqual(window_.runs[window_.runs.findIndex(([kind]) => kind === 'self') - 1], ['other', 1, 0]);
        // And what the engine reads in them.
        const held = read(window_.runs);
        assert.deepEqual([held.keystrokes, held.pasteEvents, held.injectedChars, held.maxInjectedChars],
            [20 + 6 + 3 + 2 + 3 + 1 + 2 + 1 + 5, 2, 240, 240]);
        assert.deepEqual([held.selfPasteEvents, held.selfPasteChars, held.hesitations, held.pauses],
            [1, OWN.length - 1, 1, 1]);
    });

    await t.test('a window of pastes only', async () => {
        const s = sensor();
        s.paste('x'.repeat(300));
        s.paste('y'.repeat(40));
        s.paste('z'.repeat(8));
        await s.internals.flush('idle');

        const [window_] = windowsOf(s);
        assertRelations(window_);
        assert.deepEqual(window_.runs, [['paste', 300], ['paste', 40], ['paste', 8]]);
        assert.equal(read(window_.runs).keystrokes, 0);
        assert.deepEqual(window_.sum, { keys: 0, chars: 340, pastes: 3 });
    });

    await t.test('a silence ended by a click, then typing, is one silence', async () => {
        // The click does not end the silence and does not restart it: the pause is counted when
        // the typing resumes, for its whole length — and the click made inside it does not add
        // its own duration to a stretch of time the silence already covers.
        const s = sensor();
        s.type(5);
        s.time.advance(3);
        s.click();
        s.time.advance(2);
        s.click();
        s.time.advance(1);
        s.type(4);
        await s.internals.flush('idle');

        const [window_] = windowsOf(s);
        assertRelations(window_);
        assert.equal(read(window_.runs).pauses, 1);
        assert.deepEqual(shape(window_.runs),
            [['type', 5], ['gap'], ['click', 2], ['type', 4]]);
        const [, silence] = window_.runs[1];
        assert.equal(silence, 6450, 'the real length of the silence, from keystroke to keystroke');
        assert.deepEqual(window_.runs[2], ['click', 2], 'the clicks are inside it, and add no time of their own');
    });

    await t.test('the 200-keystroke ceiling seals the window, and the next one starts clean', async () => {
        const s = sensor();
        s.type(230);
        await settle();
        await s.internals.flush('idle');

        const [first, second] = windowsOf(s);
        assertRelations(first);
        assertRelations(second);
        assert.equal(first.reason, 'volume');
        assert.deepEqual(shape(first.runs), [['type', 200]]);
        assert.deepEqual(shape(second.runs), [['type', 30]]);
        assert.deepEqual([first.seq, second.seq], [0, 1]);
        assert.deepEqual(second.sum, { keys: 230, chars: 0, pastes: 0 });
    });

    await t.test('the silence before the first keystroke heads the window, however long', async () => {
        // Longer than five minutes it is neither a hesitation nor a pause — the student had
        // left — and it is still told, at its real length. It began before the window did, so
        // it is the one run the engine does not hold against the window's duration.
        const s = sensor();
        s.type(5);
        await s.internals.flush('idle');
        s.time.advance(400);
        s.click();                              // the window opens on a click
        s.time.advance(2);
        s.type(5);
        await s.internals.flush('idle');

        const second = windowsOf(s)[1];
        assertRelations(second);
        assert.equal(second.runs[0][0], 'gap', 'the first run, before the click');
        assert.ok(second.runs[0][1] > 300000);
        assert.equal(read(second.runs).pauses, 0);
        assert.equal(read(second.runs).hesitations, 0);
        assert.deepEqual(shape(second.runs.slice(1)), [['click', 1], ['type', 5]]);
    });

    await t.test('a pause that began in the previous window is counted, and heads this one', async () => {
        const s = sensor();
        s.type(5);
        await s.internals.flush('idle');
        s.time.advance(30);
        s.type(5);
        await s.internals.flush('idle');

        const second = windowsOf(s)[1];
        assertRelations(second);
        assert.equal(read(second.runs).pauses, 1);
        assert.equal(second.runs[0][0], 'gap');
    });

    await t.test('clicks carried over from an empty window are counted, and never timed', async () => {
        const s = sensor();
        s.click();
        await s.internals.flush('idle');        // nothing to send: the click is carried over
        s.time.advance(120);
        s.click();
        s.type(3);
        await s.internals.flush('idle');

        const [window_] = windowsOf(s);
        assertRelations(window_);
        assert.deepEqual(window_.runs.slice(0, 1), [['click', 2]]);
        assert.deepEqual(shape(window_.runs), [['click', 2], ['type', 3]]);
    });

    // One silence, one clock. The hesitation used to be read on the gap since the last key
    // pressed, which a paste shortcut is without counting a keystroke: one stop cut by a
    // Ctrl+V was two hesitations and a pause, and three silences in a window that only
    // lasted one.
    await t.test('a paste shortcut inside a silence does not count it twice', async () => {
        const s = sensor();
        s.type(3);
        s.time.advance(1.5);
        s.press('v', { ctrlKey: true });
        s.paste('x'.repeat(50));
        s.time.advance(1);
        s.type(3);
        await s.internals.flush('idle');

        const [window_] = windowsOf(s);
        assertRelations(window_);
        assert.equal(read(window_.runs).hesitations, 1);
        assert.equal(read(window_.runs).pauses, 0);
        assert.deepEqual(window_.runs.map(([kind]) => kind), ['type', 'gap', 'paste', 'type']);
    });

    // A key taken by a composition says nothing of a search for a word: the short silence it
    // ends is not written. A long one is, like any other.
    await t.test('a key taken by a composition ends no short silence', async () => {
        const s = sensor();
        s.type(2);
        s.time.advance(1.5);
        s.press('Process', { isComposing: true });
        s.time.advance(2.85);                   // 3000 ms exactly: three seconds is still short
        s.press('Process', { isComposing: true });
        s.time.advance(1.5);
        s.type(1);                              // an ordinary key, after the same silence
        await s.internals.flush('idle');

        const [window_] = windowsOf(s);
        assertRelations(window_);
        assert.deepEqual(window_.runs.map(([kind, n]) => [kind, n]), [['type', 4], ['gap', 1650], ['type', 1]]);
    });

    await t.test('a key taken by a composition is a type keystroke, and ends a long silence', async () => {
        const s = sensor();
        s.type(2);
        s.time.advance(2.851);                  // one millisecond past three seconds
        s.press('Process', { isComposing: true });
        s.press('Process', { isComposing: true });
        await s.internals.flush('idle');

        const [window_] = windowsOf(s);
        assertRelations(window_);
        assert.deepEqual(shape(window_.runs), [['type', 2], ['gap'], ['type', 2]]);
    });

    await t.test('a copy is told with the size the selection had, line breaks aside', async () => {
        const s = sensor();
        s.type(3);
        s.globals.document.getSelection = () => 'douze\nsignes';
        s.internals.onCopy({ isTrusted: true, target: null });
        s.flushDeferred();
        s.flushDeferred();
        s.type(2);
        await s.internals.flush('idle');

        // The selection is read on later turns, and the test's turns run every timer the
        // sensor armed — its idle flush among them. Wherever the windows were cut, the runs
        // are these, in this order.
        const windows = windowsOf(s);
        for (const window_ of windows) assertRelations(window_);
        assert.deepEqual(shape(windows.flatMap((w) => w.runs)),
            [['type', 3], ['copy', 11], ['type', 2]]);
    });

    await t.test('the runs never outgrow what the engine accepts', async () => {
        // A writer who alternates a keystroke and a click, without ever stopping two seconds:
        // two runs a gesture, and no other trigger than the number of runs itself.
        const s = sensor();
        for (let i = 0; i < 300; i++) {
            s.press(i % 2 ? 'ArrowLeft' : 'a');
            s.click();
        }
        await settle();
        await s.internals.flush('idle');

        const windows = windowsOf(s);
        assert.ok(windows.length >= 2, 'the window was sealed before its runs overflowed');
        for (const window_ of windows) assertRelations(window_);
        assert.equal(windows[0].reason, 'volume');
        assert.equal(windows.reduce((sum, w) => sum + read(w.runs).keystrokes, 0), 300);
    });

    await t.test('clicks and copies alone never pile up without bound', async () => {
        // No keystroke and no paste: nothing is ever sealed, the runs are carried over. They
        // stop being added before the limit, leaving room for the gesture that will seal them.
        const s = sensor();
        s.globals.document.getSelection = () => 'x';
        for (let i = 0; i < 2000; i++) {
            s.click();
            s.internals.onCopy({ isTrusted: true, target: null });
            s.flushDeferred();
            s.flushDeferred();
        }
        s.type(3);
        s.press('z', { ctrlKey: true });
        await s.internals.flush('idle');

        const [window_] = windowsOf(s);
        assertRelations(window_);
    });
});

test('the runs hold no key and no word', async (t) => {
    const sentence = 'Bonjour, le monde : voici une phrase.';

    await t.test('a type run is never cut on what was typed', async () => {
        const s = sensor();
        for (const key of sentence) s.press(key);
        s.press('Enter');
        s.press('Tab');
        // AltGr, as Windows reports it: Ctrl+Alt, and a character. `@` and `€` on a French
        // keyboard — a run cut there would be cut on a class of characters.
        s.press('@', { ctrlKey: true, altKey: true });
        s.press('€', { ctrlKey: true, altKey: true });
        for (const key of 'suite') s.press(key);
        await s.internals.flush('idle');

        const [window_] = windowsOf(s);
        assertRelations(window_);
        assert.deepEqual(shape(window_.runs), [['type', sentence.length + 4 + 5]]);
    });

    await t.test('a shortcut and a named key are keystrokes that write nothing', async () => {
        const s = sensor();
        s.type(2);
        s.press('c', { ctrlKey: true });
        s.press('Escape');
        s.type(2);
        await s.internals.flush('idle');

        assert.deepEqual(shape(windowsOf(s)[0].runs),
            [['type', 2], ['other', 2], ['type', 2]]);
    });

    await t.test('nothing sent names a key, a position on the keyboard or a character', async () => {
        const s = sensor();
        const codes = ['KeyQ', 'KeyW', 'Space', 'Comma'];
        [...'aé ,'].forEach((key, i) => {
            s.internals.onKeyDown(trusted({ key, code: codes[i], repeat: false }));
            s.time.advance(0.08);
            s.internals.onKeyUp(trusted({ key, code: codes[i] }));
            s.time.advance(0.05);
        });
        await s.internals.flush('idle');

        const wire = JSON.stringify(windowsOf(s)[0]);
        for (const code of codes) assert.equal(wire.includes(code), false, code);
        const { runs, dwell, flight } = windowsOf(s)[0];
        // Categories and numbers, and nothing else.
        assert.ok(runs.flat().every((cell) => Number.isInteger(cell) || /^[a-z]+$/.test(cell)));
        assert.ok([...dwell.bins, dwell.rollover, ...flight.bins].every(Number.isInteger));
        assert.ok([flight.med, flight.mad].every(Number.isFinite));
    });

    await t.test('the debug journal does not learn the keys either', async () => {
        const s = sensor({ stored: { debug: true } });
        s.internals.onKeyDown(trusted({ key: 'q', code: 'KeyQ', repeat: false }));
        s.internals.onKeyUp(trusted({ key: 'q', code: 'KeyQ' }));
        await s.internals.flush('idle');

        assert.equal(JSON.stringify(s.logs).includes('KeyQ'), false);
    });
});

test('windows are numbered in a session, and the session counts what it sealed', async (t) => {
    await t.test('three windows: a number each, and totals that add up', async () => {
        const s = sensor();
        s.type(10);
        await s.internals.flush('idle');
        s.time.advance(5);
        s.paste('x'.repeat(100));
        s.type(4);
        await s.internals.flush('idle');
        s.time.advance(5);
        s.type(7);
        await s.internals.flush('idle');

        const windows = windowsOf(s);
        assert.deepEqual(windows.map((w) => w.seq), [0, 1, 2]);
        assert.equal(new Set(windows.map((w) => w.session)).size, 1, 'one session');
        assert.deepEqual(windows.map((w) => w.sum), [
            { keys: 10, chars: 0, pastes: 0 },
            { keys: 14, chars: 100, pastes: 1 },
            { keys: 21, chars: 100, pastes: 1 },
        ]);
    });

    await t.test('the id is random, long enough, and made of what a URL takes', async () => {
        const ids = new Set();
        for (let i = 0; i < 50; i++) {
            const s = sensor();
            s.type(2);
            await s.internals.flush('idle');
            const { session } = windowsOf(s)[0];
            assert.match(session, /^[A-Za-z0-9_-]{22}$/, '128 bits, base64url');
            ids.add(session);
        }
        assert.equal(ids.size, 50);
    });

    // This is the whole point of numbering in the page: the window the worker never received
    // was still sealed, so the next one shows the hole — a number that skips, and totals the
    // windows that did arrive do not reach. The difference is exactly what the lost one held.
    await t.test('a window that never reaches the worker is still numbered and counted', async () => {
        const s = sensor();
        s.type(10);
        await s.internals.flush('idle');
        const send = s.globals.chrome.runtime.sendMessage;
        s.globals.chrome.runtime.sendMessage = () => { throw new Error('Extension context invalidated.'); };
        const warn = s.globals.console.warn;
        s.globals.console.warn = () => {};
        s.time.advance(5);
        s.paste('x'.repeat(500));
        s.type(3);
        await s.internals.flush('idle');
        s.globals.chrome.runtime.sendMessage = send;
        s.globals.console.warn = warn;
        s.time.advance(5);
        s.type(6);
        await s.internals.flush('idle');

        const windows = windowsOf(s);
        assert.deepEqual(windows.map((w) => w.seq), [0, 2]);
        assert.deepEqual(windows[1].sum, { keys: 19, chars: 500, pastes: 1 });
    });

    await t.test('a suspension lifted starts a new session, numbered from zero', async () => {
        const s = sensor();
        s.type(4);
        s.storage.change({ paused: true });     // seals the window on the way in
        await settle();
        s.storage.change({ paused: false });
        s.type(4);
        await s.internals.flush('idle');

        const [before, after] = windowsOf(s);
        assert.equal(before.reason, 'pause');
        assert.notEqual(after.session, before.session);
        assert.deepEqual([before.seq, after.seq], [0, 0]);
        assert.deepEqual(after.sum, { keys: 4, chars: 0, pastes: 0 });
        assert.equal(after.mono, 0, 'and its clock starts again');
        assert.notEqual(after.runs[0][0], 'gap', 'the first keystroke of a session ends no silence');
    });

    await t.test('so does pairing again', async () => {
        const s = sensor();
        s.type(4);
        s.storage.change({ signedIn: false });
        await settle();
        s.storage.change({ signedIn: true });
        s.type(4);
        await s.internals.flush('idle');

        const [before, after] = windowsOf(s);
        assert.notEqual(after.session, before.session);
        assert.equal(after.seq, 0);
    });

    await t.test('nothing of a session is written anywhere', async () => {
        const s = sensor();
        const written = [];
        s.globals.chrome.storage.local.set = (values) => { written.push(values); return Promise.resolve(); };
        s.type(4);
        await s.internals.flush('idle');
        assert.deepEqual(written, []);
    });
});

test('a window is dated on two clocks', async (t) => {
    await t.test('its first activity on both, and its length on the monotonic one', async () => {
        const s = sensor();
        s.type(10);
        await s.internals.flush('idle');
        s.time.advance(60);
        s.type(10);
        await s.internals.flush('idle');

        const [first, second] = windowsOf(s);
        for (const window_ of [first, second]) {
            assertRelations(window_);
            assert.equal(window_.ms, 1350, 'from the first keystroke to the last');
        }
        assert.equal(first.at, s.time.now - 1500 - 60000 - 1500);
        assert.equal(first.mono, 0, 'the first activity of the session is the zero of its clock');
        assert.equal(second.mono - first.mono, second.at - first.at);
    });

    await t.test('a window of a single instant is sent as one second', async () => {
        const s = sensor();
        s.type(1);
        await s.internals.flush('idle');
        const [window_] = windowsOf(s);
        assert.equal(window_.ms, 1000);
    });

    await t.test('a clock set back shows between the two', async () => {
        // The wall clock goes back ten minutes and the monotonic one does not follow: the gap
        // between the two is what the engine reads.
        const s = sensor();
        s.type(5);
        await s.internals.flush('idle');
        s.time.advance(-600);
        s.mono.skew = 600_000 + 30_000;         // thirty real seconds went by
        s.type(5);
        await s.internals.flush('idle');

        const [first, second] = windowsOf(s);
        assert.ok(second.at < first.at);
        assert.ok(second.mono > first.mono + first.ms);
    });
});

test('the rhythm leaves as a distribution', async (t) => {
    const stroke = (s, code, { down = 0, hold }) => {
        s.time.advance(down / 1000);
        s.internals.onKeyDown(trusted({ key: 'a', code, repeat: false }));
        return () => {
            s.time.advance(hold / 1000);
            s.internals.onKeyUp(trusted({ key: 'a', code }));
        };
    };

    await t.test('the flight times, bin by bin, on the edges the engine holds', async () => {
        const s = sensor();
        const flights = [0, 19, 20, 99, 100, 129, 130, 649, 650, 799];
        s.internals.onKeyDown(trusted({ key: 'a', repeat: false }));
        for (const flight of flights) {
            s.time.advance(flight / 1000);
            s.internals.onKeyDown(trusted({ key: 'a', repeat: false }));
        }
        await s.internals.flush('idle');

        const [window_] = windowsOf(s);
        assertRelations(window_);
        assert.deepEqual(window_.flight.bins, [2, 1, 0, 0, 1, 2, 1, 0, 0, 0, 0, 0, 1, 2]);
        assert.deepEqual(window_.flight.bins, FLIGHT_EDGES.map((_, bin) =>
            flights.filter((flight) => binOf(FLIGHT_EDGES, flight) === bin).length));
        assert.deepEqual([window_.flight.med, window_.flight.mad], [114.5, 95]);
    });

    await t.test('the zeros at the tail of a histogram are not sent', async () => {
        const s = sensor();
        s.type(6);                              // five flight times of 150 ms: one bin, the seventh
        await s.internals.flush('idle');

        const [window_] = windowsOf(s);
        assertRelations(window_);
        assert.deepEqual(window_.flight.bins, [0, 0, 0, 0, 0, 0, 5]);
        assert.deepEqual(padded(window_.flight.bins, FLIGHT_EDGES), [0, 0, 0, 0, 0, 0, 5, 0, 0, 0, 0, 0, 0, 0]);
        // No key was seen released: the holds are sent all the same, as an empty histogram.
        assert.deepEqual(window_.dwell, { bins: [], rollover: 0 });
    });

    await t.test('no histogram without the two flight times a median needs', async () => {
        const s = sensor();
        s.type(2);
        await s.internals.flush('idle');
        const [window_] = windowsOf(s);
        assert.equal('flight' in window_, false);
    });

    await t.test('how long each key was held, on its own edges', async () => {
        const s = sensor();
        const holds = [5, 20, 119, 120, 299, 300, 2000];
        for (const hold of holds) stroke(s, 'KeyA', { down: 400, hold })();
        await s.internals.flush('idle');

        const [window_] = windowsOf(s);
        assertRelations(window_);
        assert.deepEqual(window_.dwell.bins, [1, 1, 0, 0, 0, 1, 1, 0, 1, 2]);
        assert.deepEqual(window_.dwell.bins, DWELL_EDGES.map((_, bin) =>
            holds.filter((hold) => binOf(DWELL_EDGES, hold) === bin).length));
        assert.equal(window_.dwell.rollover, 0);
    });

    await t.test('a key pressed before the previous one is released is an overlap', async () => {
        const s = sensor();
        const releaseA = stroke(s, 'KeyA', { hold: 90 });      // A down…
        const releaseB = stroke(s, 'KeyB', { down: 60, hold: 0 });  // …B down 60 ms later, A still held
        releaseA();
        s.time.advance(0.05);
        releaseB();
        stroke(s, 'KeyC', { down: 300, hold: 80 })();          // and one typed on its own
        await s.internals.flush('idle');

        const [window_] = windowsOf(s);
        assertRelations(window_);
        assert.equal(window_.dwell.rollover, 1);
        assert.equal(window_.dwell.bins.reduce((sum, n) => sum + n, 0), 3);
    });

    await t.test('only type keys are timed', async () => {
        const s = sensor();
        for (const key of ['Backspace', 'ArrowLeft', 'Escape']) {
            s.internals.onKeyDown(trusted({ key, code: key, repeat: false }));
            s.time.advance(0.08);
            s.internals.onKeyUp(trusted({ key, code: key }));
            s.time.advance(0.2);
        }
        await s.internals.flush('idle');
        assert.deepEqual(windowsOf(s)[0].dwell.bins, []);
    });

    await t.test('a release that arrives after its window was sealed is counted in the next', async () => {
        // A keystroke is counted when the key goes down and its hold when it comes back: a
        // window sealed between the two leaves the hold to the next one, and the engine allows
        // a window that much more holds than it has type keystrokes.
        const s = sensor();
        const release = stroke(s, 'KeyA', { hold: 100 });
        await s.internals.flush('idle');
        release();
        s.press('ArrowLeft');
        await s.internals.flush('idle');

        const [first, second] = windowsOf(s);
        assertRelations(first);
        assertRelations(second);
        assert.deepEqual(first.dwell.bins, []);
        assert.equal(second.dwell.bins.reduce((sum, n) => sum + n, 0), 1);
    });

    await t.test('a key held when the document is left is not waited for', async () => {
        const s = sensor();
        stroke(s, 'KeyA', { hold: 0 });
        s.leaveTab();
        s.comeBackTab();
        const release = stroke(s, 'KeyB', { hold: 80 });
        release();
        await s.internals.flush('idle');
        const last = windowsOf(s).at(-1);
        assert.equal(last.dwell.rollover, 0, 'the key left behind does not make the next one an overlap');
    });

    await t.test('a release the page forged times nothing', async () => {
        const s = sensor();
        s.internals.onKeyDown(trusted({ key: 'a', code: 'KeyA', repeat: false }));
        s.time.advance(0.08);
        s.internals.onKeyUp({ isTrusted: false, code: 'KeyA' });
        await s.internals.flush('idle');
        assert.deepEqual(windowsOf(s)[0].dwell.bins, []);
    });
});

test('how far the text moved between two readings', async (t) => {
    const moodle = (areas) => sensor({
        hostname: 'moodle.mon-etablissement.fr',
        href: 'https://moodle.mon-etablissement.fr/mod/assign/view.php?id=42',
        areas,
    });
    const probe = sensor();
    const span = (before, after) => ({ ...probe.internals.textSpan(before, after) });

    await t.test('three lengths: where, how much went, how much came', () => {
        assert.deepEqual(span('abcdef', 'abcdef'), { at: 6, cut: 0, add: 0, kept: 0 });
        assert.deepEqual(span('abcdef', 'abcdefghi'), { at: 6, cut: 0, add: 3, kept: 0 });
        assert.deepEqual(span('abcdef', 'abXYZdef'), { at: 2, cut: 1, add: 3, kept: 0 });
        assert.deepEqual(span('abcdef', 'adef'), { at: 1, cut: 2, add: 0, kept: 0 });
        assert.deepEqual(span('', 'abc'), { at: 0, cut: 0, add: 3, kept: 0 });
        assert.deepEqual(span('abc', ''), { at: 0, cut: 3, add: 0, kept: 0 });
        // The prefix and the suffix never overlap: a repeated letter is counted once.
        assert.deepEqual(span('aaa', 'aaaa'), { at: 3, cut: 0, add: 1, kept: 0 });
        assert.deepEqual(span('aaaa', 'aaa'), { at: 3, cut: 1, add: 0, kept: 0 });
    });

    await t.test('a paragraph replaced by another of the same length moves no volume, and shows', () => {
        const before = 'Introduction. ' + 'a'.repeat(300) + ' Conclusion.';
        const after = 'Introduction. ' + 'b'.repeat(300) + ' Conclusion.';
        assert.deepEqual(span(before, after), { at: 14, cut: 300, add: 300, kept: 0 });
    });

    // A span is an envelope: two places touched between two readings give one span from the
    // first to the last, and the untouched text between them sits on both sides. `kept` is
    // what tells it from the paragraph above — word for word, blanks included.
    await t.test('two distant edits: what lies between them was kept, not written', () => {
        const middle = ' le développement durable suppose une transformation profonde des modes de production ';
        const { cut, add, kept } = span('Ancien début' + middle + 'ancienne fin.', 'Nouveau début' + middle + 'nouvelle chute.');
        assert.ok(cut > middle.length && add > middle.length);
        assert.ok(kept >= middle.length - 1 && kept <= Math.min(cut, add));
        assert.ok(add - kept < 30, 'what is new is the two edits, not the envelope');
    });

    await t.test('kept follows the order: words that came back shuffled are not all kept', () => {
        const { kept } = span('un deux trois quatre', 'quatre trois deux un');
        assert.ok(kept > 0 && kept < 'un deux trois quatre'.length);
    });

    await t.test('kept is left out, not guessed, when a side is too long to compare', () => {
        const words = (n, word) => Array.from({ length: n }, (_, i) => word + i).join(' ');
        const long = span(words(1001, 'a'), words(3, 'b'));
        assert.equal('kept' in long, false);
        assert.equal(long.add, words(3, 'b').length);
        assert.equal(span(words(1000, 'a'), words(1000, 'a') + ' fin').kept, 0, 'a pure addition compares nothing');
        assert.equal('kept' in span(words(900, 'a'), words(900, 'b')), true);
    });

    await t.test('lengths are counted in characters, as the volume is', () => {
        // Two emoji that share their first half: the boundary must not fall inside one.
        const cases = [['a😀b', 'a😁b'], ['😀', '😀😀'], ['x😀y', 'xy'], ['é😀', 'é😁😀'], ['😀a', '😁a']];
        for (const [before, after] of cases) {
            const { at, cut, add, kept } = span(before, after);
            assert.ok(kept <= Math.min(cut, add));
            assert.equal([...after].length, [...before].length - cut + add, `${before} → ${after}`);
            assert.ok(at + cut <= [...before].length);
            assert.equal([...before].slice(0, at).join(''), [...after].slice(0, at).join(''));
        }
        assert.deepEqual(span('a😀b', 'a😁b'), { at: 1, cut: 1, add: 1, kept: 0 });
    });

    await t.test('the first reading has nothing to be compared with', async () => {
        const s = moodle([{ value: 'x'.repeat(100) }]);
        s.type(4);
        await s.internals.flush('idle');
        const [window_] = windowsOf(s);
        assertRelations(window_);
        assert.deepEqual(window_.text, { len: 100 }, 'its size, and nothing to compare it with');
    });

    await t.test('a fresh reading says what changed since the window that carried the last', async () => {
        const field = { value: 'x'.repeat(100) };
        const s = moodle([field]);
        s.type(4);
        await s.internals.flush('idle');                // seq 0: first reading
        s.time.advance(1);
        s.type(4);
        await s.internals.flush('idle');                // seq 1: cached
        s.time.advance(6);
        field.value = 'x'.repeat(40) + 'y'.repeat(360) + 'x'.repeat(50);
        s.type(4);
        await s.internals.flush('idle');                // seq 2: read again

        const windows = windowsOf(s);
        for (const window_ of windows) assertRelations(window_);
        assert.deepEqual(windows[1].text, { len: 100 }, 'a cached size carries no span');
        assert.deepEqual(windows[2].text, { len: 450, since: 0, at: 40, cut: 10, add: 360, kept: 0 });
        // The relation the engine checks: the earlier size, less what went, plus what came.
        assert.equal(windows[2].text.len, windows[0].text.len - windows[2].text.cut + windows[2].text.add);
    });

    await t.test('a reading identical to the last is sent, with nothing in it', async () => {
        const s = moodle([{ value: 'x'.repeat(100) }]);
        s.type(4);
        await s.internals.flush('idle');
        s.time.advance(6);
        s.type(4);
        await s.internals.flush('idle');
        assert.deepEqual(windowsOf(s)[1].text, { len: 100, since: 0, at: 100, cut: 0, add: 0, kept: 0 });
    });

    await t.test('line breaks are no more in the span than in the volume', async () => {
        const field = { value: 'un\ndeux' };
        const s = moodle([field]);
        s.type(4);
        await s.internals.flush('idle');
        s.time.advance(6);
        field.value = 'un\n\n\ndeux\ntrois';
        s.type(4);
        await s.internals.flush('idle');
        const [first, second] = windowsOf(s);
        assert.deepEqual(first.text, { len: 6 });
        assert.deepEqual(second.text, { len: 11, since: 0, at: 6, cut: 0, add: 5, kept: 0 });
    });

    await t.test('a failed reading carries no span and does not become the reference', async () => {
        const field = { value: 'x'.repeat(100) };
        const s = moodle([field]);
        s.type(4);
        await s.internals.flush('idle');
        s.time.advance(6);
        const read = s.globals.document.querySelectorAll;
        s.globals.document.querySelectorAll = () => [];
        s.type(4);
        await s.internals.flush('idle');
        s.globals.document.querySelectorAll = read;
        field.value = 'x'.repeat(130);
        s.time.advance(1);
        s.type(4);
        await s.internals.flush('idle');

        const windows = windowsOf(s);
        assert.deepEqual(windows[1].text, { len: 100 }, 'the last size known, and no span');
        assert.deepEqual(windows[2].text, { len: 130, since: 0, at: 100, cut: 0, add: 30, kept: 0 });
    });

    await t.test('the previous reading goes when measuring stops', async () => {
        const field = { value: 'x'.repeat(100) };
        const s = moodle([field]);
        s.type(4);
        await s.internals.flush('idle');
        assert.equal(s.internals.session.reading.text.length, 100);
        const kept = s.internals.session;
        s.storage.change({ paused: true });
        assert.equal(kept.reading, null, 'nothing of the text outlives the session');
        assert.equal(s.internals.session, null);

        s.storage.change({ paused: false });
        s.time.advance(6);
        field.value = 'x'.repeat(150);
        s.type(4);
        await s.internals.flush('idle');
        assert.deepEqual(windowsOf(s).at(-1).text, { len: 150 }, 'and the new session starts from a first reading');
    });

    await t.test('Overleaf reads no text, so it sends no `text` at all', async () => {
        const s = sensor({ hostname: 'www.overleaf.com', href: 'https://www.overleaf.com/project/64f0a1b2c3d4e5f6a7b8c9d0' });
        s.type(4);
        await s.internals.flush('idle');
        s.time.advance(40);
        s.type(4);
        await s.internals.flush('idle');
        for (const window_ of windowsOf(s)) {
            assertRelations(window_);
            assert.equal('text' in window_, false);
        }
    });

    // Google Docs: the text is read by the export the worker already makes for the volume,
    // every thirty seconds at most. The span is computed here, against the previous export.
    const googleDocs = (exports) => {
        const s = sensor();
        const asked = { exports: 0 };
        const send = s.globals.chrome.runtime.sendMessage;
        s.globals.chrome.runtime.sendMessage = (message) => {
            if (message.type !== 'CERTIMENS_GDOCS_VOLUME') return send(message);
            asked.exports++;
            return exports(asked.exports);
        };
        return { s, asked };
    };
    const exported = (text) => Promise.resolve({ ok: true, volume: [...text].length, text });

    await t.test('Google Docs: on each export, and no export more often than before', async () => {
        const texts = ['x'.repeat(1000), 'x'.repeat(1000) + 'y'.repeat(250)];
        const { s, asked } = googleDocs((n) => exported(texts[n - 1]));
        s.type(4);
        await s.internals.flush('idle');
        for (let i = 0; i < 5; i++) {
            s.time.advance(4);
            s.type(4);
            await s.internals.flush('idle');
        }
        assert.equal(asked.exports, 1, 'six windows in under thirty seconds: one export');
        s.time.advance(20);
        s.type(4);
        await s.internals.flush('idle');

        const windows = windowsOf(s);
        assert.equal(asked.exports, 2);
        for (const window_ of windows) assertRelations(window_);
        assert.deepEqual(windows.slice(0, 6).map((w) => w.text), Array(6).fill({ len: 1000 }));
        assert.deepEqual(windows[6].text, { len: 1250, since: 0, at: 1000, cut: 0, add: 250, kept: 0 });
    });

    await t.test('Google Docs: a worker that hands back the size alone gives a volume and no span', async () => {
        const { s } = googleDocs(() => Promise.resolve({ ok: true, volume: 1000 }));
        s.type(4);
        await s.internals.flush('idle');
        s.time.advance(40);
        s.type(4);
        await s.internals.flush('idle');
        const windows = windowsOf(s);
        assert.deepEqual(windows.map((w) => w.text), [{ len: 1000 }, { len: 1000 }]);
    });

    await t.test('windows leave in the order they were numbered, whatever the export takes', async () => {
        // The first window waits for an export; the second is sealed meanwhile. It must not
        // overtake it: the reading it would carry is compared with the one before.
        let answer;
        const { s } = googleDocs(() => new Promise((resolve) => { answer = resolve; }));
        s.type(4);
        const first = s.internals.flush('idle');
        s.time.advance(3);
        s.type(4);
        const second = s.internals.flush('idle');
        await settle();
        assert.equal(windowsOf(s).length, 0, 'both wait');
        answer({ ok: true, volume: 3, text: 'abc' });
        await Promise.all([first, second]);
        assert.deepEqual(windowsOf(s).map((w) => w.seq), [0, 1]);
    });

    await t.test('a page that closes sends what was sealed, without waiting for the export', async () => {
        const { s } = googleDocs(() => new Promise(() => {}));     // an export that never answers
        s.type(4);
        s.internals.flush('idle');
        s.time.advance(3);
        s.type(4);
        s.internals.flush('pagehide');
        assert.deepEqual(windowsOf(s).map((w) => [w.seq, w.why, 'text' in w]), [[0, 'idle', false], [1, 'end', false]]);
    });
});
