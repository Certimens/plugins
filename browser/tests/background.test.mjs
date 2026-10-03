// Sending to the engine from the browser extension (src/background.js).
//
// This is the repository's biggest file, and the only one of this agent that talked to the
// engine without being checked: the offline queue, the `offline` flag, the key order of the
// measurement body, what a refusal does to a window and the rename refused after the
// deadline are reimplemented here, and `docs/moteur.md` describes them as binding on
// all four agents.
//
// The cases are deliberately those of `libreoffice/tests/test_engine.py`,
// `word/tests/agent.test.mjs` and `vscode/tests/engine.test.mjs`: a divergence between the four
// implementations shows up there first.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clock, load } from './helpers/sandbox.mjs';
import { ALLOWED, REFUSED } from './helpers/engine-url.mjs';

const INTERNALS = ['enqueue', 'drain', 'pushWindows', 'toWindow', 'getState', 'getConfig',
    'adoptToken', 'syncTitles', 'startPairing', 'pollPairing', 'syncSiteScripts', 'setSites',
    'refreshProposedSites', 'REQUESTS', 'engineUrlAllowed', 'countEvent', 'flushTelemetry',
    'noteInstalled', 'noteStarted', 'advancePairing', 'createFileFor', 'countRuntimeError', 'faultOf', 'TELEMETRY_EVENTS', 'TELEMETRY_FLUSH_MS', 'TELEMETRY_MAX_COUNT', 'MAX_QUEUE',
    'reportValues', 'reportLink', 'browserName', 'reportBlock', 'reportUrl', 'REPORT_KEYS', 'REPORT_FRAGMENT'];

function json(body, { status = 200 } = {}) {
    return {
        ok: status >= 200 && status < 300,
        status,
        statusText: 'status ' + status,
        headers: { get: () => 'application/json' },
        json: () => Promise.resolve(body),
    };
}

// What a read of `chrome.storage.local` returns is not the object that was written there: it is
// an object the storage layer rebuilds, and **nothing promises it keeps the key order**. A queue
// read back alphabetically returns `{start, end}` as `{end, start}`, which is enough to take
// every honest submission out of the shape the engine accepts. So the double does it too: code
// that relies on the order of what it stored fails here rather than at the student's.
function reordered(value) {
    if (Array.isArray(value)) return value.map(reordered);
    if (!value || typeof value !== 'object') return value;
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, reordered(value[key])]));
}

// `chrome.storage.local`, reduced to what the service worker does with it: one key or a list of
// keys to read, an object to write.
function fakeStorage(initial = {}) {
    const map = new Map(Object.entries(initial));
    // How many times each key was written. What draining the queue costs is not read in the
    // final state: it is read there.
    const written = new Map();
    return {
        map,
        read: (key) => map.get(key),
        writes: (key) => written.get(key) || 0,
        area: {
            get(keys) {
                const names = typeof keys === 'string' ? [keys] : keys;
                const out = {};
                for (const name of names) if (map.has(name)) out[name] = reordered(map.get(name));
                return Promise.resolve(out);
            },
            set(values) {
                for (const [key, value] of Object.entries(values)) {
                    map.set(key, value);
                    written.set(key, (written.get(key) || 0) + 1);
                }
                return Promise.resolve();
            },
            // One key or a list of them, as the API takes it: a double that only knew the
            // first form made every wipe of several keys a wipe of none.
            remove(keys) {
                for (const key of [].concat(keys)) map.delete(key);
                return Promise.resolve();
            },
        },
    };
}

/**
 * Loads the service worker as it ships, with the globals Chrome gives it.
 *
 * `metrics` answers a measurement submission and may change its mind from one attempt to the
 * next; `down` cuts the network, like a captive portal or a stopped engine — the agent must
 * never rely on anything but its own attempt.
 */
const EXTENSION_ID = 'certimens-test-id';
const EXTENSION_ORIGIN = `chrome-extension://${EXTENSION_ID}/`;
// The build the host hands over, which the extension declares to the engine on every call.
const MANIFEST_VERSION = '1.4.2';

function worker({ stored = {}, metrics = () => json(null), routes = () => null, down = false,
    granted = () => true, scripting = true, sessionStored = {}, manifest = {}, dataConsent = false,
    accessLevel, tabs = [], navigator, platform = { os: 'linux', arch: 'x86-64' }, browserInfo } = {}) {
    const time = clock();
    const onMessage = { fn: null };
    const storage = fakeStorage({ config: { engineUrl: 'https://engine.test', token: 'api-token' }, ...stored });
    const session = fakeStorage(sessionStored);
    // `accessLevel` is what the host makes of `storage.local.setAccessLevel`: absent (Firefox,
    // and the default of this double), 'granted' (Chromium), or 'refused' (a Safari that only
    // takes it for the session area). `levels` is every level the worker asked for.
    const levels = [];
    if (accessLevel) {
        storage.area.setAccessLevel = ({ accessLevel: level }) => {
            levels.push(level);
            return accessLevel === 'granted' ? Promise.resolve() : Promise.reject(new Error('not supported'));
        };
    }
    // The open tabs, and every message the worker sent one of them.
    const told = [];
    // The tabs the worker opened itself: the problem report's form.
    const opened = [];
    const onChanged = { fn: null };
    // What the worker listens for on its own global scope: its uncaught errors.
    const scopeListeners = new Map();
    const calls = [];
    const badge = [];
    const registered = [];
    const globals = {
        Date: class extends Date {
            static now() {
                return time.now;
            }
        },
        setTimeout: () => 0,
        clearTimeout: () => {},
        addEventListener: (type, fn) => scopeListeners.set(type, fn),
        btoa: (text) => Buffer.from(text, 'binary').toString('base64'),
        // The worker reads addresses the engine sends it: `URL` is what says what it may do
        // with them.
        URL,
        // The worker bounds every call in time; the limit itself is the runtime's.
        AbortSignal,
        // constants.js is loaded below, with the worker and in the same scope, because that is
        // what importScripts does on Chrome (background.scripts on Firefox) — and because the
        // rule saying where the token may travel lives there and is applied here. i18n.js is
        // stubbed instead: a test reads the key, not the sentence.
        t: (key) => key,
        setLanguage: () => {},
        currentLanguage: () => 'fr',
        // What the browser says of itself, for the problem report: absent unless a test gives
        // one, as in a context that has no such thing.
        ...(navigator ? { navigator } : {}),
        fetch(url, init = {}) {
            const body = init.body ? JSON.parse(init.body) : null;
            calls.push({ url, method: init.method, body, raw: init.body, headers: init.headers || {} });
            if (down) return Promise.reject(new Error('Failed to fetch'));
            const answer = routes(url, init, body);
            if (answer) return Promise.resolve(answer);
            if (url.endsWith('/api/auth/device')) {
                return Promise.resolve(json({
                    device_code: 'device-1', user_code: 'CDFH-JKMN',
                    verification_uri: 'https://engine.test/device', expires_in: 600, interval: 5,
                }));
            }
            if (url.endsWith('/api/auth/me')) return Promise.resolve(json({ email: 'a@b.fr', display_name: 'A B', language: 'fr' }));
            if (url.endsWith('/api/auth/tokens')) return Promise.resolve(json([{ id: 'tok-1' }]));
            if (url.endsWith('/metrics')) return Promise.resolve(metrics(body));
            return Promise.resolve(json({ id: 'engine-1' }));
        },
        chrome: {
            storage: {
                local: storage.area,
                session: session.area,
                onChanged: { addListener: (fn) => { onChanged.fn = fn; } },
            },
            tabs: {
                query: () => Promise.resolve(tabs.map((id) => ({ id }))),
                sendMessage: (tabId, message) => {
                    told.push({ tabId, message });
                    return Promise.resolve();
                },
                create: (options) => {
                    opened.push(options);
                    return Promise.resolve({ id: 99, ...options });
                },
            },
            runtime: {
                id: EXTENSION_ID,
                // Kept rather than dropped: this listener is the worker's front door, and
                // who it answers is a rule of its own (see "the worker's front door" below).
                onMessage: { addListener: (fn) => { onMessage.fn = fn; } },
                getURL: (path) => EXTENSION_ORIGIN + path,
                // What the extension declares its build from, on every call to the engine.
                getManifest: () => ({ version: MANIFEST_VERSION, ...manifest }),
                onInstalled: { addListener: () => {} },
                onStartup: { addListener: () => {} },
                openOptionsPage: () => {},
                getPlatformInfo: () => (platform ? Promise.resolve(platform) : Promise.reject(new Error('no platform'))),
                // Firefox's alone.
                ...(browserInfo ? { getBrowserInfo: () => Promise.resolve(browserInfo) } : {}),
            },
            alarms: { create: () => {}, get: () => Promise.resolve(undefined), onAlarm: { addListener: () => {} } },
            action: {
                setBadgeText: (options) => {
                    badge.push(options.text);
                    return Promise.resolve();
                },
                setBadgeBackgroundColor: () => Promise.resolve(),
            },
            i18n: { getUILanguage: () => 'fr-FR' },
            permissions: {
                // `granted` says which addresses the student actually let through: one revoked
                // from the browser's own settings stays in the list and must lose its script.
                contains: ({ origins, data_collection: data }) => Promise.resolve(data ? dataConsent : origins.every(granted)),
                remove: () => Promise.resolve(true),
            },
            // Dynamic registration, which an older host does not have at all.
            scripting: scripting ? {
                registered,
                getRegisteredContentScripts: () => Promise.resolve([...registered]),
                registerContentScripts: (scripts) => {
                    registered.push(...scripts);
                    return Promise.resolve();
                },
                unregisterContentScripts: ({ ids }) => {
                    for (const id of ids) {
                        const at = registered.findIndex((script) => script.id === id);
                        if (at >= 0) registered.splice(at, 1);
                    }
                    return Promise.resolve();
                },
            } : undefined,
        },
    };
    // In importScripts' order: constants.js, i18n.js (stubbed above), report.js, then the worker.
    return { storage, session, calls, badge, registered, onMessage, time, scopeListeners, levels, told, onChanged, opened,
        internals: load([new URL('../src/constants.js', import.meta.url), new URL('../src/report.js', import.meta.url),
            new URL('../src/background.js', import.meta.url)], { globals, expose: INTERNALS }) };
}

// A window as the sensor seals it and as the queue keeps it: where it goes, its session, and
// the window in the shape the engine reads (docs/moteur.md, "Le corps de mesure").
const SESSION = 'p3Vq0hJmR2aXw9LkT1yZ5g';
const AT = Date.parse('2026-10-09T08:00:00.000Z');

