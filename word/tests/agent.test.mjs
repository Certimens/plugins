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
import { ALLOWED, REFUSED } from './helpers/engine-url.mjs';

const INTERNALS = ['startPairing', 'pollPairing', 'adoptToken', 'pushItem', 'getState', 'getConfig',
    'updatedVersion', 'engineUrlAllowed', 'documentId', 'resumeEngineDocument', 'stampEngineDocument',
    'startResume', 'createFileFor'];
const PREFIX = 'certimens.';

// The extended metrics arrived in three generations (docs/mesures.md, "Metrics envoyées"). The
// number is written here rather than read from the shipped code: what the test holds is the
// rule, and nothing is added to the production code to make it observable.
const GENERATIONS = 3;

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

// The open Word document, as Office hands it over: its custom properties — where the identity
// and the engine document it feeds are written, under the names the LibreOffice agent reads —
// and the requirement set that decides whether they exist at all.
function wordDocument({ properties = {}, customProperties = true, answers = true, url = 'https://sp.test/Documents/Mémoire.docx' } = {}) {
    const props = { ...properties };
    const settings = {};
    const Office = {
        context: {
            document: {
                url,
                settings: {
                    get: (key) => settings[key],
                    set: (key, value) => { settings[key] = value; },
                    saveAsync: (callback) => callback(),
                },
            },
            requirements: { isSetSupported: (set, version) => customProperties && set === 'WordApi' && version === '1.3' },
        },
    };
    const Word = {
        // `answers: false` is a document Word will not hand over — closed under the pane's
        // feet, or locked by the host.
        run: (body) => (answers ? body({
            document: {
                properties: {
                    customProperties: {
                        getItemOrNullObject: (name) => ({
                            isNullObject: !(name in props),
                            value: props[name],
                            load: () => {},
                        }),
                        add: (name, value) => { props[name] = value; },
                    },
                },
            },
            sync: () => Promise.resolve(),
        }) : Promise.reject(new Error('document unavailable'))),
    };
    return { Office, Word, props, settings };
}

// agent loads the shipped script with the globals it expects from its siblings (i18n.js, config)
// and from the browser. `routes` answers one request each; `metrics` is the answer to a
// measurement push, which a test can change between attempts. `documents` is what the engine
// holds, for the file that names the one it feeds.
function agent({ stored = {}, metrics = () => json(null), devicePoll = () => json({ token: 'api-token' }),
    documents = {}, documentStatus = 0, role = 'student', document: doc = wordDocument() } = {}) {
    const time = clock();
    const storage = fakeStorage(stored);
    const calls = [];
    const fetchStub = (url, init) => {
        const body = init.body ? JSON.parse(init.body) : null;
        calls.push({ url, method: init.method, body, headers: init.headers || {} });
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
        if (url.endsWith('/api/auth/me')) return Promise.resolve(json({ email: 'a@b.fr', display_name: 'A B', language: 'fr', role }));
        if (init.method === 'GET' && /\/api\/documents\/[^/]+$/.test(url)) {
            if (documentStatus) return Promise.resolve(json({ error: 'refused' }, { status: documentStatus }));
            const id = url.split('/').pop();
            return Promise.resolve(id in documents
                ? json({ id, name: documents[id] })
                : json({ error: 'not found' }, { status: 404 }));
        }
        if (url.endsWith('/api/auth/tokens')) return Promise.resolve(json([{ id: 'tok-1', label: 'Complément Word — 2026-10-10' }]));
        if (url.endsWith('/metrics')) return Promise.resolve(metrics(body));
        return Promise.resolve(json({ id: 'engine-1' }));
    };
    let minted = 0;
    const globals = {
        ...officeGlobals(time),
        ...doc,
        localStorage: storage,
        fetch: fetchStub,
        // UUID-shaped: what the add-in mints, it reads back and checks the shape of.
        crypto: { randomUUID: () => `0000000${minted++}-0000-4000-8000-000000000000` },
        t: (key) => key,
        dateLocale: () => 'fr-FR',
        window: { addEventListener: () => {} },
        navigator: { onLine: true },
    };
    return { storage, calls, properties: doc.props, settings: doc.settings,
        internals: load(new URL('../src/agent.js', import.meta.url), { globals, expose: INTERNALS }) };
}

