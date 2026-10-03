// Sensor of the Word add-in (src/sensor.js).
//
// Office does not deliver keystrokes: the sensor reads the text again and works out what
// changed. The difference between two reads is therefore the heart of the measurement, and the
// only part of the product whose correctness cannot be seen by reading the code.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clock, load, officeGlobals } from './helpers/sandbox.mjs';

const INTERNALS = ['difference', 'analyse', 'chars', 'codePoints', 'shingles', 'measure', 'isNavigating',
    'rangeSelected', 'previousText', 'flush', 'rememberSelection', 'ownText', 'pendingEvents', 'readText',
    'session', 'noteLocalEvent'];

// The delay the add-in gives a selection to stop moving before hashing it. Written here rather
// than read from the shipped code: a test that took the value from the sensor would follow it
// wherever it went, and this one is a promise — the block has to be remembered before the paste
// that follows the copy is read.
const SELECTION_SETTLE_MS = 150;
// Where the monotonic clock of the tests starts, against a wall clock that starts at a million:
// the two must never be the same number, or a sensor reading the wrong one would pass.
const MONO_ORIGIN = 400_000;

// What the engine deduces from runs, written out again here rather than borrowed from the
// sensor: keystrokes, pastes and what they carried, restitutions, and the silences.
const total = (runs) => runs.reduce((sum, [, n]) => sum + n, 0);
const ofKind = (runs, ...kinds) => runs.filter(([kind]) => kinds.includes(kind));

function deduced(runs) {
    const pastes = ofKind(runs, 'paste');
    return {
        keys: total(ofKind(runs, 'type', 'erase', 'nav', 'other')),
        pastes: pastes.length,
        pasted: total(pastes.filter(([, n]) => n > 15)),
        restitutions: ofKind(runs, 'self').length,
        restituted: total(ofKind(runs, 'self')),
        gaps: Array.from(ofKind(runs, 'gap'), ([, ms]) => ms),
    };
}

function sensor() {
    const time = clock();
    const queued = [];
    // The engine document the sensor wrote into the file, so the next editor finds it.
    const stamped = [];
    let paused = false;
    // Measurement belongs to a session: the add-in stops counting when the student signs out,
    // exactly as it does when they suspend it. The ordinary case here is a student signed in.
    let signedIn = true;
    // What Word hands back when the sensor reads the document, and how far the wall clock was
    // set back since the test began.
    let documentText = '';
    let rewound = 0;
    // Timers the test drives. The add-in hashes a selection on a later turn and only once it has
    // settled, so `clearTimeout` has to cancel for real — otherwise the test would pay for work
    // the student's machine never does — and the delay says which timer is which.
    const timers = new Map();
    let nextTimer = 0;
    const globals = {
        ...officeGlobals(time),
        // The monotonic clock, which the sensor reads beside the wall clock at every event. It
        // runs with the test's clock and from another origin, as the real one does; `rewind`
        // moves the wall clock alone, which is what setting a machine's time back does.
        performance: { now: () => time.now - MONO_ORIGIN + rewound },
        // A session is named at random: the platform's own generator, not a double.
        crypto: globalThis.crypto,
        Word: { run: () => Promise.resolve(documentText) },
        setTimeout: (fn, ms) => {
            timers.set(++nextTimer, { fn, ms });
            return nextTimer;
        },
        clearTimeout: (id) => timers.delete(id),
        isPaused: () => paused,
        measuring: () => !paused && signedIn,
        enqueue: (item) => queued.push(item),
        stampEngineDocument: (id) => stamped.push(id),
        documentName: () => 'Mémoire.docx',
        documentSource: () => 'https://example.sharepoint.com/Documents/Mémoire.docx',
        noteTitle: () => {},
    };
    const internals = load(new URL('../src/sensor.js', import.meta.url), { globals, expose: INTERNALS });
    return {
        time,
        queued,
        stamped,
        internals,
        // The deferred work owed at a given delay, run as the next turn would run it. The idle
        // flush waits on a timer too, and a test that wants one asks for it by name.
        runTimers(ms) {
            for (const [id, timer] of [...timers]) {
                if (timer.ms !== ms) continue;
                timers.delete(id);
                timer.fn();
            }
        },
        // How many selections are waiting to be hashed: one per press would be one too many.
        get pendingSelections() {
            let count = 0;
            for (const timer of timers.values()) {
                if (timer.ms === SELECTION_SETTLE_MS) count++;
            }
            return count;
        },
        pause(on = true) {
            paused = on;
        },
        signOut(out = true) {
            signedIn = !out;
        },
        // The student selects a block, and the turn that hashes it comes round. Office raises
        // the selection; the Ctrl+C that follows it raises nothing at all.
        selects(text) {
            internals.rememberSelection(text);
            this.runTimers(SELECTION_SETTLE_MS);
        },
        // `events`: one timestamp per local event Word signalled before the re-read.
        // As when Word drives it, the text just read is the one in hand while it is analysed.
        edit(before, after, eventCount = 1) {
            const events = [];
            for (let i = 0; i < eventCount; i++) events.push(this.event(0.15));
            internals.previousText = after;
            internals.analyse(before, after, events);
        },
        // One local event as the sensor notes it, `seconds` after the previous one: the same
        // instant on both clocks.
        event(seconds) {
            const at = time.advance(seconds);
            return { at, mono: globals.performance.now() };
        },
        // The whole path, as Word drives it: `eventCount` local events, then the re-read that
        // finds `text`. Without events it is the baseline re-read — a co-author's edit, or the
        // document read while the measurement is suspended.
        async read(text, eventCount = 0) {
            documentText = text;
            const events = [];
            for (let i = 0; i < eventCount; i++) events.push(this.event(0.15));
            internals.pendingEvents = events;
            await internals.readText();
        },
        // The student sets the machine's clock back: the wall clock moves, the other does not.
        rewind(seconds) {
            time.advance(-seconds);
            rewound += seconds * 1000;
        },
        // The open window, read the way the engine reads a sealed one: what the sensor
        // classified, and what the runs add up to. The sensor keeps no count of keystrokes or
        // pastes beside its runs, so neither does the test.
        get counters() {
            const { runs, corrections, reformulations, revisions, jumps } = internals.measure;
            return { corrections, reformulations, revisions, jumps, ...deduced(runs) };
        },
    };
}

test('the difference between two reads', async (t) => {
    const { difference } = load(new URL('../src/sensor.js', import.meta.url), { globals: officeGlobals(clock()), expose: INTERNALS });
    // The difference is minimal: it shares the longest prefix and the longest suffix, so
    // "chat" → "chien" costs only "at" → "ien". That is what gets counted as keystrokes.
    const diff = (before, after) => {
        const { deleted, inserted } = difference(before, after);
        return `${deleted}|${inserted}`;
    };

    await t.test('an insertion in the middle', () => {
        assert.equal(diff('le chat dort', 'le grand chat dort'), '|grand ');
    });

    await t.test('a deletion in the middle', () => {
        assert.equal(diff('le grand chat dort', 'le chat dort'), 'grand |');
    });

    await t.test('a replacement costs only what differs', () => {
        assert.equal(diff('le chat dort', 'le chien dort'), 'at|ien');
    });

    await t.test('an addition at the end of the text', () => {
        assert.equal(diff('bonjour', 'bonjour !'), '| !');
    });

    await t.test('no change at all', () => {
        assert.equal(diff('identique', 'identique'), '|');
    });

    await t.test('a text entirely replaced', () => {
        assert.equal(diff('avant', 'après'), 'vant|près');
    });

    await t.test('a repetition does not make the bounds drift', () => {
        assert.equal(diff('aaa', 'aa'), 'a|');
    });

    await t.test('an insertion into an empty text', () => {
        assert.equal(diff('', 'bonjour'), '|bonjour');
    });

    await t.test('a document entirely erased', () => {
        assert.equal(diff('bonjour', ''), 'bonjour|');
    });
});