function sealed(seq, extra = {}, block = {}) {
    return {
        documentId: 'gdocs:AbC', documentName: 'Mémoire', session: SESSION,
        window: {
            seq, at: AT + seq * 5000, mono: 1000 + seq * 5000, ms: 2000, why: 'idle', active: 1800,
            runs: [['type', 5, 1800]],
            counts: { corrections: 0, reformulations: 0, revisions: 0, jumps: 0, exits: 0, back_keys: 0, back_chars: 0 },
            flight: { med: 140, mad: 12.5, bins: [0, 0, 0, 0, 0, 1, 2, 1] },
            dwell: { bins: [0, 0, 0, 1, 3, 1], rollover: 1 },
            sum: { keys: 5 * (seq + 1), chars: 0, pastes: 0 },
            ...block,
        },
        ...extra,
    };
}

function window_(seq = 0) {
    return sealed(seq);
}

const paired = (queue, extra = {}) => ({ engineIds: { 'gdocs:AbC': 'engine-1' }, queue, ...extra });

const metricsOf = (calls) => calls.filter((c) => c.url.endsWith('/metrics'));

// The engine stores what measured a window and flags a push that names nothing, so this header
// is not an extra: omitting it would raise a signal on every honest window of every student
// using this extension, and a signal that fires on everything tells a reader nothing.
test('every call names this agent and its build', async (t) => {
    await t.test('on the push, in the shape the engine parses', async () => {
        const { internals, calls } = worker({ stored: { queue: [window_()] } });

        await internals.drain();

        const pushed = metricsOf(calls);
        assert.ok(pushed.length, 'no measurement sent');
        for (const call of pushed) {
            assert.equal(call.headers['X-Certimens-Agent'], `browser/${MANIFEST_VERSION}`);
        }
    });

    // The browser refuses to let an extension set a User-Agent, so this header is the only
    // thing that says *which* agent and *which* build: the transport signature underneath it
    // says "a browser extension" and stops there.
    await t.test('and on every other call, from one place', async () => {
        const { internals, calls } = worker({ stored: { queue: [window_()] } });

        await internals.drain();

        assert.ok(calls.every((c) => c.headers['X-Certimens-Agent']));
    });
});

test('the offline queue', async (t) => {
    await t.test('a window waits for the engine to come back rather than being lost', async () => {
        const { internals, storage, calls } = worker({ down: true });

        await internals.enqueue(window_());
        await internals.drain();

        assert.equal(storage.read('queue').length, 1);
        assert.equal(storage.read('status').state, 'offline');
        // A single attempt: creating the document already fails, and nothing insists.
        assert.equal(calls.length, 1);
    });

    await t.test('and goes again as soon as the engine answers', async () => {
        const { internals, storage } = worker({ stored: { queue: [window_()], status: { state: 'offline' } } });

        await internals.drain();

        assert.equal(storage.read('queue').length, 0);
        assert.equal(storage.read('queueSent'), 0, 'an emptied queue starts over');
        assert.equal(storage.read('status').state, 'synced');
    });

    await t.test('a rejected measurement does not block the queue behind it', async () => {
        // A 400 is final: sending it again forever would stop everything behind it.
        const { internals, storage } = worker({
            stored: { queue: [window_()], engineIds: { 'gdocs:AbC': 'engine-1' } },
            metrics: () => json({ code: 'invalid_body', error: 'refused' }, { status: 400 }),
        });
        const warn = console.warn;
        console.warn = () => {};
        try {
            await internals.drain();
        } finally {
            console.warn = warn;
        }

        assert.equal(storage.read('queue').length, 0);
    });

    await t.test('draining the queue does not write the queue at every window', async () => {
        // This is what makes a day offline catchable up: between two submissions one does have
        // to write that the window has gone — otherwise it would go again — but what is written
        // is a cursor, not the queue. With the queue, catching up on 5000 windows rewrote a
        // 3 MB array five thousand times.
        const queue = [window_(), window_(), window_(), window_()];
        const { internals, storage } = worker({ stored: { queue, engineIds: { 'gdocs:AbC': 'engine-1' } } });

        await internals.drain();

        assert.equal(storage.read('queue').length, 0);
        assert.equal(storage.read('queueSent'), 0);
        // One write of the queue to empty it at the end, and not one per window.
        assert.equal(storage.writes('queue'), 1);
        assert.equal(storage.writes('queueSent'), queue.length + 1);
    });

    await t.test('what has gone does not go again after a failure', async () => {
        // The cursor moves on before the next submission: a cut in the middle of a catch-up
        // leaves behind exactly what has not gone through yet.
        let sent = 0;
        const { internals, storage, calls } = worker({
            stored: { queue: [window_(), window_(), window_()], engineIds: { 'gdocs:AbC': 'engine-1' } },
            metrics: () => (++sent === 3 ? Promise.reject(new TypeError('network')) : json(null)),
        });

        await internals.drain();
        assert.equal(storage.read('queueSent'), 2, 'two windows went through');
        assert.equal(storage.read('status').state, 'offline');

        await internals.drain();
        // The catch-up resends only the third: the engine never saw the first two twice.
        assert.equal(metricsOf(calls).length, 4);
        assert.equal(storage.read('queue').length, 0);
    });

    await t.test('a refused token says so, and is not taken for a network failure', async () => {
        const { internals, storage } = worker({
            stored: { queue: [window_()], engineIds: { 'gdocs:AbC': 'engine-1' } },
            metrics: () => json({ error: 'invalid token' }, { status: 401 }),
        });

        await internals.drain();

        assert.equal(storage.read('status').state, 'auth_error');
        assert.equal(storage.read('queue').length, 1, 'the window stays: the token may come back');
    });

    await t.test('an engine without a token sends nothing out', async () => {
        const { internals, storage, calls } = worker({ stored: { config: { engineUrl: 'https://engine.test' } } });

        await internals.drain();

        assert.equal(storage.read('status').state, 'unconfigured');
        assert.deepEqual(calls, []);
    });
});

test('`offline` describes the window, not the queue', async (t) => {
    await t.test('it is set when queueing, from our own last attempt', async () => {
        // Never navigator.onLine: a captive portal answers the link layer and never the engine,
        // and two of the four agents do not have that API anyway.
        const { internals, storage } = worker({ stored: { status: { state: 'offline' } }, down: true });

        await internals.enqueue(window_());

        assert.equal(storage.read('queue')[0].offline, true);
    });

    await t.test('a window written while the engine was answering goes out saying nothing', async () => {
        // Even if it then waits for hours: it is not the queue it describes.
        const { internals, storage } = worker({ stored: { status: { state: 'synced' } }, down: true });

        await internals.enqueue(window_());

        assert.equal(storage.read('queue')[0].offline, undefined);
    });

    // `offline` says the window waited for want of a network. An engine that answered with an
    // error was reached: what queues behind that answer waited for another reason, says
    // nothing, and therefore leaves one window per request — a batch holding a window that is
    // not `offline` is one the engine flags.
    await t.test('an engine that answers an error was reached: what queues behind it is not stamped', async () => {
        const { internals, storage, calls } = worker({
            stored: paired([window_(0)]),
            metrics: () => json({ error: 'boom' }, { status: 500 }),
        });

        await internals.drain();
        assert.equal(storage.read('status').state, 'offline');
        assert.equal(storage.read('status').reached, true);
        await internals.enqueue(window_(1));

        assert.equal(storage.read('queue')[1].offline, undefined);
        assert.equal(metricsOf(calls).length, 1);
    });

    await t.test('an engine that did not answer was not: what queues behind it is', async () => {
        const { internals, storage } = worker({ stored: paired([window_(0)]), down: true });

        await internals.drain();
        assert.equal(storage.read('status').reached, false);
        await internals.enqueue(window_(1));

        assert.equal(storage.read('queue')[1].offline, true);
    });
});

test('the passed deadline', async (t) => {
    await t.test('a refused rename is held as synced', async () => {
        // The copy is frozen: that rename will not go through. Retrying it every minute would
        // turn the sending state red for something nobody has a hand on.
        const { internals, storage, calls } = worker({
            stored: {
                engineIds: { 'gdocs:AbC': 'engine-1' },
                titles: { 'gdocs:AbC': 'Mémoire rendu' },
                syncedTitles: { 'gdocs:AbC': 'Mémoire' },
            },
            routes: (url, init) => (init.method === 'PUT'
                ? json({ code: 'deadline_passed', error: "this assignment's deadline has passed" }, { status: 403 })
                : null),
        });

        await internals.drain();

        assert.equal(storage.read('status').state, 'synced');
        assert.equal(storage.read('syncedTitles')['gdocs:AbC'], 'Mémoire rendu');
        calls.length = 0;
        await internals.drain();
        assert.deepEqual(calls, [], 'nothing is retried');
    });
});

test('pairing', async (t) => {
    await t.test('asks for no password and keeps the token returned', async () => {
        const { internals, storage, calls } = worker({ stored: { config: { engineUrl: 'https://engine.test' } } });

        const pairing = await internals.startPairing('https://engine.test');
        assert.equal(pairing.userCode, 'CDFH-JKMN');
        await internals.adoptToken(pairing.engineUrl, 'api-token');

        assert.equal(storage.read('config').token, 'api-token');
        assert.equal(storage.read('config').tokenId, 'tok-1');
        assert.ok(!calls.some((call) => call.body && 'password' in call.body));
    });

    await t.test('as long as nobody has confirmed, it answers "not yet" rather than an error', async () => {
        const { internals } = worker({
            routes: (url) => (url.endsWith('/api/auth/device/token')
                ? json({ code: 'device_authorization_pending', error: 'not yet' }, { status: 400 })
                : null),
        });

        const pairing = await internals.startPairing('https://engine.test');

        assert.equal(await internals.pollPairing(pairing), null);
    });

    await t.test('polled too often, it waits instead of giving up', async () => {
        // A 429 comes from the rate limiter, not from the exchange: a whole institution behind
        // the same exit hits it. Reading it as a failure would drop a code its owner is about
        // to confirm.
        const { internals } = worker({
            routes: (url) => (url.endsWith('/api/auth/device/token')
                ? json({ error: 'too many requests' }, { status: 429 })
                : null),
        });

        const pairing = await internals.startPairing('https://engine.test');

        assert.equal(await internals.pollPairing(pairing), null);
    });

    await t.test('a refused pairing is told in the student\'s language', async () => {
        // The engine only answers in English. This is the one moment the student is waiting in
        // front of a screen: the sentence they read must say what happened.
        const { internals } = worker({
            routes: (url) => (url.endsWith('/api/auth/device/token')
                ? json({ code: 'device_denied', error: 'this authorization was refused' }, { status: 401 })
                : null),
        });

        const pairing = await internals.startPairing('https://engine.test');

        await assert.rejects(() => internals.pollPairing(pairing), (err) => err.message === 'pair.denied');
    });
});

