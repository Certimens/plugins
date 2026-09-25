// Loads one of the plugins' classic scripts (no module, no bundler: see CLAUDE.md) into an
// isolated context, with the browser and Office globals it expects stubbed out.
//
// The scripts under test are the ones that ship, read from disk unchanged: nothing is added to
// them for the sake of testing. An epilogue appended at load time exposes the internals a test
// needs, which a classic script otherwise keeps to its own scope.
//
// Each load builds a fresh context, so a test never inherits the counters of the previous one.

import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

// A clock the tests drive: the sensors date every event with Date.now(), and the pause and
// effective-time rules are only measurable if that value is ours.
export function clock(start = 1_000_000) {
    let now = start;
    return {
        get now() {
            return now;
        },
        advance(seconds) {
            now += seconds * 1000;
            return now;
        },
    };
}

function fakeDate(source) {
    return class extends Date {
        static now() {
            return source.now;
        }
    };
}

// Timers are inert: the idle flush and the title polling must not fire on their own, otherwise a
// test would depend on the machine's speed. Tests that want a flush call it.
function inertTimers() {
    let id = 0;
    const noop = () => ++id;
    return { setTimeout: noop, clearTimeout: () => {}, setInterval: noop, clearInterval: () => {} };
}

export function browserGlobals(time, { hostname = 'docs.google.com', href, title = 'Mémoire - Google Docs' } = {}) {
    const listeners = new Map();
    const document = {
        title,
        visibilityState: 'visible',
        documentElement: {},
        addEventListener: (type, fn) => listeners.set(type, fn),
        removeEventListener: () => {},
        querySelectorAll: () => [],
        querySelector: () => null,
        getElementById: () => null,
        hasFocus: () => true,
    };
    return {
        listeners,
        globals: {
            document,
            location: { hostname, href: href ?? `https://${hostname}/document/d/AbC-123_xyz/edit`, search: '' },
            window: { addEventListener: (type, fn) => listeners.set(`window:${type}`, fn) },
            MutationObserver: class {
                observe() {}
            },
            // The sensors guard their handlers with `e.target instanceof Element`: without the
            // constructor the guard throws instead of letting a synthetic event through.
            Element: class Element {},
            chrome: {
                storage: {
                    local: { get: () => Promise.resolve({}), set: () => Promise.resolve() },
                    onChanged: { addListener: () => {} },
                },
                runtime: {
                    sendMessage: () => Promise.resolve({ ok: false }),
                    onMessage: { addListener: () => {} },
                },
            },
            Date: fakeDate(time),
            ...inertTimers(),
        },
    };
}

export function officeGlobals(time) {
    return { Date: fakeDate(time), ...inertTimers() };
}

/**
 * Runs `relPath` in a fresh context and returns its internals.
 *
 * `expose` names the script's own bindings to surface; each becomes a readable (and, where the
 * script declared it with `let`, writable) property of the returned object.
 */
export function load(relPath, { globals = {}, expose = [] } = {}) {
    const source = readFileSync(join(root, relPath), 'utf8');
    const epilogue = `
;globalThis.__internals = Object.defineProperties({}, {
${expose.map((name) => `  ${name}: { get: () => ${name}, set: (value) => { ${name} = value; }, enumerable: true }`).join(',\n')}
});`;
    const context = createContext({ console, Promise, JSON, Math, Object, Array, Set, Map, WeakSet, ...globals });
    runInContext(source + epilogue, context, { filename: relPath });
    return context.__internals;
}
