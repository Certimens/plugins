// What can only be checked inside the editor, run by VS Code itself (see run.mjs).
//
// Each case answers "does the extension do anything once installed?", not "does it count
// right?" — that is the business of the unit suites, which hold the measurement rules. Here the
// host is exercised: activation, the commands the manifest promises, the webview, and a
// document really being edited.
//
// No mocha: a failure is an exception, and that is all a suite needs.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const vscode = require('vscode');
const manifest = require('../../package.json');

const EXTENSION_ID = `${manifest.publisher}.${manifest.name}`;

const results = [];

async function check(name, fn) {
    try {
        await fn();
        results.push(`  ✔ ${name}`);
    } catch (err) {
        results.push(`  ✖ ${name}\n      ${err.message.split('\n').join('\n      ')}`);
    }
}

// A command that throws comes back here: that is what we want to see, not a silent rejection.
async function run(command, ...args) {
    return vscode.commands.executeCommand(command, ...args);
}

exports.run = async function () {
    const extension = vscode.extensions.getExtension(EXTENSION_ID);

    await check(`the editor sees the extension "${EXTENSION_ID}"`, () => {
        assert.ok(extension, `not found — publisher and name from package.json form its identifier`);
    });

    await check('it activates without throwing', async () => {
        await extension.activate();
        assert.ok(extension.isActive);
    });

    await check('every command of the manifest is registered', async () => {
        const registered = new Set(await vscode.commands.getCommands(true));
        const promised = manifest.contributes.commands.map((entry) => entry.command);
        const missing = promised.filter((command) => !registered.has(command));
        // A command declared and never registered shows in the palette and answers "command
        // not found": nothing, on the development side, says so.
        assert.deepEqual(missing, [], 'commands promised by package.json and absent from the host');
    });

    await check('the declared setting is readable, with its default value', () => {
        const [key] = Object.keys(manifest.contributes.configuration.properties);
        const [section, name] = [key.slice(0, key.indexOf('.')), key.slice(key.indexOf('.') + 1)];
        const value = vscode.workspace.getConfiguration(section).get(name);
        assert.notEqual(value, undefined, `${key} returns nothing`);
        assert.deepEqual(value, manifest.contributes.configuration.properties[key].default);
    });

    await check('the token has somewhere to live: SecretStorage answers', async () => {
        // `activate()` returns what the panel — and an integration suite — can talk to.
        const api = await extension.activate();
        const secrets = api.agent.engine.secrets;
        // A key of our own, never `token`: writing a token would make the agent connected, and
        // its queue would go to the default engine from a CI runner.
        await secrets.set('host-suite-probe', 'a-value');
        assert.equal(await secrets.get('host-suite-probe'), 'a-value');
        await secrets.delete('host-suite-probe');
        assert.equal(await secrets.get('host-suite-probe'), undefined);
    });

    await check('the panel opens: its webview is accepted as it is', async () => {
        // A webview whose security policy refuses the script stays blank, with no error anywhere
        // but in its own console.
        await run('certimens.focusPanel');
    });

    // The browser is not opened from a CI runner: `openExternal` is replaced for the length of
    // the case (the editor leaves `vscode.env` writable under an extension test, and only then).
    // What is checked is that the command runs in the real host, and that the editor is handed
    // the link **as a string** — a `vscode.Uri` would encode the fragment's `?`, `=` and `&`.
    await check('« report a problem » opens the prefilled form, and throws nothing', async () => {
        const opened = [];
        const original = vscode.env.openExternal;
        vscode.env.openExternal = (target) => {
            opened.push(target);
            return Promise.resolve(true);
        };
        let url;
        try {
            url = await run('certimens.reportProblem');
        } finally {
            vscode.env.openExternal = original;
        }
        assert.equal(opened.length, 1, 'openExternal was not called');
        assert.equal(typeof opened[0], 'string');
        assert.equal(opened[0], url);
        const match = /^https:\/\/monespace\.certimens\.fr\/#report\?kind=problem&details=([^&]+)$/.exec(url);
        assert.ok(match, url);
        const lines = decodeURIComponent(match[1]).split('\n');
        assert.equal(lines.length, 11);
        assert.match(lines[1], new RegExp(`^host: VS Code ${vscode.version.replace(/\./g, '\\.')}`));
        assert.match(lines[2], new RegExp(`^os: ${process.platform} ${process.arch}`));
    });

    await check('pausing toggles and comes back', async () => {
        await run('certimens.togglePause');
        await run('certimens.togglePause');
    });

    await check('a document really being edited makes nothing throw', async () => {
        const document = await vscode.workspace.openTextDocument({ language: 'markdown', content: '' });
        const editor = await vscode.window.showTextDocument(document);
        // Character by character: it is what the sensor counts, and what inserting a whole
        // block would not let it see.
        for (const character of 'Mémoire : introduction.') {
            await editor.edit((edit) => edit.insert(document.positionAt(document.getText().length), character));
        }
        assert.equal(document.getText(), 'Mémoire : introduction.');
        // The send is asked for explicitly: with no reachable engine the window goes to the
        // queue, and the whole sensor → agent path is exercised.
        await run('certimens.flush');
    });

    await check('with a folder open, the queue is a file of the workspace storage', async () => {
        const api = await extension.activate();
        const engine = api.agent.engine;
        assert.ok(vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length, 'run.mjs opens a folder');
        assert.equal(engine.queueOwn, true, 'the editor gave no local storage folder: the queue fell back to the workspace state');
        // Not a real window: nobody is signed in here, so nothing leaves, and the probe is
        // cleared right after — the way a sign-out clears a queue.
        await engine.enqueue({ documentId: 'host-suite-probe' });
        const file = path.join(engine.queue.dir, 'queue.jsonl');
        assert.equal(fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).length, 1, `${file}: one line`);
        assert.equal(engine.pending(), 1);
        await engine.clearAccountState();
        assert.equal(fs.readFileSync(file, 'utf8'), '');
        assert.equal(engine.pending(), 0);
    });

    // --- WHAT BROUGHT A BLOCK ---
    // The agent tells a paste from an accepted suggestion by watching the editor's pastes and
    // drops (src/extension.js, watchPastes) — where the editor has the providers, 1.97 and
    // later. run.mjs passes this suite on the minimum declared, which has not, and on 1.97.
    // From 1.90 to 1.96 the function is there already, as a proposal that throws: the version
    // says whether the editor has the providers, not the function's presence.
    const [major, minor] = vscode.version.split('.').map((part) => parseInt(part, 10));
    const providers = major > 1 || (major === 1 && minor >= 97);
    const BLOCK = 'func main() { fmt.Println("bonjour tout le monde") }';

    // A file of the workspace: the providers watch the files the agent may measure, and an
    // untitled buffer is not one.
    async function fileEditor(name) {
        const folder = vscode.workspace.workspaceFolders[0].uri;
        const uri = vscode.Uri.joinPath(folder, name);
        await vscode.workspace.fs.writeFile(uri, new Uint8Array());
        const document = await vscode.workspace.openTextDocument(uri);
        return vscode.window.showTextDocument(document);
    }

    await check(`the paste watch is registered ${providers ? 'without throwing' : 'nowhere: this editor has no paste provider'}`, async () => {
        const api = await extension.activate();
        assert.equal(api.agent.announcing, providers);
    });

    // An edit made through the API — what a completion, a snippet, an assistant does — asks no
    // paste provider: nothing is noted, and the text is what was written.
    await check('a programmatic edit is no paste, and lands as written', async () => {
        const api = await extension.activate();
        const editor = await fileEditor('suggestion.go');
        await editor.edit((edit) => edit.insert(new vscode.Position(0, 0), BLOCK));
        assert.equal(editor.document.getText(), BLOCK);
        assert.equal(api.agent.notices.size, 0, 'a note was taken for an edit no one pasted');
    });

    await check(providers
        ? 'a real paste is announced, and the editor applies it untouched'
        : 'a real paste lands untouched (nothing to announce it in this editor)', async () => {
        const api = await extension.activate();
        const editor = await fileEditor('paste.go');
        await vscode.env.clipboard.writeText(BLOCK);
        await run('editor.action.clipboardPasteAction');
        // The editor applies a paste once every provider has answered.
        for (let i = 0; i < 50 && editor.document.getText() !== BLOCK; i++) {
            await new Promise((resolve) => setTimeout(resolve, 100));
        }
        assert.equal(editor.document.getText(), BLOCK, 'the paste the editor would have made, and no other');
        // Nobody is signed in here, so nothing is measured and the note is not spent: it is
        // still there to be seen.
        assert.equal(api.agent.notices.has(editor.document.uri.toString()), providers);
    });

    // What the sensor makes of each, through the host's own handler. Nobody is signed in, so the
    // agent measures nothing: it is told it does for the length of this case, on this instance
    // only, and what its windows would queue is dropped (`flushed` queues only when signed in).
    await check(providers
        ? 'a pasted block is a `paste`, an edit and a snippet are `suggest`'
        : 'every block is a `paste`, as this editor cannot tell', async () => {
        const api = await extension.activate();
        const agent = api.agent;
        agent.measuring = () => true;
        try {
            const kinds = [];
            const lastRun = (editor) => {
                const runs = agent.sensors.get(editor.document.uri.toString()).measure.runs;
                return runs[runs.length - 1].kind;
            };
            let editor = await fileEditor('pasted.go');
            await vscode.env.clipboard.writeText(BLOCK);
            await run('editor.action.clipboardPasteAction');
            for (let i = 0; i < 50 && editor.document.getText() !== BLOCK; i++) {
                await new Promise((resolve) => setTimeout(resolve, 100));
            }
            kinds.push(lastRun(editor));
            editor = await fileEditor('edited.go');
            await editor.edit((edit) => edit.insert(new vscode.Position(0, 0), BLOCK));
            kinds.push(lastRun(editor));
            editor = await fileEditor('snippet.go');
            await editor.insertSnippet(new vscode.SnippetString('for i := 0; i < ${1:n}; i++ {\n\t$0\n}'));
            kinds.push(lastRun(editor));
            assert.deepEqual(kinds, providers ? ['paste', 'suggest', 'suggest'] : ['paste', 'paste', 'paste']);
        } finally {
            delete agent.measuring;
            agent.endSessions('logout');
        }
    });

    const failed = results.filter((line) => line.startsWith('  ✖'));
    console.log(`\nCertimens in VS Code ${vscode.version}:\n${results.join('\n')}\n`);
    if (failed.length) throw new Error(`${failed.length} failing case(s) in the extension host`);
};
