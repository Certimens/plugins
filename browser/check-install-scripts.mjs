// Which dependencies run code when they are installed, and whether that was agreed to.
//
// `npm ci` executes the install script of every package in the tree — four hundred and some
// here, all of it development tooling. The jobs that publish to the stores hold their
// credentials, so they install through `make install-publish`, which passes `--ignore-scripts`:
// nothing of the tree runs there. That buys nothing on its own, because the day a dependency
// starts *needing* to run would be discovered at a release, by a publication that quietly
// produced nothing.
//
// So the list is written down, as arguments in package.json. A package that declares an install
// script without being named there fails the lint, which is the moment to read what it runs and
// decide: allow it here, or drop the dependency.
//
// What it reads is package-lock.json — the resolved tree, including every transitive
// dependency — and not node_modules, so it answers the same whether or not anything is
// installed.
//
// The lockfile is read from the **working directory**, not from beside this file: two of the
// three agents reach it through a symbolic link, and Node resolves those before handing over
// `import.meta.url`. Read from here, all three would lint the browser's tree and say so three
// times. An npm script runs in its own project, which is exactly the right directory.
//
// Usage: node check-install-scripts.mjs [allowed-package...]

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const allowed = new Set(process.argv.slice(2));

const lock = JSON.parse(readFileSync(join(process.cwd(), 'package-lock.json'), 'utf8'));

// The key of a locked package is its path (`node_modules/a/node_modules/b`); the name is what
// comes after the last `node_modules/`, so a scoped package keeps its scope.
const named = (path) => path.slice(path.lastIndexOf('node_modules/') + 'node_modules/'.length);

const running = Object.entries(lock.packages || {})
    .filter(([path, meta]) => path && meta.hasInstallScript)
    .map(([path]) => named(path));

const unexpected = [...new Set(running)].filter((name) => !allowed.has(name)).sort();
// An allowance for a package that has gone, or that no longer runs anything: it says the tree
// is more guarded than the list claims, and a stale list is what makes the next reading of it
// careless.
const stale = [...allowed].filter((name) => !running.includes(name)).sort();

for (const name of unexpected) {
    console.error(`${name} runs a script when it is installed, and nothing says it may.`);
}
for (const name of stale) {
    console.error(`${name} is allowed to run an install script and does not: drop it from the list.`);
}

if (unexpected.length || stale.length) {
    console.error('\nThe publish jobs install with --ignore-scripts, next to the stores\' credentials:\n'
        + 'what runs at install time there is a decision, not a default. Read what the package runs,\n'
        + 'then name it in the lint:deps arguments of package.json, or take the dependency out.');
    process.exit(1);
}

console.log(`Install scripts: ${allowed.size} allowed, ${Object.keys(lock.packages || {}).length - 1} packages.`);