test('the sites the student adds', async (t) => {
    // No manifest can name every institution's Moodle, and asking for `https://*/*` up front
    // would amount to asking everyone for the whole web to serve a few. The address is
    // therefore added from the options page, which carries the gesture the browser demands for
    // the permission; here, all that is left is registering the script.
    const MOODLE = 'https://moodle.mon-etablissement.fr/*';

    await t.test('a site added gets the content script registered', async () => {
        const { internals, registered, storage } = worker();

        await internals.setSites([MOODLE]);

        assert.deepEqual(storage.read('sites'), [MOODLE]);
        assert.equal(registered.length, 1);
        // Spread: these arrays are born in the isolated context, and `deepEqual` compares
        // prototypes too.
        assert.deepEqual([...registered[0].matches], [MOODLE]);
        assert.deepEqual([...registered[0].js], ['content.js']);
        // Not all frames: the rich editors of Moodle and Canvas put their body in a
        // same-origin iframe, which the sensor attaches itself to. Injecting there too would
        // put two sensors on the same keystrokes.
        assert.equal(registered[0].allFrames, false);
        assert.equal(registered[0].persistAcrossSessions, true);
    });

    await t.test('a site removed leaves none behind', async () => {
        const { internals, registered } = worker({ stored: { sites: [MOODLE] } });

        await internals.setSites([]);

        assert.deepEqual(registered, []);
    });

    await t.test('a permission revoked in the browser leaves no script', async () => {
        // The address stays in the list — the student did not remove it — but nothing must run
        // where the browser no longer lets us go.
        const { internals, registered } = worker({ stored: { sites: [MOODLE] }, granted: () => false });

        await internals.syncSiteScripts();

        assert.deepEqual(registered, []);
    });

    await t.test('reconciling twice does not register twice', async () => {
        // The registration survives a restart: every startup reconciles, it does not install.
        const { internals, registered } = worker({ stored: { sites: [MOODLE] } });

        await internals.syncSiteScripts();
        await internals.syncSiteScripts();

        assert.equal(registered.length, 1);
    });

    await t.test('a browser without dynamic registration does not break', async () => {
        const { internals, storage } = worker({ scripting: false });

        await internals.setSites([MOODLE]);

        assert.deepEqual(storage.read('sites'), [MOODLE]);
    });
});

test('the sites the institution proposes', async (t) => {
    // A third source, beside the editors the manifest names and the addresses the student
    // types: the institution tells the engine where its students write, and the agent reads
    // that list. It **proposes**; it grants nothing.
    //
    // It travels inside `/api/auth/me` and not on a route of its own: an agent knows an
    // account, never a school. It therefore costs no call — every `me` the agent already makes
    // refreshes it on the way.
    const MOODLE = 'https://moodle.mon-etablissement.fr/*';

    const withSites = (writing_sites) => (url) => (url.endsWith('/api/auth/me')
        ? json({ email: 'a@b.fr', display_name: 'A B', language: 'fr', writing_sites })
        : null);

    await t.test('it arrives with the account, and it is kept', async () => {
        const { internals, storage, calls } = worker({
            routes: withSites(['https://moodle.mon-etablissement.fr']),
        });

        await internals.refreshProposedSites(true);

        // Kept as the pattern that will be asked of the browser, not as the raw origin.
        assert.deepEqual([...storage.read('proposedSites').sites], [MOODLE]);
        // And no route of its own: a single call, the one the agent already made.
        assert.deepEqual(calls.map((c) => c.url.replace('https://engine.test', '')), ['/api/auth/me']);
    });

    await t.test('an engine too old to carry it proposes nothing, and says nothing', async () => {
        // Adding a field is a piece of work on the engine's side, and a published agent meets
        // engines older than itself: the absence reads as "this school proposes nothing", not
        // as a failure.
        const { internals, storage } = worker();

        await internals.refreshProposedSites(true);

        assert.deepEqual([...storage.read('proposedSites').sites], []);
        assert.equal(storage.read('status'), undefined, 'this is not a sending failure');
    });

    await t.test('a failed read keeps what the institution proposed yesterday', async () => {
        const { internals, storage } = worker({
            stored: { proposedSites: { sites: [MOODLE], at: 0 } },
            down: true,
        });

        await internals.refreshProposedSites(true);

        assert.deepEqual([...storage.read('proposedSites').sites], [MOODLE],
            'a school\'s addresses do not vanish because the network did');
    });

    await t.test('what the agent cannot ask for is not proposed', async () => {
        // The list comes from a server. A `https://*/*` or a `javascript:` in it would ask the
        // student for something they would not read in the permission dialog.
        const { internals, storage } = worker({
            routes: withSites([
                'https://moodle.mon-etablissement.fr',
                'http://moodle.mon-etablissement.fr',
                'https://*.mon-etablissement.fr',
                'javascript:alert(1)',
                'not an address',
            ]),
        });

        await internals.refreshProposedSites(true);

        assert.deepEqual([...storage.read('proposedSites').sites], [MOODLE]);
    });

    await t.test('an address already added is no longer a proposal', async () => {
        const { internals, storage } = worker({
            stored: {
                sites: [MOODLE],
                proposedSites: { sites: [MOODLE, 'https://wiki.mon-etablissement.fr/*'], at: Date.now() },
            },
        });

        const res = await internals.REQUESTS.CERTIMENS_SITES();

        assert.deepEqual([...res.sites], [MOODLE], 'it is the student\'s now');
        assert.deepEqual([...res.proposed], ['https://wiki.mon-etablissement.fr/*']);
        assert.equal(storage.read('sites').length, 1);
    });

    await t.test('proposing registers no script: nobody has granted anything yet', async () => {
        // That is the whole rule. `chrome.permissions.request` obeys a gesture alone, which a
        // service worker does not have and a server never will: only the options page, on the
        // student's click, turns a proposal into a measured site.
        const { internals, registered } = worker({
            routes: withSites(['https://moodle.mon-etablissement.fr']),
        });

        await internals.refreshProposedSites(true);
        await internals.syncSiteScripts();

        assert.equal(registered.length, 0);
    });

    await t.test('every `me` refreshes it on the way, not just the daily re-read', async () => {
        // It travels with the account: a pairing, a list of assignments or the "test" button
        // bring it up to date without one more call.
        const { internals, storage } = worker({
            routes: withSites(['https://moodle.mon-etablissement.fr']),
        });

        await internals.adoptToken('https://engine.test', 'a-new-token');

        assert.deepEqual([...storage.read('proposedSites').sites], [MOODLE]);
    });

    await t.test('and changing account does not inherit the previous school', async () => {
        // The incoming account carries its own list, empty or not — that is what keeps the
        // school one was connected to a minute ago from showing through.
        const { internals, storage } = worker({
            stored: { proposedSites: { sites: ['https://former.fr/*'], at: Date.now() } },
            routes: withSites([]),
        });

        await internals.adoptToken('https://engine.test', 'a-new-token');

        assert.deepEqual([...storage.read('proposedSites').sites], []);
    });
});

// --- WHERE THE TOKEN MAY TRAVEL ---

test('the addresses an engine may be reached at', async (t) => {
    await t.test('https anywhere, http only where the request cannot leave the building', () => {
        const { internals } = worker();
        for (const url of ALLOWED) assert.equal(internals.engineUrlAllowed(url), true, url);
        for (const url of REFUSED) assert.equal(internals.engineUrlAllowed(url), false, url);
    });

    // The pages refuse it first and with a sentence on screen. This is the floor under them:
    // the retry alarm finishing a pairing, and a drain against an address stored before the
    // rule existed, meet no other check.
    await t.test('and the worker refuses to call one of the others', async () => {
        const { internals, calls } = worker();

        await assert.rejects(() => internals.startPairing('http://engine.example.fr'),
            (err) => err.code === 'engine_url_refused');
        assert.deepEqual(calls, [], 'nothing left the machine');
    });

    await t.test('including one already in the configuration', async () => {
        // An address that was accepted before this rule, or written by something else: the
        // queue must stop rather than keep pushing in the clear.
        const { internals, storage, calls } = worker({
            stored: { config: { engineUrl: 'http://engine.example.fr', token: 'a-token' },
                      queue: [window_()], queueSent: 0 },
        });

        await internals.drain();

        assert.deepEqual(calls, []);
        assert.equal(storage.read('status').state, 'offline');
        assert.equal(storage.read('queueSent'), 0, 'the window is still waiting');
    });

    // A pairing opened against another address is the one message that moves the account: the
    // engine answering it hands out the token this agent then keeps.
    await t.test('and a page cannot open a pairing against one', async () => {
        const { internals, calls } = worker();
        const answer = await new Promise((resolve) => {
            Promise.resolve(internals.REQUESTS.CERTIMENS_PAIR_START({ engineUrl: 'http://engine.example.fr' }))
                .then(() => resolve({ ok: true }), (err) => resolve({ ok: false, code: err.code }));
        });

        assert.deepEqual(answer, { ok: false, code: 'engine_url_refused' });
        assert.deepEqual(calls, []);
    });
});

// --- THE WORKER'S FRONT DOOR ---

test("the worker's front door", async (t) => {
    // Everything the worker can be asked arrives through one listener, and two very different
    // callers use it: this agent's own windows, and the sensor — which runs in whatever page
    // the student added, so potentially anywhere. Nothing on the web reaches either today; the
    // point is that the distinction is made once here rather than assumed in fourteen handlers.
    const PAGE = 'https://moodle.univ-exemple.fr/mod/assign/view.php?id=7';

    function send(internals, onMessage, message, sender) {
        return new Promise((resolve) => {
            const answered = onMessage.fn(message, sender, resolve);
            // `false` means the listener took no responsibility for answering: the message was
            // dropped. Nothing ever calls back, so the test must not wait for it.
            if (answered !== true) resolve(null);
        });
    }

    await t.test('a window of ours is answered', async () => {
        const { internals, onMessage } = worker();
        const answer = await send(internals, onMessage, { type: 'CERTIMENS_STATUS' },
            { id: EXTENSION_ID, url: EXTENSION_ORIGIN + 'popup.html' });
        assert.equal(answer.ok, true);
    });

    // The options page is a tab by declaration (`open_in_tab`), and the popup is one whenever
    // it is opened by address: read as "comes from a tab, so it is the sensor", both would be
    // refused — and the popup would render empty, which is exactly what a real Chromium said.
    await t.test('including one opened as a tab, which our own pages are', async () => {
        const { internals, onMessage } = worker();
        const answer = await send(internals, onMessage, { type: 'CERTIMENS_STATUS' },
            { id: EXTENSION_ID, url: EXTENSION_ORIGIN + 'options.html', tab: { id: 4, windowId: 1 } });
        assert.equal(answer.ok, true);
    });

    await t.test('the sensor may announce what it measures', async () => {
        const { internals, onMessage, storage } = worker();
        await send(internals, onMessage,
            { type: 'CERTIMENS_DOC_TITLE', documentId: 'site:x', documentName: 'Dissertation' },
            { id: EXTENSION_ID, url: PAGE, tab: { id: 4, windowId: 1 } });
        await internals.drain();
        assert.equal(storage.read('titles')['site:x'], 'Dissertation');
    });

    // The one thing a sensor cannot read for itself: Google redirects the export to
    // googleusercontent.com, which the page's own CORS will not follow.
    await t.test('and ask for the volume of a Google Doc, which it cannot read itself', async () => {
        const { internals, onMessage } = worker({ routes: () => null });
        const answer = await send(internals, onMessage,
            { type: 'CERTIMENS_GDOCS_VOLUME', documentId: 'AbC-123' },
            { id: EXTENSION_ID, url: PAGE, tab: { id: 4, windowId: 1 } });
        assert.ok(answer, 'the request is taken');
    });

    // The rest belongs to a window the student is looking at. `CERTIMENS_PAIR_START` most of
    // all: a pairing opened against another address, answered by a token, moves the account
    // and everything measured with it.
    await t.test('but it cannot open a pairing, end one, or send the copy', async () => {
        for (const type of ['CERTIMENS_PAIR_START', 'CERTIMENS_LOGOUT', 'CERTIMENS_UPLOAD_DOCX',
            'CERTIMENS_ADD_SITE', 'CERTIMENS_STATUS']) {
            const { internals, onMessage, calls } = worker();
            const answer = await send(internals, onMessage, { type, engineUrl: 'https://ailleurs.test' },
                { id: EXTENSION_ID, url: PAGE, tab: { id: 4, windowId: 1 } });
            assert.equal(answer, null, type + ' is dropped');
            assert.deepEqual(calls, [], type + ' reached no engine');
        }
    });

    await t.test('and nothing wearing another extension id is read at all', async () => {
        const { internals, onMessage } = worker();
        const answer = await send(internals, onMessage, { type: 'CERTIMENS_STATUS' },
            { id: 'another-extension', url: 'chrome-extension://another-extension/page.html' });
        assert.equal(answer, null);
    });
});

