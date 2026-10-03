// The exclusion filter of the VS Code extension (`matches` in src/extension.js).
//
// It shipped inert. The glob was compiled by four chained String.replace passes over one growing
// string, so each pass rewrote the metacharacters the previous had emitted — '(?:.*/)?' and '.*'
// both carry a '*' and a '?' — and every one of the twelve defaults ended up as an expression
// demanding a literal colon in the first path segment. Not one of them matched anything, and the
// only setting a student has for keeping a path out of the engine did nothing while reporting
// nothing. The same compilation backtracked without bound, so a pattern contributed by a cloned
// repository's own .vscode/settings.json froze the extension host — shared by every extension in
// it — for minutes on a single keystroke.
//
// Both are the same defect, so both are pinned here: what each shipped default must and must not
// match, and that the cost of a pattern does not depend on what the pattern contains.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import Module from 'node:module';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

// The host hands the extension its `vscode` module; outside the editor it does not exist. The
// shipped file is loaded unchanged, as everywhere else in this suite.
const load = Module._load;
Module._load = function (request, ...rest) {
    return request === 'vscode' ? {} : load.call(this, request, ...rest);
};
const { matches } = require('../src/extension.js');
Module._load = load;

// The twelve shipped defaults, with the paths each one exists to cover — at the project root and
// nested, because the leading '**/' is exactly what used to be rewritten away.
const DEFAULTS = [
    ['**/node_modules/**', ['node_modules/left-pad/index.js', 'ui/node_modules/react/index.js']],
    ['**/.git/**', ['.git/COMMIT_EDITMSG', 'sub/.git/config']],
    ['**/dist/**', ['dist/app.js', 'packages/core/dist/index.js']],
    ['**/build/**', ['build/out.o', 'android/app/build/generated/R.java']],
    ['**/out/**', ['out/main.js', 'vscode/out/extension.js']],
    ['**/target/**', ['target/debug/app', 'crates/api/target/release/app']],
    ['**/vendor/**', ['vendor/autoload.php', 'php/vendor/composer/installed.json']],
    ['**/.venv/**', ['.venv/bin/activate', 'tools/.venv/lib/site.py']],
    ['**/__pycache__/**', ['__pycache__/mod.cpython-312.pyc', 'pkg/__pycache__/a.pyc']],
    ['**/*.min.*', ['app.min.js', 'static/css/site.min.css']],
    ['**/*.lock', ['yarn.lock', 'rust/Cargo.lock']],
    ['**/*-lock.json', ['package-lock.json', 'ui/package-lock.json']],
];

// Ordinary source paths, plus the near misses a substring match would wrongly catch.
const MEASURED = [
    'src/index.js',
    'README.md',
    'internal/document/domain/scoring.go',
    'my-node_modules-notes.md',
    'docs/distribution.md',
    'lib/locking.js',
    'app/minify.js',
];

test('the shipped defaults exclude what they name', async (t) => {
    for (const [pattern, paths] of DEFAULTS) {
        await t.test(pattern, () => {
            for (const path of paths) {
                assert.equal(matches(pattern, path), true, `${pattern} should match ${path}`);
            }
        });
    }
});

test('the shipped defaults leave ordinary source alone', () => {
    for (const [pattern] of DEFAULTS) {
        for (const path of MEASURED) {
            assert.equal(matches(pattern, path), false, `${pattern} should not match ${path}`);
        }
    }
});

test('patterns without a doubled star keep working', async (t) => {
    await t.test('a single star stays inside one segment', () => {
        assert.equal(matches('*.lock', 'yarn.lock'), true);
        assert.equal(matches('*.lock', 'rust/Cargo.lock'), false);
        assert.equal(matches('dist/*', 'dist/app.js'), true);
        assert.equal(matches('dist/*', 'dist/sub/app.js'), false);
    });

    await t.test('a question mark is exactly one character', () => {
        assert.equal(matches('a?b.txt', 'axb.txt'), true);
        assert.equal(matches('a?b.txt', 'ab.txt'), false);
        assert.equal(matches('a?b.txt', 'axxb.txt'), false);
    });

    await t.test('a pattern with no wildcard is its own path', () => {
        assert.equal(matches('src/index.js', 'src/index.js'), true);
        assert.equal(matches('src/index.js', 'src/other.js'), false);
    });

    await t.test('a doubled star at the end covers everything below', () => {
        assert.equal(matches('node_modules/**', 'node_modules/a/b.js'), true);
        assert.equal(matches('node_modules/**', 'src/node_modules/a.js'), false);
    });

    await t.test('regex metacharacters in a pattern are literal', () => {
        assert.equal(matches('a+b.js', 'a+b.js'), true);
        assert.equal(matches('a+b.js', 'aab.js'), false);
        assert.equal(matches('(x).js', '(x).js'), true);
    });
});

// The availability half. A pattern of many stars against a path it does not match used to cost
// 8.5 s at 33 characters and roughly four times that for every two characters added; the
// alternating form a cap on adjacent wildcards would have missed is covered too. Matching
// segment by segment, the cost follows the pattern and the path and nothing else, so a generous
// ceiling here still fails loudly if a regular-expression compiler ever comes back.
test('a hostile pattern costs no more than an ordinary one', async (t) => {
    const path = 'app/src/main/java/com/example/app/MainActivity.java';

    const elapsed = (pattern, subject) => {
        const started = process.hrtime.bigint();
        matches(pattern, subject);
        return Number(process.hrtime.bigint() - started) / 1e6;
    };

    await t.test('a run of stars', () => {
        for (const length of [33, 41, 81, 161]) {
            const pattern = '*'.repeat(length - 1) + 'Z';
            assert.ok(elapsed(pattern, path) < 50, `${length} stars should not take 50 ms`);
        }
    });

    await t.test('stars alternating with literals', () => {
        const pattern = `${Array(32).fill('*a').join('')}*`;
        assert.ok(elapsed(pattern, `${'a'.repeat(400)}b`) < 50, 'alternating stars should not take 50 ms');
    });

    await t.test('a long path against a long pattern', () => {
        assert.ok(elapsed(`**/${'*x'.repeat(40)}*`, `${'x'.repeat(300)}/y`) < 50);
    });
});
