// The extension's interface dictionary (src/i18n.js).
//
// This is the **reference** dictionary: the Word task pane points at this file through a
// symlink, and VS Code keeps a copy it compares to this one (vscode/tests/i18n.test.mjs). A
// translation is checked above all by what is missing: a key present in one language and not
// the other goes unnoticed until a student runs into it. The language-choice rule, for its
// part, is the engine's and must stay identical in the four agents —
// libreoffice/tests/test_i18n.py makes the same checks on the Python side.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';

import { clock, load, officeGlobals } from './helpers/sandbox.mjs';

const dictionary = load(new URL('../src/i18n.js', import.meta.url), {
    globals: officeGlobals(clock()),
    expose: ['MESSAGES', 't', 'setLanguage', 'normalizeLanguage', 'dateLocale', 'currentLanguage'],
});

// What the extension and the Word task pane ship, read as it is: the dictionary itself is left
// out, without which every key would find itself.
function files(directory) {
    const base = new URL(directory);
    return readdirSync(base, { withFileTypes: true, recursive: true })
        .filter((entry) => entry.isFile() && /\.(js|html)$/.test(entry.name) && entry.name !== 'i18n.js')
        .map((entry) => readFileSync(new URL(entry.name, new URL(entry.parentPath + '/', base)), 'utf8'));
}

test('dictionary of the browser extension', async (t) => {
    const fr = Object.keys(dictionary.MESSAGES.fr);
    const en = Object.keys(dictionary.MESSAGES.en);

    await t.test('both languages carry exactly the same keys', () => {
        assert.deepEqual(fr.filter((key) => !en.includes(key)), [], 'keys with no English translation');
        assert.deepEqual(en.filter((key) => !fr.includes(key)), [], 'keys with no French version');
    });

    await t.test('no key nobody displays', () => {
        // A sentence removed from the interface leaves its key behind, and the dictionary starts
        // describing a window that no longer exists. It happened: it long carried the pause
        // sentence of the LibreOffice dialog, which the extension never displayed — it has a
        // banner of its own. This dictionary also serves the Word task pane: both are read.
        const source = [
            ...files(new URL('../src/', import.meta.url)),
            ...files(new URL('../../word/src/', import.meta.url)),
        ].join('\n');
        // The keys built at run time, which no literal search can see: the debug log names a
        // counter by its metric type (`counter.${type}`), and the options page names the sync
        // state by the one the service worker kept (`status.${state}`). The five states are
        // named one by one: "status." as a whole would let status.queued, status.detail and the
        // others through, which are written out.
        const BUILT = (key) => key.startsWith('counter.')
            || ['idle', 'synced', 'offline', 'auth_error', 'unconfigured'].includes(key.replace('status.', ''));
        const unused = fr.filter((key) => !BUILT(key) && !source.includes(key));
        assert.deepEqual(unused, [], 'keys no page displays');
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
        // As long as the student is not connected, the host decides.
        assert.equal(dictionary.setLanguage('', 'en-US'), 'en');
        assert.equal(dictionary.setLanguage(null, null), 'fr');
    });

    await t.test('variables are substituted, an unknown key shows', () => {
        dictionary.setLanguage('fr');
        assert.equal(dictionary.t('cle.inexistante'), 'cle.inexistante');
        const key = fr.find((k) => dictionary.MESSAGES.fr[k].includes('{'));
        const variable = dictionary.MESSAGES.fr[key].match(/\{(\w+)\}/)[1];
        assert.ok(!dictionary.t(key, { [variable]: 'X' }).includes(`{${variable}}`));
        // A variable not supplied stays visible rather than leaving a hole in the sentence.
        assert.ok(dictionary.t(key).includes(`{${variable}}`));
    });

    await t.test('dates follow the language', () => {
        dictionary.setLanguage('en');
        assert.equal(dictionary.dateLocale(), 'en-GB');
        dictionary.setLanguage('fr');
        assert.equal(dictionary.dateLocale(), 'fr-FR');
    });
});