test('what the difference makes count', async (t) => {
    await t.test('an unchanged text is a move', () => {
        const s = sensor();
        s.edit('le chat dort', 'le chat dort', 2);
        assert.equal(s.counters.jumps, 2);
        assert.equal(s.counters.keys, 0);
    });

    await t.test('a few characters inserted are keystrokes', () => {
        const s = sensor();
        s.edit('le chat', 'le chat dort', 5);
        assert.equal(s.counters.keys, 5);
        assert.equal(s.counters.pastes, 0);
    });

    await t.test('many characters for few events is a paste', () => {
        const s = sensor();
        s.edit('', 'x'.repeat(400), 1);
        assert.equal(s.counters.pastes, 1);
        assert.equal(s.counters.pasted, 400);
        assert.equal(s.counters.keys, 0);
    });

    await t.test('a deletion while typing is an immediate correction', () => {
        const s = sensor();
        s.edit('le chat', 'le cha', 1);
        assert.equal(s.counters.corrections, 1);
        assert.equal(s.counters.revisions, 0);
    });

    await t.test('a deletion after a move is a deferred reformulation', () => {
        const s = sensor();
        s.edit('le chat dort', 'le chat dort', 1);  // a move on its own
        s.edit('le chat dort', 'le chat dor', 1);
        assert.equal(s.counters.reformulations, 1);
        assert.equal(s.counters.corrections, 0);
    });

    // One gesture, one revision. Taking a word out used to arrive as one reformulation *per
    // character*, which is how the counter could be large for a trivial edit and empty for a
    // real one. The length alone is enough: past a word's worth, nobody is repairing a mis-hit
    // letter.
    await t.test('a deletion is one revision, whatever its length', () => {
        const s = sensor();
        s.edit('le chat dort', 'le chat dort', 1);  // a move on its own
        s.edit('le chat dort', 'le chat', 1);       // five characters, after the move
        assert.equal(s.counters.reformulations, 1);
        assert.equal(s.counters.corrections, 0);
    });

    // Backspace hammered through a phrase lands over several differences when the student is
    // slower than the poll: the run is still one gesture, read once past a word's worth, as it
    // is one press at a time in the browser.
    await t.test('single-character deletions in a row are one reformulation past a word', () => {
        const s = sensor();
        let text = 'abcdefghij';
        for (let i = 0; i < 9; i++) {
            const next = text.slice(0, -1);
            s.edit(text, next, 1);
            text = next;
        }
        assert.equal(s.counters.corrections, 5);
        assert.equal(s.counters.reformulations, 1);
        assert.equal(s.counters.revisions, 0);
    });

    await t.test('a word taken out on the spot is a reformulation, not seven corrections', () => {
        const s = sensor();
        s.edit('le chat dormait', 'le chat', 1);
        assert.equal(s.counters.reformulations, 1);
        assert.equal(s.counters.corrections, 0);
        assert.equal(s.counters.revisions, 0);
    });

    await t.test('an insertion after a trip is a reformulation', () => {
        const s = sensor();
        s.edit('le chat dort', 'le chat dort', 2);  // two moves, no text touched
        s.edit('le chat dort', 'le gros chat dort', 1);
        assert.equal(s.counters.reformulations, 1);
        assert.equal(s.counters.corrections, 0);
    });

    await t.test('a one-character nudge leaves an insertion alone', () => {
        const s = sensor();
        s.edit('le chat dort', 'le chat dort', 1);  // a single move: a nudge
        s.edit('le chat dort', 'le chat dorts', 1);
        assert.equal(s.counters.reformulations, 0);
        assert.equal(s.counters.corrections, 0);
    });

    await t.test('a wide deletion is a mass revision, counted once', () => {
        const s = sensor();
        s.edit('a'.repeat(200), '', 1);
        assert.equal(s.counters.revisions, 1);
        assert.equal(s.counters.corrections, 0);
    });

    await t.test('deleting a selection is a mass revision, even a short one', () => {
        const s = sensor();
        s.internals.rangeSelected = true;
        s.edit('le chat dort', 'le  dort', 1);
        assert.equal(s.counters.revisions, 1);
        assert.equal(s.counters.corrections, 0);
    });

    await t.test('the selection only counts for the edit that follows it', () => {
        const s = sensor();
        s.internals.rangeSelected = true;
        s.edit('le chat dort', 'le  dort', 1);
        s.edit('le  dort', 'le dort', 1);
        assert.equal(s.counters.revisions, 1);
        assert.equal(s.counters.corrections, 1);
    });
});

// A `gap` is a silence between two *typed* differences, at its real length. A caret move and a
// paste end no silence: neither is a keystroke.
test('a silence is recorded between two typed differences', async (t) => {
    await t.test('resuming typing after ten seconds is one gap, of that length', () => {
        const s = sensor();
        s.edit('a', 'ab');
        s.time.advance(10);
        s.edit('ab', 'abc');
        assert.deepEqual(s.counters.gaps, [10150]);
    });

    await t.test('a silence ended by a caret move or a paste is not one', () => {
        const s = sensor();
        s.edit('a', 'ab');
        s.time.advance(10);
        s.edit('ab', 'ab');                       // the caret moved, the text did not
        s.time.advance(10);
        s.edit('ab', 'ab' + 'x'.repeat(500));     // an injection
        assert.deepEqual(s.counters.gaps, []);
        assert.equal(s.counters.keys, 1);
    });

    await t.test('the silence spent clicking is still one silence when typing resumes', () => {
        const s = sensor();
        s.edit('a', 'ab');
        s.time.advance(10);
        s.edit('ab', 'ab');
        s.time.advance(10);
        s.edit('ab', 'abc');
        assert.deepEqual(s.counters.gaps, [20300], 'one thought, not two');
    });

    await t.test('one difference records at most one, however many events it carries', () => {
        const s = sensor();
        s.edit('a', 'ab');
        const events = [s.event(10), s.event(10), s.event(10)];
        s.internals.analyse('ab', 'abc', events);
        // From the last typed difference to the first event of this one: the rest is the
        // difference being typed.
        assert.deepEqual(s.counters.gaps, [10000]);
    });

    // Office delivers no keystroke: under three seconds, what is measured is the spacing of
    // Word's events. The engine is told so, and reads no word search from this agent.
    await t.test('three seconds or less is not resolved, and is not recorded', () => {
        const s = sensor();
        s.edit('a', 'ab');
        s.internals.analyse('ab', 'abc', [s.event(3)]);
        assert.deepEqual(s.counters.gaps, []);
        s.internals.analyse('abc', 'abcd', [s.event(3.001)]);
        assert.deepEqual(s.counters.gaps, [3001]);
    });

    // The length is the fact; reading a pause or a departure in it is the engine's.
    await t.test('a silence is never capped', () => {
        const s = sensor();
        s.edit('a', 'ab');
        s.internals.analyse('ab', 'abc', [s.event(7200)]);
        assert.deepEqual(s.counters.gaps, [7200000]);
    });

    // A duration must not move with the machine's time.
    await t.test('it is measured on the monotonic clock', () => {
        const s = sensor();
        s.edit('a', 'ab');
        s.rewind(3600);
        s.internals.analyse('ab', 'abc', [s.event(10)]);
        assert.deepEqual(s.counters.gaps, [10000]);
    });
});

