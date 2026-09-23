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
const WORD_SHARED = ['ui.css', 'ui.js', 'fonts', 'icons/icon16.png', 'icons/icon32.png', 'icons/icon128.png'];

const manifest = JSON.parse(readFileSync(join(source, 'manifest.json'), 'utf8'));

// Chrome Web Store and Opera Add-ons limit; they reject the package beyond it.
if (manifest.description.length > 132) {
    console.error(`Description du manifest trop longue (${manifest.description.length} caractères, 132 maximum).`);
    process.exit(1);
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

// Read back by the workflows, so the version is resolved here and nowhere else.
writeFileSync(join(dist, 'VERSION'), label + '\n');
