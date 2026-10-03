// Sending to the engine from the VS Code extension (src/engine.js).
//
// This file is the agent's biggest and the only one that talked to the engine without being
// checked: the offline queue, the `offline` flag, the key order of a measurement and the
// degradation in front of an engine that is too old are reimplemented here, and
// `docs/moteur.md` describes them as binding on all four agents. Until now a single agent held
// them (LibreOffice, which has a fake engine at hand) — and a test that runs one serialiser can
// say nothing about the three others.
//
// The cases are deliberately those of `libreoffice/tests/test_engine.py` and
// `word/tests/agent.test.mjs`: a divergence between the implementations shows up there first.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { Engine, engineUrlAllowed } = require('../src/engine.js');
const { ALLOWED, REFUSED } = await import('./helpers/engine-url.mjs');

// The extended metrics arrived in three generations (docs/mesures.md, "Metrics envoyées"). The
// number is written here rather than read from the shipped code: what the test holds is the
// rule, and nothing is added to the production code to make it observable.
const GENERATIONS = 3;
const { setLanguage } = require('../src/i18n.js');

setLanguage('fr');

function json(body, { status = 200 } = {}) {
    return {
        ok: status >= 200 && status < 300,
        status,
        statusText: 'status ' + status,
        headers: { get: () => 'application/json' },
        json: () => Promise.resolve(body),
    };
}

// What a read from storage returns is not the object that was written there: it is an object
// the host rebuilds, and **nothing promises it keeps the key order**. A queue read back
// alphabetically returns `{start, end}` as `{end, start}`, which is enough to take every
// submission out of the shape the engine accepts — silently, and on honest work. So the double
// does it too: code that relies on the order of what it stored fails here rather than at the
// student's.
function reordered(value) {
    if (Array.isArray(value)) return value.map(reordered);
    if (!value || typeof value !== 'object') return value;
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, reordered(value[key])]));
}

// The extension's global storage and its SecretStorage, reduced to what the client uses.
function fakeStore(initial = {}) {
    const map = new Map(Object.entries(initial));
    return {
        map,
        get: (key, fallback) => (map.has(key) ? reordered(map.get(key)) : fallback),
        set: (key, value) => {
            map.set(key, value);
            return Promise.resolve();
        },
    };
}

/**
 * A fake engine: `routes` answers a call, `metrics` answers a measurement submission and may
 * change its mind from one attempt to the next. `down` cuts the network, like a captive portal
 * or a stopped engine — the agent must never rely on anything but its own attempt.
 */
function engine({ stored = {}, token = 'api-token', metrics = () => json(null), down = false } = {}) {
    const calls = [];
    const store = fakeStore(stored);
    const secrets = new Map(token ? [['token', token]] : []);
    const instance = new Engine({
        store,
        secrets: {
            get: (key) => Promise.resolve(secrets.get(key)),
            set: (key, value) => Promise.resolve(secrets.set(key, value)),
            delete: (key) => Promise.resolve(secrets.delete(key)),
        },
        userAgent: 'Certimens-VSCode/0.0.0 (test)',
        hostLanguage: 'fr',
        schedule: () => 0,
        cancel: () => {},
        fetch: (url, init) => {
            const body = init.body ? JSON.parse(init.body) : null;
            calls.push({ url, method: init.method, body, raw: init.body, headers: init.headers });
            if (down) return Promise.reject(new Error('fetch failed'));
            if (url.endsWith('/api/auth/device')) {
                return Promise.resolve(json({
                    device_code: 'device-1', user_code: 'CDFH-JKMN',
                    verification_uri: 'https://engine.test/device',
                    expires_in: 600, interval: 5,
                }));
            }
            if (url.endsWith('/api/auth/me')) return Promise.resolve(json({ email: 'a@b.fr', display_name: 'A B', language: 'fr' }));
            if (url.endsWith('/api/auth/tokens')) return Promise.resolve(json([{ id: 'tok-1' }]));
            if (url.endsWith('/metrics')) return Promise.resolve(metrics(body));
            return Promise.resolve(json({ id: 'engine-1' }));
        },
    });
    return { instance, calls, store, secrets };
}

const PERIOD = { start: '2026-10-09T08:00:00.000Z', end: '2026-10-09T08:00:02.000Z' };

function window_(values = { keystrokes_total: 5 }) {
    return { documentId: 'vscode:abcd:src/main.go', documentName: 'src/main.go', period: PERIOD, values };
}