test('the window sent to the queue', async (t) => {
    await t.test('carries numbers and categories, never the text', () => {
        const s = sensor();
        s.edit('le chat', 'le chat dort', 5);
        s.internals.flush('idle');
        assert.equal(s.queued.length, 1);
        const [window] = s.queued;
        assert.deepEqual(JSON.parse(JSON.stringify(window.runs)), [['type', 5, 0]]);
        assert.deepEqual({ ...window.text }, { len: 12 });
        assert.ok(!JSON.stringify(window).includes('le chat'), 'no excerpt of the document must go out');
    });

    await t.test('has neither rhythm nor departures from the document (Word gives neither)', () => {
        const s = sensor();
        s.edit('le chat', 'le chat dort', 5);
        s.internals.flush('idle');
        const [window] = s.queued;
        assert.ok(!('flight' in window) && !('dwell' in window));
        assert.deepEqual(Object.keys(window.counts), ['corrections', 'reformulations', 'revisions', 'jumps']);
    });

    // Nothing the engine deduces from the runs travels beside them.
    await t.test('holds exactly the window the engine reads, and where it goes', () => {
        const s = sensor();
        s.edit('le chat', 'le chat dort', 5);
        s.internals.flush('idle');
        assert.deepEqual(Object.keys(s.queued[0]), ['documentId', 'documentName', 'documentSource',
            'session', 'seq', 'at', 'mono', 'ms', 'why', 'active', 'runs', 'counts', 'text', 'sum']);
    });

    await t.test('a move on its own triggers no send', () => {
        const s = sensor();
        s.edit('le chat dort', 'le chat dort', 2);
        s.internals.flush('idle');
        assert.equal(s.queued.length, 0);
    });

    // The moves carry over to the window that follows, but not the time spent making them: a
    // window never reports more effective time than it lasted, which the engine refuses.
    await t.test('moves carried over bring their count, not their time', () => {
        const s = sensor();
        s.edit('le chat dort', 'le chat dort', 30);     // 4.35 s of walking through the text
        s.internals.flush('idle');
        s.time.advance(20);
        s.edit('le chat dort', 'le chat dort !', 2);
        s.internals.flush('idle');
        const [window] = s.queued;
        assert.equal(window.counts.jumps, 30);
        assert.deepEqual(JSON.parse(JSON.stringify(window.runs)), [['move', 30], ['type', 2, 0]]);
        assert.equal(window.ms, 1000);
        assert.equal(window.active, 150);
    });
});

// A student's paragraph, and what a spell-checker gives back. The first and last words are
// touched, so that the difference spans the whole text — a correction limited to the middle
// never reaches the sensor as a paste, since the diff narrows down to what actually changed.
// The browser and LibreOffice suites run the same cases on the same texts.
const WRITTEN = `La mesure de la rédaction repose sur des compteurs et jamais sur le texte lui même.
Chaque fenêtre de mesure part vers le moteur avec sa période et ses valeurs.
L'étudiant garde son texte sur son poste, ce qui est la promesse du produit.
Aucune touche n'est enregistrée et aucun caractère ne quitte l'ordinateur de l'étudiant.
Les quatre agents partagent la même définition des mesures et chacun l'implémente seul.`;

const CORRECTED = `Les mesures de la rédaction reposent sur des compteurs et jamais sur le texte lui-même.
Chaque fenêtre de mesure part vers le moteur avec sa période et ses valeurs.
L'étudiant garde son texte sur son poste, ce qui est la promesse du produit.
Aucune touche n'est enregistrée et aucun caractère ne quitte l'ordinateur de l'étudiant.
Les quatre agents partagent la même définition des mesures et chacun l'implémente seuls !`;

const FOREIGN = `L'intelligence artificielle transforme radicalement les méthodes de travail
contemporaines dans presque tous les secteurs économiques connus, et cette évolution rapide
soulève des questions inédites pour les établissements d'enseignement supérieur français !`;

test('text run through a corrector is not an injection', async (t) => {
    await t.test('replacing one\'s text with its corrected version is a revision', () => {
        const s = sensor();
        s.edit(WRITTEN, CORRECTED, 1);
        assert.equal(s.counters.pastes, 0, 'this is not a paste of foreign text');
        assert.equal(s.counters.pasted, 0, 'one\'s own words are not an injection');
        assert.equal(s.counters.revisions, 1);
        assert.equal(s.counters.keys, 1, 'the replaced block counts as one keystroke');
    });

    await t.test('erased then pasted back corrected: still a revision', () => {
        const s = sensor();
        s.edit(WRITTEN, '', 1);
        s.edit('', CORRECTED, 1);
        assert.equal(s.counters.pastes, 0);
        assert.equal(s.counters.pasted, 0);
        assert.equal(s.counters.revisions, 2, 'the deletion, then the restitution');
    });

    await t.test('a couple of words moved inside the document is not an injection', () => {
        // The four-word floor used to drop short copies: a phrase moved from one sentence to
        // another had left no fingerprint, and came back as someone else's text.
        const s = sensor();
        s.edit('developpement durable', '', 1);
        s.edit('', 'developpement durable', 1);
        assert.equal(s.counters.pastes, 0);
        assert.equal(s.counters.pasted, 0);
        assert.equal(s.counters.restitutions, 1);
    });

    await t.test('replacing one\'s text with foreign text stays an injection', () => {
        const s = sensor();
        s.edit(WRITTEN, FOREIGN, 1);
        assert.equal(s.counters.pastes, 1);
        assert.ok(s.counters.pasted > 0);
    });

    await t.test('with nothing erased, a paste is an injection', () => {
        const s = sensor();
        s.edit('', CORRECTED, 1);
        assert.equal(s.counters.pastes, 1);
        assert.ok(s.counters.pasted > 0);
    });

    await t.test('pasted back several times, one\'s own text never becomes a paste', () => {
        const s = sensor();
        s.edit(WRITTEN, '', 1);
        s.edit('', CORRECTED, 1);
        s.time.advance(500);
        s.edit('', CORRECTED, 1);
        s.time.advance(500);
        s.edit('', CORRECTED, 1);
        assert.equal(s.counters.pastes, 0, 'the same block, put back three times, stays theirs');
        assert.equal(s.counters.pasted, 0);
        assert.equal(s.counters.revisions, 2, 'the deletion, then a single revision');
        assert.equal(s.counters.keys, 4, 'each block put back counts as one keystroke');
    });

    await t.test('the ten minutes run from the last paste, not from the deletion', () => {
        const s = sensor();
        s.edit(WRITTEN, '', 1);
        s.time.advance(500);
        s.edit('', CORRECTED, 1);
        s.time.advance(2000);       // more than an hour after the deletion
        s.edit('', CORRECTED, 1);
        assert.equal(s.counters.pastes, 0, 'what is still in use stays comparable');
    });

    await t.test('past the hour, the erased text is no longer recognised', () => {
        const s = sensor();
        s.edit(WRITTEN, '', 1);
        s.time.advance(3601);
        s.edit('', CORRECTED, 1);
        assert.equal(s.counters.pastes, 1);
    });
});

