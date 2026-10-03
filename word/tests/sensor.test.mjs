// Sensor of the Word add-in (src/sensor.js).
//
// Office does not deliver keystrokes: the sensor reads the text again and works out what
// changed. The difference between two reads is therefore the heart of the measurement, and the
// only part of the product whose correctness cannot be seen by reading the code.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clock, load, officeGlobals } from './helpers/sandbox.mjs';

const INTERNALS = ['difference', 'analyse', 'chars', 'codePoints', 'shingles', 'measure', 'isNavigating',
    'rangeSelected', 'previousText', 'flush'];

function sensor() {
    const time = clock();
    const queued = [];
    const globals = {
        ...officeGlobals(time),
        enqueue: (item) => queued.push(item),
        documentName: () => 'Mémoire.docx',
        noteTitle: () => {},
    };
    const internals = load(new URL('../src/sensor.js', import.meta.url), { globals, expose: INTERNALS });
    return {
        time,
        queued,
        internals,
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
        s.time.advance(500);        // more than ten minutes after the deletion
        s.edit('', CORRECTED, 1);
        assert.equal(s.counters.pasteEvents, 0, 'what is still in use stays comparable');
    });

    await t.test('past ten minutes, the erased text is no longer recognised', () => {
        const s = sensor();
        s.edit(WRITTEN, '', 1);
        s.time.advance(601);
        s.edit('', CORRECTED, 1);
        assert.equal(s.counters.pasteEvents, 1);
    });
});

test('the biggest paste, and the restitution counted for itself', async (t) => {
    const text = 'le capteur observe la manière dont un document est écrit, jamais le texte lui-même : il compte les frappes, les pauses et les corrections, et c\'est tout ce qui part vers le moteur';

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

    await t.test('a foreign text is not', () => {
        const s = sensor();
        s.edit(text, '');
        s.edit('', 'une réponse entièrement rédigée ailleurs, qui ne reprend rien de ce qui précède');
        assert.equal(s.counters.selfPasteEvents, 0);
        assert.equal(s.counters.pasteEvents, 1);
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
