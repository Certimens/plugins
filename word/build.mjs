// Builds the Word add-in: dist/word/, the site published on GitHub Pages, and
// dist/word-localhost.xml, the same manifest pointing at https://localhost:3000 (make serve).
//
// Everything the add-in serves lives in src/: the site is that folder, plus the licence.
// src/ui.css, src/ui.js, src/i18n.js, src/fonts/ and three of the icons are symbolic links
// into the browser extension — the agents share one stylesheet and one dictionary. The copy
// below dereferences them, so the published site carries real files.
//
// Versions come from git:
//   --release vX.Y.Z  the tag drives the manifest (used by the release workflow);
//   otherwise         the last tag plus the current commit, e.g. 1.4.2-a9085f3.
// Office wants four numbers, and cannot carry the commit: the traceable label goes to
// dist/VERSION and to the landing page.
//
// Usage: node build.mjs [--release vX.Y.Z]

import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const source = join(here, 'src');
const dist = join(here, 'dist');
const BASE_URL = (process.env.WORD_BASE_URL || 'https://certimens.github.io/plugins/word').replace(/\/+$/, '');
const DEV_URL = 'https://localhost:3000';

// The site is src/, and the licence that has to travel with it. What is published is decided
// by where a file sits, not by a list of exceptions kept up to date by hand.
const ALSO_SHIPPED = ['LICENSE', 'NOTICE'];

// The site carries real files, never the links this folder is made of. cpSync is no help: even
// with dereference it recreates a nested link, with its target rewritten as an absolute path.
// statSync and copyFileSync both follow a link, so each entry lands as what it really is.
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

function resolveVersion() {
    const index = process.argv.indexOf('--release');
    const tag = index === -1 ? '' : (process.argv[index + 1] || '');
    if (tag) {
        const version = tag.replace(/^v/, '');
        if (!/^\d+(\.\d+){0,3}$/.test(version)) {
            console.error(`Tag « ${tag} » : version attendue sous la forme X.Y.Z.`);
            process.exit(1);
        }
        return { version, label: version };
    }
    // No tag in the checkout: 0.0.0 says as much, and the label still carries the commit.
    const version = git('describe', '--tags', '--abbrev=0').replace(/^v/, '') || '0.0.0';
    const commit = git('rev-parse', '--short', 'HEAD');
    return { version, label: commit ? `${version}-${commit}` : version };
}

const { version, label } = resolveVersion();

// Office wants a four-part version.
const manifest = (baseUrl) => readFileSync(join(source, 'manifest.xml'), 'utf8')
    .replaceAll('{{BASE_URL}}', baseUrl)
    .replaceAll('{{VERSION}}', `${version}.0`);

rmSync(dist, { recursive: true, force: true });
const site = join(dist, 'word');
copy(source, site);
for (const file of ALSO_SHIPPED) copy(join(here, file), join(site, file));
writeFileSync(join(site, 'manifest.xml'), manifest(BASE_URL));
// Landing page: GitHub Pages serves no directory listing, so the site's root needs one file.
writeFileSync(join(site, 'index.html'),
    readFileSync(join(source, 'index.html'), 'utf8').replaceAll('{{VERSION}}', label));
writeFileSync(join(dist, 'word-localhost.xml'), manifest(DEV_URL));
writeFileSync(join(dist, 'VERSION'), label + '\n');
console.log(`word/dist/word/ (${label}, ${BASE_URL})`);
