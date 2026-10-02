// Les deux thèmes de ui.css, mesurés plutôt que relus.
//
// ui.css est la feuille des quatre agents : une couleur changée ici se voit dans le popup, la
// page d'options, le volet Word et le panneau VS Code. Le thème sombre n'est pas un second jeu
// de valeurs inventé — c'est la même rampe lue par l'autre bout — mais rien n'empêche une
// retouche de le rendre illisible. Ce test est la barrière : **toute couleur qui porte du sens
// doit atteindre 4,5:1 sur la surface de son propre thème** (WCAG AA, texte normal).
//
// Le moteur tient le même test pour son thème à lui ; les deux doivent rester vrais séparément.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const css = readFileSync(new URL('../src/ui.css', import.meta.url), 'utf8');

/** Les tokens hexadécimaux d'un bloc `{ … }` ouvert par `selector`. */
function tokens(selector) {
    const start = css.indexOf(selector);
    assert.notEqual(start, -1, `bloc introuvable : ${selector}`);
    const block = css.slice(start + selector.length, css.indexOf('}', start));
    return Object.fromEntries([...block.matchAll(/--([a-z-]+):\s*(#[0-9a-f]{3,8})\s*;/g)]
        .map(([, name, value]) => [name, value]));
}

function luminance(hex) {
    const h = hex.slice(1).length === 3 ? [...hex.slice(1)].map((c) => c + c).join('') : hex.slice(1);
    const channel = (value) => {
        const v = value / 255;
        return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
    };
    const [r, g, b] = [0, 2, 4].map((i) => channel(parseInt(h.slice(i, i + 2), 16)));
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a, b) {
    const [high, low] = [luminance(a), luminance(b)].sort((x, y) => y - x);
    return (high + 0.05) / (low + 0.05);
}

const light = tokens(':root {');
const dark = { ...light, ...tokens(":root[data-theme='dark'] {") };

// Les couleurs qui portent du sens : un texte, un état, une bordure qu'on doit distinguer.
const MEANINGFUL = ['text', 'text-secondary', 'accent-text', 'success', 'warning', 'error', 'primary'];

for (const [name, scheme] of [['clair', light], ['sombre', dark]]) {
    test(`thème ${name}`, async (t) => {
        await t.test('chaque couleur porteuse de sens atteint 4,5:1 sur la surface', () => {
            for (const token of MEANINGFUL) {
                const value = scheme[token];
                assert.ok(value, `--${token} manque au thème ${name}`);
                const ratio = contrast(value, scheme.paper);
                assert.ok(ratio >= 4.5, `--${token} (${value}) : ${ratio.toFixed(2)}:1 sur ${scheme.paper}`);
            }
        });

        await t.test('le texte principal se lit aussi sur le fond de page', () => {
            assert.ok(contrast(scheme.text, scheme.bg) >= 4.5);
        });

        // L'or comme surface est la seule constante des deux thèmes : un bouton plein est doré
        // et porte de l'encre, ici comme sur l'espace web.
        await t.test('le bouton plein porte de l’encre sur l’or', () => {
            assert.equal(scheme.accent, '#c5a059');
            assert.equal(scheme['accent-ink'], '#1a202c');
            assert.ok(contrast(scheme['accent-ink'], scheme.accent) >= 4.5);
        });
    });
}

test('les deux thèmes décrivent les mêmes tokens', () => {
    // Un token défini en clair et oublié en sombre retombe silencieusement sur la valeur
    // claire : c'est ainsi qu'un fond blanc réapparaît au milieu d'un panneau sombre.
    const overridden = Object.keys(tokens(":root[data-theme='dark'] {"));
    const expected = ['primary', 'accent-text', 'bg', 'paper', 'text', 'text-secondary',
        'divider', 'success', 'warning', 'error'];
    for (const token of expected) {
        assert.ok(overridden.includes(token), `--${token} n'est pas redéfini en sombre`);
    }
});

test('la media query et le choix explicite portent les mêmes valeurs', () => {
    // Les deux blocs sont écrits à la main : ce test est ce qui les empêche de diverger.
    const query = tokens('@media (prefers-color-scheme: dark) {\n    :root:not([data-theme=\'light\']) {');
    assert.deepEqual(query, tokens(":root[data-theme='dark'] {"));
});