// The engine stores what measured a window and flags a push that names nothing, so this header
// is not an extra: omitting it would raise a signal on every honest window written in Word.
//
// It matters more here than for the three others. The pane and the engine's own editor are both
// pages in a browser, indistinguishable by their transport signature: without this declaration,
// nothing could say which of the two wrote a copy.
test('every call names this agent', async () => {
    const { calls, internals } = agent({ stored: PAIRED });

    await internals.pushItem(internals.getConfig(), internals.getState(), WINDOW);

    const pushed = calls.filter((c) => c.url.endsWith('/metrics'));
    assert.ok(pushed.length, 'no measurement sent');
    for (const call of pushed) {
        // A checkout still holds the build placeholder, which is the agent not knowing its own
        // build: it then sends its kind alone, which the engine accepts. `make build` stamps the
        // version in, so what is pinned here is the shape and not the number.
        assert.match(call.headers['X-Certimens-Agent'], /^word(\/[A-Za-z0-9._+-]{1,32})?$/);
    }
    assert.ok(calls.every((c) => c.headers['X-Certimens-Agent']));
});

test('connecting gives the extended measurements their chance again', async () => {
    // The add-in has met an engine that refused every generation — at some point, on some account.
    const { storage, internals } = agent({ stored: { extendedDropped: GENERATIONS } });

    await internals.adoptToken('https://engine.test', 'api-token');

    assert.equal(storage.read('extendedDropped'), 0);
});

