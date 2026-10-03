// The interface dictionary of the VS Code extension (src/i18n.js).
//
// The same checks as for the other agents — a key forgotten in one language, a variable that
// changes name, a language-choice rule drifting from the engine's — plus the one that belongs
// to VS Code alone: **this dictionary is a copy**. The browser carries the reference file (the
// Word task pane points at it through a symlink); VS Code, which is in CommonJS, keeps its own
// and must say the same thing for the shared keys.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readdirSync, readFileSync } from 'node:fs';

import { clock, load, officeGlobals } from './helpers/sandbox.mjs';

const require = createRequire(import.meta.url);
const dictionary = require('../src/i18n.js');

test('dictionary of the VS Code extension', async (t) => {
    const fr = Object.keys(dictionary.MESSAGES.fr);
    const en = Object.keys(dictionary.MESSAGES.en);

    await t.test('both languages carry exactly the same keys', () => {
        assert.deepEqual(fr.filter((key) => !en.includes(key)), [], 'keys with no English translation');
        assert.deepEqual(en.filter((key) => !fr.includes(key)), [], 'keys with no French version');
    });

    await t.test('no key nobody displays', () => {
        // The same check as in the three other agents: a sentence removed from the interface
        // leaves its key behind, and the dictionary then describes a window that no longer
        // exists.
        const base = new URL('../src/', import.meta.url);
        const source = readdirSync(base, { withFileTypes: true, recursive: true })
            .filter((entry) => entry.isFile() && entry.name.endsWith('.js') && entry.name !== 'i18n.js')
            .map((entry) => readFileSync(new URL(entry.name, new URL(entry.parentPath + '/', base)), 'utf8'))
            .join('\n');
        // Plurals are chosen at run time: `plural(key, count)` reads the "…Plural" key as soon
        // as the count goes past one, and no literal search would see it.
        const unused = fr.filter((key) => !key.endsWith('Plural') && !source.includes(key));
        assert.deepEqual(unused, [], 'keys no panel displays');
        // And every plural's singular exists, without which `plural` would fall back to the key.
        for (const key of fr.filter((k) => k.endsWith('Plural'))) {
            assert.ok(fr.includes(key.replace(/Plural$/, '')), `${key}: missing singular`);
        }
    });

    await t.test('no empty translation', () => {
        for (const language of ['fr', 'en']) {
            for (const [key, text] of Object.entries(dictionary.MESSAGES[language])) {
                assert.ok(text.trim().length > 0, `${language}/${key} is empty`);
            }
        }
    });

    await t.test('both languages expect the same variables', () => {
        const names = (text) => [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
        for (const key of fr) {
            assert.deepEqual(names(dictionary.MESSAGES.en[key]), names(dictionary.MESSAGES.fr[key]),
                `${key}: the variables differ from one language to the other`);
        }
    });

    await t.test('the engine\'s rule: "en" gives English, everything else French', () => {
        assert.equal(dictionary.normalizeLanguage('en'), 'en');
        assert.equal(dictionary.normalizeLanguage('en-GB'), 'en');
        assert.equal(dictionary.normalizeLanguage('EN-us'), 'en');
        assert.equal(dictionary.normalizeLanguage('fr-FR'), 'fr');
        assert.equal(dictionary.normalizeLanguage('es-ES'), 'fr');
        assert.equal(dictionary.normalizeLanguage(''), 'fr');
        assert.equal(dictionary.normalizeLanguage(null), 'fr');
    });

    await t.test('the account wins over the editor\'s language', () => {
        assert.equal(dictionary.setLanguage('en', 'fr-FR'), 'en');
        assert.equal(dictionary.setLanguage('fr', 'en-US'), 'fr');
        assert.equal(dictionary.setLanguage('', 'en-US'), 'en');
        assert.equal(dictionary.setLanguage(null, null), 'fr');
    });

    await t.test('variables are substituted, an unknown key shows', () => {
        dictionary.setLanguage('fr');
        assert.equal(dictionary.t('cle.inexistante'), 'cle.inexistante');
        const key = fr.find((k) => dictionary.MESSAGES.fr[k].includes('{'));
        const variable = dictionary.MESSAGES.fr[key].match(/\{(\w+)\}/)[1];
        assert.ok(!dictionary.t(key, { [variable]: 'X' }).includes(`{${variable}}`));
        assert.ok(dictionary.t(key).includes(`{${variable}}`));
    });

    await t.test('dates follow the language', () => {
        dictionary.setLanguage('en');
        assert.equal(dictionary.dateLocale(), 'en-GB');
        dictionary.setLanguage('fr');
        assert.equal(dictionary.dateLocale(), 'fr-FR');
    });
});

test('the copy says the same thing as the reference dictionary', () => {
    const reference = load(new URL('../../browser/src/i18n.js', import.meta.url), {
        globals: officeGlobals(clock()),
        expose: ['MESSAGES'],
    });
    const shared = Object.keys(reference.MESSAGES.fr).filter((key) => key in dictionary.MESSAGES.fr);
    // A shared key is the key of one same message: if the text diverges, it has been reused for
    // something else, and the student will read two different sentences for one same state.
    assert.ok(shared.length > 0, 'both dictionaries should share keys');
    for (const key of shared) {
        for (const language of ['fr', 'en']) {
            assert.equal(dictionary.MESSAGES[language][key], reference.MESSAGES[language][key],
                `${key} differs from the reference in ${language}`);
        }
    }
});
