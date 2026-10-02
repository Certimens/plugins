// Le dictionnaire d'interface de l'extension (src/i18n.js).
//
// C'est le dictionnaire **de référence** : le volet Word pointe sur ce fichier par un lien
// symbolique, et VS Code en tient une copie qu'il compare à celui-ci (vscode/tests/i18n.test.mjs).
// Une traduction se vérifie surtout par ce qui manque : une clé présente dans une langue et pas
// dans l'autre passe inaperçue jusqu'à ce qu'un étudiant tombe dessus. La règle de choix de la
// langue, elle, est celle du moteur et doit rester identique dans les quatre agents —
// libreoffice/tests/test_i18n.py fait les mêmes vérifications côté Python.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { clock, load, officeGlobals } from './helpers/sandbox.mjs';

const dictionary = load(new URL('../src/i18n.js', import.meta.url), {
    globals: officeGlobals(clock()),
    expose: ['MESSAGES', 't', 'setLanguage', 'normalizeLanguage', 'dateLocale', 'currentLanguage'],
});

test('dictionnaire de l’extension navigateur', async (t) => {
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
