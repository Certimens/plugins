// How the host tells a paste from every other block (`watchPastes` and `Agent.pastedInto` in
// src/extension.js).
//
// The change event gives the text a gesture inserted, never the gesture. Since VS Code 1.97 the
// editor shows an extension every paste and every drop before applying it; the host registers a
// provider for each that returns no edit and only notes "a paste is landing in this document".
// The sensor then reads the next change as a paste, and a block that lands with no note as a
// suggestion (`suggest`). What is pinned here: what is registered and where, that nothing pasted
// is ever read, how long a note lasts and what spends it, and every case in which the host has
// to say it cannot tell — which keeps a block a `paste`.
//
// The editor itself is not here: tests/host/suite.cjs pastes for real, in a VS Code that has
// the providers.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import Module from 'node:module';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

// The `vscode` module the shipped file is handed: an editor that has the two providers, which
// each test reshapes to the editor it needs. The file holds on to this one object.
const vscode = {};
const load = Module._load;
Module._load = function (request, ...rest) {
    return request === 'vscode' ? vscode : load.call(this, request, ...rest);
};
const { watchPastes, pasteProvidersIn, Agent } = require('../src/extension.js');
Module._load = load;

const TEXT_KIND = { value: 'text' };

function editor({ version = '1.97.0', web = false, providers = true, settings = {}, installed = [], refuseDrop = false } = {}) {
    const registered = [];
    const disposed = [];
    const asked = { configuration: 0 };
    const register = (what) => (selector, provider, metadata) => {
        if (what === 'drop' && refuseDrop) throw new Error('refused');
        // What VS Code 1.90 to 1.96 do: the function is there, as a proposal that throws.
        if (what === 'paste' && !pasteProvidersIn(version)) throw new Error("Extension 'certimens.certimens' CANNOT use API proposal: documentPaste.");
        const entry = { what, selector, provider, metadata };
        registered.push(entry);
        return { dispose: () => disposed.push(what) };
    };
    for (const key of Object.keys(vscode)) delete vscode[key];
    Object.assign(vscode, {
        version,
        env: { uiKind: web ? 2 : 1 },
        UIKind: { Desktop: 1, Web: 2 },
        languages: {
            registerDocumentDropEditProvider: register('drop'),
            ...(providers ? { registerDocumentPasteEditProvider: register('paste') } : {}),
        },
        ...(providers ? {
            DocumentDropOrPasteEditKind: { Text: TEXT_KIND },
            DocumentPasteTriggerKind: { Automatic: 0, PasteAs: 1 },
        } : {}),
        workspace: {
            getConfiguration: (section) => {
                asked.configuration++;
                assert.equal(section, 'editor');
                return { get: (key, fallback) => (key in settings ? settings[key] : fallback) };
            },
        },
        extensions: { getExtension: (id) => (installed.includes(id) ? { id } : undefined) },
    });
    // What the host is, for these two methods: its notes and whether it is announced to.
    const agent = Object.assign(Object.create(Agent.prototype), { announcing: false, notices: new Map() });
    const subscriptions = watchPastes(agent);
    return { agent, registered, disposed, asked, subscriptions };
}

const doc = (path = '/projet/src/main.go') => ({ uri: { toString: () => `file://${path}` } });

// A change event of `doc`, inserting each text given.
const changeOf = (document, ...texts) => ({ document, contentChanges: texts.map((text) => ({ text, rangeLength: 0 })) });

const BLOCK = 'fmt.Println("bonjour tout le monde")';

// Node's monotonic clock, which the host reads, set to `ms` for the length of `fn`.
function at(ms, fn) {
    const real = Object.getOwnPropertyDescriptor(globalThis, 'performance');
    Object.defineProperty(globalThis, 'performance', { value: { now: () => ms }, configurable: true, writable: true });
    try {
        return fn();
    } finally {
        Object.defineProperty(globalThis, 'performance', real);
    }
}

