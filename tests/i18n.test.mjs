// Les dictionnaires d'interface des agents JavaScript (extension/i18n.js, vscode/i18n.js).
//
// Une traduction se vérifie surtout par ce qui manque : une clé présente dans une langue et pas
// dans l'autre passe inaperçue jusqu'à ce qu'un étudiant tombe dessus. La règle de choix de la
// langue, elle, est celle du moteur (internal/user/domain.NormalizeLanguage) et doit rester
// identique dans les quatre agents.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

import { clock, load, officeGlobals } from './helpers/sandbox.mjs';

const require = createRequire(import.meta.url);

function browserDictionary() {
    return load('extension/i18n.js', {
        globals: officeGlobals(clock()),
        expose: ['MESSAGES', 't', 'setLanguage', 'normalizeLanguage', 'dateLocale', 'currentLanguage'],
    });
}

const DICTIONARIES = [
    ['extension', browserDictionary()],
    ['vscode', require('../vscode/i18n.js')],
];

for (const [name, dictionary] of DICTIONARIES) {
    test(`dictionnaire ${name}`, async (t) => {
        const fr = Object.keys(dictionary.MESSAGES.fr);
        const en = Object.keys(dictionary.MESSAGES.en);

        await t.test('les deux langues portent exactement les mêmes clés', () => {
            assert.deepEqual(fr.filter((key) => !en.includes(key)), [], 'clés sans traduction anglaise');
            assert.deepEqual(en.filter((key) => !fr.includes(key)), [], 'clés sans version française');
        });

        await t.test('aucune traduction vide', () => {
            for (const language of ['fr', 'en']) {
                for (const [key, text] of Object.entries(dictionary.MESSAGES[language])) {
                    assert.ok(text.trim().length > 0, `${language}/${key} est vide`);
                }
            }
        });

        await t.test('les deux langues attendent les mêmes variables', () => {
            const names = (text) => [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
            for (const key of fr) {
                assert.deepEqual(names(dictionary.MESSAGES.en[key]), names(dictionary.MESSAGES.fr[key]),
                    `${key} : les variables diffèrent d'une langue à l'autre`);
            }
        });

        await t.test('la règle du moteur : « en » donne l’anglais, tout le reste le français', () => {
            assert.equal(dictionary.normalizeLanguage('en'), 'en');
            assert.equal(dictionary.normalizeLanguage('en-GB'), 'en');
            assert.equal(dictionary.normalizeLanguage('EN-us'), 'en');
            assert.equal(dictionary.normalizeLanguage('fr-FR'), 'fr');
            assert.equal(dictionary.normalizeLanguage('es-ES'), 'fr');
            assert.equal(dictionary.normalizeLanguage(''), 'fr');
            assert.equal(dictionary.normalizeLanguage(null), 'fr');
        });

        await t.test('le compte l’emporte sur la langue de l’éditeur', () => {
            assert.equal(dictionary.setLanguage('en', 'fr-FR'), 'en');
            assert.equal(dictionary.setLanguage('fr', 'en-US'), 'fr');
            // Tant que l'étudiant n'est pas connecté, c'est l'hôte qui décide.
            assert.equal(dictionary.setLanguage('', 'en-US'), 'en');
            assert.equal(dictionary.setLanguage(null, null), 'fr');
        });

        await t.test('les variables sont remplacées, une clé inconnue se voit', () => {
            dictionary.setLanguage('fr');
            assert.equal(dictionary.t('cle.inexistante'), 'cle.inexistante');
            const key = fr.find((k) => dictionary.MESSAGES.fr[k].includes('{'));
            const variable = dictionary.MESSAGES.fr[key].match(/\{(\w+)\}/)[1];
            assert.ok(!dictionary.t(key, { [variable]: 'X' }).includes(`{${variable}}`));
            // Une variable non fournie reste visible plutôt que de laisser un trou dans la phrase.
            assert.ok(dictionary.t(key).includes(`{${variable}}`));
        });

        await t.test('les dates suivent la langue', () => {
            dictionary.setLanguage('en');
            assert.equal(dictionary.dateLocale(), 'en-GB');
            dictionary.setLanguage('fr');
            assert.equal(dictionary.dateLocale(), 'fr-FR');
        });
    });
}

test('les deux dictionnaires JavaScript s’accordent sur les clés communes', () => {
    const [, browser] = DICTIONARIES[0];
    const [, editor] = DICTIONARIES[1];
    const shared = Object.keys(browser.MESSAGES.fr).filter((key) => key in editor.MESSAGES.fr);
    // Les clés partagées sont celles d'un même message : s'il diverge, c'est qu'une clé a été
    // réutilisée pour autre chose, et l'étudiant lira deux phrases différentes pour un même état.
    assert.ok(shared.length > 0, 'les deux dictionnaires devraient partager des clés');
    for (const key of shared) {
        for (const language of ['fr', 'en']) {
            assert.equal(editor.MESSAGES[language][key], browser.MESSAGES[language][key],
                `${key} diffère entre l'extension et VS Code en ${language}`);
        }
    }
});
