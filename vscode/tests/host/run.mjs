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
// puts to the test. VSCODE_VERSION forces another ('stable' for the latest).
//
// VS Code is an Electron application: even to run a suite, it asks for a display. `make
// test-host` therefore starts it in a throwaway container (tests/host/Dockerfile), which brings
// xvfb and the editor's libraries without installing anything on the machine. Nothing prevents
// running `npm run test:host` directly where there is a display.
//
// Everything this downloads fits in .vscode-test/ (VSCODE_TEST_CACHE elsewhere), ignored by
// git: `make clean` erases it.

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { runTests } from '@vscode/test-electron';

const here = dirname(fileURLToPath(import.meta.url));
const agent = resolve(here, '..', '..');
const declared = JSON.parse(readFileSync(resolve(agent, 'package.json'), 'utf8')).engines.vscode;
const version = process.env.VSCODE_VERSION || declared.replace(/^\D+/, '');

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
            '--user-data-dir', process.env.VSCODE_TEST_USER_DATA || resolve(agent, '.vscode-test', 'user-data'),
            '--extensions-dir', process.env.VSCODE_TEST_EXTENSIONS || resolve(agent, '.vscode-test', 'extensions'),
        ],
    });
} catch (err) {
    console.error(`\nVS Code ${version}: the integration suite failed.`, err?.message || err);
    process.exit(1);
}
