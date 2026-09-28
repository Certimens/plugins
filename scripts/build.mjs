// Builds the extension packages for each store: dist/chrome.zip, dist/firefox.zip and
// dist/safari.zip.
//
// The extension/ manifest serves every browser (and unpacked loading too). Each package keeps
// only what its browser understands: Chrome rejects background.scripts in MV3 and doesn't know
// browser_specific_settings; Firefox prefers background.scripts over the service worker.
// chrome.zip also serves Edge, Opera and the other Chromium browsers (Brave, Vivaldi, Arc).
// safari.zip (same content as Chrome) is converted into an Xcode project on macOS: see
// scripts/safari.sh.
//
// The Word add-in goes into dist/word/ (site published on GitHub Pages): the word/ files, plus
// the extension's stylesheet, fonts and icons, and its manifest whose URLs point at
// WORD_BASE_URL. dist/word-localhost.xml is the same manifest pointing at
// https://localhost:3000 (npm run word:serve).
//
// The LibreOffice extension goes into dist/libreoffice.oxt: the libreoffice/ files (without its
// tests), the extension/manifest.json version injected into description.xml, and the icons.
//
// The VS Code extension goes into dist/certimens-vscode.vsix (and dist/vscode/, the unpacked
// folder `code --extensionDevelopmentPath` loads): the vscode/ files, plus the extension's
// stylesheet, fonts and icon under media/, and the resolved version in its package.json.
//
// Versions come from git, so nothing has to be bumped by hand before a release:
//   --release vX.Y.Z  the tag drives every package (used by the release workflow);
//   otherwise         the last tag plus the current commit, e.g. 1.4.2-a9085f3, so any build
//                     can be traced back to what it was built from.
// The version in extension/manifest.json is only the fallback used when the checkout has no tag.
//
// Usage: node scripts/build.mjs [--release vX.Y.Z]

import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const source = join(root, 'extension');
const wordSource = join(root, 'word');
const dist = join(root, 'dist');
const WORD_BASE_URL = (process.env.WORD_BASE_URL || 'https://certimens.github.io/plugins/word').replace(/\/+$/, '');
const WORD_DEV_URL = 'https://localhost:3000';
// What the Word add-in reuses from the extension.
const WORD_SHARED = ['ui.css', 'ui.js', 'i18n.js', 'fonts', 'icons/icon16.png', 'icons/icon32.png', 'icons/icon128.png'];
// What the VS Code panel reuses from it, under media/ (the one folder its webview may read).
// ui.css asks for fonts/ next to itself, hence the whole folder.
const VSCODE_SHARED = { 'ui.css': 'ui.css', 'fonts': 'fonts', 'icons/icon128.png': 'icon128.png' };

const manifest = JSON.parse(readFileSync(join(source, 'manifest.json'), 'utf8'));

// The store listing's name and description come from _locales/, not from the manifest, so the
// length is checked there — once per language, since each one is what its own store listing shows.
// Chrome Web Store and Opera Add-ons reject a package beyond 132 characters.
const LOCALES = ['fr', 'en'];
for (const locale of LOCALES) {
    const messages = JSON.parse(readFileSync(join(source, '_locales', locale, 'messages.json'), 'utf8'));
    const description = messages.extensionDescription.message;
    if (description.length > 132) {
        console.error(`Description trop longue en ${locale} (${description.length} caractères, 132 maximum) : extension/_locales/${locale}/messages.json`);
        process.exit(1);
    }
}