// The token, a pairing's device code and the queue live in `chrome.storage.local`, which every
// content script reads by default — including the one on an address the student added, which
// may be any page. Where the browser allows it, the worker closes the area to them and hands the
// sensor the three booleans it starts from, and the changes to its four keys, itself.
test('the token is out of the content scripts\' reach', async (t) => {
    const PAGE = 'http://wiki.univ-exemple.fr/devoir';
    const SENSOR = { id: EXTENSION_ID, url: PAGE, tab: { id: 4, windowId: 1 } };
    const turn = () => new Promise((done) => setImmediate(done));
    const ask = (onMessage, message, sender) => new Promise((resolve) => {
        if (onMessage.fn(message, sender, resolve) !== true) resolve(null);
    });

    await t.test('the area is closed to everything but the extension, at every start', async () => {
        const { levels } = worker({ accessLevel: 'granted' });
        await turn();
        assert.deepEqual(levels, ['TRUSTED_CONTEXTS']);
    });

    await t.test('the sensor is answered three booleans, and no credential', async () => {
        const { onMessage } = worker({
            accessLevel: 'granted',
            stored: { paused: false, signedIn: true, debug: 1, pairing: { deviceCode: 'device-1', token: 'pending-token' } },
        });
        const answer = await ask(onMessage, { type: 'CERTIMENS_SENSOR_STATE' }, SENSOR);
        assert.deepEqual({ ...answer }, { ok: true, debug: true, paused: false, signedIn: true });
        assert.ok(!JSON.stringify(answer).includes('token'), 'a credential reached the sensor');
    });

    await t.test('a change to its keys reaches every tab, and nothing else does', async () => {
        const { onChanged, told } = worker({ accessLevel: 'granted', tabs: [4, 9] });
        await turn();
        // A sign-out writes the session flag and the configuration in one go: only the flag
        // may leave the worker.
        onChanged.fn({
            signedIn: { oldValue: true, newValue: false },
            config: { oldValue: { token: 'api-token' }, newValue: { engineUrl: 'https://engine.test' } },
        }, 'local');
        await turn();
        assert.deepEqual(told.map(({ tabId }) => tabId), [4, 9]);
        for (const { message } of told) {
            assert.deepEqual(JSON.parse(JSON.stringify(message)),
                { type: 'CERTIMENS_SENSOR_STATE', changes: { signedIn: { newValue: false } } });
        }
        told.length = 0;
        onChanged.fn({ queue: { newValue: [] }, config: { newValue: { token: 'other' } } }, 'local');
        onChanged.fn({ prompted: { newValue: ['site:x'] } }, 'session');
        await turn();
        assert.deepEqual(told, [], 'a change the sensors do not follow was broadcast');
    });

    for (const [name, accessLevel] of [['without setAccessLevel (Firefox)', undefined], ['where it is refused', 'refused']]) {
        await t.test(`${name}, nothing changes: the sensors read the area themselves`, async () => {
            const { onChanged, told } = worker({ accessLevel, tabs: [4] });
            await turn();
            onChanged.fn({ paused: { newValue: true } }, 'local');
            await turn();
            assert.deepEqual(told, [], 'the change was sent twice');
        });
    }
});

// --- THE MEASUREMENT BODY ---
//
// There is one body (docs/moteur.md, "Le corps de mesure"). The cases are those of the three
// other agents' suites: what is held here is a body, byte for byte.
const quiet = async (run) => {
    const warn = console.warn;
    console.warn = () => {};
    try {
        await run();
    } finally {
        console.warn = warn;
    }
};

const FROM_A_PAGE = { id: EXTENSION_ID, url: 'https://docs.google.com/document/d/AbC/edit', tab: { id: 1 } };

test('the measurement body', async (t) => {
    await t.test('a live window: the envelope, key for key, in one line', async () => {
        const { internals, calls } = worker({ stored: paired([sealed(12)]) });

        await internals.drain();

        const [call] = metricsOf(calls);
        const sent = call.body.sent;
        assert.ok(Number.isInteger(sent), 'milliseconds since the epoch, as a whole number');
        assert.equal(call.raw, '{"session":"p3Vq0hJmR2aXw9LkT1yZ5g","sent":' + sent + ',"windows":[{'
            + '"seq":12,"at":' + (AT + 60000) + ',"mono":61000,"ms":2000,"why":"idle","active":1800,'
            + '"runs":[["type",5,1800]],'
            + '"counts":{"corrections":0,"reformulations":0,"revisions":0,"jumps":0,"exits":0,"back_keys":0,"back_chars":0},'
            + '"flight":{"med":140,"mad":12.5,"bins":[0,0,0,0,0,1,2,1]},'
            + '"dwell":{"bins":[0,0,0,1,3,1],"rollover":1},'
            + '"sum":{"keys":65,"chars":0,"pastes":0}}]}');
        assert.ok(!call.raw.includes('\n'), 'the body is never indented');
    });

    await t.test('`offline` between `why` and `active`, and `text` before `sum`', async () => {
        const item = sealed(3, { offline: true }, { text: { len: 1540, since: 1, at: 1180, cut: 40, add: 360, kept: 32 } });
        const { internals, calls } = worker({ stored: paired([item]) });

        await internals.drain();

        const [sent] = metricsOf(calls)[0].body.windows;
        assert.deepEqual(Object.keys(sent),
            ['seq', 'at', 'mono', 'ms', 'why', 'offline', 'active', 'runs', 'counts', 'flight', 'dwell', 'text', 'sum']);
        assert.equal(sent.offline, true);
        assert.deepEqual(Object.keys(sent.text), ['len', 'since', 'at', 'cut', 'add', 'kept']);
    });

    await t.test('a block the window does not have is left out, never sent empty or null', async () => {
        const bare = sealed(0, {}, { flight: undefined, text: undefined, dwell: { bins: [], rollover: 0 } });
        const { internals, calls } = worker({ stored: paired([bare]) });

        await internals.drain();

        const call = metricsOf(calls)[0];
        assert.deepEqual(Object.keys(call.body.windows[0]),
            ['seq', 'at', 'mono', 'ms', 'why', 'active', 'runs', 'counts', 'dwell', 'sum']);
        assert.equal(call.raw.includes('null'), false);
        assert.equal(call.raw.includes('offline'), false, '`offline` only when it is true');
    });

    await t.test('the size of the text alone, when there is no reading to compare it with', async () => {
        const { internals } = worker();
        assert.deepEqual({ ...internals.toWindow(sealed(0, {}, { text: { len: 812 } })).text }, { len: 812 });
        // A span is whole or it is not sent: the engine refuses part of one.
        assert.deepEqual({ ...internals.toWindow(sealed(1, {}, { text: { len: 812, since: 0, at: 3 } })).text }, { len: 812 });
    });

    await t.test('a key the body does not know is not sent', async () => {
        // The vocabulary is closed and the engine refuses an unknown key: nothing a page added
        // to its message rides along into a request made with the student's token.
        const { internals } = worker();
        const item = sealed(0, {}, { counts: { corrections: 2, jumps: 1, invented: 9 }, extra: 'x' });
        const sent = internals.toWindow(item);
        assert.deepEqual({ ...sent.counts }, { corrections: 2, jumps: 1 }, 'and a count the sensor did not take stays absent');
        assert.equal('extra' in sent, false);
    });

    // The queue is read back from storage, which hands its keys over in whatever order it
    // likes (see `reordered`): every level is laid out again, so a window that waited leaves
    // as the bytes it would have left as.
    await t.test('a window read back from the queue is the same bytes as a live one', async () => {
        const { internals } = worker();
        const item = sealed(4, {}, { text: { len: 30, since: 2, at: 10, cut: 1, add: 3 } });
        assert.equal(JSON.stringify(internals.toWindow(reordered(item))), JSON.stringify(internals.toWindow(item)));
        assert.deepEqual(Object.keys(internals.toWindow(reordered(item)).counts),
            ['corrections', 'reformulations', 'revisions', 'jumps', 'exits', 'back_keys', 'back_chars']);
    });

    await t.test('`sent` is this attempt\'s, and is kept nowhere', async () => {
        let attempts = 0;
        const { internals, storage, calls } = worker({
            stored: paired([sealed(0)]),
            metrics: () => (++attempts === 1 ? Promise.reject(new TypeError('network')) : json(null)),
        });

        await internals.drain();
        assert.equal(JSON.stringify(storage.read('queue')).includes('"sent"'), false);
        await internals.drain();

        const bodies = metricsOf(calls).map((call) => call.body);
        assert.equal(bodies.length, 2);
        assert.ok(bodies.every((body) => Number.isInteger(body.sent)), 'written on each attempt');
    });

    await t.test('the sensor\'s message becomes a window of the body', async () => {
        const { internals, onMessage, storage, calls } = worker({ stored: paired([]) });
        const { documentId, documentName, session, window } = sealed(7);
        onMessage.fn({ type: 'CERTIMENS_METRICS', documentId, documentName, reason: 'idle', session, window }, FROM_A_PAGE);
        await internals.drain();
        await internals.drain();

        const sent = metricsOf(calls).at(-1).body;
        assert.deepEqual(Object.keys(sent), ['session', 'sent', 'windows']);
        assert.equal(sent.windows[0].seq, 7);
        assert.equal('text' in sent.windows[0], false);
        assert.equal(storage.read('queue').length, 0);
    });

    // The message comes from a page. A session that is not one, a number that is not whole, a
    // window without runs: it is not a window of the body, and there is no other body for it
    // to leave in. It is dropped before it is queued.
    await t.test('a message that is not a window in full is dropped', async () => {
        for (const broken of [{ session: '../../admin' }, { session: 'court' }, { window: null },
            { block: { seq: -1 } }, { block: { seq: 1.5 } }, { block: { at: null } }, { block: { mono: -3 } },
            { block: { ms: undefined } }, { block: { why: undefined } }, { block: { why: 'pause' } },
            { block: { runs: [] } }, { block: { runs: undefined } }, { block: { counts: null } },
            { block: { sum: null } }, { block: { sum: { keys: 5 } } }, { block: { dwell: { rollover: 0 } } },
            { block: { text: { since: 0 } } }]) {
            const { internals, onMessage, storage, calls } = worker({ stored: paired([]) });
            const { documentId, documentName, session, window } = sealed(7, {}, broken.block);
            await quiet(async () => {
                onMessage.fn({ type: 'CERTIMENS_METRICS', documentId, documentName, session, window, ...broken, block: undefined },
                    FROM_A_PAGE);
                await internals.drain();
                await internals.drain();
            });

            assert.deepEqual(metricsOf(calls), [], JSON.stringify(broken));
            assert.equal(storage.read('queue').length, 0, JSON.stringify(broken));
        }
    });
});