test('the biggest paste, and the restitution counted for itself', async (t) => {
    const text = 'le capteur observe la manière dont un document est écrit, jamais le texte lui-même : il compte les frappes, les pauses et les corrections, et c\'est tout ce qui part vers le moteur';

    // The rule the four agents share: what comes from elsewhere is weighed in characters, never
    // in keystrokes. This agent never saw a key, so it has always counted it that way; the
    // assertion is here because the browser and LibreOffice have only just joined it.
    await t.test('an injection is no keystroke at all', () => {
        const s = sensor();
        s.edit('', 'x'.repeat(400));
        assert.equal(s.counters.pastes, 1);
        assert.equal(s.counters.pasted, 400);
        assert.equal(s.counters.keys, 0);
    });

    await t.test('each paste is a run of its own size, never added to its neighbour', () => {
        // Twenty pastes of a hundred characters and a single one of two thousand give the same
        // total: the runs are what says something arrived in one block.
        const s = sensor();
        s.edit('', 'x'.repeat(100));
        s.edit('x'.repeat(100), 'x'.repeat(100) + 'y'.repeat(2000));
        assert.deepEqual(JSON.parse(JSON.stringify(s.internals.measure.runs)), [['paste', 100], ['paste', 2000]]);
    });

    await t.test('a restitution is counted for itself', () => {
        // Without this run, the engine sees a mass revision without being able to tell
        // whether the student rewrote their paragraph by hand or ran it through a corrector.
        const s = sensor();
        s.edit(text, '');                       // the paragraph goes off to the corrector
        s.edit('', text.replace('manière', 'façon'));   // it comes back corrected
        assert.equal(s.counters.restitutions, 1);
        assert.equal(s.counters.pasted, 0);
    });

    await t.test('a restitution is counted in characters as well as in gestures', () => {
        // The volume a restitution carries is the volume it would have been accused of: the same
        // text, inserted by somebody who never wrote it, counts exactly that many injected
        // characters. Four restitutions say nothing about whether a paragraph or a third of the
        // document came back, and only the size of the run does.
        const corrected = text.replace('manière', 'façon');

        const stranger = sensor();
        stranger.edit('', corrected);

        const s = sensor();
        s.edit(text, '');
        s.edit('', corrected);
        assert.equal(s.counters.restitutions, 1);
        assert.equal(s.counters.restituted, stranger.counters.pasted);
        assert.ok(s.counters.restituted > 0);
        assert.equal(s.counters.pasted, 0, 'and it is still not an injection');
    });

    await t.test('a foreign text is not', () => {
        const s = sensor();
        s.edit(text, '');
        s.edit('', 'une réponse entièrement rédigée ailleurs, qui ne reprend rien de ce qui précède');
        assert.equal(s.counters.restitutions, 0);
        assert.equal(s.counters.pastes, 1);
    });
});

test('a copy leaves no event, but the selection it was made on does', async (t) => {
    const sentence = 'la mesure ne dit rien du contenu : elle décrit la manière dont le document a été écrit, et c\'est tout ce qui part vers le moteur';
    const document = `Introduction. ${sentence} Suite du propos.`;

    // The most ordinary gesture there is, and the one this agent could not see: copy a sentence
    // of your own and paste it again further down. Office raises no clipboard event, so nothing
    // was remembered and the paste was counted as text imported from outside — on a document
    // that duplicated enough of itself, the certificate then said it had never been typed.
    await t.test('a sentence pasted back is the student\'s own text', () => {
        const s = sensor();
        s.selects(sentence);
        s.edit(document, `${document} ${sentence}`);
        assert.equal(s.counters.pasted, 0, 'it was already in the document');
        assert.equal(s.counters.pastes, 0);
        assert.equal(s.counters.restitutions, 1);
    });

    // And again, and again: the paragraph was not revised three times, it was duplicated.
    await t.test('the same block pasted again stays the student\'s own', () => {
        const s = sensor();
        s.selects(sentence);
        let text = document;
        for (let i = 0; i < 3; i++) {
            const after = `${text} ${sentence}`;
            s.edit(text, after);
            text = after;
        }
        assert.equal(s.counters.pasted, 0);
        assert.equal(s.counters.restitutions, 3);
        assert.equal(s.counters.revisions, 1, 'the first lands as a revision, the rest are duplications');
    });

    // Re-selecting the block before pasting it again is the same gesture, not a new copy: most
    // people select and press Ctrl+C again rather than trust what is in the clipboard. Kept as a
    // new entry, the block would arrive with its history erased — never restituted, hence revised
    // again — and the engine would read two mass revisions where the rule says one.
    await t.test('selecting it a second time does not revise it a second time', () => {
        const s = sensor();
        s.selects(sentence);
        const once = `${document} ${sentence}`;
        s.edit(document, once);
        s.selects(sentence);
        s.edit(once, `${once} ${sentence}`);
        assert.equal(s.counters.restitutions, 2);
        assert.equal(s.counters.revisions, 1, 'revised once, then duplicated');
        assert.equal(s.internals.ownText.length, 1, 'one block, one entry');
    });

    // Nothing selected, nothing remembered: a text that never was in the document is still an
    // injection, which is what keeps the rule from being a way out.
    await t.test('a foreign text is not excused by a selection made elsewhere', () => {
        const s = sensor();
        s.selects(sentence);
        s.edit(document, `${document} une réponse entièrement rédigée ailleurs, qui ne reprend rien du document`);
        assert.equal(s.counters.restitutions, 0);
        assert.equal(s.counters.pastes, 1);
    });

    // A selection extended with Shift+Arrow raises one event per press. Hashing each read would
    // pay for the whole block again at every keystroke — 137 ms for a dissertation selected
    // whole, on a machine faster than the student's — and would fill the twenty slots with the
    // prefixes of a single paragraph. It is hashed once, when it stops moving.
    await t.test('a selection being extended is hashed once, and kept once', () => {
        const s = sensor();
        for (let end = 20; end <= sentence.length; end += 20) s.internals.rememberSelection(sentence.slice(0, end));
        s.internals.rememberSelection(sentence);
        assert.equal(s.pendingSelections, 1, 'one turn owed, not one per press');
        s.runTimers(SELECTION_SETTLE_MS);
        assert.equal(s.internals.ownText.length, 1);
    });

    // Suspending the measurement counts nothing and keeps nothing. A selection made just before
    // the click must not land behind it.
    await t.test('a selection that settles during a pause is dropped', () => {
        const s = sensor();
        s.internals.rememberSelection(sentence);
        s.pause();
        s.runTimers(SELECTION_SETTLE_MS);
        assert.equal(s.internals.ownText.length, 0);
    });

    // A selection too short to be a block is not a copy worth remembering: one fingerprint over
    // three words can only ever match a paste just as short.
    await t.test('a short selection is not remembered', () => {
        const s = sensor();
        s.selects('deux mots');
        assert.equal(s.internals.ownText.length, 0);
    });
});

