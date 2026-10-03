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
    'refreshProposedSites', 'REQUESTS', 'engineUrlAllowed'];

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
            remove(key) {
                map.delete(key);
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
    granted = () => true, scripting = true } = {}) {
    const time = clock();
    const onMessage = { fn: null };
    const storage = fakeStorage({ config: { engineUrl: 'https://engine.test', token: 'api-token' }, ...stored });
    const session = fakeStorage();
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
        btoa: (text) => Buffer.from(text, 'binary').toString('base64'),
        // The worker reads addresses the engine sends it: `URL` is what says what it may do
        // with them.
        URL,
        // constants.js is loaded below, with the worker and in the same scope, because that is
        // what importScripts does on Chrome (background.scripts on Firefox) — and because the
        // rule saying where the token may travel lives there and is applied here. i18n.js is
        // stubbed instead: a test reads the key, not the sentence.
        t: (key) => key,
        setLanguage: () => {},
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
                onChanged: { addListener: () => {} },
            },
            runtime: {
                id: EXTENSION_ID,
                // Kept rather than dropped: this listener is the worker's front door, and
                // who it answers is a rule of its own (see "the worker's front door" below).
                onMessage: { addListener: (fn) => { onMessage.fn = fn; } },
                getURL: (path) => EXTENSION_ORIGIN + path,
                // What the extension declares its build from, on every call to the engine.
                getManifest: () => ({ version: MANIFEST_VERSION }),
                onInstalled: { addListener: () => {} },
                onStartup: { addListener: () => {} },
                openOptionsPage: () => {},
            },
            alarms: { create: () => {}, onAlarm: { addListener: () => {} } },
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
                contains: ({ origins }) => Promise.resolve(origins.every(granted)),
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
    return { storage, session, calls, badge, registered, onMessage, internals: load([new URL('../src/constants.js', import.meta.url),
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
            assert.deepEqual([...session.map.keys()], [], code + ': nothing is remembered about that engine');
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
