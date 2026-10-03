// Sending to the engine from the Word add-in (src/agent.js).
//
// What this file covers is not the network but a memory: the add-in remembers that an engine
// refused the extended measurements and then stops sending them. That memory is shared by every
// open document and survives a restart of Word — if nothing clears it, a single refusal is
// enough to make the agent permanently blind to pastes and rhythm, without anyone seeing it: on
// the engine's side, a measurement never sent looks like a measurement the sensor cannot
// take.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clock, load, officeGlobals } from './helpers/sandbox.mjs';

const INTERNALS = ['startPairing', 'pollPairing', 'adoptToken', 'pushItem', 'getState', 'getConfig', 'updatedVersion'];
const PREFIX = 'certimens.';

function fakeStorage(initial = {}) {
    const map = new Map(Object.entries(initial).map(([k, v]) => [PREFIX + k, JSON.stringify(v)]));
    return {
        map,
        getItem: (key) => (map.has(key) ? map.get(key) : null),
        setItem: (key, value) => map.set(key, value),
        removeItem: (key) => map.delete(key),
        read: (key) => (map.has(PREFIX + key) ? JSON.parse(map.get(PREFIX + key)) : undefined),
    };
}

function json(body, { status = 200 } = {}) {
    return {
        ok: status >= 200 && status < 300,
        status,
        statusText: 'status ' + status,
        headers: { get: () => 'application/json' },
        json: () => Promise.resolve(body),
    };
}

// agent loads the shipped script with the globals it expects from its siblings (i18n.js, config)
// and from the browser. `routes` answers one request each; `metrics` is the answer to a
// measurement push, which a test can change between attempts.
function agent({ stored = {}, metrics = () => json(null), devicePoll = () => json({ token: 'api-token' }) } = {}) {
    const time = clock();
    const storage = fakeStorage(stored);
    const calls = [];
    const fetchStub = (url, init) => {
        const body = init.body ? JSON.parse(init.body) : null;
        calls.push({ url, method: init.method, body });
        // No password anywhere: the add-in asks for a code, polls, then reads who the token
        // belongs to. See the pairing section of the agent.
        if (url.endsWith('/api/auth/device')) {
            return Promise.resolve(json({
                device_code: 'device-1', user_code: 'CDFH-JKMN',
                verification_uri: 'https://engine.test/device',
                verification_uri_complete: 'https://engine.test/device?code=CDFH-JKMN',
                expires_in: 600, interval: 5,
            }));
        }
        if (url.endsWith('/api/auth/device/token')) return Promise.resolve(devicePoll());
        if (url.endsWith('/api/auth/me')) return Promise.resolve(json({ email: 'a@b.fr', display_name: 'A B', language: 'fr' }));
        if (url.endsWith('/api/auth/tokens')) return Promise.resolve(json([{ id: 'tok-1', label: 'Complément Word — 2026-10-10' }]));
        if (url.endsWith('/metrics')) return Promise.resolve(metrics(body));
        return Promise.resolve(json({ id: 'engine-1' }));
    };
    const globals = {
        ...officeGlobals(time),
        localStorage: storage,
        fetch: fetchStub,
        crypto: { randomUUID: () => 'runtime-1' },
        t: (key) => key,
        dateLocale: () => 'fr-FR',
        window: { addEventListener: () => {} },
        navigator: { onLine: true },
    };
    return { storage, calls, internals: load(new URL('../src/agent.js', import.meta.url), { globals, expose: INTERNALS }) };
}

test('connecting gives the extended measurements their chance again', async () => {
    // The add-in has met an engine that refused both generations — at some point, on some account.
    const { storage, internals } = agent({ stored: { extendedDropped: 2 } });

    await internals.adoptToken('https://engine.test', 'api-token');

    assert.equal(storage.read('extendedDropped'), 0);
});

test('a memory written before the generations means "everything that existed then"', async () => {
    // Installs updated from an earlier version carry a boolean. Read as 0, they would push the
    // first generation to an engine already known to refuse it, at every single window.
    const { internals } = agent({ stored: { extendedUnsupported: true } });

    assert.equal(internals.getState().extendedDropped, 2);
});

