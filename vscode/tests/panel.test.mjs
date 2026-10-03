// Status line of the VS Code panel (src/panel.js).
//
// `statusText` turns the engine's vocabulary ("synced", "offline") into a sentence for the
// student. It is tested apart because one of its cases shipped broken: while paused, it repeated
// word for word the banner displayed just above, and the panel showed two red blocks saying the
// same thing (Certimens/plugins#2).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import Module from 'node:module';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

// The extension is loaded by VS Code's host, which hands it the `vscode` module. Outside the
// editor it does not exist: we replace it for the duration of the load, without changing
// anything in the shipped code. The panel touches none of it on import — everything goes
// through its methods.
const load = Module._load;
Module._load = function (request, ...rest) {
    return request === 'vscode' ? {} : load.call(this, request, ...rest);
};
const { statusText, CertimensPanel } = require('../src/panel.js');
const { setLanguage } = require('../src/i18n.js');
Module._load = load;

setLanguage('fr');

test('the panel status line', async (t) => {
    await t.test('paused with nothing pending: it stays quiet', () => {
        // The panel's banner already says it is paused. Repeating it was the bug.
        assert.equal(statusText({ state: 'synced' }, 0, true).text, '');
    });

    await t.test('paused with measurements pending: it says only what it adds', () => {
        const { text } = statusText({ state: 'offline' }, 3, true);
        assert.match(text, /3 mesures/);
        assert.doesNotMatch(text, /suspendue/i, 'the line must not repeat the banner');
    });

    await t.test('singular and plural', () => {
        assert.match(statusText({ state: 'synced' }, 1, true).text, /^1 mesure d/);
        assert.match(statusText({ state: 'synced' }, 2, true).text, /^2 mesures d/);
    });

    await t.test('not connected', () => {
        assert.deepEqual(statusText({ state: 'unconfigured' }, 0, false), { text: 'Non connecté.', kind: 'info' });
    });

    await t.test('access denied', () => {
        assert.equal(statusText({ state: 'auth_error' }, 0, false).kind, 'error');
    });

    await t.test('engine unreachable, with its reason', () => {
        const { text } = statusText({ state: 'offline', message: 'ECONNREFUSED' }, 0, false);
        assert.match(text, /ECONNREFUSED/);
    });

    await t.test('everything has gone through', () => {
        assert.deepEqual(statusText({ state: 'synced' }, 0, false), { text: 'Mesures synchronisées.', kind: 'ok' });
    });

    await t.test('the queue wins over the engine state', () => {
        // Two pending measurements tell the student more than "synced".
        assert.match(statusText({ state: 'synced' }, 2, false).text, /2 mesures/);
    });
});

// "Certimens has been updated" — the same rule as in the three other agents, against the
// editor's globalState (browser/tests/update.test.mjs, word/tests/agent.test.mjs,
// libreoffice/tests/test_engine.py).
//
// `noteVersion` is called on a bare object rather than on a constructed panel: the constructor
// subscribes to the editor's events, and the `vscode` module is an empty object here. What is
// under test reads two things off `this.context` and nothing else.
function panelWith({ seen, version }) {
    const written = [];
    const context = {
        extension: version === undefined ? undefined : { packageJSON: { version } },
        globalState: {
            get: (key, fallback) => (key === 'seenVersion' && seen !== undefined ? seen : fallback),
            update: (key, value) => written.push([key, value]),
        },
    };
    return { written, note: () => CertimensPanel.prototype.noteVersion.call({ context }) };
}

test('what the student is told about a new version', async (t) => {
    await t.test('a fresh install says nothing, and remembers what it is', () => {
        const { written, note } = panelWith({ version: '1.5.0' });
        assert.equal(note(), '');
        assert.deepEqual(written, [['seenVersion', '1.5.0']]);
    });

    await t.test('the version that changed is announced', () => {
        const { written, note } = panelWith({ seen: '1.4.0', version: '1.5.0' });
        assert.equal(note(), '1.5.0');
        assert.deepEqual(written, [['seenVersion', '1.5.0']]);
    });

    await t.test('an unchanged version writes nothing at all', () => {
        const { written, note } = panelWith({ seen: '1.5.0', version: '1.5.0' });
        assert.equal(note(), '');
        assert.deepEqual(written, [], 'the panel is resolved again every time it comes back in front');
    });

    // Development: the extension is loaded from a folder, and the host hands over no extension
    // descriptor. Nothing to announce, and nothing to remember either.
    await t.test('no version, nothing said and nothing written', () => {
        const { written, note } = panelWith({ seen: '1.4.0' });
        assert.equal(note(), '');
        assert.deepEqual(written, []);
    });
});
