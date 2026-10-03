// Capteur de l'extension VS Code (src/sensor.js).
//
// VS Code ne livre pas les frappes : il dit ce qui a changé dans le document et d'où vient le
// curseur. Les cas ci-dessous sont volontairement ceux des deux autres suites — une divergence
// entre les trois implémentations se voit d'abord ici.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clock, load } from './helpers/sandbox.mjs';

// Le fichier livré est chargé tel quel : c'est son `module.exports` de production qui sert au
// test, rien n'est ajouté au code pour le rendre observable.
function sensorModule() {
    const module = { exports: {} };
    load(new URL('../src/sensor.js', import.meta.url), { globals: { module } });
    return module.exports;
}

const { Sensor, chars, median, medianAbsoluteDeviation } = sensorModule();

function sensor({ text = 'du code' } = {}) {
    const time = clock();
    const flushed = [];
    const instance = new Sensor({
        documentId: 'vscode:abcd1234:src/main.go',
        documentName: 'tp-go/src/main.go',
        volume: () => chars(text),
        flushed: (item) => flushed.push(item),
    });
    return {
        time,
        flushed,
        instance,
        get counters() {
            return instance.measure;
        },
        // Une modification du document, `secondes` après la précédente.
        edit(changes, { seconds = 0.1, reason = '' } = {}) {
            instance.change(changes, reason, time.advance(seconds));
        },
        type(text, { seconds = 0.1 } = {}) {
            instance.change([{ text, rangeLength: 0 }], '', time.advance(seconds));
        },
        erase(count, { seconds = 0.1 } = {}) {
            instance.change([{ text: '', rangeLength: count }], '', time.advance(seconds));
        },
        move(kind, selected = false, { seconds = 0.5 } = {}) {
            instance.move(kind, selected, time.advance(seconds));
        },
        blur({ seconds = 0.1 } = {}) {
            time.advance(seconds);
            instance.blur();
        },
        // `Sensor.flush` rend la fenêtre produite, ou null quand il n'y avait rien à envoyer.
        flush(reason = 'test') {
            return instance.flush(reason);
        },
    };
}

test('ce qui compte comme une frappe', async (t) => {
    await t.test('un caractère inséré', () => {
        const s = sensor();
        s.type('f');
        s.type('u');
        assert.equal(s.counters.keystrokes, 2);
    });

    await t.test('un saut de ligne est une frappe, mais pas un caractère', () => {
        const s = sensor();
        s.type('\n');
        assert.equal(s.counters.keystrokes, 1);
        assert.equal(chars('a\nb'), 2);
    });

    await t.test('une suppression coûte autant de frappes que de caractères effacés', () => {
        const s = sensor();
        s.erase(3);
        assert.equal(s.counters.keystrokes, 3);
        assert.equal(s.counters.corrections, 3);
    });

    await t.test("un bloc effacé d'un coup ne compte qu'une frappe", () => {
        const s = sensor();
        s.erase(120);
        assert.equal(s.counters.keystrokes, 1);
        assert.equal(s.counters.macroRevisions, 1);
    });
});

test('une insertion faite en un coup est une injection', async (t) => {
    await t.test('au-delà de 15 caractères', () => {
        const s = sensor();
        s.type('func main() { fmt.Println("bonjour") }');
        assert.equal(s.counters.injectedChars, 38);
        assert.equal(s.counters.keystrokes, 0);
    });

    await t.test('en deçà, ce sont des frappes — une complétion courte reste de la frappe', () => {
        const s = sensor();
        s.type('Println');
        assert.equal(s.counters.injectedChars, 0);
        assert.equal(s.counters.keystrokes, 7);
    });

    await t.test('les sauts de ligne ne gonflent pas le compte', () => {
        const s = sensor();
        s.type('if err != nil {\n\treturn err\n}\n');
        assert.equal(s.counters.injectedChars, chars('if err != nil {\n\treturn err\n}\n'));
    });
});

