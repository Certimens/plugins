// Sending to the engine from the VS Code extension (src/engine.js).
//
// This file is the agent's biggest: the offline queue, the `offline` flag, the key order of a
// measurement body and what is done with a refusal are reimplemented here, and `docs/moteur.md`
// describes them as binding on all four agents — a test that runs one serialiser can say
// nothing about the three others.
//
// The cases are deliberately those of `libreoffice/tests/test_engine.py` and
// `word/tests/agent.test.mjs`: a divergence between the implementations shows up there first.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { Engine, HttpError, engineUrlAllowed, TELEMETRY_EVENTS, TELEMETRY_FLUSH_MS, TELEMETRY_MAX_COUNT, TELEMETRY_MAX_FAULTS, TELEMETRY_MAX_FRAMES, faultOf, REPORT_FRAGMENT, REPORT_KEYS } = require('../src/engine.js');
const { ALLOWED, REFUSED } = await import('./helpers/engine-url.mjs');

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
// alphabetically returns `{seq, at, mono}` as `{at, mono, seq}`, which is enough to take every
// submission out of the shape the engine expects — silently, and on honest work. So the double
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
        // A Memento forgets a key that is set to nothing.
        set: (key, value) => {
            if (value === undefined) map.delete(key);
            else map.set(key, value);
            return Promise.resolve();
        },
    };
}

/**
 * A fake engine: `routes` answers a call, `metrics` answers a measurement submission and may
 * change its mind from one attempt to the next. `down` cuts the network, like a captive portal
 * or a stopped engine — the agent must never rely on anything but its own attempt.
 */
function engine({ stored = {}, shared, queue, token = 'api-token', metrics = () => json(null), rename, down = false, version = '1.4.2', telemetry = () => answer(204), now } = {}) {
    const calls = [];
    // One store, unless the test is about what several windows share: `shared` is then the
    // editor's global state, and `stored` this workspace's own.
    const store = shared || fakeStore(stored);
    const local = shared ? fakeStore(stored) : undefined;
    const secrets = new Map(token ? [['token', token]] : []);
    const instance = new Engine({
        store,
        local,
        // The host's queue store (a FileQueue below); the workspace's Memento when none is given.
        queue,
        secrets: {
            get: (key) => Promise.resolve(secrets.get(key)),
            set: (key, value) => Promise.resolve(secrets.set(key, value)),
            delete: (key) => Promise.resolve(secrets.delete(key)),
        },
        userAgent: 'Certimens-VSCode/0.0.0 (test)',
        version,
        hostLanguage: 'fr',
        schedule: () => 0,
        cancel: () => {},
        now,
        fetch: (url, init) => {
            const body = init.body ? JSON.parse(init.body) : null;
            calls.push({ url, method: init.method, body, raw: init.body, headers: init.headers });
            if (down) return Promise.reject(new Error('fetch failed'));
            if (url.endsWith('/api/plugins/telemetry')) return telemetry(body);
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
            if (rename && init.method === 'PUT') return Promise.resolve(rename(body));
            return Promise.resolve(json({ id: 'engine-1' }));
        },
    });
    return { instance, calls, store, local: local || store, secrets };
}

// A bodiless answer, the way the engine says 204.
function answer(status) {
    return Promise.resolve({
        ok: status >= 200 && status < 300, status, statusText: 'status ' + status,
        headers: { get: () => '' }, json: () => Promise.reject(new Error('no body')),
    });
}

const SESSION = 'p3Vq0hJmR2aXw9LkT1yZ5g';

// A queue entry as the sensor hands it over (src/sensor.js, `flush`): the file it measured, the
// session, and the window in the shape it leaves in.
function sealed(seq = 0, { session = SESSION, offline, documentId = 'vscode:abcd:src/main.go', ...window } = {}) {
    return {
        documentId,
        documentName: 'src/main.go',
        session,
        window: {
            seq,
            at: Date.parse('2026-10-09T08:00:00.000Z') + seq * 10_000,
            mono: seq * 10_000,
            ms: 2000,
            why: 'idle',
            active: 1800,
            runs: [['gap', 5200], ['type', 5, 1800], ['paste', 40]],
            counts: { corrections: 1, reformulations: 0, revisions: 0, jumps: 2, exits: 0, back_keys: 0, back_chars: 0 },
            flight: { med: 120, mad: 20, bins: [0, 0, 0, 0, 1, 2, 1] },
            text: seq === 0 ? { len: 345 } : { len: 345, since: seq - 1, at: 300, cut: 0, add: 45, kept: 0 },
            sum: { keys: 5 * (seq + 1), chars: 40 * (seq + 1), pastes: seq + 1 },
            ...window,
        },
        ...(offline ? { offline: true } : {}),
    };
}

const window_ = () => sealed(0);

const metricsOf = (calls) => calls.filter((c) => c.url.endsWith('/metrics'));