test('live windows leave alone, a queue that waited leaves in batches', async (t) => {
    const waited = (seq, extra = {}) => sealed(seq, { offline: true, ...extra });
    const seqs = (calls) => metricsOf(calls).map((call) => call.body.windows.map((w) => w.seq));

    await t.test('two live windows are two requests', async () => {
        const { internals, calls } = worker({ stored: paired([sealed(0), sealed(1)]) });
        await internals.drain();
        assert.deepEqual(seqs(calls), [[0], [1]]);
    });

    await t.test('a queue caught up after an outage: 64 windows at most, in order, each flagged', async () => {
        const queue = Array.from({ length: 150 }, (_, seq) => waited(seq));
        const { internals, storage, calls } = worker({ stored: paired(queue) });

        await internals.drain();

        const batches = metricsOf(calls).map((call) => call.body.windows);
        assert.deepEqual(batches.map((batch) => batch.length), [64, 64, 22]);
        assert.deepEqual(batches.flat().map((w) => w.seq), queue.map((item) => item.window.seq));
        assert.ok(batches.flat().every((w) => w.offline === true));
        assert.equal(storage.read('queue').length, 0);
        // The cursor is still a number, written once per request and not once per window.
        assert.equal(storage.writes('queueSent'), 3 + 1);
    });

    await t.test('another session, or another document, is another request', async () => {
        const other = 'Zx9-other_session_id_0';
        const queue = [waited(0), waited(1), waited(0, { session: other }), waited(1, { session: other }),
            waited(2, { session: other, documentId: 'gdocs:XyZ' })];
        const { internals, calls } = worker({ stored: paired(queue, { engineIds: { 'gdocs:AbC': 'engine-1', 'gdocs:XyZ': 'engine-2' } }) });

        await internals.drain();

        assert.deepEqual(metricsOf(calls).map((call) => [call.url.split('/').at(-2), call.body.session, call.body.windows.map((w) => w.seq)]),
            [['engine-1', SESSION, [0, 1]], ['engine-1', other, [0, 1]], ['engine-2', other, [2]]]);
    });

    await t.test('a number that does not go up starts another request', async () => {
        const { internals, calls } = worker({ stored: paired([waited(3), waited(4), waited(4), waited(2)]) });
        await internals.drain();
        assert.deepEqual(seqs(calls), [[3, 4], [4], [2]]);
    });

    await t.test('the window whose own send failed leaves alone: it was live', async () => {
        // `offline` is set when queueing, from the attempt before (see above): the window
        // that met the outage first carries no flag, and is not batched with those that do.
        const { internals, calls } = worker({ stored: paired([sealed(0), waited(1), waited(2)]) });
        await internals.drain();
        assert.deepEqual(seqs(calls), [[0], [1, 2]]);
    });

    await t.test('a window that is not `offline` ends a batch: every window of one is', async () => {
        // The engine flags a batch that holds a window which did not wait for the network.
        const { internals, calls } = worker({ stored: paired([waited(0), waited(1), sealed(2), waited(3), waited(4)]) });
        await internals.drain();
        assert.deepEqual(seqs(calls), [[0, 1], [2], [3, 4]]);
    });

    // There is one body. What an older build queued in another shape — a list of typed
    // measurements, a window with a period and counters — is not translated into it: it is
    // dropped where it stands, and the windows around it leave as they would have.
    await t.test('a queued entry in another shape is dropped, and blocks nothing', async () => {
        const typed = { documentId: 'gdocs:AbC', documentName: 'Mémoire', offline: true,
            period: { start: '2026-10-09T08:00:00.000Z', end: '2026-10-09T08:00:02.000Z' }, values: { keystrokes_total: 9 } };
        const numbered = { ...typed, session: SESSION, seq: 2, mono: { start: 0, end: 2000 }, flush: 'idle',
            timeline: [['type', 9, 1500]], totals: { keystrokes: 9 } };
        const { internals, storage, calls } = worker({ stored: paired([typed, waited(0), waited(1), numbered, null, waited(3)]) });

        await internals.drain();

        assert.deepEqual(seqs(calls), [[0, 1], [3]]);
        assert.ok(metricsOf(calls).every((call) => Object.keys(call.body).join() === 'session,sent,windows'));
        assert.equal(storage.read('queue').length, 0);
        assert.equal(storage.read('status').state, 'synced');
    });

    await t.test('a batch cut by an outage leaves behind exactly what did not go', async () => {
        let requests = 0;
        const queue = Array.from({ length: 100 }, (_, seq) => waited(seq));
        const { internals, storage, calls } = worker({
            stored: paired(queue),
            metrics: () => (++requests === 2 ? Promise.reject(new TypeError('network')) : json(null)),
        });

        await internals.drain();
        assert.equal(storage.read('queueSent'), 64);
        await internals.drain();

        assert.deepEqual(metricsOf(calls).map((call) => call.body.windows.length), [64, 36, 36]);
        assert.equal(storage.read('queue').length, 0);
    });

    await t.test('a batch the engine refuses is sent again one by one, and only the refused window is lost', async () => {
        const { internals, storage, calls } = worker({
            stored: paired([waited(0), waited(1), waited(2), waited(3), waited(4)]),
            metrics: (body) => (body.windows.some((w) => w.seq === 1)
                ? json({ code: 'invalid_body', error: 'refused' }, { status: 400 })
                : json(null)),
        });
        await quiet(() => internals.drain());

        assert.deepEqual(seqs(calls), [[0, 1, 2, 3, 4], [0], [1], [2, 3, 4]]);
        assert.equal(storage.read('queue').length, 0);
    });

    await t.test('a number the engine already holds for another window does not block the queue', async () => {
        const { internals, storage, calls } = worker({
            stored: paired([sealed(0), sealed(1)]),
            metrics: (body) => (body.windows[0].seq === 0
                ? json({ code: 'window_conflict', error: 'conflict' }, { status: 409 })
                : json(null)),
        });
        await quiet(() => internals.drain());

        assert.equal(metricsOf(calls).length, 2);
        assert.equal(storage.read('queue').length, 0);
        assert.equal(storage.read('status').state, 'synced');
    });
});

test('no refusal makes the agent change body', async (t) => {
    // Whatever the engine answers, the window it refused is dropped and the next one leaves in
    // the same body: the agent neither falls back to another shape nor takes a measurement out
    // to be accepted, and it remembers nothing about the engine that refused.
    await t.test('a 400 drops the window, whatever its code, and the next one is the same body', async () => {
        for (const code of ['invalid_body', 'metrics_required', 'metric_type_unknown', '']) {
            const { internals, storage, session, calls } = worker({
                stored: paired([sealed(0), sealed(1)]),
                metrics: () => json({ code, error: 'refused' }, { status: 400 }),
            });
            await quiet(() => internals.drain());

            const bodies = metricsOf(calls).map((call) => call.body);
            assert.equal(bodies.length, 2, code + ': one attempt per window, no second try in another shape');
            assert.ok(bodies.every((body) => Object.keys(body).join() === 'session,sent,windows'), code);
            assert.deepEqual(bodies.map((body) => Object.keys(body.windows[0]).join()),
                Array(2).fill('seq,at,mono,ms,why,active,runs,counts,flight,dwell,sum'), code);
            assert.equal(storage.read('queue').length, 0, code);
            // `telemetryStarted` says the extension has started this session (SELF-TELEMETRY),
            // and nothing about any engine.
            assert.deepEqual([...session.map.keys()].filter((key) => key !== 'telemetryStarted'), [],
                code + ': nothing is remembered about that engine');
        }
    });

    await t.test('a document deleted on the engine is created again, once', async () => {
        let attempts = 0;
        const { internals, storage, calls } = worker({
            stored: paired([sealed(0)]),
            metrics: () => (++attempts === 1 ? json({ error: 'not found' }, { status: 404 }) : json(null)),
        });

        await internals.drain();

        assert.equal(metricsOf(calls).length, 2);
        assert.equal(storage.read('queue').length, 0);
    });
});

test('the text of a Google Doc only goes back to the page that shows it', async (t) => {
    const exportOf = (text) => (url) => (url.includes('/export?format=txt')
        ? { ok: true, status: 200, headers: { get: () => 'text/plain' }, text: () => Promise.resolve(text) }
        : null);
    const ask = (onMessage, sender) => new Promise((resolve) => {
        onMessage.fn({ type: 'CERTIMENS_GDOCS_VOLUME', documentId: 'AbC-123' }, { id: EXTENSION_ID, ...sender }, resolve);
    });

    await t.test('the document\'s own page gets the text its size was counted on', async () => {
        const { onMessage } = worker({ routes: exportOf('Un\r\nmémoire 😀\n') });
        const answer = await ask(onMessage, { url: 'https://docs.google.com/document/d/AbC-123/edit?tab=t.0', tab: { id: 1 } });
        assert.equal(answer.volume, 11);
        assert.equal(answer.text, 'Unmémoire 😀');
    });

    await t.test('another document, or a page the student added, gets the size alone', async () => {
        for (const url of ['https://docs.google.com/document/d/AbC-1234/edit', 'https://docs.google.com/document/d/Other/edit',
            'https://moodle.univ-exemple.fr/mod/assign/view.php?id=7', undefined]) {
            const { onMessage } = worker({ routes: exportOf('Un mémoire') });
            const answer = await ask(onMessage, { url, tab: { id: 1 } });
            assert.equal(answer.volume, 10);
            assert.equal('text' in answer, false, String(url));
        }
    });
});

