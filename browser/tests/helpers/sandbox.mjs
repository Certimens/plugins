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
import { fileURLToPath } from 'node:url';

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

/**
 * Browser globals for a content script.
 *
 * `search` is the query string, for an address built from `hostname` alone: Word Online
 * identifies the document by the WOPISrc its editing iframe carries, and without one the sensor
 * has no document to announce. With `href`, it is read from the address.
 *
 * `stored` is what `chrome.storage.local` already holds when the script loads — the sensor reads
 * its suspended state from there, so a page opened during a pause has to start suspended too.
 * The returned `storage.change()` replays what the browser would deliver when another part of
 * the extension writes that key.
 */
export function browserGlobals(time, { hostname = 'docs.google.com', href, search, title = 'Mémoire - Google Docs', stored = {} } = {}) {
    const listeners = new Map();
    let onStorageChanged = null;
    let onRuntimeMessage = null;
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
    // What the sensor sent to the service worker: a finished measurement window, a title, a
    // document being announced. A test reads the window from here rather than from the counters,
    // which the flush has already reset.
    const sent = [];
    const storage = {
        change(values) {
            if (!onStorageChanged) return;
            const changes = {};
            for (const [key, newValue] of Object.entries(values)) changes[key] = { newValue };
            onStorageChanged(changes, 'local');
        },
    };
    return {
        listeners,
        storage,
        sent,
        // What the popup gets when it asks the page a question (the open document, the text the
        // student wrote): the answer the content script hands to `sendResponse`.
        ask(message) {
            let answer;
            if (onRuntimeMessage) onRuntimeMessage(message, {}, (value) => { answer = value; });
            return answer;
        },
        globals: {
            document,
            location: (() => {
                const url = new URL(href ?? `https://${hostname}/document/d/AbC-123_xyz/edit`);
                // pathname and search are derived rather than asked for: Overleaf identifies a
                // project by the first, a Moodle names the assignment in the second, and a test
                // able to set them apart from the address would be testing a fiction. `search`
                // is still accepted on its own, for an address built from the hostname alone.
                return { hostname, href: url.href, search: search ?? url.search, pathname: url.pathname };
            })(),
            window: { addEventListener: (type, fn) => listeners.set(`window:${type}`, fn) },
            MutationObserver: class {
                observe() {}
            },
            // Word Online identifies the document by the WOPISrc of its editing iframe, which
            // the sensor reads from the URL.
            URLSearchParams,
            // The sensors guard their handlers with `e.target instanceof Element`: without the
            // constructor the guard throws instead of letting a synthetic event through.
            Element: class Element {},
            chrome: {
                storage: {
                    local: { get: () => Promise.resolve({ ...stored }), set: () => Promise.resolve() },
                    onChanged: { addListener: (fn) => { onStorageChanged = fn; } },
                },
                runtime: {
                    sendMessage: (message) => {
                        sent.push(message);
                        return Promise.resolve({ ok: false });
                    },
                    onMessage: { addListener: (fn) => { onRuntimeMessage = fn; } },
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
 * Runs the script at `file` in a fresh context and returns its internals.
 *
 * `file` is a URL, which a test builds from its own location — `new URL('../sensor.js',
 * import.meta.url)`. This helper is shared by three agents through a symbolic link, and Node
 * resolves a link before it reports import.meta.url: nothing here may depend on where the
 * helper itself sits.
 *
 * `expose` names the script's own bindings to surface; each becomes a readable (and, where the
 * script declared it with `let`, writable) property of the returned object.
 */
export function load(file, { globals = {}, expose = [] } = {}) {
    const path = file instanceof URL ? fileURLToPath(file) : file;
    const source = readFileSync(path, 'utf8');
    const epilogue = `
;globalThis.__internals = Object.defineProperties({}, {
${expose.map((name) => `  ${name}: { get: () => ${name}, set: (value) => { ${name} = value; }, enumerable: true }`).join(',\n')}
});`;
    const context = createContext({ console, Promise, JSON, Math, Object, Array, Set, Map, WeakSet, ...globals });
    runInContext(source + epilogue, context, { filename: path });
    return context.__internals;
}
