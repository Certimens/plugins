// Le dictionnaire d'interface de l'extension VS Code (src/i18n.js).
//
// Les mêmes vérifications que pour les autres agents — une clé oubliée dans une langue, une
// variable qui change de nom, une règle de choix de la langue qui dérive de celle du moteur —
// plus celle qui n'appartient qu'à VS Code : **ce dictionnaire est une copie**. Le navigateur
// porte le fichier de référence (le volet Word y pointe par un lien symbolique) ; VS Code, qui
// est en CommonJS, en tient le sien et doit dire la même chose pour les clés communes.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

import { clock, load, officeGlobals } from './helpers/sandbox.mjs';

const require = createRequire(import.meta.url);
const dictionary = require('../src/i18n.js');

test('dictionnaire de l’extension VS Code', async (t) => {
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
        assert.equal(dictionary.setLanguage('', 'en-US'), 'en');
        assert.equal(dictionary.setLanguage(null, null), 'fr');
    });

    await t.test('les variables sont remplacées, une clé inconnue se voit', () => {
        dictionary.setLanguage('fr');
        assert.equal(dictionary.t('cle.inexistante'), 'cle.inexistante');
        const key = fr.find((k) => dictionary.MESSAGES.fr[k].includes('{'));
        const variable = dictionary.MESSAGES.fr[key].match(/\{(\w+)\}/)[1];
        assert.ok(!dictionary.t(key, { [variable]: 'X' }).includes(`{${variable}}`));
        assert.ok(dictionary.t(key).includes(`{${variable}}`));
    });

    await t.test('les dates suivent la langue', () => {
        dictionary.setLanguage('en');
        assert.equal(dictionary.dateLocale(), 'en-GB');
        dictionary.setLanguage('fr');
        assert.equal(dictionary.dateLocale(), 'fr-FR');
    });
});

test('la copie dit la même chose que le dictionnaire de référence', () => {
    const reference = load(new URL('../../browser/src/i18n.js', import.meta.url), {
        globals: officeGlobals(clock()),
        expose: ['MESSAGES'],
    });
    const shared = Object.keys(reference.MESSAGES.fr).filter((key) => key in dictionary.MESSAGES.fr);
    // Une clé partagée est celle d'un même message : si le texte diverge, c'est qu'elle a été
    // réutilisée pour autre chose, et l'étudiant lira deux phrases différentes pour un même état.
    assert.ok(shared.length > 0, 'les deux dictionnaires devraient partager des clés');
    for (const key of shared) {
        for (const language of ['fr', 'en']) {
            assert.equal(dictionary.MESSAGES[language][key], reference.MESSAGES[language][key],
                `${key} diffère de la référence en ${language}`);
        }
    }
});
