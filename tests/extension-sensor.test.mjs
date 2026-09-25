// Counting rules of the browser sensor (extension/content.js).
//
// The same rules are covered on the Python side by libreoffice/tests/test_measure.py: the two
// implementations are independent and must agree (see the mesures-redaction skill). What is
// tested here and nowhere else is what only the browser can see — a selection swept with the
// mouse.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { browserGlobals, clock, load } from './helpers/sandbox.mjs';

const INTERNALS = ['measure', 'onKeyDown', 'onMouseDown', 'onMouseUp', 'recordInjection', 'flush', 'selectionScope'];

function sensor({ hostname = 'docs.google.com' } = {}) {
    const time = clock();
    const { globals } = browserGlobals(time, { hostname });
    const internals = load('extension/content.js', { globals, expose: INTERNALS });
    const press = (key, modifiers = {}) => {
        internals.onKeyDown({ key, isTrusted: true, repeat: false, ctrlKey: false, metaKey: false, shiftKey: false, ...modifiers });
        time.advance(0.15);
    };
    return {
        time,
        press,
        type: (count = 1) => {
            for (let i = 0; i < count; i++) press('a');
        },
        selectAll: () => press('a', { ctrlKey: true }),
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
        get counters() {
            return internals.measure;
        },
    };
}

test('remplacer une sélection est une suppression', async (t) => {
    await t.test('taper par-dessus un Ctrl+A est une révision massive', () => {
        const s = sensor();
        s.selectAll();
        s.type();
        assert.equal(s.counters.macroRevisions, 1);
        assert.equal(s.counters.reformulations, 0);
    });

    await t.test('taper par-dessus une sélection Maj+flèche est une reformulation', () => {
        const s = sensor();
        s.press('ArrowRight', { shiftKey: true });
        s.type();
        assert.equal(s.counters.reformulations, 1);
        assert.equal(s.counters.macroRevisions, 0);
    });

    await t.test('coller par-dessus une sélection est une révision et une injection', () => {
        const s = sensor();
        s.selectAll();
        s.paste('x'.repeat(500));
        assert.equal(s.counters.macroRevisions, 1);
        assert.equal(s.counters.injectedChars, 500);
    });

    await t.test('effacer une sélection est compté à son échelle', () => {
        const s = sensor();
        s.selectAll();
        s.press('Backspace');
        assert.equal(s.counters.macroRevisions, 1);
        assert.equal(s.counters.corrections, 0);
    });

    await t.test("une sélection n'est décomptée qu'une fois", () => {
        const s = sensor();
        s.selectAll();
        s.type(3);
        assert.equal(s.counters.macroRevisions, 1);
    });

    await t.test('Maj seule ne sélectionne rien (c\'est aussi ainsi qu\'on tape les majuscules)', () => {
        const s = sensor();
        s.press('A', { shiftKey: true });
        s.press('B', { shiftKey: true });
        assert.equal(s.counters.macroRevisions, 0);
        assert.equal(s.counters.reformulations, 0);
    });

    await t.test('un déplacement sans Maj annule la sélection', () => {
        const s = sensor();
        s.selectAll();
        s.press('ArrowRight');
        s.type();
        assert.equal(s.counters.macroRevisions, 0);
    });

    await t.test('un clic annule la sélection', () => {
        const s = sensor();
        s.selectAll();
        s.click();
        s.type();
        assert.equal(s.counters.macroRevisions, 0);
    });
});

test('couper et annuler soldent la sélection eux-mêmes', async (t) => {
    await t.test("couper n'est pas facturé deux fois", () => {
        const s = sensor();
        s.selectAll();
        s.press('x', { ctrlKey: true });   // le couper efface la sélection
        s.type();                          // on écrit à la place
        assert.equal(s.counters.macroRevisions, 1);
    });

    await t.test('couper puis coller est un seul déplacement de bloc', () => {
        const s = sensor();
        s.selectAll();
        s.press('x', { ctrlKey: true });
        s.paste('x'.repeat(500));
        assert.equal(s.counters.macroRevisions, 1);
    });

    await t.test("annuler ne laisse pas de sélection en attente", () => {
        const s = sensor();
        s.selectAll();
        s.press('z', { ctrlKey: true });
        s.type();
        assert.equal(s.counters.macroRevisions, 0);
    });

    await t.test('copier conserve la sélection', () => {
        const s = sensor();
        s.selectAll();
        s.press('c', { ctrlKey: true });
        s.type();
        assert.equal(s.counters.macroRevisions, 1);
    });
});

test('la souris', async (t) => {
    await t.test('une sélection tracée à la souris pèse comme un Ctrl+A', () => {
        const s = sensor();
        s.drag();
        s.type();
        assert.equal(s.counters.macroRevisions, 1);
    });

    await t.test('un clic immobile reste un clic, pas une sélection', () => {
        const s = sensor();
        s.click();
        s.type();
        assert.equal(s.counters.macroRevisions, 0);
        assert.equal(s.counters.navigation, 1);
    });

    await t.test("un tremblement de quelques pixels n'est pas un tracé", () => {
        const s = sensor();
        s.drag({ x: 100, y: 100 }, { x: 102, y: 101 });
        s.type();
        assert.equal(s.counters.macroRevisions, 0);
    });
});

test('une suppression solde le déplacement qui la précède', async (t) => {
    await t.test('la première après un clic est massive, les suivantes immédiates', () => {
        const s = sensor();
        s.type(3);
        s.click();
        for (let i = 0; i < 4; i++) s.press('Backspace');
        assert.equal(s.counters.macroRevisions, 1);
        assert.equal(s.counters.corrections, 3);
        assert.equal(s.counters.reformulations, 0);
    });

    await t.test('la première après une flèche est une reformulation différée', () => {
        const s = sensor();
        s.type(3);
        s.press('ArrowLeft');
        s.press('Backspace');
        s.press('Backspace');
        assert.equal(s.counters.reformulations, 1);
        assert.equal(s.counters.corrections, 1);
    });
});

test('une pause va de 3 s à 5 minutes', async (t) => {
    await t.test('une interruption de deux minutes est une pause', () => {
        const s = sensor();
        s.type();
        s.time.advance(120);
        s.type();
        assert.equal(s.counters.pauses, 1);
    });

    await t.test("au-delà du plafond, l'étudiant a quitté le document", () => {
        const s = sensor();
        s.type();
        s.time.advance(360);
        s.type();
        assert.equal(s.counters.pauses, 0);
    });

    await t.test('un trou sous le seuil est du flux de frappe', () => {
        const s = sensor();
        s.type();
        s.time.advance(1);
        s.type();
        assert.equal(s.counters.pauses, 0);
    });

    await t.test("le temps effectif garde son propre plafond de 60 s", () => {
        const s = sensor();
        s.type();
        const before = s.counters.activeMs;
        s.time.advance(120);
        s.type();
        assert.equal(s.counters.pauses, 1);
        assert.equal(s.counters.activeMs, before, 'un long silence ne se crédite pas en temps de frappe');
    });
});
