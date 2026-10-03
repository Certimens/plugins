// Ligne d'état du panneau VS Code (src/panel.js).
//
// `statusText` traduit le vocabulaire du moteur (« synced », « offline ») en une phrase pour
// l'étudiant. Elle est testée à part parce qu'un de ses cas a été livré cassé : suspendue, elle
// répétait mot pour mot le bandeau affiché juste au-dessus, et le panneau montrait deux blocs
// rouges disant la même chose (Certimens/plugins#2).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import Module from 'node:module';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

// L'extension est chargée par l'hôte de VS Code, qui lui fournit le module « vscode ». Hors de
// l'éditeur il n'existe pas : on le remplace le temps du chargement, sans rien changer au code
// livré. Le panneau n'en touche rien à l'import — tout passe par ses méthodes.
const load = Module._load;
Module._load = function (request, ...rest) {
    return request === 'vscode' ? {} : load.call(this, request, ...rest);
};
const { statusText } = require('../src/panel.js');
const { setLanguage } = require('../src/i18n.js');
Module._load = load;

setLanguage('fr');

test('la ligne d’état du panneau', async (t) => {
    await t.test('suspendue et rien en attente : elle se tait', () => {
        // Le bandeau du panneau dit déjà la suspension. Répéter, c'était le bug.
        assert.equal(statusText({ state: 'synced' }, 0, true).text, '');
    });

    await t.test('suspendue avec des mesures en attente : elle ne dit que ce qu’elle ajoute', () => {
        const { text } = statusText({ state: 'offline' }, 3, true);
        assert.match(text, /3 mesures/);
        assert.doesNotMatch(text, /suspendue/i, 'la ligne ne doit pas répéter le bandeau');
    });

    await t.test('le singulier et le pluriel', () => {
        assert.match(statusText({ state: 'synced' }, 1, true).text, /^1 mesure d/);
        assert.match(statusText({ state: 'synced' }, 2, true).text, /^2 mesures d/);
    });

    await t.test('non connecté', () => {
        assert.deepEqual(statusText({ state: 'unconfigured' }, 0, false), { text: 'Non connecté.', kind: 'info' });
    });

    await t.test('identifiants refusés', () => {
        assert.equal(statusText({ state: 'auth_error' }, 0, false).kind, 'error');
    });

    await t.test('moteur injoignable, avec son motif', () => {
        const { text } = statusText({ state: 'offline', message: 'ECONNREFUSED' }, 0, false);
        assert.match(text, /ECONNREFUSED/);
    });

    await t.test('tout est passé', () => {
        assert.deepEqual(statusText({ state: 'synced' }, 0, false), { text: 'Mesures synchronisées.', kind: 'ok' });
    });

    await t.test('la file l’emporte sur l’état du moteur', () => {
        // Deux mesures en attente disent plus à l'étudiant que « synchronisé ».
        assert.match(statusText({ state: 'synced' }, 2, false).text, /2 mesures/);
    });
});