test('pairing asks for no password and keeps the token returned', async () => {
    const { storage, calls, internals } = agent();

    const pairing = await internals.startPairing('https://engine.test');
    assert.equal(pairing.userCode, 'CDFH-JKMN');
    // What the add-in calls itself, shown to the student at the moment they confirm.
    assert.equal(calls[0].body.client, 'pair.clientWord');

    const token = await internals.pollPairing(pairing);
    await internals.adoptToken(pairing.engineUrl, token);

    const config = storage.read('config');
    assert.equal(config.token, 'api-token');
    assert.equal(config.tokenId, 'tok-1');
    assert.equal(config.displayName, 'A B');
    // Nothing resembling a password was ever sent.
    assert.ok(!calls.some((call) => call.body && 'password' in call.body));
});

test('as long as nobody has confirmed, pairing answers "not yet" rather than an error', async () => {
    const { internals } = agent({
        devicePoll: () => json({ code: 'device_authorization_pending', error: 'not yet' }, { status: 400 }),
    });

    const pairing = await internals.startPairing('https://engine.test');

    // null, not a throw: the add-in keeps asking. A refusal that is not "not yet" — an expired
    // code, a refusal — does throw, and the pane shows it.
    assert.equal(await internals.pollPairing(pairing), null);
});

test('a pairing polled too often waits longer, it does not give up', async () => {
    // A 429 comes from the rate limiter, not from the exchange: two students pairing from the
    // same institution address are enough to hit it. Reading it as a failure would drop a code
    // its owner is about to confirm.
    const { internals } = agent({ devicePoll: () => json({ error: 'too many requests' }, { status: 429 }) });

    const pairing = await internals.startPairing('https://engine.test');
    const interval = pairing.interval;

    assert.equal(await internals.pollPairing(pairing), null);
    // And the next attempt waits longer, as RFC 8628 requires.
    assert.ok(pairing.interval > interval);
});

test('a refused pairing is told in the student\'s language', async () => {
    // The engine answers in English, its only language. This is the one moment the student is
    // waiting in front of a screen: the sentence they read must say what happened.
    const { internals } = agent({
        devicePoll: () => json({ code: 'device_denied', error: 'this authorization was refused' }, { status: 401 }),
    });

    const pairing = await internals.startPairing('https://engine.test');

    await assert.rejects(() => internals.pollPairing(pairing), (err) => err.message === 'pair.denied');
});

// The window of one submission, as the add-in queues it.
const WINDOW = {
    documentId: 'doc1',
    documentName: 'Mémoire.docx',
    period: { start: '2026-10-09T08:00:00.000Z', end: '2026-10-09T08:00:02.000Z' },
    values: { keystrokes_total: 5, focus_losses: 1, injected_chars_max: 300 },
};

const PAIRED = { engineIds: { doc1: 'engine-1' }, config: { engineUrl: 'https://engine.test', token: 'api-token' } };

test('an engine that refuses one measurement type loses only one generation at a time', async () => {
    // The extended metrics arrived in two batches, and a deployed engine may know the first and
    // ignore the second. Dropping them all on the first refusal would take away measurements it
    // can read, and nobody would see it: on the engine's side, a measurement never sent looks
    // like a measurement the sensor cannot take.
    const { storage, calls, internals } = agent({
        stored: PAIRED,
        // This engine reads `focus_losses` (first generation) but not `injected_chars_max`
        // (second): it refuses as long as the second one is there.
        metrics: (body) => (body.metrics.some((m) => m.type === 'injected_chars_max')
            ? json({ code: 'metric_type_unknown', error: 'unknown metric type' }, { status: 400 })
            : json(null)),
    });

    await internals.pushItem(internals.getConfig(), internals.getState(), WINDOW);

    assert.equal(storage.read('extendedDropped'), 1);
    // The window goes again without the second generation, and the first is still there.
    const sent = calls.filter((c) => c.url.endsWith('/metrics')).at(-1).body.metrics;
    assert.deepEqual(sent.map((m) => m.type).sort(), ['focus_losses', 'keystrokes_total']);
});

