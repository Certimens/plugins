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
// One object for the whole file: a case that needs a piece of the editor sets it on this one,
// which is the object the panel holds.
const vscodeStub = {};
Module._load = function (request, ...rest) {
    return request === 'vscode' ? vscodeStub : load.call(this, request, ...rest);
};
const { statusText, CertimensPanel, notify } = require('../src/panel.js');
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

// The page is built under a policy that allows no inline style: one that slipped back in would
// be dropped by the webview without a word, which is how the panel shipped without its spacing.
test('the page asks for nothing its own policy refuses', () => {
    const html = CertimensPanel.prototype.html.call(
        { updated: '', media: (name) => `vscode-resource:/media/${name}` },
        { cspSource: 'vscode-resource:' },
    );
    const nonce = /script-src 'nonce-([\w-]+)'/.exec(html)[1];
    assert.match(html, new RegExp(`style-src vscode-resource: 'nonce-${nonce}'`));
    assert.ok(html.includes(`<style nonce="${nonce}">`), 'the style sheet carries the nonce');
    assert.ok(html.includes(`<script nonce="${nonce}">`));
    assert.doesNotMatch(html, /\sstyle=/, 'no style attribute: nothing allows one');
    assert.doesNotMatch(html, /\son[a-z]+=/, 'no inline handler either');
});

// « Signaler un problème »: the page asks, the host builds. The link carries the report block,
// and the block is nothing a webview needs to see.
test('the « report a problem » link of the panel', async (t) => {
    const html = CertimensPanel.prototype.html.call(
        { updated: '', media: (name) => `vscode-resource:/media/${name}` },
        { cspSource: 'vscode-resource:' },
    );

    await t.test('the page has the link, and only posts a message', () => {
        assert.match(html, /<button type="button" id="report" class="link small">Signaler un problème<\/button>/);
        assert.match(html, /postMessage\(\{ type: 'reportProblem' \}\)/);
        assert.doesNotMatch(html, /#report|details=|kind=problem/, 'the page builds no link of its own');
    });

    await t.test('the message runs the command, with nothing from the page', async () => {
        const executed = [];
        vscodeStub.commands = { executeCommand: (...args) => { executed.push(args); return Promise.resolve(); } };
        try {
            const panel = { refresh: () => {}, agent: { engine: { countRuntime: () => {} } } };
            CertimensPanel.prototype.handle.call(panel, { type: 'reportProblem', url: 'https://evil.test/' });
            await new Promise((resolve) => setImmediate(resolve));
            assert.deepEqual(executed, [['certimens.reportProblem']]);
        } finally {
            delete vscodeStub.commands;
        }
    });

    await t.test('an error notification carries the button, and the button opens the form', async () => {
        const shown = [];
        const executed = [];
        let choice;
        vscodeStub.window = { showErrorMessage: (...args) => { shown.push(args); return Promise.resolve(choice); } };
        vscodeStub.commands = { executeCommand: (...args) => { executed.push(args); return Promise.resolve(); } };
        try {
            choice = undefined;
            await notify.failure(new Error('[ici](command:workbench.action.reloadWindow)'));
            assert.equal(shown.length, 1);
            assert.equal(shown[0][1], 'Signaler un problème');
            assert.doesNotMatch(shown[0][0], /\]\(/, 'the sentence goes through plain()');
            assert.deepEqual(executed, [], 'dismissed: nothing opens');
            choice = 'Signaler un problème';
            await notify.failure(new Error('erreur réseau'));
            assert.deepEqual(executed, [['certimens.reportProblem']]);
        } finally {
            delete vscodeStub.window;
            delete vscodeStub.commands;
        }
    });
});
