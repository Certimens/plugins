// Capteur du complément Word (word/sensor.js).
//
// Office ne livre pas les frappes : le capteur relit le texte et en déduit ce qui a changé. La
// différence entre deux lectures est donc le cœur de la mesure, et la seule partie du produit
// dont la justesse ne se voit pas à la lecture du code.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clock, load, officeGlobals } from './helpers/sandbox.mjs';

const INTERNALS = ['difference', 'analyse', 'chars', 'measure', 'isNavigating', 'rangeSelected', 'previousText', 'flush'];

function sensor() {
    const time = clock();
    const queued = [];
    const globals = {
        ...officeGlobals(time),
        enqueue: (item) => queued.push(item),
        documentName: () => 'Mémoire.docx',
        noteTitle: () => {},
    };
    const internals = load('word/sensor.js', { globals, expose: INTERNALS });
    return {
        time,
        queued,
        internals,
        // `events` : un horodatage par événement local signalé par Word avant la relecture.
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

test('la différence entre deux lectures', async (t) => {
    const { difference } = load('word/sensor.js', { globals: officeGlobals(clock()), expose: INTERNALS });
    // La différence est minimale : elle partage le plus long préfixe et le plus long suffixe, donc
    // « chat » → « chien » ne coûte que « at » → « ien ». C'est ce qui est compté comme frappes.
    const diff = (before, after) => {
        const { deleted, inserted } = difference(before, after);
        return `${deleted}|${inserted}`;
    };

    await t.test('une insertion au milieu', () => {
        assert.equal(diff('le chat dort', 'le grand chat dort'), '|grand ');
    });

    await t.test('une suppression au milieu', () => {
        assert.equal(diff('le grand chat dort', 'le chat dort'), 'grand |');
    });

    await t.test('un remplacement ne coûte que ce qui diffère', () => {
        assert.equal(diff('le chat dort', 'le chien dort'), 'at|ien');
    });

    await t.test('un ajout en fin de texte', () => {
        assert.equal(diff('bonjour', 'bonjour !'), '| !');
    });

    await t.test('aucun changement', () => {
        assert.equal(diff('identique', 'identique'), '|');
    });

    await t.test('un texte entièrement remplacé', () => {
        assert.equal(diff('avant', 'après'), 'vant|près');
    });

    await t.test('une répétition ne fait pas dériver les bornes', () => {
        assert.equal(diff('aaa', 'aa'), 'a|');
    });

    await t.test('une insertion dans un texte vide', () => {
        assert.equal(diff('', 'bonjour'), '|bonjour');
    });

    await t.test('un document entièrement effacé', () => {
        assert.equal(diff('bonjour', ''), 'bonjour|');
    });
});

test('ce que la différence fait compter', async (t) => {
    await t.test('un texte inchangé est un déplacement', () => {
        const s = sensor();
        s.edit('le chat dort', 'le chat dort', 2);
        assert.equal(s.counters.navigation, 2);
        assert.equal(s.counters.keystrokes, 0);
    });

    await t.test('quelques caractères insérés sont des frappes', () => {
        const s = sensor();
        s.edit('le chat', 'le chat dort', 5);
        assert.equal(s.counters.keystrokes, 5);
        assert.equal(s.counters.pasteEvents, 0);
    });

    await t.test('beaucoup de caractères pour peu d\'événements est un collage', () => {
        const s = sensor();
        s.edit('', 'x'.repeat(400), 1);
        assert.equal(s.counters.pasteEvents, 1);
        assert.equal(s.counters.injectedChars, 400);
        assert.equal(s.counters.keystrokes, 0);
    });

    await t.test('une suppression en cours de frappe est une correction immédiate', () => {
        const s = sensor();
        s.edit('le chat', 'le cha', 1);
        assert.equal(s.counters.corrections, 1);
        assert.equal(s.counters.macroRevisions, 0);
    });

    await t.test('une suppression après un déplacement est une reformulation différée', () => {
        const s = sensor();
        s.edit('le chat dort', 'le chat dort', 1);  // déplacement seul
        s.edit('le chat dort', 'le chat dor', 1);
        assert.equal(s.counters.reformulations, 1);
        assert.equal(s.counters.corrections, 0);
    });

    await t.test('une suppression large est une révision massive, comptée une fois', () => {
        const s = sensor();
        s.edit('a'.repeat(200), '', 1);
        assert.equal(s.counters.macroRevisions, 1);
        assert.equal(s.counters.corrections, 0);
    });

    await t.test('supprimer une sélection est une révision massive, même courte', () => {
        const s = sensor();
        s.internals.rangeSelected = true;
        s.edit('le chat dort', 'le  dort', 1);
        assert.equal(s.counters.macroRevisions, 1);
        assert.equal(s.counters.corrections, 0);
    });

    await t.test('la sélection ne vaut que pour la modification qui la suit', () => {
        const s = sensor();
        s.internals.rangeSelected = true;
        s.edit('le chat dort', 'le  dort', 1);
        s.edit('le  dort', 'le dort', 1);
        assert.equal(s.counters.macroRevisions, 1);
        assert.equal(s.counters.corrections, 1);
    });
});

test("la fenêtre envoyée à la file", async (t) => {
    await t.test('porte les compteurs, jamais le texte', () => {
        const s = sensor();
        s.internals.previousText = 'le chat dort';
        s.edit('le chat', 'le chat dort', 5);
        s.internals.flush('idle');
        assert.equal(s.queued.length, 1);
        const [window] = s.queued;
        assert.equal(window.values.total_keystrokes, 5);
        assert.equal(window.values.real_volume, 12);
        assert.ok(!JSON.stringify(window).includes('le chat'), 'aucun extrait du document ne doit sortir');
    });

    await t.test("n'a ni cadence ni sorties du document (Word ne les donne pas)", () => {
        const s = sensor();
        s.edit('le chat', 'le chat dort', 5);
        s.internals.flush('idle');
        const [window] = s.queued;
        assert.ok(!('mad_ms' in window.values));
        assert.ok(!('median_flight_ms' in window.values));
        assert.ok(!('focus_losses' in window.values));
    });

    await t.test('un déplacement seul ne déclenche pas d\'envoi', () => {
        const s = sensor();
        s.edit('le chat dort', 'le chat dort', 2);
        s.internals.flush('idle');
        assert.equal(s.queued.length, 0);
    });
});