test('an engine that knows no generation drops them all, and nothing more', async () => {
    const { storage, calls, internals } = agent({
        stored: PAIRED,
        metrics: (body) => (body.metrics.length > 1
            ? json({ code: 'metric_type_unknown', error: 'unknown metric type' }, { status: 400 })
            : json(null)),
    });

    await internals.pushItem(internals.getConfig(), internals.getState(), WINDOW);

    assert.equal(storage.read('extendedDropped'), 2);
    const sent = calls.filter((c) => c.url.endsWith('/metrics')).at(-1).body.metrics;
    assert.deepEqual(sent.map((m) => m.type), ['keystrokes_total']);
});

test('the key order of a measurement is not free', async (t) => {
    // A measurement body has an exact shape, and the engine accepts only two: a key inserted
    // elsewhere, or `offline` always sent, steps out of it. The three other agents hold that
    // order at home; this one held it nowhere.
    await t.test('{type, value, period}, and `offline` last when it is true', async () => {
        const { calls, internals } = agent({ stored: PAIRED });

        await internals.pushItem(internals.getConfig(), internals.getState(), WINDOW);
        await internals.pushItem(internals.getConfig(), internals.getState(), { ...WINDOW, offline: true });

        const sent = calls.filter((c) => c.url.endsWith('/metrics')).flatMap((c) => c.body.metrics);
        const orders = sent.map((m) => Object.keys(m).join(','));
        assert.deepEqual([...new Set(orders)].sort(),
            ['type,value,period', 'type,value,period,offline'].sort());
    });

    // The period comes from somewhere other than the measurement: the latter is built at every
    // submission, the former comes out of the queue, and hence out of storage, which promises
    // nothing about keeping the key order it was given: read back, it may return `{end, start}`.
    await t.test('{start, end}, whatever the window', async () => {
        const { calls, internals } = agent({ stored: PAIRED });

        await internals.pushItem(internals.getConfig(), internals.getState(),
            { ...WINDOW, period: { end: WINDOW.period.end, start: WINDOW.period.start } });

        const sent = calls.filter((c) => c.url.endsWith('/metrics')).flatMap((c) => c.body.metrics);
        assert.ok(sent.length > 0, 'no measurement sent');
        assert.deepEqual([...new Set(sent.map((m) => Object.keys(m.period).join(',')))], ['start,end']);
    });
});

test('any other 400 leaves the extended measurements in place', async () => {
    // That was the bug: an invalid period was enough to silence focus_losses for good.
    const { storage, internals } = agent({
        stored: PAIRED,
        metrics: () => json({ code: 'metric_period_invalid', error: 'period end must be after its start' },
            { status: 400 }),
    });

    await assert.rejects(() => internals.pushItem(internals.getConfig(), internals.getState(), WINDOW));

    assert.equal(storage.read('extendedDropped'), undefined);
});

// "Certimens has been updated" — the same rule as in the three other agents, against the pane's
// own storage (browser/tests/update.test.mjs, vscode/tests/panel.test.mjs,
// libreoffice/tests/test_engine.py).
//
// The trap is the first opening: a pane that has never written the key has just been installed,
// and reading that as an update would tell every student already using the add-in, the day this
// ships, that they moved to the version they have been running for a month.
test('what the student is told about a new build', async (t) => {
    await t.test('a first opening says nothing, and remembers the build', () => {
        const { internals, storage } = agent();
        assert.equal(internals.updatedVersion('1.5.0'), '');
        assert.equal(storage.read('seenVersion'), '1.5.0');
    });

    await t.test('the build that changed is announced, once', () => {
        const { internals, storage } = agent({ stored: { seenVersion: '1.4.0' } });
        assert.equal(internals.updatedVersion('1.5.0'), '1.5.0');
        assert.equal(storage.read('seenVersion'), '1.5.0');
        // Every document open in this Word shares that storage: the first pane says it, the
        // others stay quiet. That is the right number of times to say it.
        assert.equal(internals.updatedVersion('1.5.0'), '');
    });

    // The pane reads the build from <body data-build>, which the build templates. A page served
    // without it — an old cached copy — must not be announced as a version of its own.
    await t.test('no build, nothing said and nothing written', () => {
        const { internals, storage } = agent({ stored: { seenVersion: '1.4.0' } });
        assert.equal(internals.updatedVersion(''), '');
        assert.equal(storage.read('seenVersion'), '1.4.0');
    });
});