test('une suppression solde le déplacement qui la précède', async (t) => {
    await t.test('après un clic : révision massive, puis corrections immédiates', () => {
        const s = sensor();
        s.move('mouse');
        s.erase(1);
        s.erase(1);
        s.erase(1);
        assert.equal(s.counters.macroRevisions, 1);
        assert.equal(s.counters.corrections, 2);
        assert.equal(s.counters.reformulations, 0);
    });

    await t.test('après un déplacement au clavier : reformulation différée, puis corrections', () => {
        const s = sensor();
        s.move('keyboard');
        s.erase(1);
        s.erase(1);
        assert.equal(s.counters.reformulations, 1);
        assert.equal(s.counters.corrections, 1);
        assert.equal(s.counters.macroRevisions, 0);
    });

    await t.test('sans déplacement : correction immédiate', () => {
        const s = sensor();
        s.type('a');
        s.erase(1);
        assert.equal(s.counters.corrections, 1);
        assert.equal(s.counters.macroRevisions, 0);
    });
});

test('remplacer une sélection est une suppression', async (t) => {
    await t.test("à l'échelle de la sélection tracée à la souris : une révision massive", () => {
        const s = sensor();
        s.move('mouse', true);
        s.edit([{ text: 'x', rangeLength: 12 }]);
        assert.equal(s.counters.macroRevisions, 1);
        assert.equal(s.counters.reformulations, 0);
        // la frappe qui remplace, plus le bloc effacé
        assert.equal(s.counters.keystrokes, 2);
    });

    await t.test('une sélection Maj+flèches est une reformulation différée', () => {
        const s = sensor();
        s.move('keyboard', true);
        s.edit([{ text: 'x', rangeLength: 4 }]);
        assert.equal(s.counters.reformulations, 1);
        assert.equal(s.counters.macroRevisions, 0);
    });

    await t.test('« tout sélectionner » arrive en commande et pèse comme un bloc', () => {
        const s = sensor();
        s.move('command', true);
        s.edit([{ text: 'réponse collée et retapée', rangeLength: 800 }]);
        assert.equal(s.counters.macroRevisions, 1);
        assert.equal(s.counters.injectedChars, 25);
    });

    await t.test("un déplacement sans sélection l'annule", () => {
        const s = sensor();
        s.move('mouse', true);
        s.move('keyboard', false);
        s.erase(1);
        // le clic a été annulé par le déplacement clavier : reformulation, pas révision massive
        assert.equal(s.counters.macroRevisions, 0);
        assert.equal(s.counters.reformulations, 1);
    });
});

test("l'annulation compte une correction sans rejouer ce qu'elle restaure", () => {
    const s = sensor();
    s.edit([{ text: 'un paragraphe entier restauré par Ctrl+Z', rangeLength: 0 }], { reason: 'undo' });
    assert.equal(s.counters.corrections, 1);
    assert.equal(s.counters.keystrokes, 1);
    assert.equal(s.counters.injectedChars, 0);
});

test('les déplacements', async (t) => {
    await t.test('comptent comme des sauts de navigation', () => {
        const s = sensor();
        s.move('mouse');
        s.move('keyboard');
        assert.equal(s.counters.navigation, 2);
    });

    await t.test("celui qui suit immédiatement une frappe est l'écho du curseur, pas une navigation", () => {
        const s = sensor();
        s.type('a');
        s.move('keyboard', false, { seconds: 0.02 }); // 20 ms : le curseur suit ce qui vient d'être tapé
        assert.equal(s.counters.navigation, 0);
    });

    await t.test("seuls, ils n'ouvrent pas de fenêtre", () => {
        const s = sensor();
        s.move('mouse');
        s.move('keyboard');
        assert.equal(s.flush(), null);
        assert.equal(s.flushed.length, 0);
    });
});

test('les pauses cognitives', async (t) => {
    await t.test('une reprise entre 3 s et 5 min en est une', () => {
        const s = sensor();
        s.type('a');
        s.type('b', { seconds: 10 });
        assert.equal(s.counters.pauses, 1);
    });

    await t.test('en deçà de 3 s, rien', () => {
        const s = sensor();
        s.type('a');
        s.type('b', { seconds: 2 });
        assert.equal(s.counters.pauses, 0);
    });

    await t.test("au-delà de 5 min, l'étudiant a quitté le document", () => {
        const s = sensor();
        s.type('a');
        s.type('b', { seconds: 400 });
        assert.equal(s.counters.pauses, 0);
    });
});