// --- WHAT THE AGENT SAYS OF ITSELF ---
//
// docs/moteur.md, "Ce que l'agent dit de lui-même": counters of a closed vocabulary, persisted,
// sent at most every fifteen minutes when paired, reset on a 204 alone. The same cases as the
// three other agents' suites (word/tests/agent.test.mjs, vscode/tests/engine.test.mjs,
// libreoffice/tests/test_engine.py).

const TELEMETRY = '/api/plugins/telemetry';
const telemetryCalls = (calls) => calls.filter((c) => c.url.endsWith(TELEMETRY));
// Started already counted for this run: the tests below begin from the counters they set.
const STARTED = { telemetryStarted: true };
// Lets the storage writes the worker starts on its own (at load, from a listener) land.
const settle = async () => {
    for (let i = 0; i < 10; i++) await new Promise((resolve) => setImmediate(resolve));
};
const counters = (storage) => ({ ...(storage.read('telemetry') || {}) });
// The telemetry endpoint answering `status`, every other route answering as usual.
const telemetryAnswer = (status) => (url) => (url.endsWith(TELEMETRY) ? json(null, { status }) : null);

test('what the agent counts about itself', async (t) => {
    await t.test('the vocabulary is the contract\'s, in its order', async () => {
        const { internals } = worker();
        assert.deepEqual([...internals.TELEMETRY_EVENTS], ['installed', 'updated', 'started', 'error.runtime',
            'error.engine', 'error.rejected', 'error.auth', 'network.failure', 'queue.dropped']);
        assert.equal(internals.TELEMETRY_FLUSH_MS, 15 * 60 * 1000);
        assert.equal(internals.TELEMETRY_MAX_COUNT, 10000);
    });

    await t.test('a word of the vocabulary is counted and kept; anything else is not', async () => {
        const { internals, storage } = worker({ sessionStored: STARTED });
        await internals.countEvent('error.engine');
        await internals.countEvent('error.engine');
        await internals.countEvent('TypeError: le texte de l’étudiant');
        assert.deepEqual(counters(storage), { 'error.engine': 2 });
    });

    await t.test('each count stops at the cap', async () => {
        const { internals, storage } = worker({ sessionStored: STARTED, stored: { telemetry: { 'error.runtime': 9999 } } });
        for (let i = 0; i < 3; i++) await internals.countEvent('error.runtime');
        assert.equal(counters(storage)['error.runtime'], 10000);
    });

    await t.test('started once per run of the extension, not per wake of the worker', async () => {
        const first = worker();
        await settle();
        assert.deepEqual(counters(first.storage), { started: 1 });
        // The worker woken again within the same browser session: same session storage.
        const again = worker({ stored: { telemetry: counters(first.storage) },
            sessionStored: Object.fromEntries(first.session.map) });
        await settle();
        assert.deepEqual(counters(again.storage), { started: 1 });
    });

    await t.test('installed and updated, as the browser announces them', async () => {
        const { internals, storage } = worker({ sessionStored: STARTED });
        await internals.noteInstalled({ reason: 'install' });
        await internals.noteInstalled({ reason: 'update', previousVersion: '1.4.1' });
        // A reload of the same build, and the browser updating itself: neither is the agent's.
        await internals.noteInstalled({ reason: 'update', previousVersion: MANIFEST_VERSION });
        await internals.noteInstalled({ reason: 'chrome_update' });
        assert.deepEqual(counters(storage), { installed: 1, updated: 1 });
    });

    await t.test('the worker\'s own uncaught errors, and those our pages and sensors report', async () => {
        const { storage, scopeListeners, onMessage } = worker({ sessionStored: STARTED });
        scopeListeners.get('error')({ message: 'boom' });
        scopeListeners.get('unhandledrejection')({ reason: new Error('boom') });
        onMessage.fn({ type: 'CERTIMENS_RUNTIME_ERROR' }, { id: EXTENSION_ID, url: EXTENSION_ORIGIN + 'popup.html' });
        onMessage.fn({ type: 'CERTIMENS_RUNTIME_ERROR' }, { id: EXTENSION_ID, url: 'https://docs.google.com/document/d/x/edit', tab: { id: 1 } });
        // Another extension is nobody we count for.
        onMessage.fn({ type: 'CERTIMENS_RUNTIME_ERROR' }, { id: 'someone-else', url: 'https://x.test/' });
        await settle();
        assert.deepEqual(counters(storage), { 'error.runtime': 4 });
    });

    await t.test('the work\'s calls count what the engine answered, or that it did not', async () => {
        const cases = [
            [{ down: true }, 'network.failure'],
            [{ metrics: () => json({ error: 'down' }, { status: 503 }) }, 'error.engine'],
            [{ metrics: () => json({ error: 'refused' }, { status: 400 }) }, 'error.rejected'],
            [{ metrics: () => json({ error: 'token' }, { status: 401 }) }, 'error.auth'],
        ];
        for (const [options, event] of cases) {
            const { internals, storage } = worker({ sessionStored: STARTED, stored: paired([sealed(0)]), ...options });
            await quiet(() => internals.drain());
            assert.deepEqual(counters(storage), { [event]: 1 }, event);
        }
    });

    await t.test('a pairing still waiting for its confirmation is not a refusal', async () => {
        const { internals, storage } = worker({
            sessionStored: STARTED,
            routes: (url) => (url.endsWith('/api/auth/device/token')
                ? json({ code: 'device_authorization_pending', error: 'pending' }, { status: 400 }) : null),
        });
        assert.equal(await internals.pollPairing({ engineUrl: 'https://engine.test', deviceCode: 'd' }), null);
        assert.deepEqual(counters(storage), {});
        const limited = worker({ sessionStored: STARTED,
            routes: (url) => (url.endsWith('/api/auth/device/token') ? json({ error: 'too many' }, { status: 429 }) : null) });
        assert.equal(await limited.internals.pollPairing({ engineUrl: 'https://engine.test', deviceCode: 'd' }), null);
        assert.deepEqual(counters(limited.storage), {});
    });

    await t.test('a document looked up and gone is an answer, not a refusal', async () => {
        const { internals, storage } = worker({ sessionStored: STARTED, stored: paired([]),
            routes: (url, init) => (init.method === 'GET' && url.endsWith('/api/documents/engine-1')
                ? json({ error: 'not found' }, { status: 404 }) : null) });
        const info = await internals.REQUESTS.CERTIMENS_DOC_INFO({ documentId: 'gdocs:AbC' });
        assert.equal(info.engineId, null);
        assert.deepEqual(counters(storage), {});
    });

    await t.test('what the agent refuses itself, without calling the engine, is counted nowhere', async () => {
        const { internals, storage, calls } = worker({ sessionStored: STARTED });
        await assert.rejects(() => internals.startPairing('http://8.8.8.8'));
        assert.equal(calls.length, 0);
        assert.deepEqual(counters(storage), {});
    });

    await t.test('a window a full queue pushes out is counted', async () => {
        const { internals, storage } = worker({ sessionStored: STARTED, stored: { queue: Array(5000).fill(sealed(0)) } });
        await internals.enqueue(sealed(1));
        assert.equal(storage.read('queue').length, internals.MAX_QUEUE);
        assert.deepEqual(counters(storage), { 'queue.dropped': 1 });
    });
});

// Values from the worker's realm, compared as data.
const plain = (value) => JSON.parse(JSON.stringify(value));

// Where the extension's code broke (constants.js, `faultOf`): its own frames, as positions in its
// published source, and nothing else a stack carries.
test('a fault is where our code broke, and nothing else', async (t) => {
    const { internals } = worker();
    const own = EXTENSION_ORIGIN;

    await t.test('V8: our frames, innermost first, without the message or the extension\'s address', () => {
        const stack = [
            'TypeError: Cannot read properties of undefined (reading \'Mon mémoire\')',
            `    ${own}content.js:1:1 is quoted in a message line, which is never read`,
            `    at flushTelemetry (${own}background.js:323:15)`,
            '    at https://docs.google.com/static/editor.js:10:2',
            `    at async Promise.all (index 0)`,
            `    at new Queue (${own}background.js:40:9)`,
            `    at ${own}background.js:387:5`,
        ].join('\n');
        assert.deepEqual(plain(internals.faultOf('TypeError', stack, own)), {
            type: 'TypeError',
            frames: ['flushTelemetry@background.js:323:15', 'Queue@background.js:40:9', 'background.js:387:5'],
        });
    });

    await t.test('Firefox and Safari: the same, from their dialect', () => {
        const ff = 'moz-extension://5b1c0e3a-uuid/';
        const stack = `flush@${ff}background.js:323:15\nasync*drain@${ff}background.js:12:3\nlisten/<@${ff}content.js:1630:13\n@https://example.org/a.js:1:1\n`;
        assert.deepEqual([...internals.faultOf('RangeError', stack, ff).frames],
            ['flush@background.js:323:15', 'drain@background.js:12:3', 'content.js:1630:13']);
    });

    await t.test('a type that is not a name, a file in a folder, no stack: nothing of them', () => {
        assert.equal(internals.faultOf('Cannot read \'Mon mémoire\'', '', own).type, 'Other');
        assert.deepEqual([...internals.faultOf('Error', `    at f (${own}lib/x.js:1:1)\n    at g (${own}x.js:2:2)`, own).frames], ['g@x.js:2:2']);
        assert.deepEqual([...internals.faultOf('Error', undefined, own).frames], []);
    });

    await t.test('at most a dozen frames', () => {
        const stack = '\n' + Array.from({ length: 20 }, (_, i) => `    at f${i} (${own}background.js:${i + 1}:1)`).join('\n');
        assert.equal(internals.faultOf('Error', stack, own).frames.length, 12);
    });
});

