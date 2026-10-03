// Starts a **real VS Code**, installs this agent into it and runs `suite.cjs` in its extension
// host (`npm run test:host`).
//
// Every other test of this agent replaces the `vscode` module with an empty object: they check
// our rules, and can say nothing about what only happens once inside the editor — an activation
// that throws, a command declared in package.json and never registered, a webview refused by
// its security policy. That is the class of failure where the extension installs and does
// nothing, and it is exactly what the store does not review.
//
// The version downloaded is the **minimum declared** by `engines.vscode`, not the latest: it is
// the one of the student whose editor has not moved in two years, and the only one nothing else
// puts to the test. A second run follows on PASTE_PROVIDERS_VERSION, the first editor that shows
// an extension a paste before applying it: the agent only tells a paste from an accepted
// suggestion there, and that is only proven in an editor that has it. VSCODE_VERSION forces a
// single other one ('stable' for the latest).
//
// VS Code is an Electron application: even to run a suite, it asks for a display. `make
// test-host` therefore starts it in a throwaway container (tests/host/Dockerfile), which brings
// xvfb and the editor's libraries without installing anything on the machine. Nothing prevents
// running `npm run test:host` directly where there is a display.
//
// Everything this downloads fits in .vscode-test/ (VSCODE_TEST_CACHE elsewhere), ignored by
// git: `make clean` erases it.

import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { runTests } from '@vscode/test-electron';

const here = dirname(fileURLToPath(import.meta.url));
const agent = resolve(here, '..', '..');
const declared = JSON.parse(readFileSync(resolve(agent, 'package.json'), 'utf8')).engines.vscode;
// `registerDocumentPasteEditProvider` and the drop provider's metadata became final API in
// VS Code 1.97 (@types/vscode 1.97.0); src/extension.js registers them only where they exist.
const PASTE_PROVIDERS_VERSION = '1.97.0';
const minimum = declared.replace(/^\D+/, '');
const versions = process.env.VSCODE_VERSION
    ? [process.env.VSCODE_VERSION]
    : [...new Set([minimum, PASTE_PROVIDERS_VERSION])];

for (const version of versions) await runOn(version);

async function runOn(version) {
    // A folder to open, empty and throwaway: without one the editor gives the extension no storage
    // folder of its own (`context.storageUri`), and the offline queue's file is never written.
    const workspace = mkdtempSync(join(tmpdir(), 'certimens-workspace-'));
    // One profile per version: an editor opening the profile a newer one wrote may migrate it, and
    // the two runs must not depend on their order.
    const userData = `${process.env.VSCODE_TEST_USER_DATA || resolve(agent, '.vscode-test', 'user-data')}-${version}`;
    const extensions = `${process.env.VSCODE_TEST_EXTENSIONS || resolve(agent, '.vscode-test', 'extensions')}-${version}`;

    try {
        await runTests({
            version,
            extensionDevelopmentPath: agent,
            extensionTestsPath: resolve(here, 'suite.cjs'),
            // The container mounts a volume so the editor is not downloaded again on every run.
            cachePath: process.env.VSCODE_TEST_CACHE || resolve(agent, '.vscode-test'),
            // --disable-extensions does not disable the one in development: the window carries
            // ours only, and nothing a developer's machine may have installed.
            // The profile is throwaway and local to the project, like the rest of .vscode-test/.
            launchArgs: [
                workspace,
                '--disable-extensions',
                '--disable-gpu',
                // Electron refuses its sandbox when running as root, which is the case in a
                // container. The isolation, here, is the container itself.
                '--no-sandbox',
                // The student's token lives in the editor's SecretStorage, which on Linux goes
                // through the desktop keyring. A container has none: without this flag, the store
                // would depend on whatever the image happens to contain. `basic` is the fallback
                // VS Code already uses on a Linux without a keyring — a real path, and always the
                // same one. The keyring itself (gnome-keyring, KWallet, Keychain, DPAPI) is still
                // to be checked by hand (TESTING.md).
                '--password-store=basic',
                // A test suite does not phone home. The editor probes its remote services and its
                // telemetry on startup; none of that concerns the extension, and a CI that emits to
                // a third party on every run is a decision one does not take by omission.
                '--disable-telemetry',
                '--disable-updates',
                // A workspace-trust dialog would block the suite waiting for a click nobody will
                // give.
                '--disable-workspace-trust',
                // Everything the editor writes goes into a folder of its own. The container
                // mounts this agent **read-only** and sends them to /tmp: an integration suite that
                // leaves root-owned files behind is not throwaway.
                '--user-data-dir', userData,
                '--extensions-dir', extensions,
            ],
        });
    } catch (err) {
        console.error(`\nVS Code ${version}: the integration suite failed.`, err?.message || err);
        process.exit(1);
    }
}