// Anything that reads what is being pasted throws.
const untouchable = (name) => new Proxy({}, {
    get: (target, key) => {
        throw new Error(`${name}.${String(key)} was read`);
    },
    has: () => {
        throw new Error(`${name} was inspected`);
    },
});

const paste = (s, document, ms, triggerKind = 0) => at(ms, () => s.registered.find((r) => r.what === 'paste').provider
    .provideDocumentPasteEdits(document, untouchable('ranges'), untouchable('dataTransfer'), { triggerKind }, untouchable('token')));

test('where the editor has them, both providers are registered for the measured files', async (t) => {
    await t.test('one for pastes, one for drops, of the schemes the agent measures', () => {
        const s = editor();
        assert.deepEqual(s.registered.map((r) => r.what), ['paste', 'drop']);
        for (const { selector } of s.registered) assert.deepEqual(selector, [{ scheme: 'file' }, { scheme: 'vscode-remote' }]);
        assert.equal(s.agent.announcing, true);
        assert.equal(s.subscriptions.length, 2, 'both disposed with the extension');
    });

    // The editor asks a provider only about the kinds of data it names, and the kinds of edit it
    // declares are what "Paste as…" filters on.
    await t.test('with the metadata the editor requires', () => {
        const [pasteEntry, dropEntry] = editor().registered;
        assert.deepEqual(pasteEntry.metadata, { providedPasteEditKinds: [TEXT_KIND], pasteMimeTypes: ['text/plain', 'text/uri-list'] });
        assert.deepEqual(dropEntry.metadata, { providedDropEditKinds: [TEXT_KIND], dropMimeTypes: ['text/plain', 'text/uri-list', 'files'] });
    });

    // An edit returned would be applied instead of the editor's own paste, and two would bring up
    // the widget that lets the student pick: the student must see nothing.
    await t.test('they return no edit, and read nothing of what is pasted or dropped', () => {
        const s = editor();
        assert.equal(paste(s, doc(), 0), undefined);
        const drop = s.registered.find((r) => r.what === 'drop').provider;
        assert.equal(drop.provideDocumentDropEdits(doc(), untouchable('position'), untouchable('dataTransfer'), untouchable('token')), undefined);
        assert.equal(s.agent.notices.size, 1, 'one document noted, twice');
    });
});

test('where it cannot tell, the host says so and a block stays a paste', async (t) => {
    // From 1.90 to 1.96 the function is on `vscode.languages` already, as a proposal that throws
    // when called: its presence is not enough, and calling it would count an error of ours.
    await t.test('an editor before 1.97 registers nothing, not even the drop — and calls nothing that throws', () => {
        for (const version of ['1.90.0', '1.96.4']) {
            const s = editor({ version });
            assert.deepEqual(s.registered, [], version);
            assert.deepEqual(s.disposed, [], version);
            assert.equal(s.agent.announcing, false, version);
            assert.equal(s.agent.pastedInto(changeOf(doc(), BLOCK)), undefined, version);
        }
    });

    await t.test('the version is read as VS Code writes it', () => {
        for (const version of ['1.97.0', '1.97.2', '1.98.0-insider', '1.146.0', '2.0.0']) assert.ok(pasteProvidersIn(version), version);
        for (const version of ['1.96.4', '1.90.0', '0.99.0', '', undefined]) assert.ok(!pasteProvidersIn(version), String(version));
    });

    await t.test('an editor without the function at all registers nothing', () => {
        const s = editor({ providers: false });
        assert.deepEqual(s.registered, []);
        assert.equal(s.agent.announcing, false);
        assert.equal(s.agent.pastedInto(changeOf(doc(), BLOCK)), undefined);
    });

    // In a browser tab the editor's own Paste command, from the menu or the palette, writes the
    // clipboard in without asking any provider.
    await t.test('in a browser tab, nothing is registered', () => {
        const s = editor({ web: true });
        assert.deepEqual(s.registered, []);
        assert.equal(s.agent.pastedInto(changeOf(doc(), BLOCK)), undefined);
    });

    await t.test('a drop the editor refuses to watch takes the paste watch down with it', () => {
        const s = editor({ refuseDrop: true });
        assert.deepEqual(s.disposed, ['paste']);
        assert.deepEqual(s.subscriptions, []);
        assert.equal(s.agent.announcing, false);
    });

    await t.test('with `editor.pasteAs.enabled` off the editor asks no paste provider', () => {
        const s = editor({ settings: { 'pasteAs.enabled': false } });
        assert.equal(at(0, () => s.agent.pastedInto(changeOf(doc(), BLOCK))), undefined);
    });

    await t.test('a Vim or a Neovim mode pastes by edits of its own', () => {
        for (const id of ['vscodevim.vim', 'asvetliakov.vscode-neovim']) {
            const s = editor({ installed: [id] });
            assert.equal(at(0, () => s.agent.pastedInto(changeOf(doc(), BLOCK))), undefined, id);
        }
    });
});

