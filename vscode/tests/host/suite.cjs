// What can only be checked inside the editor, run by VS Code itself (see run.mjs).
//
// Each case answers "does the extension do anything once installed?", not "does it count
// right?" — that is the business of the unit suites, which hold the measurement rules. Here the
// host is exercised: activation, the commands the manifest promises, the webview, and a
// document really being edited.
//
// No mocha: a failure is an exception, and that is all a suite needs.

const assert = require('node:assert/strict');

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

    const failed = results.filter((line) => line.startsWith('  ✖'));
    console.log(`\nCertimens in VS Code ${vscode.version}:\n${results.join('\n')}\n`);
    if (failed.length) throw new Error(`${failed.length} failing case(s) in the extension host`);
};