test('counting a fault', async (t) => {
    const stack = `TypeError: x\n    at flush (${EXTENSION_ORIGIN}background.js:323:15)`;

    await t.test('counted as error.runtime, kept once with its count', async () => {
        const { internals, storage } = worker({ sessionStored: STARTED });
        await internals.countRuntimeError('TypeError', stack);
        await internals.countRuntimeError('TypeError', stack);
        assert.deepEqual(counters(storage), { 'error.runtime': 2 });
        assert.deepEqual(plain(storage.read('telemetryFaults')), [{ type: 'TypeError', frames: ['flush@background.js:323:15'], count: 2 }]);
    });

    await t.test('ten distinct faults at most; the eleventh is still counted', async () => {
        const { internals, storage } = worker({ sessionStored: STARTED });
        for (let i = 1; i <= 11; i++) await internals.countRuntimeError('Error', `Error\n    at f (${EXTENSION_ORIGIN}background.js:${i}:1)`);
        assert.equal(storage.read('telemetryFaults').length, 10);
        assert.deepEqual(counters(storage), { 'error.runtime': 11 });
    });

    await t.test('from a page or a content script, by message', async () => {
        const { onMessage, storage } = worker({ sessionStored: STARTED });
        onMessage.fn({ type: 'CERTIMENS_RUNTIME_ERROR', name: 'TypeError', stack }, { id: EXTENSION_ID, url: EXTENSION_ORIGIN + 'popup.html' }, () => {});
        await settle();
        assert.deepEqual(plain(storage.read('telemetryFaults')), [{ type: 'TypeError', frames: ['flush@background.js:323:15'], count: 1 }]);
    });

    await t.test('the worker\'s own uncaught errors', async () => {
        const { scopeListeners, storage } = worker({ sessionStored: STARTED });
        const boom = new RangeError('le texte de l’étudiant');
        boom.stack = `RangeError: le texte de l’étudiant\n    at drain (${EXTENSION_ORIGIN}background.js:12:3)`;
        scopeListeners.get('unhandledrejection')({ reason: boom });
        scopeListeners.get('unhandledrejection')({ reason: 'not an error' });
        await settle();
        assert.deepEqual(plain(storage.read('telemetryFaults')), [
            { type: 'RangeError', frames: ['drain@background.js:12:3'], count: 1 },
            { type: 'Other', frames: [], count: 1 },
        ]);
        assert.doesNotMatch(JSON.stringify(storage.read('telemetryFaults')), /étudiant/);
    });
});

test('sending the counters', async (t) => {
    await t.test('the body is the counters and nothing else, in the vocabulary\'s order, with the usual headers', async () => {
        const { internals, calls } = worker({ sessionStored: STARTED,
            routes: telemetryAnswer(204),
            stored: { telemetry: { started: 3, 'error.runtime': 1, installed: 1 } } });
        await internals.flushTelemetry();
        const [call] = telemetryCalls(calls);
        assert.equal(call.url, 'https://engine.test' + TELEMETRY);
        assert.equal(call.method, 'POST');
        // Storage handed the keys back in another order; they leave in the table's.
        assert.equal(call.raw, '{"events":{"installed":1,"started":3,"error.runtime":1}}');
        assert.equal(call.headers['Authorization'], 'Bearer api-token');
        assert.equal(call.headers['Content-Type'], 'application/json');
        assert.equal(call.headers['X-Certimens-Agent'], `browser/${MANIFEST_VERSION}`);
    });

    await t.test('the faults leave with the counters, and are forgotten with them', async () => {
        const fault = { type: 'TypeError', frames: ['flush@background.js:323:15'], count: 2 };
        const { internals, calls, storage } = worker({ sessionStored: STARTED, routes: telemetryAnswer(204),
            stored: { telemetry: { 'error.runtime': 2 }, telemetryFaults: [fault] } });
        await internals.flushTelemetry();
        const [call] = telemetryCalls(calls);
        assert.deepEqual(call.body, { events: { 'error.runtime': 2 }, faults: [fault] });
        assert.deepEqual(plain(storage.read('telemetryFaults')), []);
    });

    await t.test('kept for next time when the engine does not answer', async () => {
        const fault = { type: 'TypeError', frames: ['flush@background.js:323:15'], count: 2 };
        const { internals, storage } = worker({ sessionStored: STARTED, down: true,
            stored: { telemetry: { 'error.runtime': 2 }, telemetryFaults: [fault] } });
        await internals.flushTelemetry();
        assert.deepEqual(plain(storage.read('telemetryFaults')), [fault]);
    });

    await t.test('nothing leaves before pairing, and the counts wait for it', async () => {
        const { internals, calls, storage } = worker({ sessionStored: STARTED,
            stored: { config: { engineUrl: 'https://engine.test' }, telemetry: { installed: 1 } } });
        await internals.flushTelemetry();
        assert.equal(calls.length, 0);
        assert.deepEqual(counters(storage), { installed: 1 });
    });

    await t.test('nothing leaves when there is nothing to say', async () => {
        const { internals, calls } = worker({ sessionStored: STARTED });
        await internals.flushTelemetry();
        assert.equal(calls.length, 0);
    });

    await t.test('at most once every fifteen minutes', async () => {
        const { internals, calls, time } = worker({ sessionStored: STARTED, routes: telemetryAnswer(503),
            stored: { telemetry: { started: 1 } } });
        await internals.flushTelemetry();
        time.advance(60);
        await internals.flushTelemetry();
        assert.equal(telemetryCalls(calls).length, 1, 'the minute tick does not send every minute');
        time.advance(15 * 60);
        await internals.flushTelemetry();
        assert.equal(telemetryCalls(calls).length, 2);
    });

    await t.test('a 204 takes off what was sent, and keeps what was counted during the send', async () => {
        let answer;
        const { internals, storage } = worker({ sessionStored: STARTED,
            routes: (url) => (url.endsWith(TELEMETRY) ? new Promise((resolve) => { answer = resolve; }) : null),
            stored: { telemetry: { started: 2, 'error.engine': 1 } } });
        const flushing = internals.flushTelemetry();
        await settle();
        await internals.countEvent('error.engine');
        await internals.countEvent('network.failure');
        answer(json(null, { status: 204 }));
        await flushing;
        assert.deepEqual(counters(storage), { 'error.engine': 1, 'network.failure': 1 });
    });

    await t.test('no answer, or a 5xx: kept for next time, and not counted', async () => {
        for (const options of [{ down: true }, { routes: telemetryAnswer(500) }, { routes: telemetryAnswer(429) }]) {
            const { internals, storage } = worker({ sessionStored: STARTED, stored: { telemetry: { started: 1 } }, ...options });
            await internals.flushTelemetry();
            assert.deepEqual(counters(storage), { started: 1 }, JSON.stringify(Object.keys(options)));
        }
    });

    await t.test('a 400, a 413 or a 401: dropped, and not counted either', async () => {
        for (const status of [400, 413, 401]) {
            const { internals, storage } = worker({ sessionStored: STARTED, routes: telemetryAnswer(status),
                stored: { telemetry: { started: 1 } } });
            await internals.flushTelemetry();
            assert.deepEqual(counters(storage), {}, String(status));
        }
    });

    await t.test('signing out keeps the counters: they belong to no account', async () => {
        const { internals, storage } = worker({ sessionStored: STARTED, stored: { telemetry: { installed: 1 } } });
        await internals.REQUESTS.CERTIMENS_LOGOUT();
        assert.deepEqual(counters(storage), { installed: 1 });
    });
});

// Firefox only lets an extension declare these counters as **optional** data
// (`technicalAndInteraction`): on the Firefox package, nothing leaves without that consent.
test('on Firefox, the counters leave only with the student\'s consent', async (t) => {
    const firefox = { browser_specific_settings: { gecko: { data_collection_permissions: {
        required: ['authenticationInfo'], optional: ['technicalAndInteraction'] } } } };

    await t.test('without it, nothing is sent and the counts stay on the machine', async () => {
        const { internals, calls, storage } = worker({ sessionStored: STARTED, manifest: firefox,
            stored: { telemetry: { installed: 1 } } });
        await internals.flushTelemetry();
        assert.equal(telemetryCalls(calls).length, 0);
        assert.deepEqual(counters(storage), { installed: 1 });
    });

    await t.test('with it, they leave as anywhere else', async () => {
        const { internals, calls } = worker({ sessionStored: STARTED, manifest: firefox, dataConsent: true,
            routes: telemetryAnswer(204), stored: { telemetry: { installed: 1 } } });
        await internals.flushTelemetry();
        assert.equal(telemetryCalls(calls).length, 1);
    });
});

// The engine keeps one living document per name and per account. A document created from a
// sealed window is created with nobody watching, so a name already taken is not a refusal to
// pass on: it is a name to change.
test('a document whose name is taken', async (t) => {
    const nameTaken = () => json({ error: 'taken', code: 'document_name_taken' }, { status: 409 });
    const creation = (refusals) => (url, init) => (init.method === 'POST' && url.endsWith('/api/documents') && refusals-- > 0
        ? nameTaken() : null);
    const created = (calls) => calls.filter((c) => c.method === 'POST' && c.url.endsWith('/api/documents')).map((c) => c.body.name);

    await t.test('from a sealed window, it takes a free name and the window leaves', async () => {
        const { internals, calls, storage } = worker({ routes: creation(1) });
        await internals.enqueue(window_());
        await internals.drain();
        const names = created(calls);
        assert.equal(names[0], 'Mémoire');
        assert.match(names[1], /^Mémoire \(\d{4}-\d\d-\d\d \d\d\.\d\d\.\d\d\)$/);
        assert.equal(metricsOf(calls).length, 1);
        assert.equal(storage.read('queue').length, 0);
    });

    await t.test('typed by the student, it is said and nothing is created behind them', async () => {
        const { internals, calls } = worker({ routes: creation(5) });
        await assert.rejects(() => internals.createFileFor('gdocs:AbC', 'Mémoire', 'Mémoire'),
            (err) => err.code === 'document_name_taken' && err.message === 'error.nameTaken');
        assert.equal(created(calls).length, 1);
    });

    await t.test('a creation refused keeps the window: it is not the window that was refused', async () => {
        const { internals, storage } = worker({ routes: creation(5) });
        await internals.enqueue(window_());
        await internals.drain();
        assert.equal(storage.read('queue').length, 1);
        assert.equal(storage.read('status').state, 'offline');
        assert.equal(storage.read('status').reached, true);
    });
});