test('a note explains the next change of its document, and only that one', async (t) => {
    await t.test('a block with no note, where the editor would have given one, is no paste', () => {
        const s = editor();
        assert.equal(at(0, () => s.agent.pastedInto(changeOf(doc(), BLOCK))), false);
    });

    await t.test('the change after a paste is the paste, and spends the note', () => {
        const s = editor();
        paste(s, doc(), 1000);
        assert.equal(at(1050, () => s.agent.pastedInto(changeOf(doc(), BLOCK))), true);
        assert.equal(at(1100, () => s.agent.pastedInto(changeOf(doc(), BLOCK))), false, 'the completion accepted next');
    });

    // The paste the editor finally did not apply (its document changed while the providers were
    // answering, say) must not turn the next suggestion into a paste for long.
    await t.test('a note nothing came to spend expires', () => {
        const s = editor();
        paste(s, doc(), 1000);
        assert.equal(at(1000 + 10_001, () => s.agent.pastedInto(changeOf(doc(), BLOCK))), false);
        paste(s, doc(), 50_000);
        assert.equal(at(50_000 + 9_999, () => s.agent.pastedInto(changeOf(doc(), BLOCK))), true);
    });

    // A keystroke that comes first is what cancelled the paste: the editor drops a paste whose
    // document changed under it.
    await t.test('a keystroke spends it too', () => {
        const s = editor();
        paste(s, doc(), 0);
        at(10, () => s.agent.pastedInto(changeOf(doc(), 'a')));
        assert.equal(at(20, () => s.agent.pastedInto(changeOf(doc(), BLOCK))), false);
    });

    await t.test('"Paste as…" waits for the student to choose', () => {
        const s = editor();
        paste(s, doc(), 0, 1);
        assert.equal(at(60_000, () => s.agent.pastedInto(changeOf(doc(), BLOCK))), true);
        paste(s, doc(), 0, 1);
        assert.equal(at(2 * 60_000 + 1, () => s.agent.pastedInto(changeOf(doc(), BLOCK))), false);
    });

    await t.test('a paste into one file says nothing of another', () => {
        const s = editor();
        paste(s, doc('/projet/a.go'), 0);
        assert.equal(at(10, () => s.agent.pastedInto(changeOf(doc('/projet/b.go'), BLOCK))), false);
        assert.equal(at(20, () => s.agent.pastedInto(changeOf(doc('/projet/a.go'), BLOCK))), true);
    });

    await t.test('a drop is a paste', () => {
        const s = editor();
        at(0, () => s.registered.find((r) => r.what === 'drop').provider.provideDocumentDropEdits(doc()));
        assert.equal(at(10, () => s.agent.pastedInto(changeOf(doc(), BLOCK))), true);
    });

    // The sensor reads the answer for a block only; the settings and the extensions are not
    // asked on every keystroke.
    await t.test('an ordinary keystroke asks the editor nothing', () => {
        const s = editor();
        at(0, () => s.agent.pastedInto(changeOf(doc(), 'a', 'é', '\n' + ' '.repeat(12))));
        assert.equal(s.asked.configuration, 0);
    });
});