test('a memory written before the generations means "everything that existed then"', async () => {
    // Installs updated from an earlier version carry a boolean. Read as 0, they would push the
    // first generation to an engine already known to refuse it, at every single window.
    const { internals } = agent({ stored: { extendedUnsupported: true } });

    assert.equal(internals.getState().extendedDropped, GENERATIONS);
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
    values: { keystrokes_total: 5, focus_losses: 1, injected_chars_max: 300,
              self_paste_chars_total: 120 },
};

const PAIRED = { engineIds: { doc1: 'engine-1' }, config: { engineUrl: 'https://engine.test', token: 'api-token' } };

// --- the file says which document it feeds ---
//
// A dissertation begun in Writer and carried on in Word is one piece of work. What makes it one
// record is written in the file itself, in the custom properties every editor reads, and taken
// back here — which is the one place where something read out of a student's file decides which
// document the engine is asked for.
const UUID = '0000000a-0000-4000-8000-000000000000';
const SOURCE = 'https://sp.test/Documents/Mémoire.docx';
const CARRIED = { CertimensDocumentId: UUID, CertimensEngineDocument: 'f9' };

test('the identity is written in the file, under the name the other agents read', async () => {
    const { properties, internals } = agent();

    const id = await internals.documentId();

    assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    assert.equal(properties.CertimensDocumentId, id);
    // Opened again, the same file is the same document: nothing is minted a second time.
    assert.equal(await internals.documentId(), id);
});

test('a file that names its engine document is taken back, not opened twice', async () => {
    const { calls, storage, internals } = agent({
        stored: { config: PAIRED.config },
        document: wordDocument({ properties: CARRIED }),
        documents: { f9: 'Mémoire' },
    });

    const file = await internals.resumeEngineDocument(UUID, SOURCE);

    assert.equal(file.id, 'f9');
    assert.equal(storage.read('engineIds')[UUID], 'f9');
    // The name the engine holds, so a rename made in Word since is still seen as one.
    assert.equal(storage.read('syncedTitles')[UUID], 'Mémoire');
    calls.length = 0;
    await internals.pushItem(internals.getConfig(), internals.getState(), { ...WINDOW, documentId: UUID });
    assert.equal(calls.filter((c) => c.url.endsWith('/api/documents')).length, 0, 'a second document was opened');
    assert.ok(calls.some((c) => c.url.endsWith('/api/documents/f9/metrics')));
});

test('a window measured while the document is being taken back joins it', async () => {
    // The take-back is a network call the pane does not wait on, and the queue drains every
    // minute: without this, a window could open a second record beside the one it is rejoining.
    const { calls, internals } = agent({
        stored: { config: PAIRED.config },
        document: wordDocument({ properties: CARRIED }),
        documents: { f9: 'Mémoire' },
    });

    const resume = internals.startResume(UUID);
    await internals.pushItem(internals.getConfig(), internals.getState(), { ...WINDOW, documentId: UUID });
    await resume;

    assert.equal(calls.filter((c) => c.url.endsWith('/api/documents')).length, 0, 'a second document was opened');
    assert.ok(calls.some((c) => c.url.endsWith('/api/documents/f9/metrics')));
});

test('a document that is not this account\'s is not taken back', async () => {
    // A file a classmate sent carries their id: it is a file like any other here.
    const { storage, internals } = agent({
        stored: { config: PAIRED.config },
        document: wordDocument({ properties: CARRIED }),
        documentStatus: 403,
    });

    assert.equal(await internals.resumeEngineDocument(UUID, SOURCE), null);
    assert.equal(storage.read('engineIds'), undefined);
});

test('a document that no longer exists is not taken back', async () => {
    const { storage, internals } = agent({
        stored: { config: PAIRED.config },
        document: wordDocument({ properties: CARRIED }),
    });

    assert.equal(await internals.resumeEngineDocument(UUID, SOURCE), null);
    assert.equal(storage.read('engineIds'), undefined);
});

test('only a student takes a document back', async () => {
    // A teacher is allowed to read a copy handed in to them, so the engine would answer 200:
    // their own keystrokes would land in their student's record.
    const { calls, storage, internals } = agent({
        stored: { config: PAIRED.config },
        document: wordDocument({ properties: CARRIED }),
        documents: { f9: 'Mémoire' },
        role: 'teacher',
    });

    assert.equal(await internals.resumeEngineDocument(UUID, SOURCE), null);
    assert.equal(storage.read('engineIds'), undefined);
    assert.equal(calls.filter((c) => c.url.includes('/api/documents/')).length, 0);
});

test('an id shaped like a route never reaches one', async () => {
    // The value is read out of a file, where whoever produced or last held it could have
    // written anything. A slash in it would not be an id: it would be another route, called
    // with the student's token.
    for (const forged of ['../auth/tokens', 'f9/metrics', '', 'f'.repeat(65)]) {
        const { calls, internals } = agent({
            stored: { config: PAIRED.config },
            document: wordDocument({ properties: { CertimensDocumentId: UUID, CertimensEngineDocument: forged } }),
        });

        assert.equal(await internals.resumeEngineDocument(UUID, SOURCE), null);
        assert.equal(calls.length, 0, `${forged} reached the engine`);
    }
});

test('a copy of a document does not take back the original\'s record', async () => {
    // Saved under another name, kept beside the original, sent back by a corrector: the file
    // carries the identity and the engine document of the one it was copied from. The engine
    // cannot tell the two apart — both are this student's — so the refusal lives here.
    const { storage, internals } = agent({
        stored: {
            config: PAIRED.config,
            engineIds: { [UUID]: 'f9' },
            engineSources: { [UUID]: 'https://sp.test/Documents/Original.docx' },
        },
        document: wordDocument({ properties: CARRIED }),
        documents: { f9: 'Mémoire' },
    });

    const id = await internals.documentId();

    assert.notEqual(id, UUID, 'the copy kept the original identity');
    assert.equal(await internals.resumeEngineDocument(id, SOURCE), null);
    assert.equal(storage.read('engineIds')[id], undefined);
});

test('the file is stamped with the document it feeds, once', async () => {
    const { properties, internals } = agent({ stored: PAIRED });

    await internals.stampEngineDocument('doc1');
    assert.equal(properties.CertimensEngineDocument, 'engine-1');

    // Every window close goes through here: what is already written is not written again.
    delete properties.CertimensEngineDocument;
    await internals.stampEngineDocument('doc1');
    assert.equal(properties.CertimensEngineDocument, undefined);
});

test('creating the document from the pane writes it into the file at once', async () => {
    const { properties, internals } = agent({ stored: { config: PAIRED.config } });

    const id = await internals.documentId();
    await internals.createFileFor(id, 'Mémoire', 'Mémoire');

    assert.equal(properties.CertimensEngineDocument, 'engine-1');
});

test('a host without custom properties keeps measuring, and does not travel', async () => {
    // Below WordApi 1.3 the identity falls back to the add-in's own settings, in a part of the
    // .docx no other editor reads: one agent, one record, as before.
    const { settings, properties, internals } = agent({
        stored: { config: PAIRED.config },
        document: wordDocument({ customProperties: false }),
    });

    const id = await internals.documentId();

    assert.match(id, /^[0-9a-f]{8}-/);
    assert.equal(settings.certimensDocumentId, id);
    assert.equal(await internals.resumeEngineDocument(id, SOURCE), null);
    await internals.stampEngineDocument(id);
    assert.deepEqual(properties, {});
});

test('a document Word will not answer for costs the measurement, not the pane', async () => {
    // Reading the identity is the first thing the pane does. A rejection there would leave the
    // student with no pane at all, for a file that is merely not measurable this time.
    const { internals } = agent({
        stored: { config: PAIRED.config },
        document: wordDocument({ properties: CARRIED, answers: false }),
    });

    const id = await internals.documentId();

    assert.match(id, /^[0-9a-f]{8}-/);
    assert.equal(await internals.resumeEngineDocument(id, SOURCE), null);
    await internals.stampEngineDocument(id);
});

test('an engine that refuses one measurement type loses only one generation at a time', async () => {
    // The extended metrics arrived in three batches, and a deployed engine may know the older
    // ones and ignore the newest. Dropping them all on the first refusal would take away
    // measurements it can read, and nobody would see it: on the engine's side, a measurement
    // never sent looks like a measurement the sensor cannot take.
    const { storage, calls, internals } = agent({
        stored: PAIRED,
        // This engine reads `focus_losses` and `injected_chars_max` (the two older generations)
        // but not `self_paste_chars_total`: it refuses as long as that one is there.
        metrics: (body) => (body.metrics.some((m) => m.type === 'self_paste_chars_total')
            ? json({ code: 'metric_type_unknown', error: 'unknown metric type' }, { status: 400 })
            : json(null)),
    });

    await internals.pushItem(internals.getConfig(), internals.getState(), WINDOW);

    assert.equal(storage.read('extendedDropped'), 1);
    // The window goes again without the newest generation, and the two older ones are still there.
    const sent = calls.filter((c) => c.url.endsWith('/metrics')).at(-1).body.metrics;
    assert.deepEqual(sent.map((m) => m.type).sort(),
        ['focus_losses', 'injected_chars_max', 'keystrokes_total']);
});

test('an engine that knows no generation drops them all, and nothing more', async () => {
    const { storage, calls, internals } = agent({
        stored: PAIRED,
        metrics: (body) => (body.metrics.length > 1
            ? json({ code: 'metric_type_unknown', error: 'unknown metric type' }, { status: 400 })
            : json(null)),
    });

    await internals.pushItem(internals.getConfig(), internals.getState(), WINDOW);

    assert.equal(storage.read('extendedDropped'), GENERATIONS);
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

    // `reason` comes after `offline`, and a window queued before this agent knew how to say it
    // omits the key rather than sending it empty — an empty string is a value outside the
    // engine's vocabulary, a missing key is an agent that did not say.
    await t.test('`reason` last, and absent rather than empty', async () => {
        const { calls, internals } = agent({ stored: PAIRED });

        await internals.pushItem(internals.getConfig(), internals.getState(), { ...WINDOW, flush: 'idle' });
        await internals.pushItem(internals.getConfig(), internals.getState(), { ...WINDOW, offline: true, flush: 'end' });
        await internals.pushItem(internals.getConfig(), internals.getState(), WINDOW);

        const sent = calls.filter((c) => c.url.endsWith('/metrics')).flatMap((c) => c.body.metrics);
        assert.deepEqual([...new Set(sent.map((m) => Object.keys(m).join(',')))].sort(), [
            'type,value,period',
            'type,value,period,offline,reason',
            'type,value,period,reason',
        ]);
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

// --- WHERE THE TOKEN MAY TRAVEL ---

test('the addresses an engine may be reached at', async (t) => {
    // The same table as the three other agents (tests/helpers/engine-url.mjs): `make check`
    // compares the four patterns character for character, and this says whether the pattern is
    // the right one.
    await t.test('https anywhere, http only where the request cannot leave the building', () => {
        const { internals } = agent();
        for (const url of ALLOWED) assert.equal(internals.engineUrlAllowed(url), true, url);
        for (const url of REFUSED) assert.equal(internals.engineUrlAllowed(url), false, url);
    });

    // This pane keeps the token in a localStorage it shares with every page GitHub Pages serves
    // from the same account (SECURITY.md). An address written there by one of them is refused
    // here rather than called.
    await t.test('and the client refuses to call one of the others', async () => {
        const { internals, calls } = agent();

        await assert.rejects(() => internals.startPairing('http://engine.example.fr'),
            (err) => err.code === 'engine_url_refused');
        assert.deepEqual(calls, [], 'nothing left the machine');
    });

    await t.test('including one already in the configuration', async () => {
        const { internals, calls } = agent({
            stored: { config: { engineUrl: 'http://engine.example.fr', token: 'a-token' } },
        });

        await assert.rejects(() => internals.pushItem(internals.getConfig(), internals.getState(), WINDOW),
            (err) => err.code === 'engine_url_refused');
        assert.deepEqual(calls, []);
    });
});