function git(...args) {
    try {
        return execFileSync('git', args, { cwd: root, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
    } catch {
        return ''; // not a git checkout, or no tag yet
    }
}

// version: numeric, the only form Chrome and Word accept. label: what a human reads, equal to
// version on a release and carrying the commit otherwise.
function resolveVersion() {
    const index = process.argv.indexOf('--release');
    const tag = index === -1 ? '' : (process.argv[index + 1] || '');
    if (tag) {
        const version = tag.replace(/^v/, '');
        // Chrome accepts 1 to 4 dot-separated integers, nothing else.
        if (!/^\d+(\.\d+){0,3}$/.test(version)) {
            console.error(`Tag « ${tag} » : version attendue sous la forme X.Y.Z.`);
            process.exit(1);
        }
        return { version, label: version };
    }
    const version = (git('describe', '--tags', '--abbrev=0') || manifest.version).replace(/^v/, '');
    const commit = git('rev-parse', '--short', 'HEAD');
    return { version, label: commit ? `${version}-${commit}` : version };
}

const { version, label } = resolveVersion();

const TARGETS = {
    chrome(m) {
        delete m.browser_specific_settings;
        m.background = { service_worker: m.background.service_worker };
    },
    firefox(m) {
        m.background = { scripts: m.background.scripts };
    },
    safari(m) {
        delete m.browser_specific_settings;
        m.background = { service_worker: m.background.service_worker };
    },
};

rmSync(dist, { recursive: true, force: true });
for (const [target, adapt] of Object.entries(TARGETS)) {
    const dir = join(dist, target);
    cpSync(source, dir, { recursive: true, filter: (path) => !path.endsWith('.md') });
    const targetManifest = structuredClone(manifest);
    targetManifest.version = version;
    // version must stay numeric for Chrome; the traceable label goes to version_name, which
    // Chromium browsers and Safari display and which AMO accepts without a warning.
    if (label !== version) targetManifest.version_name = label;
    adapt(targetManifest);
    writeFileSync(join(dir, 'manifest.json'), JSON.stringify(targetManifest, null, 2) + '\n');
    mkdirSync(dist, { recursive: true });
    execFileSync('zip', ['-qr', '-X', join(dist, `${target}.zip`), '.'], { cwd: dir, stdio: 'inherit' });
    console.log(`dist/${target}.zip (${label})`);
}

// Office wants a four-part version.
const wordManifest = (baseUrl) => readFileSync(join(wordSource, 'manifest.xml'), 'utf8')
    .replaceAll('{{BASE_URL}}', baseUrl)
    .replaceAll('{{VERSION}}', `${version}.0`);
const wordDir = join(dist, 'word');
cpSync(wordSource, wordDir, { recursive: true });
for (const path of WORD_SHARED) cpSync(join(source, path), join(wordDir, path), { recursive: true });
writeFileSync(join(wordDir, 'manifest.xml'), wordManifest(WORD_BASE_URL));
// Landing page: GitHub Pages serves no directory listing, so the site's root needs one file.
writeFileSync(join(wordDir, 'index.html'),
    readFileSync(join(wordSource, 'index.html'), 'utf8').replaceAll('{{VERSION}}', label));
writeFileSync(join(dist, 'word-localhost.xml'), wordManifest(WORD_DEV_URL));
console.log(`dist/word/ (${label}, ${WORD_BASE_URL})`);

const loSource = join(root, 'libreoffice');
const loDir = join(dist, 'libreoffice');
cpSync(loSource, loDir, {
    recursive: true,
    filter: (path) => !/[\\/](tests|__pycache__)$/.test(path) && !path.endsWith('.pyc'),
});
cpSync(join(source, 'icons', 'icon128.png'), join(loDir, 'icons', 'icon128.png'));
writeFileSync(join(loDir, 'description.xml'),
    readFileSync(join(loSource, 'description.xml'), 'utf8').replaceAll('{{VERSION}}', label));
execFileSync('zip', ['-qr', '-X', join(dist, 'libreoffice.oxt'), '.'], { cwd: loDir, stdio: 'inherit' });
console.log(`dist/libreoffice.oxt (${label})`);

// The marketplace wants a three-part version, and nothing but digits: a branch build's label
// (1.4.2-a9085f3) is not one, so the traceable form stays out of the package and in dist/VERSION.
const vscodeVersion = [...version.split('.'), '0', '0'].slice(0, 3).join('.');
const vscodeSource = join(root, 'vscode');
const vscodeDir = join(dist, 'vscode');
cpSync(vscodeSource, vscodeDir, { recursive: true, filter: (path) => !path.endsWith('.md') });
for (const [from, to] of Object.entries(VSCODE_SHARED)) {
    cpSync(join(source, from), join(vscodeDir, 'media', to), { recursive: true });
}
const vscodeManifest = JSON.parse(readFileSync(join(vscodeSource, 'package.json'), 'utf8'));
vscodeManifest.version = vscodeVersion;
writeFileSync(join(vscodeDir, 'package.json'), JSON.stringify(vscodeManifest, null, 4) + '\n');
// The marketplace page is the extension's own README; the repository's stays the reference.
cpSync(join(vscodeSource, 'README.md'), join(vscodeDir, 'README.md'));
// --no-dependencies: the extension ships classic scripts and depends on nothing to install.
execFileSync(join(root, 'node_modules', '.bin', 'vsce'),
    ['package', '--no-dependencies', '--skip-license', '--out', join(dist, 'certimens-vscode.vsix')],
    { cwd: vscodeDir, stdio: 'inherit' });
console.log(`dist/certimens-vscode.vsix (${vscodeVersion})`);

// Read back by the workflows, so the version is resolved here and nowhere else.
writeFileSync(join(dist, 'VERSION'), label + '\n');
