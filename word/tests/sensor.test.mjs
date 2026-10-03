// Sensor of the Word add-in (src/sensor.js).
//
// Office does not deliver keystrokes: the sensor reads the text again and works out what
// changed. The difference between two reads is therefore the heart of the measurement, and the
// only part of the product whose correctness cannot be seen by reading the code.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clock, load, officeGlobals } from './helpers/sandbox.mjs';

const INTERNALS = ['difference', 'analyse', 'chars', 'codePoints', 'shingles', 'measure', 'isNavigating',
    'rangeSelected', 'previousText', 'flush', 'rememberSelection', 'ownText'];

// The delay the add-in gives a selection to stop moving before hashing it. Written here rather
// than read from the shipped code: a test that took the value from the sensor would follow it
// wherever it went, and this one is a promise — the block has to be remembered before the paste
// that follows the copy is read.
const SELECTION_SETTLE_MS = 150;

function sensor() {
    const time = clock();
    const queued = [];
    let paused = false;
    // Timers the test drives. The add-in hashes a selection on a later turn and only once it has
    // settled, so `clearTimeout` has to cancel for real — otherwise the test would pay for work
    // the student's machine never does — and the delay says which timer is which.
    const timers = new Map();
    let nextTimer = 0;
    const globals = {
        ...officeGlobals(time),
        setTimeout: (fn, ms) => {
            timers.set(++nextTimer, { fn, ms });
            return nextTimer;
        },
        clearTimeout: (id) => timers.delete(id),
        isPaused: () => paused,
        enqueue: (item) => queued.push(item),
        documentName: () => 'Mémoire.docx',
        noteTitle: () => {},
    };
    const internals = load(new URL('../src/sensor.js', import.meta.url), { globals, expose: INTERNALS });
    return {
        time,
        queued,
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
        // The student selects a block, and the turn that hashes it comes round. Office raises
        // the selection; the Ctrl+C that follows it raises nothing at all.
        selects(text) {
            internals.rememberSelection(text);
            this.runTimers(SELECTION_SETTLE_MS);
        },
        // `events`: one timestamp per local event Word signalled before the re-read.
        edit(before, after, eventCount = 1) {
            const events = [];
            for (let i = 0; i < eventCount; i++) events.push(time.advance(0.15));
            internals.analyse(before, after, events);
        },
        get counters() {
            return internals.measure;
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
        assert.equal(s.counters.navigation, 2);
        assert.equal(s.counters.keystrokes, 0);
    });

    await t.test('a few characters inserted are keystrokes', () => {
        const s = sensor();
        s.edit('le chat', 'le chat dort', 5);
        assert.equal(s.counters.keystrokes, 5);
        assert.equal(s.counters.pasteEvents, 0);
    });

    await t.test('many characters for few events is a paste', () => {
        const s = sensor();
        s.edit('', 'x'.repeat(400), 1);
        assert.equal(s.counters.pasteEvents, 1);
        assert.equal(s.counters.injectedChars, 400);
        assert.equal(s.counters.keystrokes, 0);
    });

    await t.test('a deletion while typing is an immediate correction', () => {
        const s = sensor();
        s.edit('le chat', 'le cha', 1);
        assert.equal(s.counters.corrections, 1);
        assert.equal(s.counters.macroRevisions, 0);
    });

    await t.test('a deletion after a move is a deferred reformulation', () => {
        const s = sensor();
        s.edit('le chat dort', 'le chat dort', 1);  // a move on its own
        s.edit('le chat dort', 'le chat dor', 1);
        assert.equal(s.counters.reformulations, 1);
        assert.equal(s.counters.corrections, 0);
    });

    await t.test('a wide deletion is a mass revision, counted once', () => {
        const s = sensor();
        s.edit('a'.repeat(200), '', 1);
        assert.equal(s.counters.macroRevisions, 1);
        assert.equal(s.counters.corrections, 0);
    });

    await t.test('deleting a selection is a mass revision, even a short one', () => {
        const s = sensor();
        s.internals.rangeSelected = true;
        s.edit('le chat dort', 'le  dort', 1);
        assert.equal(s.counters.macroRevisions, 1);
        assert.equal(s.counters.corrections, 0);
    });

    await t.test('the selection only counts for the edit that follows it', () => {
        const s = sensor();
        s.internals.rangeSelected = true;
        s.edit('le chat dort', 'le  dort', 1);
        s.edit('le  dort', 'le dort', 1);
        assert.equal(s.counters.macroRevisions, 1);
        assert.equal(s.counters.corrections, 1);
    });
});

