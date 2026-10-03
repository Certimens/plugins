// Sending to the engine from the browser extension (src/background.js).
//
// This is the repository's biggest file, and the only one of this agent that talked to the
// engine without being checked: the offline queue, the `offline` flag, the key order of a
// measurement, the degradation in front of an engine that is too old and the rename refused
// after the deadline are reimplemented here, and `docs/moteur.md` describes them as binding on
// all four agents.
//
// The cases are deliberately those of `libreoffice/tests/test_engine.py`,
// `word/tests/agent.test.mjs` and `vscode/tests/engine.test.mjs`: a divergence between the four
// implementations shows up there first.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clock, load } from './helpers/sandbox.mjs';

const INTERNALS = ['enqueue', 'drain', 'pushItem', 'toMetrics', 'getState', 'getConfig',
    'adoptToken', 'syncTitles', 'startPairing', 'pollPairing', 'syncSiteScripts', 'setSites',
    'refreshProposedSites', 'REQUESTS'];

// The extended metrics arrived in two generations (docs/mesures.md, "Metrics envoyées"). The
// number is written here rather than read from the shipped code: what the test holds is the
// rule, and nothing is added to the production code to make it observable.
const GENERATIONS = 2;

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
function worker({ stored = {}, metrics = () => json(null), routes = () => null, down = false,
    granted = () => true, scripting = true } = {}) {
    const time = clock();
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
        // constants.js and i18n.js are loaded by importScripts on Chrome (by background.scripts
        // on Firefox): here the key is enough for the dictionary, and the two constants are the
        // ones the pages see too.
        DEFAULT_ENGINE_URL: 'https://monespace.certimens.fr',
        GOOGLE_EXPORT_ORIGINS: ['https://docs.google.com/document/*', 'https://*.googleusercontent.com/*'],
        t: (key) => key,
        setLanguage: () => {},
        fetch(url, init = {}) {
            const body = init.body ? JSON.parse(init.body) : null;
            calls.push({ url, method: init.method, body, raw: init.body });
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
                onMessage: { addListener: () => {} },
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
    return { storage, calls, badge, registered, internals: load(new URL('../src/background.js', import.meta.url), { globals, expose: INTERNALS }) };
}

const PERIOD = { start: '2026-10-09T08:00:00.000Z', end: '2026-10-09T08:00:02.000Z' };

function window_(values = { keystrokes_total: 5 }) {
    return { documentId: 'gdocs:AbC', documentName: 'Mémoire', period: PERIOD, values };
}

const metricsOf = (calls) => calls.filter((c) => c.url.endsWith('/metrics'));

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
            metrics: () => json({ code: 'metric_period_invalid', error: 'invalid period' }, { status: 400 }),
        });

        await internals.drain();

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
});

test('the key order of a measurement is not free', async (t) => {
    // The engine recognises an agent's serialiser by the order of its keys, and it knows only
    // two. A key inserted elsewhere, an indented body, or `offline` always sent: each one steps
    // out of it — and what the engine does with a body out of shape is documented on its side.
    await t.test('{type, value, period}, and `offline` last when it is true', async () => {
        const { internals, calls } = worker({
            stored: {
                engineIds: { 'gdocs:AbC': 'engine-1' },
                queue: [window_(), { ...window_({ keystrokes_total: 2 }), offline: true }],
            },
        });

        await internals.drain();

        const orders = metricsOf(calls).flatMap((call) => call.body.metrics.map((m) => Object.keys(m).join(',')));
        assert.deepEqual([...new Set(orders)].sort(),
            ['type,value,period', 'type,value,period,offline'].sort());
    });

    // The period counts as much as the measurement carrying it, and it comes from elsewhere:
    // the measurement is built here at every submission, the period comes out of the queue —
    // hence out of storage, which returns its keys in whatever order it likes (see `reordered`).
    // It is the one of the two orders a test on an object built on the spot could not see.
    await t.test('{start, end}, even for a window read back from the queue', async () => {
        const { internals, calls } = worker({
            stored: {
                engineIds: { 'gdocs:AbC': 'engine-1' },
                queue: [window_(), { ...window_({ keystrokes_total: 2 }), offline: true }],
            },
        });

        await internals.drain();

        const periods = metricsOf(calls).flatMap((call) => call.body.metrics.map((m) => Object.keys(m.period).join(',')));
        assert.ok(periods.length > 0, 'no measurement sent');
        assert.deepEqual([...new Set(periods)], ['start,end']);
    });

    await t.test('the body goes out without indentation', async () => {
        const { internals, calls } = worker({
            stored: { engineIds: { 'gdocs:AbC': 'engine-1' }, queue: [window_()] },
        });

        await internals.drain();

        assert.ok(!metricsOf(calls)[0].raw.includes('\n'), 'an indented body looks like no agent');
    });
});

test('the measurements the engine does not know', async (t) => {
    const paired = (queue) => ({ engineIds: { 'gdocs:AbC': 'engine-1' }, queue });
    const extended = () => window_({ keystrokes_total: 5, focus_losses: 1, injected_chars_max: 300 });

    await t.test('a refusal drops only one generation at a time', async () => {
        // A deployed engine may know the first generation and ignore the second. Dropping them
        // all on the first refusal would take away measurements it can read, and nobody would
        // see it: on the engine's side, a measurement never sent looks like a measurement the
        // sensor cannot take.
        const { internals, storage, calls } = worker({
            stored: paired([extended()]),
            metrics: (body) => (body.metrics.some((m) => m.type === 'injected_chars_max')
                ? json({ code: 'metric_type_unknown', error: 'unknown metric type' }, { status: 400 })
                : json(null)),
        });

        await internals.drain();

        assert.equal(storage.read('extendedDropped'), 1);
        assert.deepEqual(metricsOf(calls).at(-1).body.metrics.map((m) => m.type).sort(),
            ['focus_losses', 'keystrokes_total']);
    });

    await t.test('an engine that knows none of them drops them all', async () => {
        const { internals, storage, calls } = worker({
            stored: paired([extended()]),
            metrics: (body) => (body.metrics.length > 1
                ? json({ code: 'metric_type_unknown', error: 'unknown metric type' }, { status: 400 })
                : json(null)),
        });

        await internals.drain();

        assert.equal(storage.read('extendedDropped'), GENERATIONS);
        assert.deepEqual(metricsOf(calls).at(-1).body.metrics.map((m) => m.type), ['keystrokes_total']);
    });

    await t.test('any other 400 leaves them in place', async () => {
        // That was the bug: an invalid period was enough to silence focus_losses for good.
        const { internals, storage } = worker({
            stored: paired([extended()]),
            metrics: () => json({ code: 'metric_period_invalid', error: 'invalid period' }, { status: 400 }),
        });

        await internals.drain();

        assert.equal(storage.read('extendedDropped'), undefined);
    });

    await t.test('a memory written before the generations means "everything that existed then"', async () => {
        // Updated installations carry a boolean. Read as 0, it would push again at every window
        // a generation this engine has already refused.
        const { internals } = worker({ stored: { extendedUnsupported: true } });

        assert.equal((await internals.getState()).extendedDropped, GENERATIONS);
    });

    await t.test('and pairing gives them their chance again', async () => {
        // Without this the refusal is final: a single submission to an engine that is too old,
        // and the agent never sends those measurements again, even once the engine is up to
        // date and even after a change of account.
        const { internals, storage } = worker({ stored: { extendedDropped: 2 } });

        await internals.adoptToken('https://engine.test', 'api-token');

        assert.equal(storage.read('extendedDropped'), 0);
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