test('the fingerprints are a contract between the four agents', async (t) => {
    // A restitution is only recognised if the four agents hash the same text onto the same
    // number. These values are those of `browser/src/content.js` and of
    // `libreoffice/.../measure.py`: pinned here so that a rewrite of `hashShingle` cannot move
    // them silently in a single one of the three.
    const { shingles, codePoints } = load(new URL('../src/sensor.js', import.meta.url),
        { globals: officeGlobals(clock()), expose: INTERNALS });

    await t.test('four words give a known fingerprint', () => {
        assert.deepEqual([...shingles('Le candidat developpe une')], [1761045176]);
    });

    await t.test('case, accents and punctuation do not move it', () => {
        assert.deepEqual([...shingles('LE CANDIDAT DÉVELOPPÉ UNE')], [1761045176]);
        assert.deepEqual([...shingles('le, candidat; developpe  une!')], [1761045176]);
    });

    await t.test('the window slides by one word', () => {
        assert.deepEqual([...shingles('le candidat developpe une argumentation')],
            [1761045176, 821320551]);
    });

    await t.test('fewer than four words are hashed whole', () => {
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
        // The engine counts a submitted copy the same way.
        for (const text of ['', 'abc', 'a😀b', '😀😀', 'été', '\uD83D', 'x\uD83Dy']) {
            assert.equal(codePoints(text), [...text].length, JSON.stringify(text));
        }
    });
});

// A window is not a burst of typing: it is a span the agent decided to close, and the engine
// cannot tell its triggers apart on its own. This add-in has the fewest of them — Office does
// not signal the document losing focus, so it never reports a departure — and the words it
// sends are the four agents' shared vocabulary.
test('why the window was sealed travels with it', async (t) => {
    await t.test('the writer stopping, and the counter stopping, are not the same word', () => {
        const s = sensor();
        s.edit('', 'bonjour');
        s.internals.flush('idle');
        assert.equal(s.queued.at(-1).why, 'idle');

        s.edit('bonjour', 'bonjour tout le monde');
        s.internals.flush('volume');
        assert.equal(s.queued.at(-1).why, 'volume');
    });

    await t.test('suspending the measurement, signing out and closing the pane end the sitting', () => {
        for (const trigger of ['pause', 'logout', 'pagehide']) {
            const s = sensor();
            s.edit('', 'bonjour');
            s.internals.flush(trigger);
            assert.equal(s.queued.at(-1).why, 'end', trigger);
            assert.equal(s.internals.session, null);
        }
    });
});


// Signing out revokes the token at the engine. What the student writes afterwards belongs to no
// account, and the queue — shared by every document open in this Word, on one origin — would
// hold it for whichever account pairs next, which would then send it under its own bearer. The
// sensor asks the same question for a sign-out as for a suspension, and in the same place.
test('nothing is measured outside a session', async (t) => {
    const sentence = 'Un bloc de texte assez long pour être retenu comme une copie de l\'étudiant.';

    await t.test('a selection that settles after a sign-out is dropped', () => {
        const s = sensor();
        s.internals.rememberSelection(sentence);
        s.signOut();
        s.runTimers(SELECTION_SETTLE_MS);
        assert.equal(s.internals.ownText.length, 0);
    });

    await t.test('and is kept again once another account has paired', () => {
        const s = sensor();
        s.signOut();
        s.internals.rememberSelection(sentence);
        s.signOut(false);
        s.runTimers(SELECTION_SETTLE_MS);
        assert.ok(s.internals.ownText.length > 0);
    });
});

// --- the window, as the engine holds it against itself ---
//
// The engine deduces its counts from the runs and checks the window against itself: durations
// against the window's, the text against the previous one, the session's totals against what
// its windows hold. So the relations are not checked on one hand-picked window: they are checked
// on every window of every scripted sitting below, by the one function that states them.
const PASSAGE = 'Un passage venu d\'ailleurs, bien plus long qu\'une frappe ne peut l\'être.';
const OWN = 'Le texte que l\'étudiant avait écrit lui-même, avant de le couper pour le reprendre.';
const plain = (value) => JSON.parse(JSON.stringify(value));
const KEYED = ['type', 'erase', 'other'];
const INSTANT = ['move', 'paste', 'self'];

function assertRelations(window) {
    const { runs } = window;
    assert.ok(runs.length > 0, 'a sealed window holds something');
    assert.ok(runs.length <= 512, 'the engine refuses more than 512 runs');
    // Three shapes, by kind — and this sensor has no duration to give a keystroke run.
    for (const run of runs) {
        const [kind, n, ms] = run;
        if (kind === 'gap') {
            assert.equal(run.length, 2);
            assert.ok(Number.isInteger(n) && n > 3000, 'only a silence of more than 3 s is recorded');
        } else if (KEYED.includes(kind)) {
            assert.equal(run.length, 3);
            assert.ok(Number.isInteger(n) && n > 0);
            assert.equal(ms, 0);
        } else {
            assert.ok(INSTANT.includes(kind), `kind ${kind}`);
            assert.equal(run.length, 2);
            assert.ok(Number.isInteger(n) && n > 0);
        }
    }
    runs.forEach(([kind], i) => {
        if (i === 0 || kind === 'gap' || kind === 'paste' || kind === 'self') return;
        assert.notEqual(kind, runs[i - 1][0], 'two runs of the same kind in a row are one run');
    });
    // A window is sealed for a keystroke or a paste, never for moves alone.
    const { keys, pastes } = deduced(runs);
    assert.ok(keys > 0 || pastes > 0);
    // A caret move is a run and no keystroke, and each one is a jump.
    assert.equal(total(ofKind(runs, 'move')), window.counts.jumps);
    // Only the head gap may lie outside the window.
    const inside = runs.slice(runs[0][0] === 'gap' ? 1 : 0);
    assert.ok(total(ofKind(inside, 'gap')) <= window.ms + 1000);
    for (const field of ['seq', 'at', 'mono', 'ms', 'active']) {
        assert.ok(Number.isInteger(window[field]) && window[field] >= 0, field);
    }
    assert.ok(window.ms >= 1000);
    assert.ok(window.active <= window.ms + 1000, 'the engine refuses more effective time than the window lasted');
    assert.ok(['idle', 'volume', 'end'].includes(window.why));
    for (const count of Object.values(window.counts)) assert.ok(Number.isInteger(count) && count >= 0);
    assert.ok(Number.isInteger(window.text.len));
}

// The totals of a session are the sum of what its windows hold, at every window.
function assertSession(windows) {
    const sum = { keys: 0, chars: 0, pastes: 0 };
    windows.forEach((window, i) => {
        assertRelations(window);
        assert.equal(window.session, windows[0].session);
        assert.equal(window.seq, i);
        const held = deduced(window.runs);
        sum.keys += held.keys;
        sum.chars += held.pasted;
        sum.pastes += held.pastes;
        assert.deepEqual({ ...window.sum }, sum);
    });
}