const metricsOf = (calls) => calls.filter((c) => c.url.endsWith('/metrics'));

test('the offline queue', async (t) => {
    await t.test('a window waits for the engine to come back rather than being lost', async () => {
        const { instance, store, calls } = engine({ down: true });

        await instance.enqueue(window_());

        assert.equal(store.get('queue', []).length, 1);
        assert.equal(store.get('status', {}).state, 'offline');
        // A single attempt: creating the document already fails, and nothing insists.
        assert.equal(calls.length, 1);
    });

    await t.test('and goes again as soon as the engine answers', async () => {
        const { instance, store } = engine({ stored: { queue: [window_()], status: { state: 'offline' } } });

        await instance.drain();

        assert.deepEqual(store.get('queue', []), []);
        assert.equal(store.get('status', {}).state, 'synced');
    });

    await t.test('a rejected measurement does not block the queue behind it', async () => {
        // A 400 is final: sending it again forever would stop everything behind it.
        const { instance, store } = engine({
            stored: { queue: [window_()] },
            metrics: () => json({ code: 'metric_period_invalid', error: 'invalid period' }, { status: 400 }),
        });

        await instance.drain();

        assert.deepEqual(store.get('queue', []), []);
    });

    await t.test('an interrupted catch-up does not resend what has gone', async () => {
        // Draining the queue no longer writes the queue at every window but a cursor, and what
        // must hold is the property the old write served: a window that has gone never goes
        // again, even if the catch-up is cut in two.
        let sent = 0;
        const { instance, store, calls } = engine({
            stored: { queue: [window_(), window_(), window_()] },
            metrics: () => (++sent === 3 ? Promise.reject(new Error('fetch failed')) : json(null)),
        });

        await instance.drain();
        assert.equal(store.get('queueSent', 0), 2, 'two windows went through');
        assert.equal(store.get('status', {}).state, 'offline');
        assert.equal(instance.state().queue.length, 1, 'a single one is left to send');

        await instance.drain();
        assert.equal(calls.filter((c) => c.url.endsWith('/metrics')).length, 4,
            'the catch-up resends only the third');
        assert.equal(store.get('queue', []).length, 0);
        assert.equal(store.get('queueSent', 0), 0, 'an emptied queue starts over');
    });

    await t.test('a refused token says so, and is not taken for a network failure', async () => {
        const { instance, store } = engine({
            stored: { queue: [window_()] },
            metrics: () => json({ error: 'invalid token' }, { status: 401 }),
        });

        await instance.drain();

        assert.equal(store.get('status', {}).state, 'auth_error');
        assert.equal(store.get('queue', []).length, 1, 'the window stays: the token may come back');
    });
});

test('`offline` describes the window, not the queue', async (t) => {
    await t.test('it is set when queueing, from our own last attempt', async () => {
        // Never navigator.onLine: a captive portal answers the link layer and never the engine,
        // and the extension host does not have that API anyway.
        const { instance, store } = engine({ stored: { status: { state: 'offline' } }, down: true });

        await instance.enqueue(window_());

        assert.equal(store.get('queue', [])[0].offline, true);
    });

    await t.test('a window written while the engine was answering goes out saying nothing', async () => {
        // Even if it then waits for hours: it is not the queue it describes.
        const { instance, store } = engine({ stored: { status: { state: 'synced' } }, down: true });

        await instance.enqueue(window_());

        assert.equal(store.get('queue', [])[0].offline, undefined);
    });
});

