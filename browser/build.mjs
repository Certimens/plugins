// Builds the browser extension's packages: dist/chrome.zip, dist/firefox.zip and
// dist/safari.zip, plus the unpacked folders they come from.
//
// Everything the extension ships lives in src/: a package is that folder, plus the licence.
//
// src/manifest.json serves every browser (and unpacked loading too). Each package keeps only what
// its browser understands: Chrome rejects background.scripts in MV3 and doesn't know
// browser_specific_settings; Firefox prefers background.scripts over the service worker.
// chrome.zip also serves Edge, Opera and the other Chromium browsers (Brave, Vivaldi, Arc).
// safari.zip (same content as Chrome) is converted into an Xcode project on macOS: safari.sh.
//
// Versions come from git, so nothing has to be bumped by hand before a release. Each agent has
// its own tag, so each agent has its own version line:
//   --release browser-vX.Y.Z  the tag drives the packages (used by the release workflow);
//   otherwise                 the last browser tag plus the current commit, e.g. 1.4.2-a9085f3,
//                             so any build can be traced back to what it was built from.
// A checkout with no browser tag at all builds 0.0.0: there is no version to claim, and the
// four agents say so the same way. The version written in manifest.json is overwritten here.
//
// Usage: node build.mjs [--release browser-vX.Y.Z]

import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const source = join(here, 'src');
const dist = join(here, 'dist');

// A package is src/, and the licence that has to travel with it. What ships is decided by
// where a file sits, not by a list of exceptions kept up to date by hand.
const ALSO_SHIPPED = ['LICENSE', 'NOTICE'];

// A package carries real files, never a symbolic link: this agent holds none, but the same
// helper serves the other agents, where a link added by hand must not reach a store.
function copy(from, to) {
    if (statSync(from).isDirectory()) {
        mkdirSync(to, { recursive: true });
        for (const entry of readdirSync(from)) copy(join(from, entry), join(to, entry));
    } else {
        mkdirSync(dirname(to), { recursive: true });
        copyFileSync(from, to);
    }
}

function git(...args) {
    try {
        return execFileSync('git', args, { cwd: here, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
    } catch {
        return ''; // not a git checkout, or no tag yet
    }
}

// This agent's release tags, and no others: a tag on the Word add-in must not version the
// extension, or a store would receive a package whose number jumped for someone else's reason.
const TAG_PREFIX = 'browser-v';

// Strips the prefix from a release tag, and refuses another agent's. `v1.5.0` and `1.5.0` are
// accepted too: typed by hand, they can only mean this agent's build.
function versionOfTag(tag) {
    const owner = /^([a-z]+)-v/.exec(tag);
    if (owner && `${owner[1]}-v` !== TAG_PREFIX) {
        console.error(`Tag ${tag}: that is agent ${owner[1]}'s tag, not this one's `
            + `(expected: ${TAG_PREFIX}X.Y.Z).`);
        process.exit(1);
    }
    return (tag.startsWith(TAG_PREFIX) ? tag.slice(TAG_PREFIX.length) : tag).replace(/^v/, '');
}

// version: numeric, the only form Chrome accepts. label: what a human reads, equal to version
// on a release and carrying the commit otherwise.
function resolveVersion() {
    const index = process.argv.indexOf('--release');
    const tag = index === -1 ? '' : (process.argv[index + 1] || '');
    if (tag) {
        const version = versionOfTag(tag);
        // Chrome accepts 1 to 4 dot-separated integers, nothing else.
        if (!/^\d+(\.\d+){0,3}$/.test(version)) {
            console.error(`Tag ${tag}: version expected as ${TAG_PREFIX}X.Y.Z.`);
            process.exit(1);
        }
        return { version, label: version };
    }
    // No tag for this agent in the checkout: 0.0.0 says as much, and the label still carries
    // the commit. --match keeps the three other agents' tags out of the answer.
    const lastTag = git('describe', '--tags', '--abbrev=0', '--match', `${TAG_PREFIX}*`);
    const version = lastTag.slice(TAG_PREFIX.length) || '0.0.0';
    const commit = git('rev-parse', '--short', 'HEAD');
    return { version, label: commit ? `${version}-${commit}` : version };
}

const manifest = JSON.parse(readFileSync(join(source, 'manifest.json'), 'utf8'));

// The store listing's name and description come from _locales/, not from the manifest, so the
// length is checked there — once per language, since each one is what its own store listing
// shows. Chrome Web Store and Opera Add-ons reject a package beyond 132 characters.
for (const locale of ['fr', 'en']) {
    const messages = JSON.parse(readFileSync(join(source, '_locales', locale, 'messages.json'), 'utf8'));
    const description = messages.extensionDescription.message;
    if (description.length > 132) {
        console.error(`Description too long in ${locale} (${description.length} characters, 132 maximum): src/_locales/${locale}/messages.json`);
        process.exit(1);
    }
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
mkdirSync(dist, { recursive: true });

for (const [target, adapt] of Object.entries(TARGETS)) {
    const dir = join(dist, target);
    copy(source, dir);
    for (const file of ALSO_SHIPPED) copy(join(here, file), join(dir, file));
    const targetManifest = structuredClone(manifest);
    targetManifest.version = version;
    // version must stay numeric for Chrome; the traceable label goes to version_name, which
    // Chromium browsers and Safari display and which AMO accepts without a warning.
    if (label !== version) targetManifest.version_name = label;
    adapt(targetManifest);
    writeFileSync(join(dir, 'manifest.json'), JSON.stringify(targetManifest, null, 2) + '\n');
    execFileSync('zip', ['-qr', '-X', join(dist, `${target}.zip`), '.'], { cwd: dir, stdio: 'inherit' });
    console.log(`browser/dist/${target}.zip (${label})`);
}

// Read back by the workflows, so the version is resolved here and nowhere else.
writeFileSync(join(dist, 'VERSION'), label + '\n');