test('the runs say what happened, in order', async (t) => {
    await t.test('a sitting of typing, thinking, moving, erasing and pasting', () => {
        const s = sensor();
        s.edit('', 'Bonjour', 7);
        s.time.advance(5);                                  // thinking
        s.edit('Bonjour', 'Bonjour tout', 5);
        s.edit('Bonjour tout', 'Bonjour tout', 3);          // the caret walks back
        s.edit('Bonjour tout', 'Bonjour tou');              // and something is erased there
        s.edit('Bonjour tou', 'Bonjour tous');
        s.edit('Bonjour tous', 'Bonjour tous' + PASSAGE);   // pasted from elsewhere
        s.edit('Bonjour tous' + PASSAGE, 'Bonjour tous' + PASSAGE + '\r');
        s.internals.flush('idle');

        const [window] = s.queued;
        assertRelations(window);
        assert.deepEqual(plain(window.runs), [
            ['type', 7, 0], ['gap', 5150], ['type', 5, 0], ['move', 3], ['erase', 1, 0], ['type', 1, 0],
            ['paste', PASSAGE.length], ['type', 1, 0],
        ]);
        // Moving through the text is not a keystroke here: the three moves are one `move` run,
        // which the keystroke sum leaves out.
        assert.deepEqual(plain(window.counts), { corrections: 0, reformulations: 1, revisions: 0, jumps: 3 });
        assert.deepEqual(plain(window.sum), { keys: 15, chars: PASSAGE.length, pastes: 1 });
    });

    await t.test('a restitution is a run of its own, and the keystroke it is scored as', () => {
        const s = sensor();
        s.edit('Début. ' + OWN, 'Début. ');                 // cut
        s.edit('Début. ', 'Début. ' + OWN);                 // and brought back
        s.selects(OWN);
        s.edit('Début. ' + OWN, 'Début. ' + OWN + ' ' + OWN);   // then duplicated: nothing replaced
        s.internals.flush('idle');

        const [window] = s.queued;
        assertRelations(window);
        assert.deepEqual(plain(window.runs), [
            ['erase', 1, 0], ['self', OWN.length], ['other', 1, 0],
            ['self', OWN.length + 1], ['other', 1, 0],
        ]);
        // One's own text coming back is no paste and injects nothing.
        assert.deepEqual(plain(window.sum), { keys: 3, chars: 0, pastes: 0 });
    });

    await t.test('a window of pastes only', () => {
        const s = sensor();
        s.edit('', PASSAGE);
        s.edit(PASSAGE, PASSAGE + PASSAGE + '!');
        s.internals.flush('idle');

        const [window] = s.queued;
        assertRelations(window);
        assert.deepEqual(plain(window.runs), [['paste', PASSAGE.length], ['paste', PASSAGE.length + 1]]);
        assert.deepEqual(plain(window.sum), { keys: 0, chars: 2 * PASSAGE.length + 1, pastes: 2 });
    });

    await t.test('a silence ended by a move and a paste, then typing, is the head of the window', () => {
        const s = sensor();
        s.edit('', 'Bonjour', 7);
        s.internals.flush('idle');
        s.time.advance(40);
        // What wakes the window is not typing: the silence is still the one before the first
        // typed difference, and it goes first — it is the only run that lies outside the window.
        s.edit('Bonjour', 'Bonjour', 2);
        s.edit('Bonjour', 'Bonjour' + PASSAGE);
        s.edit('Bonjour' + PASSAGE, 'Bonjour' + PASSAGE + ' et la suite', 12);
        s.internals.flush('idle');

        const window = s.queued.at(-1);
        assertRelations(window);
        assert.deepEqual(plain(window.runs),
            [['gap', 40600], ['move', 2], ['paste', PASSAGE.length], ['type', 12, 0]]);
        assert.ok(window.runs[0][1] > window.ms, 'longer than the window it opens');
        assertSession(s.queued);
    });

    await t.test('a head silence of twelve minutes is reported whole', () => {
        const s = sensor();
        s.edit('', 'Bonjour', 7);
        s.internals.flush('idle');
        s.time.advance(720);
        s.edit('Bonjour', 'Bonjour !', 2);
        s.internals.flush('idle');

        const window = s.queued.at(-1);
        assertRelations(window);
        assert.deepEqual(plain(window.runs[0]), ['gap', 720150]);
    });

    await t.test('a silence this sensor cannot vouch for is not a run', () => {
        const s = sensor();
        s.edit('', 'Bon', 3);
        s.time.advance(1.5);
        s.edit('Bon', 'Bonjour', 4);
        s.internals.flush('idle');
        assert.deepEqual(plain(s.queued[0].runs), [['type', 7, 0]]);
    });

    await t.test('the 200-keystroke ceiling seals a window whose relations still hold', () => {
        const s = sensor();
        let text = '';
        for (let i = 0; i < 70; i++) {
            const next = text + 'abc';
            s.edit(text, next, 3);
            if (i % 9 === 8) s.edit(next, text = next.slice(0, -1));
            else text = next;
        }
        s.internals.flush('idle');

        assert.ok(s.queued.length >= 2);
        assert.equal(s.queued[0].why, 'volume');
        assert.ok(deduced(s.queued[0].runs).keys >= 200);
        assertSession(s.queued);
    });

    await t.test('the runs never outgrow what the engine takes: the window is sealed first', () => {
        const s = sensor();
        let text = '';
        // Pastes are one run each and count no keystroke: nothing else would seal this window.
        for (let i = 0; i < 1100; i++) {
            const next = text + PASSAGE;
            s.edit(text, next);
            text = next;
        }
        s.internals.flush('idle');

        assert.equal(s.queued.length, 3);
        assert.ok(s.queued.every((window) => window.runs.length <= 512));
        assert.equal(s.queued[0].why, 'volume');
        assertSession(s.queued);
        // Sealed early, never trimmed: every paste is in a window.
        assert.equal(s.queued.at(-1).sum.pastes, 1100);
        assert.equal(s.queued.reduce((count, window) => count + window.runs.length, 0), 1100);
    });

    await t.test('a run of typing is never cut on what was typed', () => {
        // A run that ended at each space would spell out the length of every word.
        const s = sensor();
        let text = '';
        for (const piece of ['Un', ' ', 'mot', ',', ' ', 'puis', '\r', 'un', ' ', 'autre', '.']) {
            s.edit(text, text + piece, piece.length);
            text += piece;
        }
        s.internals.flush('idle');

        const [window] = s.queued;
        assertRelations(window);
        assert.deepEqual(plain(window.runs), [['type', 22, 0]]);
    });

    await t.test('nothing in it is text', () => {
        const s = sensor();
        s.edit('', 'Bonjour', 7);
        s.edit('Bonjour', 'Bonjour' + PASSAGE);
        s.internals.flush('idle');

        const [window] = s.queued;
        const strings = [];
        JSON.stringify({ ...window, documentName: 0, documentSource: 0 },
            (key, value) => { if (typeof value === 'string') strings.push(value); return value; });
        // The session's name, why the window was sealed, and the kinds of the runs.
        assert.deepEqual(strings.filter((value) => value !== window.session).sort(), ['idle', 'paste', 'type']);
    });
});