test('the key order of a measurement is not free', async (t) => {
    // The engine recognises an agent's serialiser by the order of its keys, and it knows only
    // two. A key inserted elsewhere, an indented body, or `offline` always sent: each one steps
    // out of it — and what the engine does with a body out of shape is documented on its side.
    await t.test('{type, value, period}, and `offline` last when it is true', async () => {
        const { instance, calls } = engine({
            stored: { queue: [window_(), { ...window_({ keystrokes_total: 2 }), offline: true }] },
        });

        await instance.drain();

        const orders = metricsOf(calls).flatMap((call) => call.body.metrics.map((m) => Object.keys(m).join(',')));
        assert.deepEqual([...new Set(orders)].sort(),
            ['type,value,period', 'type,value,period,offline'].sort());
    });

    // `reason` comes after `offline`, and a window queued before this agent knew how to say it
    // omits the key rather than sending it empty — an empty string is a value outside the
    // engine's vocabulary, a missing key is an agent that did not say.
    await t.test('`reason` last, and absent rather than empty', async () => {
        const { instance, calls } = engine({
            stored: {
                queue: [
                    { ...window_(), flush: 'save' },
                    { ...window_({ keystrokes_total: 2 }), offline: true, flush: 'away' },
                    window_({ keystrokes_total: 3 }),
                ],
            },
        });

        await instance.drain();

        const metrics = metricsOf(calls).flatMap((call) => call.body.metrics);
        assert.deepEqual([...new Set(metrics.map((m) => Object.keys(m).join(',')))].sort(), [
            'type,value,period',
            'type,value,period,offline,reason',
            'type,value,period,reason',
        ]);
    });

    // The period counts as much as the measurement carrying it, and it comes from elsewhere:
    // the measurement is built here at every submission, the period comes out of the queue —
    // hence out of storage, which returns its keys in whatever order it likes (see `reordered`).
    // It is the one of the two orders a test on an object built on the spot could not see.
    await t.test('{start, end}, even for a window read back from the queue', async () => {
        const { instance, calls } = engine({
            stored: { queue: [window_(), { ...window_({ keystrokes_total: 2 }), offline: true }] },
        });

        await instance.drain();

        const periods = metricsOf(calls).flatMap((call) => call.body.metrics.map((m) => Object.keys(m.period).join(',')));
        assert.ok(periods.length > 0, 'no measurement sent');
        assert.deepEqual([...new Set(periods)], ['start,end']);
    });

    await t.test('the body goes out without indentation', async () => {
        const { instance, calls } = engine({ stored: { queue: [window_()] } });

        await instance.drain();

        assert.ok(!metricsOf(calls)[0].raw.includes('\n'), 'an indented body looks like no agent');
    });

    await t.test('and always with the User-Agent that names this agent', async () => {
        // Node adds no header of its own that would give it away: without this one, every
        // submission would be filed as "unknown client" on the document.
        const { instance, calls } = engine({ stored: { queue: [window_()] } });

        await instance.drain();

        assert.match(metricsOf(calls)[0].headers['User-Agent'], /^Certimens-VSCode\//);
    });
});

test('the measurements the engine does not know', async (t) => {
    const extended = () => window_({ keystrokes_total: 5, focus_losses: 1, injected_chars_max: 300,
        lexical_hesitations: 2 });

    await t.test('a refusal drops only one generation at a time', async () => {
        // A deployed engine may know the older generations and ignore the newest. Dropping them
        // all on the first refusal would take away measurements it can read, and nobody would
        // see it: on the engine's side, a measurement never sent looks like a measurement the
        // sensor cannot take.
        const { instance, store, calls } = engine({
            stored: { queue: [extended()] },
            // This engine reads the two older generations but not `lexical_hesitations`:
            // it refuses as long as that one is there.
            metrics: (body) => (body.metrics.some((m) => m.type === 'lexical_hesitations')
                ? json({ code: 'metric_type_unknown', error: 'unknown metric type' }, { status: 400 })
                : json(null)),
        });

        await instance.drain();

        assert.equal(store.get('extendedDropped', 0), 1);
        assert.deepEqual(metricsOf(calls).at(-1).body.metrics.map((m) => m.type).sort(),
            ['focus_losses', 'injected_chars_max', 'keystrokes_total']);
    });

    await t.test('an engine that knows none of them drops them all', async () => {
        const { instance, store, calls } = engine({
            stored: { queue: [extended()] },
            metrics: (body) => (body.metrics.length > 1
                ? json({ code: 'metric_type_unknown', error: 'unknown metric type' }, { status: 400 })
                : json(null)),
        });

        await instance.drain();

        assert.equal(store.get('extendedDropped', 0), GENERATIONS);
        assert.deepEqual(metricsOf(calls).at(-1).body.metrics.map((m) => m.type), ['keystrokes_total']);
    });

    await t.test('any other 400 leaves them in place', async () => {
        // That was the bug: an invalid period was enough to silence focus_losses for good.
        const { instance, store } = engine({
            stored: { queue: [extended()] },
            metrics: () => json({ code: 'metric_period_invalid', error: 'invalid period' }, { status: 400 }),
        });

        await instance.drain();

        assert.equal(store.get('extendedDropped', 0), 0);
    });

    await t.test('a memory written before the generations means "everything that existed then"', async () => {
        // Updated installations carry a boolean. Read as 0, it would push again at every window
        // a generation this engine has already refused.
        const { instance } = engine({ stored: { extendedUnsupported: true } });

        assert.equal(instance.state().extendedDropped, GENERATIONS);
    });

    await t.test('and pairing gives them their chance again', async () => {
        // Without this the refusal is final: a single submission to an engine that is too old,
        // and the agent never sends those measurements again, even once the engine is up to
        // date and even after a change of account.
        const { instance, store } = engine({ stored: { extendedDropped: 2 } });

        await instance.adoptToken('https://engine.test', 'api-token');

        assert.equal(store.get('extendedDropped', 0), 0);
    });
});

test('the passed deadline', async (t) => {
    await t.test('a refused rename is held as synced', async () => {
        // The copy is frozen: that rename will not go through. Retrying it every minute would
        // turn the sending state red for something nobody has a hand on.
        const { instance, store, calls } = engine({
            stored: {
                engineIds: { doc1: 'engine-1' },
                names: { doc1: 'src/rendu.go' },
                syncedNames: { doc1: 'src/main.go' },
            },
        });
        instance.fetch = () => Promise.resolve(json(
            { code: 'deadline_passed', error: "this assignment's deadline has passed" }, { status: 403 }));

        await instance.drain();

        assert.equal(store.get('status', {}).state, 'synced');
        assert.equal(store.get('syncedNames', {}).doc1, 'src/rendu.go');
        calls.length = 0;
        await instance.drain();
        assert.deepEqual(calls, [], 'nothing is retried');
    });

    await t.test('and it is told to the student in their language', async () => {
        // The engine only answers in English; the agent rewrites the refusals the student reads.
        const { instance } = engine({});
        instance.fetch = () => Promise.resolve(json(
            { code: 'deadline_passed', error: "this assignment's deadline has passed" }, { status: 403 }));

        await assert.rejects(() => instance.submitDocument('engine-1', 'a1'),
            (err) => err.code === 'deadline_passed' && !/deadline has passed/.test(err.message));
    });
});

test('pairing', async (t) => {
    await t.test('asks for no password and keeps the token returned', async () => {
        const { instance, calls, secrets, store } = engine({ token: null });

        const pairing = await instance.startPairing('https://engine.test');
        assert.equal(pairing.userCode, 'CDFH-JKMN');
        await instance.adoptToken(pairing.engineUrl, 'api-token');

        assert.equal(secrets.get('token'), 'api-token');
        assert.equal(store.get('config', {}).tokenId, 'tok-1');
        assert.ok(!calls.some((call) => call.body && 'password' in call.body));
    });

    await t.test('polled too often, it waits longer instead of giving up', async () => {
        // A 429 comes from the rate limiter, not from the exchange: a whole institution behind
        // the same exit hits it. Reading it as a failure would drop a code its owner is about
        // to confirm.
        const { instance } = engine({ token: null });
        const pairing = await instance.startPairing('https://engine.test');
        const interval = pairing.interval;
        instance.fetch = () => Promise.resolve(json({ error: 'too many requests' }, { status: 429 }));

        assert.equal(await instance.pollPairing(pairing), null);
        assert.ok(pairing.interval > interval, 'five seconds more, as RFC 8628 requires');
    });
});

// --- WHERE THE TOKEN MAY TRAVEL ---

test('the addresses an engine may be reached at', async (t) => {
    // The same table as the three other agents (tests/helpers/engine-url.mjs): `make check`
    // compares the four patterns character for character, and this says whether the pattern is
    // the right one.
    await t.test('https anywhere, http only where the request cannot leave the building', () => {
        for (const url of ALLOWED) assert.equal(engineUrlAllowed(url), true, url);
        for (const url of REFUSED) assert.equal(engineUrlAllowed(url), false, url);
    });

    await t.test('and the client refuses to call one of the others', async () => {
        const { instance, calls } = engine({ token: null });

        await assert.rejects(() => instance.startPairing('http://engine.example.fr'),
            (err) => err.code === 'engine_url_refused');
        assert.deepEqual(calls, [], 'nothing left the machine');
    });

    await t.test('including one already in the configuration', async () => {
        // An address accepted before this rule existed: the queue stops rather than keep
        // pushing in the clear, and the panel says why.
        const { instance, calls, store } = engine({
            stored: { config: { engineUrl: 'http://engine.example.fr' }, queue: [window_()] },
        });

        await instance.drain();

        assert.deepEqual(calls, []);
        assert.equal(store.get('status').state, 'offline');
        assert.equal(instance.state().queue.length, 1, 'the window is still waiting');
    });
});
