// Counting rules of the browser sensor (src/content.js).
//
// The same rules are covered on the Python side by the LibreOffice agent's test_measure.py: the two
// implementations are independent and must agree (see the mesures-redaction skill). What is
// tested here and nowhere else is what only the browser can see — a selection swept with the
// mouse.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { browserGlobals, clock, load, trusted } from './helpers/sandbox.mjs';

const INTERNALS = ['measure', 'onKeyDown', 'onMouseDown', 'onMouseUp', 'onCopy', 'recordInjection', 'rememberOwnText',
    'flush', 'selectionScope', 'shingles', 'codePoints', 'onProbeInput', 'onTopProbeInput', 'editor'];

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
    const internals = load(new URL('../src/content.js', import.meta.url), { globals, expose: INTERNALS });
    const press = (key, modifiers = {}) => {
        internals.onKeyDown({ key, isTrusted: true, repeat: false, ctrlKey: false, metaKey: false, shiftKey: false, ...modifiers });
        time.advance(0.15);
    };
    return {
        time,
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
        get counters() {
            return internals.measure;
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
        assert.equal(s.counters.macroRevisions, 1);
        assert.equal(s.counters.corrections, 0);
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
    await t.test('the first after a click is massive, the next ones immediate', () => {
        const s = sensor();
        s.type(3);
        s.click();
        for (let i = 0; i < 4; i++) s.press('Backspace');
        assert.equal(s.counters.macroRevisions, 1);
        assert.equal(s.counters.corrections, 3);
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

test('a pause runs from 3 s to 5 minutes', async (t) => {
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
    });

    await t.test('a gap below the threshold is typing flow', () => {
        const s = sensor();
        s.type();
        s.time.advance(1);
        s.type();
        assert.equal(s.counters.pauses, 0);
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
    await t.test('`injected_chars_max` keeps the biggest, not the last', () => {
        // Twenty pastes of a hundred characters and a single one of two thousand give the same
        // total: this counter is the only one saying something arrived in one block.
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
        // returns `null`, and the window goes without `real_volume_chars` — the engine tells
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

    await t.test('a deletion after a click stays a mass revision', () => {
        const s = overleaf();
        s.type(3);
        s.click();
        s.press('Backspace');
        assert.equal(s.counters.macroRevisions, 1);
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
        assert.equal(window_.values.real_volume_chars, 2000);
    });

    await t.test('a page with no input area does not send a volume of zero', async () => {
        // The engine tells a missing measurement from the value zero: a zero would read as an
        // empty document.
        const s = moodle([]);
        s.type(4);
        await s.internals.flush('test');
        const window_ = s.sent.find((message) => message.type === 'CERTIMENS_METRICS');
        assert.equal('real_volume_chars' in window_.values, false);
    });

    await t.test('the counting rules there are those of the other editors', () => {
        const s = moodle();
        s.type(3);
        s.click();
        s.press('Backspace');
        assert.equal(s.counters.macroRevisions, 1);
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
        // `real_volume_chars` every other window.
        const s = moodle([{ value: 'x'.repeat(2000) }]);
        s.type(4);
        await s.internals.flush('test');
        s.time.advance(1);
        s.type(4);
        await s.internals.flush('test');
        const windows = s.sent.filter((message) => message.type === 'CERTIMENS_METRICS');
        assert.equal(windows.length, 2);
        assert.equal(windows[1].values.real_volume_chars, 2000);
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
        // The engine counts a submitted copy the same way: `real_volume_chars` compares to it.
        for (const text of ['', 'abc', 'a😀b', '😀😀', 'été', '\uD83D', 'x\uD83Dy']) {
            assert.equal(codePoints(text), [...text].length, JSON.stringify(text));
        }
    });
});

// The three counters added for the vectors the model could not see: a word being searched for, a
// restitution's volume, and what gets typed on coming back from somewhere else.
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
    const reasonOf = (s) => s.sent.filter((message) => message.type === 'CERTIMENS_METRICS').at(-1).flush;
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

    // The safe failure: a trigger this table does not know sends nothing at all, and the engine
    // reads nothing as "the agent did not say" and falls back to what it did before. It never
    // sends a word the engine's vocabulary does not hold.
    await t.test('a trigger the table does not know says nothing', async () => {
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