test('the windows of a sitting are numbered, and the session adds them up', async (t) => {
    await t.test('a number per sealed window, totals up to it', () => {
        const s = sensor();
        s.edit('', 'Bonjour', 7);
        s.internals.flush('idle');
        s.edit('Bonjour', 'Bonjour' + PASSAGE);
        s.internals.flush('idle');
        // Movements alone seal nothing: no number is spent on a window that does not exist.
        s.edit('Bonjour' + PASSAGE, 'Bonjour' + PASSAGE, 2);
        s.internals.flush('idle');
        s.edit('Bonjour' + PASSAGE, 'Bonjour' + PASSAGE + ' !', 2);
        s.internals.flush('idle');

        assert.deepEqual(s.queued.map((window) => window.seq), [0, 1, 2]);
        assertSession(s.queued);
        assert.deepEqual({ ...s.queued[2].sum }, { keys: 9, chars: PASSAGE.length, pastes: 1 });
    });

    await t.test('the session is named at random, in the URL-safe alphabet', () => {
        const names = new Set();
        for (let i = 0; i < 20; i++) {
            const s = sensor();
            s.edit('', 'a');
            s.internals.flush('idle');
            assert.match(s.queued[0].session, /^[A-Za-z0-9_-]{22}$/);     // 128 bits
            names.add(s.queued[0].session);
        }
        assert.equal(names.size, 20);
    });

    await t.test('resuming after a suspension is another session', () => {
        const s = sensor();
        s.edit('', 'Bonjour', 7);
        s.internals.flush('pause');
        s.edit('Bonjour', 'Bonjour tout', 5);
        s.internals.flush('idle');

        const [before, after] = s.queued;
        assert.notEqual(after.session, before.session);
        assert.deepEqual([before.seq, after.seq], [0, 0]);
        assert.deepEqual({ ...after.sum }, { keys: 5, chars: 0, pastes: 0 });
        // The new session's clock starts with it, and its first window has no text to be
        // compared with.
        assert.equal(after.mono, 0);
        assert.deepEqual({ ...after.text }, { len: 12 });
    });

    // What was last typed belongs to the session before: the time since then covers the
    // suspension, not a writer thinking, and the engine would read it as a pause.
    await t.test('a silence never crosses a session: its first window has no head gap', () => {
        const s = sensor();
        s.edit('', 'Bonjour', 7);
        s.internals.flush('pause');
        s.time.advance(40);
        s.edit('Bonjour', 'Bonjour tout', 5);
        s.time.advance(5);
        s.edit('Bonjour tout', 'Bonjour tout le', 3);
        s.internals.flush('idle');

        const [, resumed] = s.queued;
        assert.equal(resumed.seq, 0);
        // The silence inside the new session is still recorded.
        assert.deepEqual(plain(resumed.runs), [['type', 5, 0], ['gap', 5150], ['type', 3, 0]]);
        assertSession([resumed]);
    });

    await t.test('a suspension decided in another pane closes this one\'s session too', async () => {
        // Every open document has its own sensor and they share the pause, not their memory:
        // this one learns it on its next event or its next read, and seals what it had open.
        const s = sensor();
        await s.read('');
        await s.read('Bonjour', 7);
        s.pause();
        await s.read('Bonjour');                // the baseline read goes on while suspended
        assert.equal(s.queued.length, 1);
        assert.equal(s.queued[0].why, 'end');
        assert.equal(s.internals.session, null);

        s.pause(false);
        await s.read('Bonjour tout', 5);
        s.internals.flush('idle');
        assert.notEqual(s.queued[1].session, s.queued[0].session);
        assert.equal(s.queued[1].seq, 0);
    });

    await t.test('an event during the suspension closes it as well, and counts nothing', () => {
        const s = sensor();
        s.edit('', 'Bonjour', 7);
        s.pause();
        s.internals.noteLocalEvent();
        assert.equal(s.queued.length, 1);
        assert.equal(s.internals.session, null);
        assert.equal(s.internals.pendingEvents.length, 0);
    });
});

test('each window is dated on two clocks', async (t) => {
    await t.test('the monotonic one counts from the start of the session, and gives the duration', () => {
        const s = sensor();
        s.edit('', 'Bonjour', 7);
        s.internals.flush('idle');
        s.time.advance(60);
        s.edit('Bonjour', 'Bonjour tout le monde', 14);
        s.internals.flush('idle');

        const [first, second] = s.queued;
        // 7 events 150 ms apart: 900 ms, held to the second the engine requires of a window.
        assert.deepEqual([first.at, first.mono, first.ms], [1_000_150, 0, 1000]);
        assert.deepEqual([second.at, second.mono, second.ms], [1_061_200, 61050, 1950]);
        // The effective time is the spacing of the events, and never more than the window.
        assert.deepEqual([first.active, second.active], [900, 1950]);
    });

    await t.test('setting the machine\'s clock back moves one and not the other', () => {
        const s = sensor();
        s.edit('', 'Bonjour', 7);
        s.internals.flush('idle');
        s.rewind(600);
        s.time.advance(60);
        s.edit('Bonjour', 'Bonjour tout', 5);
        s.internals.flush('idle');

        const [first, second] = s.queued;
        assert.ok(second.at < first.at);
        assert.ok(second.mono > first.mono + first.ms);
        // A duration is read on the clock that cannot be set: the silence is the minute spent.
        assert.deepEqual(plain(second.runs[0]), ['gap', 60150]);
        assertSession(s.queued);
    });
});

// The text is checked the way the engine checks it — against the size of the window it names —
// and against the texts themselves, which only the test holds.
function assertSpan(windows, texts) {
    windows.forEach((window, i) => {
        if (!('since' in window.text)) {
            assert.deepEqual(Object.keys(window.text), ['len']);
            return;
        }
        const previous = windows[window.text.since];
        const { len, since, at, cut, add } = window.text;
        assert.ok(since < window.seq);
        assert.equal(len, previous.text.len - cut + add);
        assert.ok(at + cut <= previous.text.len);
        assert.ok(at + add <= len);
        if ('kept' in window.text) assert.ok(window.text.kept <= Math.min(cut, add));
        if (!texts) return;
        const before = [...texts[since]];
        const after = [...texts[i]];
        assert.equal(after.length, len);
        assert.equal(before.slice(0, at).join(''), after.slice(0, at).join(''), 'the head is shared');
        assert.equal(before.slice(at + cut).join(''), after.slice(at + add).join(''), 'the tail is shared');
    });
}