test('le temps effectif', async (t) => {
    await t.test("un écart court compte pour ce qu'il dure", () => {
        const s = sensor();
        s.type('a');
        s.type('b', { seconds: 1.5 });
        assert.equal(s.counters.activeMs, 1500);
    });

    await t.test('un écart moyen compte pour 250 ms forfaitaires', () => {
        const s = sensor();
        s.type('a');
        s.type('b', { seconds: 30 });
        assert.equal(s.counters.activeMs, 250);
    });

    await t.test('un écart de plus de 60 s ne compte pas', () => {
        const s = sensor();
        s.type('a');
        s.type('b', { seconds: 120 });
        assert.equal(s.counters.activeMs, 0);
    });
});

test('le rythme de frappe', async (t) => {
    await t.test('se mesure sur les changements de la taille d’une frappe', () => {
        const s = sensor();
        s.type('a');
        s.type('b', { seconds: 0.1 });
        s.type('c', { seconds: 0.15 });
        const window = s.flush();
        assert.equal(window.values.median_flight_ms, 125);
        assert.equal(window.values.mad_ms, 25);
    });

    await t.test("une complétion acceptée d'un coup n'entre pas dans l'échantillon", () => {
        const s = sensor();
        s.type('a');
        s.type('func (s *Sensor) Measure(now int64) error {', { seconds: 0.1 });
        s.type('b', { seconds: 0.1 });
        // deux frappes séparées par une injection : un seul flight time, donc pas de rythme
        assert.equal(s.counters.flights.length, 1);
        assert.equal(s.flush().values.median_flight_ms, undefined);
    });

    await t.test("un écart de plus de 800 ms n'est pas un flight time", () => {
        const s = sensor();
        s.type('a');
        s.type('b', { seconds: 2 });
        assert.equal(s.counters.flights.length, 0);
    });

    await t.test('la médiane et son écart absolu médian', () => {
        assert.equal(median([10, 20, 30]), 20);
        assert.equal(median([10, 20]), 15);
        assert.equal(medianAbsoluteDeviation([100, 100, 100]), 0);
        assert.equal(medianAbsoluteDeviation([10]), 0);
    });
});

test('la sortie du document', async (t) => {
    await t.test('compte une sortie et clôt la fenêtre', () => {
        const s = sensor();
        s.type('a');
        s.blur();
        const window = s.flushed[0];
        assert.equal(window.values.focus_losses, 1);
        assert.equal(window.reason, 'blur');
    });

    await t.test("sans activité, elle ne crée pas de fenêtre vide", () => {
        const s = sensor();
        s.move('mouse');
        s.blur();
        assert.equal(s.flushed.length, 0);
    });
});

test('la fenêtre envoyée', async (t) => {
    await t.test("va de la première à la dernière activité, jamais au-delà", () => {
        const s = sensor();
        s.type('a');
        s.type('b', { seconds: 4 });
        const { period } = s.flush();
        assert.equal(new Date(period.end) - new Date(period.start), 4000);
    });

    await t.test("dure au moins une seconde : le moteur exige une fin après le début", () => {
        const s = sensor();
        s.type('a');
        const { period } = s.flush();
        assert.equal(new Date(period.end) - new Date(period.start), 1000);
    });

    await t.test('porte le volume du document et son chemin dans le projet', () => {
        const s = sensor({ text: 'package main\n' });
        s.type('a');
        const window = s.flush();
        assert.equal(window.values.real_volume, 12); // sans le saut de ligne
        assert.equal(window.documentName, 'tp-go/src/main.go');
        assert.equal(window.documentId, 'vscode:abcd1234:src/main.go');
    });

    await t.test("n'envoie pas paste_events : VS Code ne distingue pas un collage d'une complétion", () => {
        const s = sensor();
        s.type('un texte collé de plus de quinze caractères');
        assert.equal('paste_events' in s.flush().values, false);
    });

    await t.test('part toute seule au bout de 200 frappes', () => {
        const s = sensor();
        for (let i = 0; i < 200; i++) s.type('a', { seconds: 0.05 });
        assert.equal(s.flushed.length, 1);
        assert.equal(s.flushed[0].reason, 'volume');
        assert.equal(s.flushed[0].values.total_keystrokes, 200);
    });

    await t.test('repart à zéro : une fenêtre vidée ne se renvoie pas', () => {
        const s = sensor();
        s.type('a');
        s.flush();
        assert.equal(s.counters.keystrokes, 0);
        assert.equal(s.flush(), null);
        assert.equal(s.flushed.length, 1);
    });
});
