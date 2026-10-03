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
// An event as the user agent hands one over. The sensor drops anything else: it listens on the
// same document and window as the page it measures, so a measured page can dispatch these names
// itself, and only `isTrusted` tells the two apart. A driver that passes nothing is testing a
// case a browser never produces — which is how the four lifecycle listeners shipped without the
// guard the counting ones already had.
export function trusted(properties = {}) {
    return { isTrusted: true, ...properties };
}

export function browserGlobals(time, { hostname = 'docs.google.com', href, search, title = 'Mémoire - Google Docs', stored = {}, storageRead } = {}) {
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
                    // A thenable that calls back where a real storage read would resolve a
                    // turn later. The content script starts closed — not measuring, not signed
                    // in — and opens only once the read has answered, so a test that drove it
                    // before the answer would be testing a page that is deliberately quiet.
                    // The gap itself is covered on its own, with a read that never answers.
                    local: {
                        get: () => (storageRead ? storageRead() : { then: (onValue) => { onValue({ signedIn: true, ...stored }); } }),
                        set: () => Promise.resolve(),
                    },
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
    // `URL` is the pane's own: the engine address the student types and the one the engine
    // sends back are both read through it, and it is what the rule on where the token may
    // travel is built on. A context without it would answer "not an address" to every address.
    return { Date: fakeDate(time), URL, ...inertTimers() };
}

/**
 * Runs the script at `file` in a fresh context and returns its internals.
 *
 * `file` is a URL, which a test builds from its own location — `new URL('../sensor.js',
 * import.meta.url)`. This helper is shared by three agents through a symbolic link, and Node
 * resolves a link before it reports import.meta.url: nothing here may depend on where the
 * helper itself sits.
 *
 * Several files may be given, as an array, and they share one scope in the order listed —
 * which is what the host really does: the service worker calls `importScripts('constants.js',
 * 'i18n.js')` before its own code, and a page lists its `<script>` tags. Stubbing what the
 * first file declares instead would test the stub: the rule deciding where the token may
 * travel lives in `constants.js` and is read from `background.js`, and only loading both says
 * whether the two still agree.
 *
 * `expose` names the scripts' own bindings to surface; each becomes a readable (and, where it
 * was declared with `let`, writable) property of the returned object.
 */
export function load(file, { globals = {}, expose = [] } = {}) {
    const paths = (Array.isArray(file) ? file : [file])
        .map((entry) => (entry instanceof URL ? fileURLToPath(entry) : entry));
    const source = paths.map((path) => readFileSync(path, 'utf8')).join('\n;\n');
    const path = paths[paths.length - 1];
    const epilogue = `
;globalThis.__internals = Object.defineProperties({}, {
${expose.map((name) => `  ${name}: { get: () => ${name}, set: (value) => { ${name} = value; }, enumerable: true }`).join(',\n')}
});`;
    const context = createContext({ console, Promise, JSON, Math, Object, Array, Set, Map, WeakSet, ...globals });
    runInContext(source + epilogue, context, { filename: path });
    return context.__internals;
}