test('a pairing is finished once, by whoever asks', async (t) => {
    const PAIRING = { engineUrl: 'https://engine.test', deviceCode: 'device-1', userCode: 'CDFH-JKMN', expiresAt: Date.now() + 600000 };

    await t.test('the alarm and the popup asking together poll the code once', async () => {
        const { internals, calls, storage } = worker({
            stored: { config: { engineUrl: 'https://engine.test' }, pairing: PAIRING },
            routes: (url) => (url.endsWith('/api/auth/device/token') ? json({ token: 'api-token' }) : null),
        });
        const [one, two] = await Promise.all([internals.advancePairing(), internals.advancePairing()]);
        assert.equal(one.email, 'a@b.fr');
        assert.equal(two.email, 'a@b.fr');
        assert.equal(calls.filter((c) => c.url.endsWith('/api/auth/device/token')).length, 1);
        assert.equal(storage.read('pairing'), undefined);
    });

    await t.test('a token handed out is kept until it is adopted, not lost to a call that failed', async () => {
        let lookups = 0;
        const { internals, calls, storage } = worker({
            stored: { config: { engineUrl: 'https://engine.test' }, pairing: PAIRING },
            routes: (url) => {
                if (url.endsWith('/api/auth/device/token')) return json({ token: 'api-token' });
                // The first read of the account gets no answer at all.
                if (url.endsWith('/api/auth/me') && lookups++ === 0) throw new Error('Failed to fetch');
                return null;
            },
        });
        assert.equal(await internals.advancePairing(), null);
        assert.equal(storage.read('pairing').token, 'api-token');
        const me = await internals.advancePairing();
        assert.equal(me.email, 'a@b.fr');
        assert.equal(calls.filter((c) => c.url.endsWith('/api/auth/device/token')).length, 1, 'the code is not asked about twice');
        assert.equal(storage.read('config').token, 'api-token');
        assert.equal(storage.read('pairing'), undefined);
    });

    await t.test('the token a new pairing replaces is revoked, not left behind', async () => {
        const { internals, calls } = worker({
            stored: { config: { engineUrl: 'https://engine.test', token: 'old-token', tokenId: 'tok-0', email: 'a@b.fr' } },
        });
        await internals.adoptToken('https://engine.test', 'api-token');
        await Promise.resolve();
        const revoked = calls.filter((c) => c.method === 'DELETE');
        assert.deepEqual(revoked.map((c) => [c.url, c.headers.Authorization]),
            [['https://engine.test/api/auth/tokens/tok-0', 'Bearer old-token']]);
    });

    await t.test('the same address on another engine is another account', async () => {
        const { internals, storage } = worker({
            stored: { config: { engineUrl: 'https://old.example.fr', token: 't', email: 'a@b.fr' }, queue: [window_()] },
        });
        await internals.adoptToken('https://engine.test', 'api-token');
        assert.equal(storage.read('queue'), undefined);
    });
});

test('signing out leaves nothing for the next account', async () => {
    const { internals, storage } = worker({ stored: { ...paired([]), signedIn: true } });
    await internals.REQUESTS.CERTIMENS_LOGOUT();
    // The page seals its open window when it sees the session end: it finds nobody signed in.
    await internals.enqueue(window_());
    assert.equal(storage.read('queue'), undefined);
    assert.equal(storage.read('config').token, undefined);
});

// --- THE PROBLEM REPORT ---

// "Signaler un problème" opens the help form of the Certimens space, prefilled with a block that
// describes the agent (docs/moteur.md, "Signaler un problème"). What is pinned here is the
// contract: the address, the fragment, the eleven keys in their order, `unknown` for what the
// worker cannot say — and above all what is never in it.
test('the problem report', async (t) => {
    const ORIGIN = 'chrome-extension://certimens-test-id/';
    const ask = (onMessage, message, sender) => new Promise((resolve) => {
        if (onMessage.fn(message, sender, resolve) !== true) resolve(null);
    });
    // The block a link carries, decoded, as `[key, value]` lines.
    const blockOf = (url) => {
        const fragment = new URL(url).hash;
        const details = new URLSearchParams(fragment.slice(fragment.indexOf('?') + 1)).get('details');
        return details.split('\n').map((line) => [line.slice(0, line.indexOf(': ')), line.slice(line.indexOf(': ') + 2)]);
    };
    const CHROME = {
        brands: [{ brand: 'Not)A;Brand', version: '99' }, { brand: 'Google Chrome', version: '141.0.7390.54' },
            { brand: 'Chromium', version: '141.0.7390.54' }],
    };

    await t.test('the link opens the form in problem mode, on the engine, in the fragment', async () => {
        const { internals } = worker({ navigator: { userAgentData: CHROME } });
        const url = await internals.reportLink();
        assert.match(url, /^https:\/\/engine\.test\/#report\?kind=problem&details=[^&#]+$/);
        // The fragment is the shared declaration, not a spelling of this worker's own.
        assert.ok(url.startsWith(`https://engine.test/${internals.REPORT_FRAGMENT}?`));
    });

    await t.test('eleven lines, in the contract\'s order, every one of them present', async () => {
        const { internals } = worker({
            navigator: { userAgentData: CHROME },
            stored: {
                queue: [window_(0), window_(1), window_(2)], queueSent: 1,
                status: { state: 'offline', reached: false, message: 'Failed to fetch https://engine.test/x' },
                paused: true, telemetry: { 'network.failure': 5, 'error.runtime': 2, 'not.a.word': 7 },
            },
        });
        const lines = blockOf(await internals.reportLink());
        assert.deepEqual(lines.map(([key]) => key), [...internals.REPORT_KEYS]);
        assert.deepEqual([...internals.REPORT_KEYS], ['agent', 'host', 'os', 'language', 'engine', 'signed_in',
            'paused', 'status', 'queued', 'counters', 'at']);
        const values = Object.fromEntries(lines);
        assert.equal(values.agent, `browser/${MANIFEST_VERSION}`, 'the X-Certimens-Agent declaration');
        assert.equal(values.host, 'Chrome 141');
        assert.equal(values.os, 'linux x86-64');
        assert.equal(values.language, 'fr');
        assert.equal(values.engine, 'https://engine.test');
        assert.equal(values.signed_in, 'yes');
        assert.equal(values.paused, 'yes');
        // The state and whether the engine answered — never the status message, which carries
        // an address.
        assert.equal(values.status, 'offline (unreachable)');
        assert.equal(values.queued, '2');
        // Known words only, in the vocabulary's order.
        assert.equal(values.counters, 'error.runtime=2 network.failure=5');
        assert.match(values.at, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
    });

    await t.test('what the worker cannot say is unknown, not guessed', async () => {
        const { internals } = worker({ platform: null, stored: { status: { state: 'offline', reached: true } } });
        const values = Object.fromEntries(blockOf(await internals.reportLink()));
        // No navigator, no client hints, no getBrowserInfo: nothing to name the browser by.
        assert.equal(values.host, 'unknown');
        assert.equal(values.os, 'unknown');
        assert.equal(values.status, 'offline (reached)');
        assert.equal(values.counters, 'none');
        assert.equal(values.queued, '0');
    });

    await t.test('the browser is named by what it says of itself', async () => {
        const cases = [
            [{ browserInfo: { name: 'Firefox', version: '128.0.3' } }, 'Firefox 128'],
            [{ navigator: { userAgentData: { brands: [{ brand: 'Chromium', version: '140' }, { brand: 'Microsoft Edge', version: '140' }, { brand: 'Not=A?Brand', version: '24' }] } } }, 'Edge 140'],
            [{ navigator: { userAgentData: { brands: [{ brand: 'Chromium', version: '139' }] } } }, 'Chromium 139'],
            [{ navigator: { userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.2 Safari/605.1.15' } }, 'Safari 18'],
            [{ navigator: { userAgent: 'Mozilla/5.0 (X11; Linux x86_64; rv:128.0) Gecko/20100101 Firefox/128.0' } }, 'Firefox 128'],
            [{ navigator: { userAgent: 'SomethingElse/1.0' } }, null],
        ];
        for (const [options, expected] of cases) {
            const { internals } = worker(options);
            assert.equal(await internals.browserName(), expected, JSON.stringify(options));
        }
    });

    await t.test('no token, no device code, no e-mail, no document — even when they are all stored', async () => {
        const { internals } = worker({
            navigator: { userAgentData: CHROME },
            stored: {
                config: { engineUrl: 'https://engine.test/espace/', token: 'secret-api-token', tokenId: 'tok-9',
                    email: 'etudiante@univ-exemple.fr', displayName: 'Camille Martin', language: 'fr' },
                pairing: { deviceCode: 'device-secret', userCode: 'CDFH-JKMN', token: 'pending-secret' },
                queue: [window_(0)], engineIds: { 'gdocs:AbC': 'engine-1', 'site:moodle.univ-exemple.fr/devoir': 'engine-2' },
                titles: { 'gdocs:AbC': 'Mémoire de master' }, sites: ['https://moodle.univ-exemple.fr/*'],
            },
        });
        const url = await internals.reportLink();
        const block = decodeURIComponent(url);
        for (const secret of ['secret-api-token', 'tok-9', 'etudiante', 'Camille', 'device-secret', 'CDFH-JKMN',
            'pending-secret', 'AbC', 'engine-1', 'Mémoire', 'moodle', '/espace']) {
            assert.ok(!block.includes(secret), `${secret} is in the report`);
        }
        // The engine is named by its origin alone.
        assert.equal(Object.fromEntries(blockOf(url)).engine, 'https://engine.test');
    });

    await t.test('an engine address the rule refuses sends the link to the default engine', async () => {
        for (const engineUrl of REFUSED) {
            const { internals } = worker({ stored: { config: { engineUrl, token: 'api-token' } } });
            const url = await internals.reportLink();
            assert.ok(url.startsWith('https://monespace.certimens.fr/#report?kind=problem&details='), `${engineUrl}: ${url}`);
        }
    });

    await t.test('the block stays under 1,500 characters, cut on a line, and one value is one line', async () => {
        const { internals } = worker({ navigator: { userAgentData: { brands: [{ brand: 'X\nY', version: '1' }] } } });
        const values = Object.fromEntries(blockOf(await internals.reportLink()));
        assert.equal(values.host, 'X Y 1', 'a newline inside a value would forge a line of its own');

        // Values no host would hand over, every one at its longest.
        const long = Object.fromEntries(internals.REPORT_KEYS.map((key) => [key, 'z'.repeat(5000)]));
        const block = internals.reportBlock(long);
        assert.ok(block.length <= 1500, `${block.length} characters`);
        const lines = block.split('\n');
        assert.ok(lines.length > 1 && lines.length < internals.REPORT_KEYS.length, 'cut, and not to nothing');
        // Whole lines, in order: a line cut in the middle would read as a value that is not.
        lines.forEach((line, i) => assert.ok(line.startsWith(`${internals.REPORT_KEYS[i]}: `) && line.endsWith('z'), line.slice(0, 20)));

        // Nothing given: every key still has its line.
        assert.equal(internals.reportBlock({}), internals.REPORT_KEYS.map((key) => `${key}: unknown`).join('\n'));
    });

    await t.test('the request opens a tab on the link, from a window of ours', async () => {
        const { onMessage, opened } = worker({ navigator: { userAgentData: CHROME } });
        const answer = await ask(onMessage, { type: 'CERTIMENS_REPORT' }, { id: EXTENSION_ID, url: ORIGIN + 'popup.html' });
        assert.equal(answer.ok, true);
        assert.equal(opened.length, 1);
        assert.match(opened[0].url, /^https:\/\/engine\.test\/#report\?kind=problem&details=/);
    });

    await t.test('and never from a sensor, which runs in somebody else\'s page', async () => {
        const { onMessage, opened } = worker();
        const answer = await ask(onMessage, { type: 'CERTIMENS_REPORT' },
            { id: EXTENSION_ID, url: 'https://moodle.univ-exemple.fr/mod/assign/view.php?id=7', tab: { id: 4, windowId: 1 } });
        assert.equal(answer, null);
        assert.deepEqual(opened, []);
    });
});