test('the window sent to the queue', async (t) => {
    await t.test('carries the counters, never the text', () => {
        const s = sensor();
        s.internals.previousText = 'le chat dort';
        s.edit('le chat', 'le chat dort', 5);
        s.internals.flush('idle');
        assert.equal(s.queued.length, 1);
        const [window] = s.queued;
        assert.equal(window.values.keystrokes_total, 5);
        assert.equal(window.values.real_volume_chars, 12);
        assert.ok(!JSON.stringify(window).includes('le chat'), 'no excerpt of the document must go out');
    });

    await t.test('has neither rhythm nor departures from the document (Word gives neither)', () => {
        const s = sensor();
        s.edit('le chat', 'le chat dort', 5);
        s.internals.flush('idle');
        const [window] = s.queued;
        assert.ok(!('flight_mad_ms' in window.values));
        assert.ok(!('flight_median_ms' in window.values));
        assert.ok(!('focus_losses' in window.values));
    });

    await t.test('a move on its own triggers no send', () => {
        const s = sensor();
        s.edit('le chat dort', 'le chat dort', 2);
        s.internals.flush('idle');
        assert.equal(s.queued.length, 0);
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
        assert.equal(s.counters.pasteEvents, 0, 'this is not a paste of foreign text');
        assert.equal(s.counters.injectedChars, 0, 'one\'s own words are not an injection');
        assert.equal(s.counters.macroRevisions, 1);
        assert.equal(s.counters.keystrokes, 1, 'the replaced block counts as one keystroke');
    });

    await t.test('erased then pasted back corrected: still a revision', () => {
        const s = sensor();
        s.edit(WRITTEN, '', 1);
        s.edit('', CORRECTED, 1);
        assert.equal(s.counters.pasteEvents, 0);
        assert.equal(s.counters.injectedChars, 0);
        assert.equal(s.counters.macroRevisions, 2, 'the deletion, then the restitution');
    });

    await t.test('a couple of words moved inside the document is not an injection', () => {
        // The four-word floor used to drop short copies: a phrase moved from one sentence to
        // another had left no fingerprint, and came back as someone else's text.
        const s = sensor();
        s.edit('developpement durable', '', 1);
        s.edit('', 'developpement durable', 1);
        assert.equal(s.counters.pasteEvents, 0);
        assert.equal(s.counters.injectedChars, 0);
        assert.equal(s.counters.selfPasteEvents, 1);
    });

    await t.test('replacing one\'s text with foreign text stays an injection', () => {
        const s = sensor();
        s.edit(WRITTEN, FOREIGN, 1);
        assert.equal(s.counters.pasteEvents, 1);
        assert.ok(s.counters.injectedChars > 0);
    });

    await t.test('with nothing erased, a paste is an injection', () => {
        const s = sensor();
        s.edit('', CORRECTED, 1);
        assert.equal(s.counters.pasteEvents, 1);
        assert.ok(s.counters.injectedChars > 0);
    });

    await t.test('pasted back several times, one\'s own text never becomes a paste', () => {
        const s = sensor();
        s.edit(WRITTEN, '', 1);
        s.edit('', CORRECTED, 1);
        s.time.advance(500);
        s.edit('', CORRECTED, 1);
        s.time.advance(500);
        s.edit('', CORRECTED, 1);
        assert.equal(s.counters.pasteEvents, 0, 'the same block, put back three times, stays theirs');
        assert.equal(s.counters.injectedChars, 0);
        assert.equal(s.counters.macroRevisions, 2, 'the deletion, then a single revision');
        assert.equal(s.counters.keystrokes, 4, 'each block put back counts as one keystroke');
    });

    await t.test('the ten minutes run from the last paste, not from the deletion', () => {
        const s = sensor();
        s.edit(WRITTEN, '', 1);
        s.time.advance(500);
        s.edit('', CORRECTED, 1);
        s.time.advance(2000);       // more than an hour after the deletion
        s.edit('', CORRECTED, 1);
        assert.equal(s.counters.pasteEvents, 0, 'what is still in use stays comparable');
    });

    await t.test('past the hour, the erased text is no longer recognised', () => {
        const s = sensor();
        s.edit(WRITTEN, '', 1);
        s.time.advance(3601);
        s.edit('', CORRECTED, 1);
        assert.equal(s.counters.pasteEvents, 1);
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
        assert.equal(s.counters.pasteEvents, 1);
        assert.equal(s.counters.injectedChars, 400);
        assert.equal(s.counters.keystrokes, 0);
    });

    await t.test('`injected_chars_max` keeps the biggest, not the last', () => {
        // Twenty pastes of a hundred characters and a single one of two thousand give the same
        // total: this counter is the only one saying something arrived in one block.
        const s = sensor();
        s.edit('', 'x'.repeat(100));
        s.edit('x'.repeat(100), 'x'.repeat(100) + 'y'.repeat(2000));
        assert.equal(s.counters.injectedChars, 2100);
        assert.equal(s.counters.maxInjectedChars, 2000);
    });

    await t.test('a restitution is counted for itself', () => {
        // Without this counter, the engine sees a mass revision without being able to tell
        // whether the student rewrote their paragraph by hand or ran it through a corrector.
        const s = sensor();
        s.edit(text, '');                       // the paragraph goes off to the corrector
        s.edit('', text.replace('manière', 'façon'));   // it comes back corrected
        assert.equal(s.counters.selfPasteEvents, 1);
        assert.equal(s.counters.injectedChars, 0);
    });

    await t.test('a restitution is counted in characters as well as in gestures', () => {
        // The volume a restitution carries is the volume it would have been accused of: the same
        // text, inserted by somebody who never wrote it, counts exactly that many injected
        // characters. Four restitutions say nothing about whether a paragraph or a third of the
        // document came back, and only this counter does.
        const corrected = text.replace('manière', 'façon');

        const stranger = sensor();
        stranger.edit('', corrected);

        const s = sensor();
        s.edit(text, '');
        s.edit('', corrected);
        assert.equal(s.counters.selfPasteEvents, 1);
        assert.equal(s.counters.selfPasteChars, stranger.counters.injectedChars);
        assert.ok(s.counters.selfPasteChars > 0);
        assert.equal(s.counters.injectedChars, 0, 'and it is still not an injection');
    });

    await t.test('a foreign text is not', () => {
        const s = sensor();
        s.edit(text, '');
        s.edit('', 'une réponse entièrement rédigée ailleurs, qui ne reprend rien de ce qui précède');
        assert.equal(s.counters.selfPasteEvents, 0);
        assert.equal(s.counters.pasteEvents, 1);
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
        assert.equal(s.counters.injectedChars, 0, 'it was already in the document');
        assert.equal(s.counters.pasteEvents, 0);
        assert.equal(s.counters.selfPasteEvents, 1);
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
        assert.equal(s.counters.injectedChars, 0);
        assert.equal(s.counters.selfPasteEvents, 3);
        assert.equal(s.counters.macroRevisions, 1, 'the first lands as a revision, the rest are duplications');
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
        assert.equal(s.counters.selfPasteEvents, 2);
        assert.equal(s.counters.macroRevisions, 1, 'revised once, then duplicated');
        assert.equal(s.internals.ownText.length, 1, 'one block, one entry');
    });

    // Nothing selected, nothing remembered: a text that never was in the document is still an
    // injection, which is what keeps the rule from being a way out.
    await t.test('a foreign text is not excused by a selection made elsewhere', () => {
        const s = sensor();
        s.selects(sentence);
        s.edit(document, `${document} une réponse entièrement rédigée ailleurs, qui ne reprend rien du document`);
        assert.equal(s.counters.selfPasteEvents, 0);
        assert.equal(s.counters.pasteEvents, 1);
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
        assert.equal(s.queued.at(-1).flush, 'idle');

        s.edit('bonjour', 'bonjour tout le monde');
        s.internals.flush('volume');
        assert.equal(s.queued.at(-1).flush, 'volume');
    });

    await t.test('suspending the measurement ends the sitting', () => {
        const s = sensor();
        s.edit('', 'bonjour');
        s.internals.flush('pause');
        assert.equal(s.queued.at(-1).flush, 'end');
    });

    // The safe failure: a trigger the table does not know sends nothing at all, and the engine
    // reads nothing as "the agent did not say". It never sends a word outside the vocabulary.
    await t.test('a trigger the table does not know says nothing', () => {
        const s = sensor();
        s.edit('', 'bonjour');
        s.internals.flush('something-new');
        assert.equal(s.queued.at(-1).flush, undefined);
    });
});
