// The two themes of ui.css, measured rather than reread.
//
// ui.css is the stylesheet of the four agents: a colour changed here shows in the popup, the
// options page, the Word task pane and the VS Code panel. The dark theme is not a second set of
// invented values — it is the same ramp read from the other end — but nothing stops a touch-up
// from making it unreadable. This test is the barrier, and it has two bars:
//
// - **every colour that carries meaning reaches 4.5:1 on its own theme's surface** (WCAG AA,
//   normal text);
// - **the three verdict colours stay distinct for someone who does not see every colour.**
//   Contrast alone does not say so: the original green and red both passed AA and yet came out
//   the same olive under deuteranopia. It is this second test that forbids going back there.
//
// The engine holds the same for its own theme; both must stay true separately.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const css = readFileSync(new URL('../src/ui.css', import.meta.url), 'utf8');

/** The hexadecimal tokens of a `{ … }` block opened by `selector`. */
function tokens(selector) {
    const start = css.indexOf(selector);
    assert.notEqual(start, -1, `block not found: ${selector}`);
    const block = css.slice(start + selector.length, css.indexOf('}', start));
    return Object.fromEntries([...block.matchAll(/--([a-z-]+):\s*(#[0-9a-f]{3,8})\s*;/g)]
        .map(([, name, value]) => [name, value]));
}

function channels(hex) {
    const h = hex.slice(1).length === 3 ? [...hex.slice(1)].map((c) => c + c).join('') : hex.slice(1);
    return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
}

/** The linear-light components, the ones luminance and simulations are computed on. */
function linear(hex) {
    return channels(hex).map((value) => {
        const v = value / 255;
        return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
    });
}

function luminance(hex) {
    const [r, g, b] = linear(hex);
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a, b) {
    const [high, low] = [luminance(a), luminance(b)].sort((x, y) => y - x);
    return (high + 0.05) / (low + 0.05);
}

/** Every token of a block, raw value: a hex, an `rgb(… / x%)`, or a `var(--other)`. */
function rawTokens(selector) {
    const start = css.indexOf(selector);
    assert.notEqual(start, -1, `block not found: ${selector}`);
    const block = css.slice(start + selector.length, css.indexOf('}', start));
    return Object.fromEntries([...block.matchAll(/--([a-z-]+):\s*([^;]+);/g)]
        .map(([, name, value]) => [name, value.trim()]));
}

/** The colour actually painted: a reference is followed, a translucent one is composited. */
function flatten(value, scheme, under) {
    const reference = /^var\(--([a-z-]+)\)$/.exec(value);
    if (reference) return flatten(scheme[reference[1]], scheme, under);
    const wash = /^rgb\((\d+) (\d+) (\d+) \/ (\d+)%\)$/.exec(value);
    if (!wash) return value;
    const alpha = Number(wash[4]) / 100;
    const base = channels(under);
    const mixed = [1, 2, 3].map((i) => Math.round(Number(wash[i]) * alpha + base[i - 1] * (1 - alpha)));
    return '#' + mixed.map((c) => c.toString(16).padStart(2, '0')).join('');
}

const light = tokens(':root {');
const dark = { ...light, ...tokens(":root[data-theme='dark'] {") };
const lightRaw = rawTokens(':root {');
const darkRaw = { ...lightRaw, ...rawTokens(":root[data-theme='dark'] {") };

// The colours that carry meaning: a text, a state, a border one has to tell apart.
const MEANINGFUL = ['text', 'text-secondary', 'accent-text', 'success', 'warning', 'error', 'primary'];

for (const [name, scheme, raw] of [['light', light, lightRaw], ['dark', dark, darkRaw]]) {
    test(`${name} theme`, async (t) => {
        await t.test('every meaningful colour reaches 4.5:1 on the surface', () => {
            for (const token of MEANINGFUL) {
                const value = scheme[token];
                assert.ok(value, `--${token} is missing from the ${name} theme`);
                const ratio = contrast(value, scheme.paper);
                assert.ok(ratio >= 4.5, `--${token} (${value}): ${ratio.toFixed(2)}:1 on ${scheme.paper}`);
            }
        });

        await t.test('the main text reads on the page background too', () => {
            assert.ok(contrast(scheme.text, scheme.bg) >= 4.5);
        });

        // An alert is not painted on the surface but on its own wash — translucent in dark,
        // where the text is the verdict colour itself. Every point by which the wash lightens
        // the background is taken from that text's legibility: that is where the wash's alpha
        // is decided, not by eye.
        await t.test('the text of an alert reads on its wash', () => {
            for (const kind of ['success', 'error', 'info']) {
                const wash = flatten(raw[`${kind}-wash`], raw, scheme.paper);
                const text = flatten(raw[`${kind}-text`], raw, scheme.paper);
                const ratio = contrast(text, wash);
                assert.ok(ratio >= 4.5, `--${kind}-text (${text}): ${ratio.toFixed(2)}:1 on ${wash}`);
            }
        });

        // Gold as a surface is the one constant of both themes: a solid button is gold and
        // carries ink, here as on the web space.
        await t.test('the solid button carries ink on gold', () => {
            assert.equal(scheme.accent, '#c5a059');
            assert.equal(scheme['accent-ink'], '#1a202c');
            assert.ok(contrast(scheme['accent-ink'], scheme.accent) >= 4.5);
        });
    });
}

test('both themes describe the same tokens', () => {
    // A token defined in light and forgotten in dark silently falls back to the light value:
    // that is how a white background reappears in the middle of a dark panel.
    const overridden = Object.keys(tokens(":root[data-theme='dark'] {"));
    const expected = ['primary', 'accent-text', 'bg', 'paper', 'text', 'text-secondary',
        'divider', 'success', 'warning', 'error'];
    for (const token of expected) {
        assert.ok(overridden.includes(token), `--${token} is not redefined in dark`);
    }
});

test('the media query and the explicit choice carry the same values', () => {
    // Both blocks are written by hand: this test is what keeps them from diverging.
    const query = tokens('@media (prefers-color-scheme: dark) {\n    :root:not([data-theme=\'light\']) {');
    assert.deepEqual(query, tokens(":root[data-theme='dark'] {"));
});

// --- COLOUR VISION ---
// The matrices of Machado, Oliveira and Fernandes (2009), complete deficiency, applied in
// linear light: what an eye without one of the three cones sees of our three verdicts. They are
// not a homemade approximation — it is the model the tools of the field use.
const DEFICIENCIES = {
    protanopia: [[0.152286, 1.052583, -0.204868], [0.114503, 0.786281, 0.099216], [-0.003882, -0.048116, 1.051998]],
    deuteranopia: [[0.367322, 0.860646, -0.227968], [0.280085, 0.672501, 0.047413], [-0.011820, 0.042940, 0.968881]],
    tritanopia: [[1.255528, -0.076749, -0.178779], [-0.078411, 0.930809, 0.147602], [0.004733, 0.691367, 0.303900]],
};

/** Lab (D65) of a colour, optionally seen through a deficiency. */
function lab(hex, deficiency) {
    let c = linear(hex);
    if (deficiency) {
        const m = DEFICIENCIES[deficiency];
        c = m.map((row) => Math.min(1, Math.max(0, row[0] * c[0] + row[1] * c[1] + row[2] * c[2])));
    }
    const xyz = [
        (0.4124 * c[0] + 0.3576 * c[1] + 0.1805 * c[2]) / 0.95047,
        0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2],
        (0.0193 * c[0] + 0.1192 * c[1] + 0.9505 * c[2]) / 1.08883,
    ].map((t) => (t > 216 / 24389 ? Math.cbrt(t) : (841 / 108) * t + 4 / 29));
    return [116 * xyz[1] - 16, 500 * (xyz[0] - xyz[1]), 200 * (xyz[1] - xyz[2])];
}

/** The perceived distance between two colours (CIE76), in Lab units. */
function distance(a, b, deficiency) {
    const [first, second] = [lab(a, deficiency), lab(b, deficiency)];
    return Math.hypot(...first.map((value, i) => value - second[i]));
}

// Two floors, not one: every pair must stay separable, but the pair that tells the student
// whether the measurement goes out or not — success against failure — must be so by a wide
// margin, because it is the only one read at a glance without reading the text beside it.
for (const [name, scheme] of [['light', light], ['dark', dark]]) {
    test(`${name} theme: the verdicts are told apart without seeing every colour`, () => {
        const pairs = [
            ['success/failure', scheme.success, scheme.error, 30],
            ['success/pending', scheme.success, scheme.warning, 12],
            ['pending/failure', scheme.warning, scheme.error, 12],
        ];
        for (const deficiency of [null, ...Object.keys(DEFICIENCIES)]) {
            for (const [label, a, b, floor] of pairs) {
                const delta = distance(a, b, deficiency);
                assert.ok(delta >= floor,
                    `${label} under ${deficiency || 'normal vision'}: ΔE ${delta.toFixed(1)}, floor ${floor}`);
            }
        }
    });
}
