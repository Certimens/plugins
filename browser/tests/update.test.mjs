// "Certimens has been updated" (src/pages.js, showUpdateIfNew).
//
// The rule is one sentence long and has exactly one trap in it: an install that has never
// written the key must be read as a **fresh** install and not as an update. Get that wrong and
// every student already running the extension is told, the day this ships, that they updated to
// the version they have been running for a month — and every new install is greeted by a notice
// about a version it has never not had.
//
// The same rule is implemented in the three other agents, each against its own storage:
// word/tests/agent.test.mjs, vscode/tests/panel.test.mjs, libreoffice/tests/test_engine.py.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { load } from './helpers/sandbox.mjs';

function pages({ stored = {}, version = '1.5.0', versionName = '' } = {}) {
    const written = [];
    const shown = [];
    // What the page listens for on its window, and what it tells the worker.
    const listeners = new Map();
    const messages = [];
    const globals = {
        window: { addEventListener: (type, fn) => listeners.set(type, fn) },
        chrome: {
            runtime: {
                getManifest: () => ({ version, version_name: versionName }),
                sendMessage: (message) => {
                    messages.push(message);
                    return Promise.resolve();
                },
            },
            storage: {
                local: {
                    get: () => Promise.resolve({ ...stored }),
                    set: (values) => {
                        written.push(values);
                        Object.assign(stored, values);
                        return Promise.resolve();
                    },
                },
            },
        },
        // Declared by ui.js, which this file does not load: what it draws is tested through the
        // pages that hold the element.
        showUpdateNotice: (value) => shown.push(value),
    };
    return { stored, written, shown, listeners, messages, internals: load(new URL('../src/pages.js', import.meta.url), { globals, expose: ['showUpdateIfNew'] }) };
}

test('what the student is told about a new version', async (t) => {
    await t.test('a fresh install says nothing, and remembers what it is', async () => {
        const run = pages();
        await run.internals.showUpdateIfNew();
        assert.deepEqual(run.shown, [], 'nothing to announce on a first install');
        // Compared field by field: what the sandbox writes is built inside its own realm, and a
        // strict deep comparison would be judging prototypes rather than values.
        assert.equal(run.written.length, 1, 'but the version is recorded');
        assert.equal(run.written[0].seenVersion, '1.5.0');
    });

    await t.test('the version that changed is announced, once', async () => {
        const run = pages({ stored: { seenVersion: '1.4.0' } });
        await run.internals.showUpdateIfNew();
        assert.deepEqual(run.shown, ['1.5.0']);
        assert.equal(run.stored.seenVersion, '1.5.0');

        // The notice is consumed by being shown: the second window to open says nothing.
        const again = pages({ stored: run.stored });
        await again.internals.showUpdateIfNew();
        assert.deepEqual(again.shown, []);
    });

    await t.test('an unchanged version writes nothing at all', async () => {
        const run = pages({ stored: { seenVersion: '1.5.0' } });
        await run.internals.showUpdateIfNew();
        assert.deepEqual(run.shown, []);
        assert.deepEqual(run.written, [], 'a window opening must not rewrite the storage for nothing');
    });

    // A build of a branch is `1.4.2-a9085f3` in version_name and `1.4.2` in version, which is
    // all a store accepts. The readable one is what the student is shown — and what tells two
    // builds of the same version apart.
    await t.test('the readable label wins over the number a store demands', async () => {
        const run = pages({ stored: { seenVersion: '1.4.2' }, version: '1.4.2', versionName: '1.4.2-a9085f3' });
        await run.internals.showUpdateIfNew();
        assert.deepEqual(run.shown, ['1.4.2-a9085f3']);
    });

    // A version going backwards is a change like any other: a store rolling a release back
    // leaves the student with something other than what they were shown, and the line that says
    // so is the only trace of it they will ever see.
    await t.test('a version going backwards is announced too', async () => {
        const run = pages({ stored: { seenVersion: '1.6.0' } });
        await run.internals.showUpdateIfNew();
        assert.deepEqual(run.shown, ['1.5.0']);
    });
});

// The page's own uncaught exceptions feed the worker's `error.runtime` counter and its faults
// (docs/moteur.md, "Ce que l'agent dit de lui-même"). An extension page runs nothing but the
// extension's scripts, so listening on its window is listening to ourselves.
test('an uncaught error in a page is reported once, with its type and stack', () => {
    const run = pages();
    const boom = new Error('le texte de l’étudiant pourrait être ici');
    run.listeners.get('error')({ error: boom, message: boom.message, filename: 'popup.js' });
    run.listeners.get('unhandledrejection')({ reason: boom });

    assert.equal(run.messages.length, 1, 'a broken render must not report at every redraw');
    // The type and the stack, for the worker to keep the frames of (faultOf); the message as such
    // is not sent, and what the worker keeps of the stack is tested there.
    assert.deepEqual(Object.keys(run.messages[0]), ['type', 'name', 'stack']);
    assert.equal(run.messages[0].type, 'CERTIMENS_RUNTIME_ERROR');
    assert.equal(run.messages[0].name, 'Error');
    assert.equal(run.messages[0].stack, boom.stack);
});
