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
const { Engine, engineUrlAllowed } = require('../src/engine.js');
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
function engine({ stored = {}, token = 'api-token', metrics = () => json(null), down = false, version = '1.4.2' } = {}) {
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
        version,
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
            assert.deepEqual([...store.map.keys()].sort(), ['engineIds', 'queue', 'queueSent', 'status', 'syncedNames'], code);
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
