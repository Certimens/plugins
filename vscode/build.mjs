// Builds the VS Code extension: dist/certimens-vscode.vsix.
//
// vsce does the packaging; this script only resolves the version from git and hands it over,
// because that is the one thing vsce cannot do by itself. Everything else is vsce's own
// mechanisms, rather than code of ours:
//
//   .vscodeignore           what stays out of the package — no staging copy, no file walking;
//   --follow-symlinks       reads through media/ui.css, media/fonts and media/icon128.png,
//                           which are links into the browser agent, and packs real files;
//   --no-update-package-json  the version is passed on the command line and package.json is
//                           left alone: its 0.0.0 is a placeholder, the tag is what counts;
//   --no-dependencies       the extension ships classic scripts and installs nothing.
//
// The packaged manifest therefore keeps `scripts` and `devDependencies`. They are inert — the
// Marketplace shows neither — and that is the price of not rewriting the file.
//
// Versions come from git, one tag per agent:
//   --release vscode-vX.Y.Z  the tag drives the package (used by the release workflow);
//   otherwise                the last vscode tag, the commit staying out. The marketplace wants
//                            three parts and nothing but digits, so a branch build's label
//                            (1.4.2-a9085f3) is not one: it goes to dist/VERSION and nowhere else.
//
// Usage: node build.mjs [--release vscode-vX.Y.Z]

import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const dist = join(here, 'dist');

function git(...args) {
    try {
        return execFileSync('git', args, { cwd: here, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
    } catch {
        return ''; // not a git checkout, or no tag yet
    }
}

// This agent's release tags, and no others: a tag on another agent must not version this
// package, or its store would receive a number that jumped for someone else's reason.
const TAG_PREFIX = 'vscode-v';

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

function resolveVersion() {
    const index = process.argv.indexOf('--release');
    const tag = index === -1 ? '' : (process.argv[index + 1] || '');
    if (tag) {
        const version = versionOfTag(tag);
        if (!/^\d+(\.\d+){0,3}$/.test(version)) {
            console.error(`Tag ${tag}: version expected as ${TAG_PREFIX}X.Y.Z.`);
            process.exit(1);
        }
        return { version, label: version };
    }
    // No tag for this agent in the checkout: 0.0.0 says as much, and the label still carries
    // the commit. --match keeps the three other agents' tags out of the answer.
    const version = git('describe', '--tags', '--abbrev=0', '--match', `${TAG_PREFIX}*`)
        .slice(TAG_PREFIX.length) || '0.0.0';
    const commit = git('rev-parse', '--short', 'HEAD');
    return { version, label: commit ? `${version}-${commit}` : version };
}

const { version, label } = resolveVersion();
const marketplaceVersion = [...version.split('.'), '0', '0'].slice(0, 3).join('.');
const vsix = join(dist, 'certimens-vscode.vsix');

rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });
execFileSync(join(here, 'node_modules', '.bin', 'vsce'),
    ['package', marketplaceVersion, '--no-update-package-json', '--no-dependencies',
        '--follow-symlinks', '--out', vsix],
    { cwd: here, stdio: 'inherit' });

writeFileSync(join(dist, 'VERSION'), label + '\n');
console.log(`vscode/dist/certimens-vscode.vsix (${marketplaceVersion})`);