// The engine stores what measured a window and flags a push that names nothing, so this header
// is not an extra: omitting it would raise a signal on every honest window of every student
// using this extension, and a signal that fires on everything tells a reader nothing.
test('every call names this agent and its build', async (t) => {
    await t.test('on the push, in the shape the engine parses', async () => {
        const { instance, calls } = engine();

        await instance.enqueue(window_());

        const pushed = metricsOf(calls);
        assert.ok(pushed.length, 'no measurement sent');
        for (const call of pushed) {
            assert.equal(call.headers['X-Certimens-Agent'], 'vscode/1.4.2');
        }
        // Said beside the User-Agent, not instead of it: that one is what the engine reads to
        // recognise a client family, and the two are checked against each other.
        assert.match(pushed[0].headers['User-Agent'], /^Certimens-VSCode\//);
    });

    await t.test('and on every other call, from one place', async () => {
        const { instance, calls } = engine();

        await instance.enqueue(window_());

        assert.ok(calls.every((c) => c.headers['X-Certimens-Agent']));
    });

    // An extension never packaged has no build to claim. The kind alone is accepted by the
    // engine: refusing the whole declaration over the part it does not know would throw away
    // the part that is true.
    await t.test('a build that names itself nothing sends the kind alone', async () => {
        const { instance, calls } = engine({ version: '' });

        await instance.enqueue(window_());

        assert.equal(metricsOf(calls)[0].headers['X-Certimens-Agent'], 'vscode');
    });
});

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
            metrics: () => json({ code: 'invalid_body', error: 'invalid body' }, { status: 400 }),
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

// --- THE MEASUREMENT BODY ---
//
// There is one body, and it has no version: the envelope names the session, and each window is
// what the sensor sealed. What is held here is what the engine reads the serialiser by — the
// key order at every level, what is left out, how a queue is caught up — and that no refusal
// makes this agent send anything else.

// The keys of a JSON text in the order they are written, level by level.
function keyOrder(value, path = '', found = {}) {
    if (Array.isArray(value)) {
        for (const entry of value) keyOrder(entry, `${path}[]`, found);
    } else if (value && typeof value === 'object') {
        (found[path || '.'] ||= new Set()).add(Object.keys(value).join(','));
        for (const [key, entry] of Object.entries(value)) keyOrder(entry, `${path}.${key}`, found);
    }
    return Object.fromEntries(Object.entries(found).map(([key, orders]) => [key, [...orders]]));
}

test('the body of a measurement', async (t) => {
    await t.test('has the key order of the contract at every level, out of a queue read back in disorder', async () => {
        const { instance, calls } = engine({ stored: { queue: [sealed(3)] } });

        await instance.drain();

        const [call] = metricsOf(calls);
        assert.deepEqual(keyOrder(call.body), {
            '.': ['session,sent,windows'],
            '.windows[]': ['seq,at,mono,ms,why,active,runs,counts,flight,text,sum'],
            '.windows[].counts': ['corrections,reformulations,revisions,jumps,exits,back_keys,back_chars'],
            '.windows[].flight': ['med,mad,bins'],
            '.windows[].text': ['len,since,at,cut,add,kept'],
            '.windows[].sum': ['keys,chars,pastes'],
        });
        assert.equal(call.body.session, SESSION);
        assert.deepEqual(call.body.windows[0], sealed(3).window, 'the window leaves as it was sealed');
        assert.ok(!call.raw.includes('\n') && !call.raw.includes(': '), 'never indented');
    });

    await t.test('names no version, and holds nothing the engine derives from the runs', async () => {
        const { instance, calls } = engine({ stored: { queue: [sealed(0)] } });

        await instance.drain();

        const { raw, body } = metricsOf(calls)[0];
        assert.equal('v' in body, false);
        for (const gone of ['metrics', 'counters', 'timeline', 'totals', 'period', 'keystrokes', 'paste_events']) {
            assert.ok(!raw.includes(`"${gone}`), gone);
        }
    });

    await t.test('nothing of the queue entry itself travels: no path, no key the body does not have', async () => {
        const entry = sealed(0);
        entry.window.note = 'left by something else';
        entry.window.counts.something_else = 5;
        const { instance, calls } = engine({ stored: { queue: [entry] } });

        await instance.drain();

        const { raw } = metricsOf(calls)[0];
        // The engine refuses a body holding a key it does not know: none is forwarded.
        assert.ok(!raw.includes('main.go') && !raw.includes('note') && !raw.includes('something_else'));
    });

    // A kind of run is the sensor's word, copied as it is: a `suggest` — a block the editor or an
    // assistant put down at the writer's command — leaves in place, between its neighbours, and
    // a window whose only block is one is a window like any other, out of the queue too.
    await t.test('carries a `suggest` run where it was, and a window holding one is sendable', async () => {
        const runs = [['type', 6, 900], ['suggest', 36], ['suggest', 37], ['paste', 40], ['gap', 3500], ['type', 1, 0]];
        const alone = sealed(1, { runs: [['suggest', 36]], sum: { keys: 6, chars: 40, pastes: 1 } });
        const { instance, calls, store } = engine({ stored: { queue: [sealed(0, { runs, offline: true }), { ...alone, offline: true }] } });

        await instance.drain();

        const [call] = metricsOf(calls);
        assert.deepEqual(call.body.windows.map((window) => window.runs), [runs, [['suggest', 36]]]);
        assert.deepEqual(keyOrder(call.body)['.windows[]'], ['seq,at,mono,ms,why,offline,active,runs,counts,flight,text,sum']);
        assert.deepEqual(store.get('queue', []), [], 'both sent, neither dropped');
    });

    await t.test('`offline` sits between `why` and `active`, and only when it is true', async () => {
        const { instance, calls } = engine({ stored: { queue: [sealed(0, { offline: true })] } });

        await instance.drain();

        assert.equal(Object.keys(metricsOf(calls)[0].body.windows[0]).join(','),
            'seq,at,mono,ms,why,offline,active,runs,counts,flight,text,sum');
    });

    await t.test('a block the window does not carry is left out, never sent empty', async () => {
        const entry = sealed(0);
        delete entry.window.flight;
        delete entry.window.text;
        const { instance, calls } = engine({ stored: { queue: [entry] } });

        await instance.drain();

        const { raw, body } = metricsOf(calls)[0];
        assert.equal(Object.keys(body.windows[0]).join(','), 'seq,at,mono,ms,why,active,runs,counts,sum');
        assert.ok(!raw.includes('null') && !raw.includes('{}'));
    });

    await t.test('the text is its size alone, or its size and the whole span', async () => {
        const { instance, calls } = engine({
            stored: {
                queue: [
                    sealed(0),
                    sealed(1, { text: { len: 9400, since: 0, at: 3, cut: 9000, add: 9100 } }),
                    // A span is never sent in part: what is left of one is the size.
                    sealed(2, { text: { len: 9400, since: 1, at: 3 } }),
                ],
            },
        });

        await instance.drain();

        assert.deepEqual(metricsOf(calls).map((call) => Object.keys(call.body.windows[0].text).join(',')),
            ['len', 'len,since,at,cut,add', 'len']);
    });

    await t.test('`sent` is the clock at the attempt, written again for each one', async () => {
        let attempts = 0;
        const { instance, calls } = engine({
            stored: { queue: [sealed(0)] },
            metrics: () => (++attempts === 1 ? Promise.reject(new Error('fetch failed')) : json(null)),
        });

        const before = Date.now();
        await instance.drain();
        await new Promise((resolve) => setTimeout(resolve, 5));
        await instance.drain();

        const [first, second] = metricsOf(calls).map((call) => call.body.sent);
        assert.ok(Number.isInteger(first) && first >= before, 'milliseconds since the epoch');
        assert.ok(second > first, 'a retry is not dated by the first attempt');
        assert.deepEqual(metricsOf(calls)[1].body.windows, metricsOf(calls)[0].body.windows,
            'and nothing else of the window moves');
    });

    await t.test('and always goes with the User-Agent that names this agent', async () => {
        // Node adds no header of its own that would give it away: without this one, every
        // submission would be filed as "unknown client" on the document.
        const { instance, calls } = engine({ stored: { queue: [sealed(0)] } });

        await instance.drain();

        assert.match(metricsOf(calls)[0].headers['User-Agent'], /^Certimens-VSCode\//);
    });
});

test('a queue entry that is not a window of this body is dropped, not sent', async (t) => {
    // There is one body and nothing to rebuild another shape into: the engine would refuse it,
    // and resending it every minute would hold up everything behind it.
    const strangers = {
        'an entry that carries no window': {
            documentId: 'vscode:abcd:src/main.go', documentName: 'src/main.go', session: SESSION,
            values: { something: 5 },
        },
        'a window without its runs': sealed(0, { runs: [] }),
        'a window that does not say why it closed': sealed(0, { why: undefined }),
        'a window without its sums': sealed(0, { sum: { keys: 5 } }),
        'a window of no session': sealed(0, { session: '' }),
        'nothing at all': null,
    };

    for (const [name, stranger] of Object.entries(strangers)) {
        await t.test(name, async () => {
            const { instance, calls, store } = engine({ stored: { queue: [stranger, sealed(1)] } });

            await instance.drain();

            assert.deepEqual(metricsOf(calls).map((call) => call.body.windows.map((w) => w.seq)), [[1]],
                'the window behind it leaves, alone');
            assert.deepEqual(store.get('queue', []), []);
            assert.equal(store.get('status', {}).state, 'synced');
        });
    }

    await t.test('and it creates no document on the engine', async () => {
        const { instance, calls } = engine({ stored: { queue: [strangers['an entry that carries no window']] } });

        await instance.drain();

        assert.deepEqual(calls, []);
    });
});

test('a queue caught up after an outage leaves in batches', async (t) => {
    const backlog = (count, options = {}) => Array.from({ length: count }, (_, seq) => sealed(seq, { offline: true, ...options }));

    await t.test('64 windows of one session at most, in the order they were sealed', async () => {
        const { instance, calls, store } = engine({ stored: { queue: backlog(130) } });

        await instance.drain();

        const batches = metricsOf(calls).map((call) => call.body.windows.map((w) => w.seq));
        assert.deepEqual(batches.map((batch) => batch.length), [64, 64, 2]);
        assert.deepEqual(batches.flat(), Array.from({ length: 130 }, (_, seq) => seq));
        assert.ok(metricsOf(calls).every((call) => call.body.windows.every((w) => w.offline === true)));
        assert.deepEqual(store.get('queue', []), []);
    });

    await t.test('the windows of another session leave in another request', async () => {
        const other = 'Zk81mQ2dT7uYc0HsPq4NbA';
        const { instance, calls } = engine({
            stored: { queue: [...backlog(3), ...backlog(2, { session: other, documentId: 'vscode:abcd:src/util.go' })] },
        });

        await instance.drain();

        assert.deepEqual(metricsOf(calls).map((call) => [call.body.session, call.body.windows.length]),
            [[SESSION, 3], [other, 2]]);
    });

    await t.test('a window measured while the engine answered leaves alone, even behind others', async () => {
        // It then waited — a failed attempt, a slow request — but it is not `offline`, and a
        // window that is not is never gathered with its neighbours.
        const { instance, calls } = engine({ stored: { queue: [sealed(0), sealed(1), sealed(2, { offline: true })] } });

        await instance.drain();

        assert.deepEqual(metricsOf(calls).map((call) => call.body.windows.length), [1, 1, 1]);
    });

    await t.test('the cursor moves by what has gone, so an interrupted catch-up resends nothing', async () => {
        let requests = 0;
        const { instance, calls, store } = engine({
            stored: { queue: backlog(100) },
            metrics: () => (++requests === 2 ? Promise.reject(new Error('fetch failed')) : json(null)),
        });

        await instance.drain();
        assert.equal(store.get('queueSent', 0), 64);

        await instance.drain();
        const seqs = metricsOf(calls).filter((_, index) => index !== 1).flatMap((call) => call.body.windows.map((w) => w.seq));
        assert.deepEqual(seqs, Array.from({ length: 100 }, (_, seq) => seq));
    });

    await t.test('one window the engine refuses does not cost the batch it left in', async () => {
        const { instance, calls, store } = engine({
            stored: { queue: backlog(5) },
            metrics: (body) => (body.windows.some((w) => w.seq === 2)
                ? json({ code: 'invalid_body', error: 'invalid body' }, { status: 400 })
                : json(null)),
        });

        await instance.drain();

        const accepted = metricsOf(calls).filter((call) => !call.body.windows.some((w) => w.seq === 2))
            .flatMap((call) => call.body.windows.map((w) => w.seq));
        assert.deepEqual(accepted.sort(), [0, 1, 3, 4]);
        assert.deepEqual(store.get('queue', []), []);
        assert.equal(store.get('status', {}).state, 'synced');
    });
});

test('a refusal is a window given up, never a window sent differently', async (t) => {
    const bodies = (calls) => metricsOf(calls).map((call) => Object.keys(call.body).join(','));

    await t.test('whatever the 400 says, the window is sent once and the next one is the same body', async () => {
        for (const code of ['invalid_body', 'window_invalid', 'a_code_nobody_knows_yet']) {
            const { instance, calls, store } = engine({ metrics: () => json({ code, error: code }, { status: 400 }) });

            await instance.enqueue(sealed(0));
            await instance.enqueue(sealed(1));

            assert.deepEqual(bodies(calls), ['session,sent,windows', 'session,sent,windows'], code);
            assert.deepEqual(metricsOf(calls).map((call) => call.body.windows[0].runs.length), [3, 3], code);
            assert.deepEqual(store.get('queue', []), [], code);
            // Nothing is remembered of it either: no key records an engine to speak to otherwise.
            // `telemetry` is the refusal counted, a number and nothing of the window.
            assert.deepEqual([...store.map.keys()].sort(), ['engineIds', 'queue', 'queueSent', 'status', 'syncedNames', 'telemetry'], code);
            assert.deepEqual(store.get('telemetry'), { 'error.rejected': 2 }, code);
        }
    });

    await t.test('a rank the engine already holds with another start is final, not a failure to retry', async () => {
        const { instance, store, calls } = engine({
            stored: { queue: [sealed(0), sealed(1)] },
            metrics: (body) => (body.windows[0].seq === 0
                ? json({ code: 'window_conflict', error: 'seq already recorded' }, { status: 409 })
                : json(null)),
        });

        await instance.drain();

        assert.equal(metricsOf(calls).length, 2, 'each window is sent once');
        assert.deepEqual(store.get('queue', []), []);
        assert.equal(store.get('status', {}).state, 'synced');
    });

    await t.test('a document deleted on the engine is recreated, once, and the window sent again', async () => {
        let attempts = 0;
        const { instance, calls, store } = engine({
            stored: { queue: [sealed(0)], engineIds: { 'vscode:abcd:src/main.go': 'engine-gone' } },
            metrics: () => (++attempts === 1 ? json({ error: 'not found' }, { status: 404 }) : json(null)),
        });

        await instance.drain();

        assert.deepEqual(metricsOf(calls).map((call) => call.url.split('/').at(-2)), ['engine-gone', 'engine-1']);
        assert.deepEqual(store.get('queue', []), []);
    });

    await t.test('and one that keeps answering 404 does not loop: the window waits', async () => {
        const { instance, calls, store } = engine({
            stored: { queue: [sealed(0)] },
            metrics: () => json({ error: 'not found' }, { status: 404 }),
        });

        await instance.drain();

        assert.equal(metricsOf(calls).length, 2);
        assert.equal(store.get('status', {}).state, 'offline');
        assert.equal(instance.state().queue.length, 1);
    });
});

// What the agent says of itself (docs/moteur.md, « Ce que l'agent dit de lui-même »): counters of
// a closed vocabulary, kept beside the queue, sent at most every fifteen minutes.
test('the agent counts what happens to it', async (t) => {
    const telemetryOf = (calls) => calls.filter((c) => c.url.endsWith('/api/plugins/telemetry'));

    await t.test('the vocabulary is the contract\'s, in its order', () => {
        assert.deepEqual(TELEMETRY_EVENTS, [
            'installed', 'updated', 'started', 'error.runtime', 'error.engine', 'error.rejected',
            'error.auth', 'network.failure', 'queue.dropped',
        ]);
        assert.equal(TELEMETRY_FLUSH_MS, 900000);
        assert.equal(TELEMETRY_MAX_COUNT, 10000);
    });

    await t.test('each failure of the agent\'s calls is counted under its word', async () => {
        for (const [status, word] of [[503, 'error.engine'], [500, 'error.engine'], [401, 'error.auth'], [403, 'error.rejected'], [409, 'error.rejected']]) {
            const { instance, store } = engine({ metrics: () => json({ error: 'no' }, { status }) });
            await instance.enqueue(window_());
            assert.equal(store.get('telemetry')[word], 1, String(status));
            assert.deepEqual(Object.keys(store.get('telemetry')), [word], String(status));
        }
        const { instance, store } = engine({ down: true });
        await instance.enqueue(window_());
        assert.deepEqual(store.get('telemetry'), { 'network.failure': 1 });
    });

    await t.test('a check made before any call is not a failure of the engine', async () => {
        const { instance, store } = engine({ token: null });
        await assert.rejects(instance.api('GET', '/api/auth/me'), { status: 401 });
        assert.equal(store.get('telemetry'), undefined);
    });

    await t.test('the pairing poll\'s "keep waiting" is not a refusal; its real refusals are', async () => {
        for (const [answerOf, counted] of [
            [() => json({ code: 'device_authorization_pending' }, { status: 400 }), undefined],
            [() => json({ code: 'device_slow_down' }, { status: 400 }), undefined],
            [() => json({ error: 'too many' }, { status: 429 }), undefined],
            [() => json({ code: 'device_code_expired' }, { status: 400 }), { 'error.rejected': 1 }],
        ]) {
            const store = fakeStore();
            const instance = new Engine({
                store, secrets: { get: () => Promise.resolve(undefined) }, userAgent: 'test', hostLanguage: 'fr',
                fetch: () => Promise.resolve(answerOf()),
            });
            await instance.pollPairing({ engineUrl: 'https://engine.test', deviceCode: 'd', interval: 5000 }).catch(() => {});
            assert.deepEqual(store.get('telemetry'), counted);
        }
    });

    await t.test('a word outside the vocabulary is not counted, and a count stops at its cap', () => {
        const { instance, store } = engine({ stored: { telemetry: { started: TELEMETRY_MAX_COUNT - 1 } } });
        instance.count('error.TypeError: cannot read x of undefined');
        instance.count('started');
        instance.count('started');
        assert.deepEqual(store.get('telemetry'), { started: TELEMETRY_MAX_COUNT });
    });

    await t.test('a full queue counts each window it gives up', async () => {
        const full = Array.from({ length: 5000 }, (_, i) => sealed(i));
        const { instance, store } = engine({ token: null, stored: { queue: full } });
        await instance.enqueue(sealed(5000));
        assert.equal(store.get('queue').length, 5000);
        assert.deepEqual(store.get('telemetry'), { 'queue.dropped': 1 });
    });

    await t.test('installed, updated, started: the build against the last one seen', () => {
        const { instance, store } = engine({ version: '1.4.2' });
        instance.noteStart();
        assert.deepEqual(store.get('telemetry'), { installed: 1, started: 1 });
        instance.noteStart();
        assert.deepEqual(store.get('telemetry'), { installed: 1, started: 2 });

        const next = engine({ version: '1.5.0', stored: { telemetryVersion: '1.4.2' } });
        next.instance.noteStart();
        assert.deepEqual(next.store.get('telemetry'), { updated: 1, started: 1 });
        assert.equal(next.store.get('telemetryVersion'), '1.5.0');
    });

    await t.test('an installation that predates the counters is an update, not an install', () => {
        for (const stored of [
            { seenVersion: '1.4.2' },
            { config: { engineUrl: 'https://engine.test', language: 'fr' } },
            { signedIn: true },
        ]) {
            const { instance, store } = engine({ version: '1.5.0', stored });
            instance.noteStart();
            assert.deepEqual(store.get('telemetry'), { updated: 1, started: 1 }, JSON.stringify(stored));
            assert.equal(store.get('telemetryVersion'), '1.5.0');
        }
        // The panel already saw this very build: nothing changed, only a start.
        const same = engine({ version: '1.5.0', stored: { seenVersion: '1.5.0' } });
        same.instance.noteStart();
        assert.deepEqual(same.store.get('telemetry'), { started: 1 });
        // A signed-out store with nothing in it is a fresh install.
        const fresh = engine({ version: '1.5.0', stored: { signedIn: false } });
        fresh.instance.noteStart();
        assert.deepEqual(fresh.store.get('telemetry'), { installed: 1, started: 1 });
    });

    await t.test('only the agent\'s own exceptions are runtime errors', () => {
        const { instance, store } = engine();
        instance.countRuntime(new HttpError(500, 'engine'));
        assert.equal(store.get('telemetry'), undefined, 'an HttpError was counted where it was met');
        const guarded = instance.guard(() => { throw new TypeError('x is undefined'); });
        assert.throws(guarded, TypeError, 'the exception still reaches the editor');
        assert.deepEqual(store.get('telemetry'), { 'error.runtime': 1 });
    });

    await t.test('a runtime error keeps where our code broke, once per fault, with its count', () => {
        const { instance, store } = engine();
        // Thrown from a frame of src/engine.js: `guard` is ours, the arrow function is this test's.
        const guarded = instance.guard(() => { throw new TypeError('le texte de l’étudiant'); });
        assert.throws(guarded);
        assert.throws(guarded);
        const [fault, ...others] = store.get('telemetryFaults');
        assert.deepEqual(others, []);
        assert.equal(fault.type, 'TypeError');
        assert.equal(fault.count, 2);
        assert.match(fault.frames[0], /^(?:Engine\.)?guarded@engine\.js:\d+:\d+$/);
        assert.doesNotMatch(JSON.stringify(fault), /étudiant|tests|\//);
    });

    await t.test('at most ten distinct faults; the next are still counted', () => {
        const { instance, store } = engine();
        for (let i = 1; i <= TELEMETRY_MAX_FAULTS + 1; i++) instance.countFault({ type: 'Error', frames: [`f@engine.js:${i}:1`] });
        assert.equal(store.get('telemetryFaults').length, TELEMETRY_MAX_FAULTS);
        const { instance: other, store: kept } = engine();
        other.countRuntime('not an error');
        assert.deepEqual(kept.get('telemetryFaults'), [{ type: 'Other', frames: [], count: 1 }]);
        assert.deepEqual(kept.get('telemetry'), { 'error.runtime': 1 });
    });

    await t.test('the faults leave with the counters and are forgotten with them, kept when unanswered', async () => {
        const fault = { type: 'TypeError', frames: ['flush@engine.js:12:5'], count: 2 };
        const sent = engine({ stored: { telemetry: { 'error.runtime': 2 }, telemetryFaults: [fault] } });
        await sent.instance.reportTelemetry();
        assert.deepEqual(telemetryOf(sent.calls)[0].body, { events: { 'error.runtime': 2 }, faults: [fault] });
        assert.deepEqual(sent.store.get('telemetryFaults'), []);

        const during = engine({
            stored: { telemetry: { 'error.runtime': 2 }, telemetryFaults: [fault] },
            telemetry: () => {
                during.instance.countFault(fault);
                return answer(204);
            },
        });
        await during.instance.reportTelemetry();
        assert.deepEqual(during.store.get('telemetryFaults'), [{ ...fault, count: 1 }], 'counted during the send stays');

        const unanswered = engine({ stored: { telemetry: { 'error.runtime': 2 }, telemetryFaults: [fault] }, down: true });
        await unanswered.instance.reportTelemetry();
        assert.deepEqual(unanswered.store.get('telemetryFaults'), [fault]);
    });

    await t.test('the report: its body, its headers, and only counters', async () => {
        const { instance, calls, store } = engine({
            stored: { telemetry: { 'network.failure': 4, started: 3, 'error.runtime': 0, 'made.up': 7 } },
        });
        await instance.reportTelemetry();
        const [call] = telemetryOf(calls);
        assert.equal(call.url, 'https://monespace.certimens.fr/api/plugins/telemetry');
        assert.equal(call.method, 'POST');
        // In the vocabulary's order, zeros and unknown words left out.
        assert.equal(call.raw, '{"events":{"started":3,"network.failure":4}}');
        assert.equal(call.headers['Authorization'], 'Bearer api-token');
        assert.equal(call.headers['X-Certimens-Agent'], 'vscode/1.4.2');
        assert.equal(call.headers['Content-Type'], 'application/json');
        assert.equal(call.headers['User-Agent'], 'Certimens-VSCode/0.0.0 (test)');
        assert.deepEqual(store.get('telemetry'), {}, 'a 204 clears what was sent');
    });

    await t.test('at most every fifteen minutes, and only with something to say', async () => {
        let clock = 1_000_000_000;
        const { instance, calls } = engine({ now: () => clock });
        await instance.reportTelemetry();
        assert.equal(telemetryOf(calls).length, 0, 'nothing counted, nothing sent');

        instance.count('started');
        await instance.reportTelemetry();
        assert.equal(telemetryOf(calls).length, 1);

        instance.count('started');
        clock += TELEMETRY_FLUSH_MS - 1;
        await instance.reportTelemetry();
        assert.equal(telemetryOf(calls).length, 1, 'too soon');
        clock += 1;
        await instance.reportTelemetry();
        assert.equal(telemetryOf(calls).length, 2);
    });

    await t.test('a 204 keeps what was counted while the report was on its way', async () => {
        const during = [];
        const { instance, store } = engine({
            stored: { telemetry: { started: 2, 'error.engine': 1 } },
            telemetry: () => {
                for (const count of during) count();
                return answer(204);
            },
        });
        during.push(() => instance.count('started'), () => instance.count('error.runtime'));
        await instance.reportTelemetry();
        assert.deepEqual(store.get('telemetry'), { started: 1, 'error.runtime': 1 });
    });

    await t.test('kept when unanswered or on a 5xx; dropped on 400, 413 and 401; never counted itself', async () => {
        const counts = { started: 2, 'network.failure': 1 };
        for (const [answerOf, left] of [
            [() => Promise.reject(new Error('fetch failed')), counts],
            [() => answer(503), counts],
            [() => answer(500), counts],
            [() => answer(400), {}],
            [() => answer(413), {}],
            [() => answer(401), {}],
        ]) {
            const { instance, store, calls } = engine({ stored: { telemetry: { ...counts } }, telemetry: answerOf });
            await instance.reportTelemetry();
            assert.equal(telemetryOf(calls).length, 1);
            assert.deepEqual(store.get('telemetry'), left);
        }
    });

    await t.test('not paired: nothing is sent, everything is kept for later', async () => {
        const { instance, calls, store } = engine({ token: null, stored: { telemetry: { installed: 1, started: 1 } } });
        await instance.reportTelemetry();
        assert.equal(calls.length, 0);
        assert.deepEqual(store.get('telemetry'), { installed: 1, started: 1 });
        assert.equal(store.get('telemetryAt'), undefined, 'the next attempt is not held back');
    });

    await t.test('the counters belong to the installation: a sign-out keeps them', async () => {
        const { instance, store } = engine({ stored: { telemetry: { installed: 1 }, telemetryVersion: '1.4.2' } });
        await instance.logout();
        assert.deepEqual(store.get('telemetry'), { installed: 1 });
        assert.equal(store.get('telemetryVersion'), '1.4.2');
    });

    await t.test('the once-a-minute loop drains the queue, then reports', async () => {
        const { instance, calls } = engine({ stored: { queue: [sealed(0)], telemetry: { started: 1 } } });
        await instance.start();
        assert.deepEqual(calls.map((c) => c.url.split('/').slice(-2).join('/')), ['api/documents', 'engine-1/metrics', 'plugins/telemetry']);
    });
});

// What only shows with more than one thing happening at once: two windows of the editor, a
// file renamed while its windows wait, a refusal that is not an outage.
test('`offline` is an engine out of reach, not an engine that refused', async (t) => {
    const ID = 'vscode:abcd:src/main.go';

    await t.test('a window queued behind a 5xx is not stamped, and leaves alone', async () => {
        let fail = true;
        const { instance, store, calls } = engine({
            stored: { engineIds: { [ID]: 'engine-1' } },
            metrics: () => (fail ? json({ error: 'boom' }, { status: 503 }) : json(null)),
        });
        await instance.enqueue(sealed(0));
        assert.equal(store.get('status').state, 'offline');
        assert.equal(store.get('status').reached, true);
        await instance.enqueue(sealed(1));
        assert.deepEqual(store.get('queue').map((item) => item.offline), [undefined, undefined]);
        fail = false;
        calls.length = 0;
        await instance.drain();
        assert.deepEqual(calls.map((c) => c.body.windows.length), [1, 1], 'no batch: neither was written offline');
    });

    await t.test('a rename the engine refuses is final, and reddens nothing', async () => {
        const { instance, store, calls } = engine({
            stored: { engineIds: { [ID]: 'engine-1' }, names: { [ID]: 'tp/b.go' }, syncedNames: { [ID]: 'tp/a.go' } },
            rename: () => json({ error: 'taken', code: 'document_name_taken' }, { status: 409 }),
        });
        await instance.drain();
        await instance.drain();
        assert.equal(calls.filter((c) => c.method === 'PUT').length, 1, 'asked once, not at every drain');
        assert.equal(store.get('status').state, 'synced');
    });

    await t.test('a token the engine refused is not tried again at every window', async () => {
        const { instance, calls } = engine({
            stored: { engineIds: { [ID]: 'engine-1' } },
            metrics: () => json({ error: 'no' }, { status: 401 }),
        });
        await instance.enqueue(sealed(0));
        await instance.enqueue(sealed(1));
        assert.equal(calls.filter((c) => c.url.endsWith('/metrics')).length, 1);
        assert.equal(instance.pending(), 2, 'both wait for the next pairing');
    });
});

test('a file renamed in the project keeps its engine document', async (t) => {
    const OLD = 'vscode:abcd:src/main.go';
    const NEW = 'vscode:abcd:src/app.go';

    await t.test('the document, its name and the windows waiting follow the file', async () => {
        const { instance, store, calls } = engine({
            token: null,
            stored: {
                engineIds: { [OLD]: 'engine-1' }, names: { [OLD]: 'tp/src/main.go' },
                syncedNames: { [OLD]: 'tp/src/main.go' }, queue: [sealed(0, { documentId: OLD })],
            },
        });
        await instance.moveFile(OLD, NEW, 'tp/src/app.go');
        assert.deepEqual(store.get('engineIds'), { [NEW]: 'engine-1' });
        assert.deepEqual(store.get('names'), { [NEW]: 'tp/src/app.go' });
        assert.deepEqual(store.get('syncedNames'), { [NEW]: 'tp/src/main.go' }, 'the engine still has the old name');
        assert.equal(store.get('queue')[0].documentId, NEW);
        assert.equal(calls.length, 0);
    });

    await t.test('the next send renames the engine document and creates none', async () => {
        const { instance, calls } = engine({
            stored: {
                engineIds: { [OLD]: 'engine-1' }, names: { [OLD]: 'tp/src/main.go' },
                syncedNames: { [OLD]: 'tp/src/main.go' },
            },
        });
        await instance.moveFile(OLD, NEW, 'tp/src/app.go');
        await instance.enqueue(sealed(0, { documentId: NEW }));
        assert.deepEqual(calls.map((c) => c.method + ' ' + c.url.split('/api/')[1]),
            ['POST documents/engine-1/metrics', 'PUT documents/engine-1']);
        assert.deepEqual(calls[1].body, { name: 'tp/src/app.go' });
    });

    await t.test('a folder carries every file below it, and no other', async () => {
        const { instance, store } = engine({
            token: null,
            stored: {
                engineIds: { 'vscode:abcd:src/a.go': 'e-a', 'vscode:abcd:src/in/b.go': 'e-b', 'vscode:abcd:srcs/c.go': 'e-c' },
            },
        });
        await instance.moveFile('vscode:abcd:src', 'vscode:abcd:lib', 'tp/lib');
        assert.deepEqual(store.get('engineIds'),
            { 'vscode:abcd:lib/a.go': 'e-a', 'vscode:abcd:lib/in/b.go': 'e-b', 'vscode:abcd:srcs/c.go': 'e-c' });
    });

    await t.test('a file never sent is created under its new name', async () => {
        const { instance, calls } = engine({ token: null, stored: { queue: [sealed(0, { documentId: OLD })] } });
        await instance.moveFile(OLD, NEW, 'tp/src/app.go');
        instance.secrets.set('token', 'api-token');
        await instance.drain();
        assert.deepEqual(calls[0].body, { name: 'tp/src/app.go' });
    });
});

test('the account belongs to every window, the queue to one', async (t) => {
    await t.test('a sign-out in another window empties what this workspace was holding', async () => {
        const shared = fakeStore({ signedIn: true });
        const here = engine({ shared, stored: { queue: [sealed(0)], engineIds: { 'vscode:abcd:src/main.go': 'engine-1' } } });
        const there = engine({ shared, stored: {} });
        await there.instance.logout();
        assert.equal(here.instance.pending(), 0, 'read as empty at once');
        assert.deepEqual(here.instance.state().engineIds, {});
        // The next account pairs, in either window: nothing of the last one leaves under it.
        here.secrets.set('token', 'next-token');
        await here.instance.drain();
        assert.equal(here.calls.filter((c) => c.url.endsWith('/metrics')).length, 0);
        assert.equal(here.local.get('queue'), undefined);
    });

    await t.test('two windows never write each other\'s queue', async () => {
        const shared = fakeStore({});
        const one = engine({ shared, token: null });
        const two = engine({ shared, token: null });
        await one.instance.enqueue(sealed(0));
        await two.instance.enqueue(sealed(0, { documentId: 'vscode:ffff:b.go' }));
        assert.equal(one.instance.pending(), 1);
        assert.equal(two.instance.pending(), 1);
        assert.equal(shared.get('queue'), undefined, 'nothing of a queue in what the windows share');
    });

    await t.test('the same address on another engine is another account', async () => {
        const { instance, store } = engine({
            stored: { config: { engineUrl: 'https://old.example.fr', email: 'a@b.fr' }, queue: [sealed(0)] },
        });
        await instance.adoptToken('https://engine.test', 'new-token');
        assert.equal(store.get('queue'), undefined);
    });
});

test('signing out says whether the token is dead', async (t) => {
    const tokens = (status) => {
        const { instance } = engine({ stored: { config: { tokenId: 'tok-1' } } });
        const fetch = instance.fetch;
        instance.fetch = (url, init) => (init.method === 'DELETE' ? answer(status) : fetch(url, init));
        return instance.logout();
    };
    await t.test('revoked', async () => assert.equal(await tokens(204), true));
    await t.test('already gone at the engine: as dead as revoked', async () => {
        assert.equal(await tokens(404), true);
        assert.equal(await tokens(401), true);
    });
    await t.test('an engine that failed leaves it alive', async () => assert.equal(await tokens(503), false));
});

test('what the engine says of a pairing is clamped before it paces a loop', async () => {
    const { instance } = engine();
    const fetch = instance.fetch;
    instance.fetch = (url, init) => (url.endsWith('/api/auth/device')
        ? Promise.resolve(json({ device_code: 'd', user_code: 'C', verification_uri: 'https://engine.test/device', expires_in: 1e9, interval: 0.001 }))
        : fetch(url, init));
    const before = Date.now();
    const pairing = await instance.startPairing('https://engine.test');
    assert.equal(pairing.interval, 1000);
    assert.ok(pairing.expiresAt - before <= 1800 * 1000 + 1000);
});

// The engine keeps one living document per name and per account. A document created from a
// sealed window is created with nobody watching, so a name already taken is not a refusal to
// pass on: it is a name to change.
test('a document whose name is taken is created under a free one', async (t) => {
    const taken = (instance, answers) => {
        const fetch = instance.fetch;
        instance.fetch = (url, init) => {
            if (init.method !== 'POST' || !url.endsWith('/api/documents')) return fetch(url, init);
            return fetch(url, init).then((created) => answers.shift() || created);
        };
    };
    const nameTaken = () => json({ error: 'taken', code: 'document_name_taken' }, { status: 409 });

    await t.test('the window leaves, to a document named after the file and the instant', async () => {
        const { instance, calls } = engine({ now: () => new Date(2026, 10, 25, 14, 32, 7).getTime() });
        taken(instance, [nameTaken()]);
        await instance.enqueue(sealed(0));
        const created = calls.filter((c) => c.url.endsWith('/api/documents')).map((c) => c.body.name);
        assert.deepEqual(created, ['src/main.go', 'src/main.go (2026-11-25 14.32.07)']);
        assert.equal(calls.filter((c) => c.url.endsWith('/metrics')).length, 1);
        assert.equal(instance.pending(), 0);
    });

    await t.test('a creation the engine refuses keeps the window: it is not the window that was refused', async () => {
        const { instance, store } = engine();
        taken(instance, [nameTaken(), nameTaken()]);
        await instance.enqueue(sealed(0));
        assert.equal(instance.pending(), 1);
        assert.equal(store.get('status').state, 'offline');
        assert.equal(store.get('status').reached, true);
    });

    await t.test('a name longer than the engine takes is cut, not refused', async () => {
        const { instance, calls } = engine();
        await instance.enqueue({ ...sealed(0), documentName: 'x'.repeat(400) });
        assert.equal(calls[0].body.name.length, 255);
    });
});

// The queue in its file (src/queue-file.js), as the host hands it over when a folder is open:
// the same client, the same invariants, and a restart in between.
test('the queue kept in a file under the workspace storage', async (t) => {
    const { FileQueue } = require('../src/queue-file.js');
    const { mkdtemp, rm, readFile } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const folder = async () => {
        const dir = await mkdtemp(join(tmpdir(), 'certimens-engine-'));
        t.after(() => rm(dir, { recursive: true, force: true }));
        return dir;
    };
    const waiting = (dir) => new FileQueue(dir).load();

    await t.test('a catch-up cut in two resumes at the cursor after a restart', async () => {
        const dir = await folder();
        let sent = 0;
        const first = engine({
            queue: new FileQueue(dir), token: null,
            metrics: () => (++sent === 3 ? Promise.reject(new Error('fetch failed')) : json(null)),
        });
        for (const seq of [0, 1, 2, 3]) await first.instance.enqueue(sealed(seq));
        assert.equal(first.instance.pending(), 4);
        first.secrets.set('token', 'api-token');
        await first.instance.drain();
        assert.equal(first.instance.pending(), 2, 'two went, the third met no network');

        // The editor restarts: a new client, the same workspace state and the same folder.
        const second = engine({ queue: new FileQueue(dir), stored: Object.fromEntries(first.store.map) });
        await second.instance.drain();
        assert.deepEqual(metricsOf(second.calls).map((call) => call.body.windows[0].seq), [2, 3],
            'what had gone does not go again');
        assert.deepEqual(await waiting(dir), []);
        assert.equal(await readFile(join(dir, 'queue.jsonl'), 'utf8'), '', 'emptied once everything has left');
        assert.equal(second.store.get('queue'), undefined, 'nothing of the queue in the workspace state');
    });

    await t.test('a window is appended, not the queue rewritten', async () => {
        const dir = await folder();
        const file = new FileQueue(dir);
        const writes = [];
        for (const name of ['append', 'advance', 'rewrite', 'clear']) {
            const real = file[name].bind(file);
            file[name] = (...args) => {
                writes.push(name);
                return real(...args);
            };
        }
        const { instance } = engine({ queue: file, token: null });
        for (let seq = 0; seq < 200; seq++) await instance.enqueue(sealed(seq));
        assert.deepEqual(new Set(writes), new Set(['append']));
        assert.equal(writes.length, 200);
        assert.equal(instance.pending(), 200);
    });

    await t.test('`offline` is stamped in the file at the moment of queueing', async () => {
        const dir = await folder();
        const { instance } = engine({ queue: new FileQueue(dir), stored: { status: { state: 'offline' } }, down: true });
        await instance.enqueue(sealed(0));
        assert.deepEqual((await waiting(dir)).map((item) => item.offline), [true]);
    });

    await t.test('a full queue gives up its oldest, counts it, and is compacted', async () => {
        const dir = await folder();
        const full = new FileQueue(dir);
        await full.load();
        await full.rewrite(Array.from({ length: 5000 }, (_, seq) => sealed(seq)));
        const { instance, store } = engine({ queue: new FileQueue(dir), token: null });
        await instance.enqueue(sealed(5000));
        const left = await waiting(dir);
        assert.equal(left.length, 5000);
        assert.deepEqual([left[0].window.seq, left.at(-1).window.seq], [1, 5000]);
        assert.deepEqual(store.get('telemetry'), { 'queue.dropped': 1 });
    });

    await t.test('a sign-out in another window empties the file too', async () => {
        const dir = await folder();
        const shared = fakeStore({ signedIn: true });
        const here = engine({ shared, queue: new FileQueue(dir), token: null });
        await here.instance.enqueue(sealed(0));
        await here.instance.enqueue(sealed(1));
        const there = engine({ shared, stored: {} });
        await there.instance.logout();
        assert.equal(here.instance.pending(), 0, 'read as empty at once');
        here.secrets.set('token', 'next-token');
        await here.instance.drain();
        assert.equal(metricsOf(here.calls).length, 0, 'nothing of the last account leaves under the next');
        assert.deepEqual(await waiting(dir), []);
    });

    await t.test('and a sign-out here, before the queue was ever read', async () => {
        const dir = await folder();
        const before = new FileQueue(dir);
        await before.load();
        await before.append(sealed(0));
        const { instance } = engine({ queue: new FileQueue(dir) });
        await instance.clearAccountState();
        assert.deepEqual(await waiting(dir), []);
        assert.equal(instance.pending(), 0);
    });

    await t.test('a renamed file renames the windows waiting in the file', async () => {
        const OLD = 'vscode:abcd:src/main.go';
        const NEW = 'vscode:abcd:src/app.go';
        const dir = await folder();
        const { instance } = engine({ queue: new FileQueue(dir), token: null });
        await instance.enqueue(sealed(0, { documentId: OLD }));
        await instance.enqueue(sealed(1, { documentId: 'vscode:abcd:src/other.go' }));
        await instance.moveFile(OLD, NEW, 'tp/src/app.go');
        const left = await waiting(dir);
        assert.deepEqual(left.map((item) => item.documentId), [NEW, 'vscode:abcd:src/other.go']);
        assert.equal(left[0].documentName, 'tp/src/app.go');
    });

    await t.test('a queue an earlier build left in the workspace state moves into the file, once', async () => {
        const dir = await folder();
        const { instance, store, calls } = engine({
            queue: new FileQueue(dir), token: null,
            stored: { queue: [sealed(0), sealed(1), sealed(2)], queueSent: 1 },
        });
        await instance.drain();
        assert.equal(instance.pending(), 2);
        assert.deepEqual((await waiting(dir)).map((item) => item.window.seq), [1, 2]);
        assert.equal(store.get('queue'), undefined);
        assert.equal(store.get('queueSent'), undefined);
        instance.secrets.set('token', 'api-token');
        await instance.drain();
        assert.deepEqual(metricsOf(calls).map((call) => call.body.windows[0].seq), [1, 2]);
    });

    await t.test('a folder that cannot be written gives way to the workspace state', async () => {
        const broken = { load: () => Promise.reject(new Error('EACCES')) };
        const { instance, store } = engine({ queue: /** @type {any} */ (broken), token: null });
        const warn = console.warn;
        console.warn = () => {};
        try {
            await instance.enqueue(sealed(0));
        } finally {
            console.warn = warn;
        }
        assert.equal(store.get('queue', []).length, 1, 'kept, the slow way');
    });
});

// « Signaler un problème » (docs/moteur.md): a link to the engine's help form, prefilled with a
// block of `key: value` lines. Nothing is sent: what is tested is the link, and above all what it
// must never carry.
test('the « report a problem » link', async (t) => {
    const AT = Date.parse('2026-11-25T14:32:07.481Z');
    const ABOUT = { host: 'VS Code 1.97.0', os: 'linux x64', paused: false };
    const blockOf = (url) => {
        const [base, fragment] = url.split('#');
        const match = /^report\?kind=problem&details=([^&]*)$/.exec(fragment);
        assert.ok(match, `the fragment reads ${fragment}`);
        return { base, block: decodeURIComponent(match[1]) };
    };
    const valuesOf = (block) => Object.fromEntries(block.split('\n').map((line) => {
        const at = line.indexOf(': ');
        return [line.slice(0, at), line.slice(at + 2)];
    }));

    await t.test('the shape: the engine origin, the fragment, the keys in their order', () => {
        const { instance } = engine({ now: () => AT });
        const url = instance.reportUrl(ABOUT);
        assert.equal(REPORT_FRAGMENT, '#report');
        assert.ok(url.startsWith('https://monespace.certimens.fr/#report?kind=problem&details='), url);
        const { block } = blockOf(url);
        assert.deepEqual(block.split('\n').map((line) => line.split(': ')[0]), REPORT_KEYS);
        assert.deepEqual(valuesOf(block), {
            agent: 'vscode/1.4.2',
            host: 'VS Code 1.97.0',
            os: 'linux x64',
            language: 'fr',
            engine: 'https://monespace.certimens.fr',
            signed_in: 'no',
            paused: 'no',
            status: 'idle',
            queued: '0',
            counters: 'none',
            at: '2026-11-25T14:32:07Z',
        });
    });

    await t.test('what the editor does not say reads `unknown`, and no line is left out', () => {
        const { instance } = engine({ now: () => AT });
        const values = valuesOf(blockOf(instance.reportUrl({ host: 'a\nb', os: '' })).block);
        assert.deepEqual(Object.keys(values), REPORT_KEYS);
        assert.equal(values.os, 'unknown');
        assert.equal(values.paused, 'unknown');
        assert.equal(values.host, 'a b', 'a line break inside a value would forge a line');
    });

    await t.test('the state, the queue and the counters not yet sent', async () => {
        const { instance, store } = engine({
            now: () => AT,
            stored: {
                signedIn: true,
                status: { state: 'offline', message: 'ECONNREFUSED 10.0.0.1', reached: false },
                telemetry: { 'network.failure': 5, started: 3, 'error.runtime': 0, 'not.a.word': 9 },
            },
        });
        await instance.loadQueue();
        await instance.appendQueue(window_());
        await instance.appendQueue(sealed(1));
        let values = valuesOf(blockOf(instance.reportUrl({ ...ABOUT, paused: true })).block);
        assert.equal(values.signed_in, 'yes');
        assert.equal(values.paused, 'yes');
        assert.equal(values.status, 'offline (unreachable)', 'the state word, never the message');
        assert.equal(values.queued, '2');
        assert.equal(values.counters, 'started=3 network.failure=5', 'in the vocabulary\'s order, words of it only');
        await store.set('status', { state: 'offline', message: 'status 503', reached: true });
        values = valuesOf(blockOf(instance.reportUrl(ABOUT)).block);
        assert.equal(values.status, 'offline (reached)');
    });

    await t.test('never the token, the e-mail, a name, a file or a project', async () => {
        const { instance } = engine({
            token: 'secret-api-token',
            now: () => AT,
            stored: {
                signedIn: true,
                config: {
                    engineUrl: 'https://user:pass@moteur.univ.fr:8443/certimens/?jeton=x#y',
                    email: 'etudiante@univ.fr', displayName: 'Camille Martin', tokenId: 'tok-42', language: 'fr',
                },
                engineIds: { 'vscode:abcd:src/memoire.go': 'engine-doc-77' },
                names: { 'vscode:abcd:src/memoire.go': 'projet/src/memoire.go' },
                status: { state: 'offline', message: 'projet/src/memoire.go : refusé', reached: true },
            },
        });
        await instance.loadQueue();
        await instance.appendQueue(sealed(0, { documentId: 'vscode:abcd:src/memoire.go' }));
        const url = instance.reportUrl(ABOUT);
        const { base, block } = blockOf(url);
        assert.equal(base, 'https://moteur.univ.fr:8443/', 'the origin, never a path, a query or credentials');
        assert.equal(valuesOf(block).engine, 'https://moteur.univ.fr:8443');
        for (const secret of ['secret-api-token', 'etudiante', 'univ.fr/', 'Camille', 'tok-42', 'memoire', 'engine-doc-77', 'abcd', 'refusé', 'pass', 'jeton', 'certimens/']) {
            assert.ok(!url.includes(secret) && !block.includes(secret), `${secret} is in the link`);
        }
    });

    await t.test('a refused engine is not opened: the link goes to the default one', async () => {
        for (const refused of REFUSED) {
            const { instance } = engine({ now: () => AT, stored: { config: { engineUrl: refused } } });
            const { base } = blockOf(instance.reportUrl(ABOUT));
            assert.equal(base, 'https://monespace.certimens.fr/', refused);
        }
        const { instance } = engine({ now: () => AT, stored: { config: { engineUrl: 'http://192.168.1.5:9000/' } } });
        assert.equal(blockOf(instance.reportUrl(ABOUT)).base, 'http://192.168.1.5:9000/', 'a local engine is kept');
    });

    await t.test('the block stops at 1 500 characters, between two lines', () => {
        const { instance } = engine({ now: () => AT });
        const long = 'x'.repeat(5000);
        const { block } = blockOf(instance.reportUrl({ host: long, os: long, paused: false }));
        assert.ok(block.length <= 1500, String(block.length));
        assert.deepEqual(block.split('\n').map((line) => line.split(': ')[0]), REPORT_KEYS, 'a long value is clipped, no line is lost');
        assert.ok(block.split('\n').every((line) => /^[a-z_]+: \S/.test(line)));
    });
});

// Where our code broke, and nothing else a stack carries: not the message, not the directory the
// extension is installed in (the student's home), not another extension's frames.
test('a fault is our own frames, as bare positions', async (t) => {
    await t.test('Linux and macOS paths', () => {
        const own = '/home/alice/.vscode/extensions/certimens.certimens-1.4.2/src/';
        const stack = [
            'TypeError: Cannot read properties of undefined (reading \'Mon mémoire\')',
            `    ${own}engine.js:1:1 quoted in the message, never read`,
            `    at Engine.reportTelemetry (${own}engine.js:1224:23)`,
            '    at /home/alice/.vscode/extensions/other.ext/out/main.js:10:2',
            '    at process.processTicksAndRejections (node:internal/process/task_queues:95:5)',
            `    at async Agent.flush (${own}extension.js:40:9)`,
            `    at new Queue (${own}queue-file.js:12:3)`,
            `    at ${own}lib/vendor.js:1:1`,
            `    at file://${own}panel.js:7:5`,
        ].join('\n');
        assert.deepEqual(faultOf('TypeError', stack, own), {
            type: 'TypeError',
            frames: ['Engine.reportTelemetry@engine.js:1224:23', 'Agent.flush@extension.js:40:9', 'Queue@queue-file.js:12:3', 'panel.js:7:5'],
        });
    });

    await t.test('Windows paths', () => {
        const own = 'C:\\Users\\alice\\.vscode\\extensions\\certimens\\src\\';
        const stack = `Error: x\n    at Engine.count (${own}engine.js:5:7)\n    at C:\\Users\\alice\\other\\engine.js:1:1`;
        assert.deepEqual(faultOf('Error', stack, own).frames, ['Engine.count@engine.js:5:7']);
    });

    await t.test('a type that is not a name, no stack, at most a dozen frames', () => {
        const own = '/ext/src/';
        assert.equal(faultOf('Cannot read \'Mon mémoire\'', '', own).type, 'Other');
        assert.deepEqual(faultOf('Error', undefined, own).frames, []);
        const stack = 'Error\n' + Array.from({ length: 20 }, (_, i) => `    at f${i} (${own}engine.js:${i + 1}:1)`).join('\n');
        assert.equal(faultOf('Error', stack, own).frames.length, TELEMETRY_MAX_FRAMES);
    });
});