test('what the text was, and how far it changed between two windows', async (t) => {
    await t.test('its size alone on the first window, then where, how much went and how much came', async () => {
        const s = sensor();
        await s.read('Le chat dort.');
        await s.read('Le chat dort. Il', 3);
        s.internals.flush('idle');
        await s.read('Le chat dort. Il rêve', 5);
        await s.read('Le chien dort. Il rêve', 4);
        s.internals.flush('idle');

        const [first, second] = s.queued;
        // No window of this session had reported a text before the first one.
        assert.deepEqual({ ...first.text }, { len: 16 });
        // Several reads in between, one span: from the first change to the last.
        assert.deepEqual({ ...second.text }, { len: 22, since: 0, at: 5, cut: 11, add: 17, kept: 6 });
        assertSpan(s.queued, ['Le chat dort. Il', 'Le chien dort. Il rêve']);
    });

    await t.test('a window whose text did not change says so, with zeros', async () => {
        const s = sensor();
        await s.read('Bonjour');
        await s.read('Bonjour !', 2);
        s.internals.flush('idle');
        await s.read('Bonjour ?', 2);
        await s.read('Bonjour !', 2);       // put back as it was: counted, and the text is the same
        s.internals.flush('idle');
        await s.read('Bonjour !' + PASSAGE, 1);
        s.internals.rangeSelected = true;
        await s.read('Bonjour !', 1);
        s.internals.flush('idle');

        const [, second, third] = s.queued;
        // The window is compared with the text the previous one reported, not with the reads
        // in between: an edit undone has left nothing.
        assert.deepEqual({ ...second.text }, { len: 9, since: 0, at: 9, cut: 0, add: 0, kept: 0 });
        assert.deepEqual({ ...third.text }, { len: 9, since: 1, at: 9, cut: 0, add: 0, kept: 0 });
        assertSpan(s.queued, ['Bonjour !', 'Bonjour !', 'Bonjour !']);
    });

    await t.test('lengths are counted the way the size is', async () => {
        // Code points, and none of Word's structural characters: otherwise the previous size,
        // less what went, plus what came, would not be the new one.
        const s = sensor();
        await s.read('Titre\rUn 😀 ici\r');
        await s.read('Titre\rUn 😀 ici\rx', 1);
        s.internals.flush('idle');
        // Two characters that share their first half: the shared head must not end inside one.
        await s.read('Titre\rUn 😁 ici\r\rxy', 3);
        s.internals.flush('idle');

        const [first, second] = s.queued;
        assert.deepEqual({ ...first.text }, { len: 14 });
        assert.deepEqual({ ...second.text }, { len: 15, since: 0, at: 8, cut: 6, add: 7, kept: 0 });
        assertSpan(s.queued, ['TitreUn 😀 icix', 'TitreUn 😁 icixy']);
    });

    await t.test('text that arrived without a gesture is in the span, and in no run', async () => {
        const s = sensor();
        await s.read('Bonjour');
        await s.read('Bonjour !', 2);
        s.internals.flush('idle');
        await s.read(PASSAGE + 'Bonjour !');        // a baseline read: a co-author, or a tool
        await s.read(PASSAGE + 'Bonjour !?', 1);
        s.internals.flush('idle');

        const second = s.queued[1];
        assert.deepEqual(plain(second.runs), [['type', 1, 0]]);
        assert.deepEqual({ ...second.text },
            { len: PASSAGE.length + 10, since: 0, at: 0, cut: 9, add: PASSAGE.length + 10, kept: 0 });
        assertSpan(s.queued, ['Bonjour !', PASSAGE + 'Bonjour !?']);
    });

    await t.test('what is read while the measurement is suspended is no part of any session', async () => {
        const s = sensor();
        await s.read('Bonjour');
        await s.read('Bonjour !', 2);
        s.internals.flush('pause');
        s.pause();
        await s.read('Bonjour ! ' + PASSAGE);       // written during the pause: the reference moves
        s.pause(false);
        await s.read('Bonjour ! ' + PASSAGE + ' Et', 3);
        s.internals.flush('idle');
        await s.read('Bonjour ! ' + PASSAGE + ' Et la', 3);
        s.internals.flush('idle');

        const [, resumed, next] = s.queued;
        // The first window of the new session has nothing to be compared with: what the pause
        // covered is not handed to the engine as a span of the sitting that follows it.
        assert.deepEqual({ ...resumed.text }, { len: PASSAGE.length + 13 });
        assert.deepEqual(plain(resumed.runs), [['type', 3, 0]]);
        assert.deepEqual({ ...next.text },
            { len: resumed.text.len + 3, since: 0, at: resumed.text.len, cut: 0, add: 3, kept: 0 });
    });

    // A window sealed while a difference is being analysed holds that difference's gestures:
    // the text it reports is the one that difference produced. Reporting the read before would
    // leave what was typed or pasted last to turn up in the next window's span, with the
    // gesture that explains it one window behind.
    await t.test('a window sealed by the ceiling reports the read that sealed it', async () => {
        const s = sensor();
        await s.read('');
        await s.read('a', 1);
        s.internals.flush('idle');
        const texts = ['a'];
        let text = 'a';
        for (let i = 0; i < 5; i++) {
            text += 'x'.repeat(60);
            await s.read(text, 60);
            // The fourth read takes the window to 200 keystrokes: it is sealed inside the
            // analysis, with the text just read.
            if (s.queued.length === texts.length + 1) texts.push(text);
        }
        s.internals.flush('idle');
        texts.push(text);

        assert.deepEqual(s.queued.map((window) => window.why), ['idle', 'volume', 'idle']);
        assertSpan(s.queued, texts);
        assertSession(s.queued);
        assert.deepEqual({ ...s.queued[1].text }, { len: 241, since: 0, at: 1, cut: 0, add: 240, kept: 0 });
        assert.deepEqual({ ...s.queued[2].text }, { len: 301, since: 1, at: 241, cut: 0, add: 60, kept: 0 });
        // Each window's text grew by exactly what its own runs typed.
        assert.deepEqual(s.queued.map((window) => deduced(window.runs).keys), [1, 240, 60]);
    });

    await t.test('two places edited far apart: the span is wide, and what it kept says so', async () => {
        // The envelope runs from the first edit to the last, so the untouched text between
        // them is cut and added alike. Without `kept`, a word added at each end of a long text
        // would read as the whole text replaced.
        const middle = Array.from({ length: 300 }, (_, i) => `mot${i % 40}`).join(' ');
        const s = sensor();
        await s.read(`Début. ${middle} Fin.`);
        await s.read(`Début. ${middle} Fin. `, 1);
        s.internals.flush('idle');
        await s.read(`Un début. ${middle} Fin. `, 3);
        await s.read(`Un début. ${middle} Fin. Et la suite`, 11);
        s.internals.flush('idle');

        const { text } = s.queued[1];
        assert.ok(text.cut > 1500 && text.add > 1500);
        assert.ok(text.kept <= Math.min(text.cut, text.add));
        // What is new is what was typed, give or take the two words the edits touched.
        assert.ok(text.add - text.kept <= 14 + 12, `${text.add - text.kept} new characters`);
        assertSpan(s.queued, [`Début. ${middle} Fin. `, `Un début. ${middle} Fin. Et la suite`]);
    });

    await t.test('a text replaced by another of the same size kept nothing', async () => {
        const other = PASSAGE.replace(/[a-z]/g, 'x');
        const s = sensor();
        await s.read('Titre. ' + PASSAGE);
        await s.read('Titre. ' + PASSAGE + '.', 1);
        s.internals.flush('idle');
        await s.read('Titre. ' + other + '.');              // nobody's gesture
        await s.read('Titre. ' + other + '. ', 1);
        s.internals.flush('idle');

        const { text } = s.queued[1];
        assert.equal(text.add - text.cut, 1, 'the size barely moved');
        assert.ok(text.kept < 10, 'and nearly none of it was there before');
    });

    await t.test('past two thousand words a side, what was kept is not worked out', async () => {
        const long = Array.from({ length: 2100 }, (_, i) => `mot${i}`).join(' ');
        const s = sensor();
        await s.read(`a ${long} z`);
        await s.read(`a ${long} z.`, 1);
        s.internals.flush('idle');
        await s.read(`b ${long} y.`, 2);
        s.internals.flush('idle');

        const { text } = s.queued[1];
        assert.deepEqual(Object.keys(text), ['len', 'since', 'at', 'cut', 'add'], 'omitted, which is not the same as zero');
        assertSpan(s.queued, [`a ${long} z.`, `b ${long} y.`]);
    });

    await t.test('one text more than the previous read is held, and nothing of either goes out', async () => {
        const s = sensor();
        await s.read('Le chat dort.');
        await s.read('Le chat dort. Il', 3);
        s.internals.flush('idle');
        await s.read('Le chat dort. Il rêve', 5);
        s.internals.flush('idle');

        // The text the last window reported is held for the next comparison — the very string
        // the previous read was, not a copy — and it goes when the session does.
        assert.equal(s.internals.session.text, s.internals.previousText);
        assert.ok(!JSON.stringify(s.queued).includes('chat'), 'no excerpt of the document must go out');
        s.internals.flush('pause');
        assert.equal(s.internals.session, null);
    });
});
