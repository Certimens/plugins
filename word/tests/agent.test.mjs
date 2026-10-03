// Sending to the engine from the Word add-in (src/agent.js).
//
// What this file covers is what leaves, not the network: who the add-in says it is, which
// document a file feeds, and the body of a measurement — one shape, pinned here byte for byte,
// because the engine refuses anything else and a window refused is a window lost.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clock, load, officeGlobals } from './helpers/sandbox.mjs';
import { ALLOWED, REFUSED } from './helpers/engine-url.mjs';

const INTERNALS = ['startPairing', 'pollPairing', 'adoptToken', 'pushItem', 'getState', 'getConfig',
    'updatedVersion', 'engineUrlAllowed', 'documentId', 'resumeEngineDocument', 'stampEngineDocument',
    'startResume', 'createFileFor', 'enqueue', 'drain', 'countEvent', 'flushTelemetry', 'noteLaunch',
    'watchErrors', 'countRuntimeError', 'faultOf', 'logout', 'docInfo', 'documentName', 'startAgent',
    'movedDocumentPending', 'movedDocumentQuestion', 'settleRelocation', 'onDocumentIdChange', 'TELEMETRY_EVENTS', 'TELEMETRY_FLUSH_MS', 'TELEMETRY_MAX_COUNT', 'MAX_QUEUE',
    'reportLink', 'reportValues', 'reportBlock', 'REPORT_KEYS', 'REPORT_FRAGMENT'];
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

// The open Word document, as Office hands it over: its custom properties — where the identity
// and the engine document it feeds are written, under the names the LibreOffice agent reads —
// and the requirement set that decides whether they exist at all.
function wordDocument({ properties = {}, customProperties = true, answers = true, url = 'https://sp.test/Documents/Mémoire.docx',
    diagnostics = { host: 'Word', platform: 'PC', version: '16.0.18129.20158' } } = {}) {
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
            // Which Word this is, for the problem report: absent on a Word too old to say.
            ...(diagnostics ? { diagnostics } : {}),
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
    documents = {}, documentStatus = 0, role = 'student', document: doc = wordDocument(),
    telemetry = () => json(null, { status: 204 }), down = false, creation = () => null } = {}) {
    const time = clock();
    const storage = fakeStorage(stored);
    const calls = [];
    // What the pane listens for on its window: its uncaught errors.
    const windowListeners = new Map();
    const fetchStub = (url, init) => {
        const body = init.body ? JSON.parse(init.body) : null;
        // `raw` is the body as it left: the key order and the absence of indentation are part
        // of the contract, and neither survives being parsed.
        calls.push({ url, method: init.method, body, raw: init.body, headers: init.headers || {} });
        // No network at all: what a fetch does offline, or on a DNS or TLS failure.
        if (down) return Promise.reject(new TypeError('Failed to fetch'));
        if (url.endsWith('/api/plugins/telemetry')) return Promise.resolve(telemetry(body));
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
        // A creation the test wants refused; otherwise it is created like any other document.
        const refused = init.method === 'POST' && url.endsWith('/api/documents') ? creation(body) : null;
        return Promise.resolve(refused || json({ id: 'engine-1' }));
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
        currentLanguage: () => 'en',
        window: { addEventListener: (type, fn) => windowListeners.set(type, fn) },
        location: { origin: 'https://certimens.github.io', href: 'https://certimens.github.io/plugins/word/taskpane.html' },
        navigator: { onLine: true },
    };
    return { storage, calls, time, windowListeners, properties: doc.props, settings: doc.settings,
        // report.js before agent.js, as taskpane.html lists them: a link into the extension, and
        // the same block its service worker builds.
        internals: load([new URL('../src/report.js', import.meta.url), new URL('../src/agent.js', import.meta.url)],
            { globals, expose: INTERNALS }) };
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

// One sealed window, as the sensor queues it: where it goes (the document, its name), then the
// window itself, under the names the engine reads.
const WINDOW = {
    documentId: 'doc1',
    documentName: 'Mémoire.docx',
    session: 'p3Vq0hJmR2aXw9LkT1yZ5g',
    seq: 4,
    at: 1794478471120,
    mono: 61050,
    ms: 2000,
    why: 'idle',
    active: 1800,
    runs: [['gap', 5750], ['type', 12, 0], ['move', 2], ['paste', 73], ['self', 40], ['other', 1, 0]],
    counts: { corrections: 1, reformulations: 0, revisions: 1, jumps: 2 },
    text: { len: 96, since: 3, at: 11, cut: 0, add: 85, kept: 0 },
    sum: { keys: 40, chars: 73, pastes: 1 },
};

const PAIRED = { signedIn: true, engineIds: { doc1: 'engine-1' }, config: { engineUrl: 'https://engine.test', token: 'api-token' } };

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
    // An answer, not a refusal: nothing is counted (SELF-TELEMETRY).
    assert.equal(storage.read('telemetry'), undefined);
});

test('a document that no longer exists is not taken back', async () => {
    const { storage, internals } = agent({
        stored: { config: PAIRED.config },
        document: wordDocument({ properties: CARRIED }),
    });

    assert.equal(await internals.resumeEngineDocument(UUID, SOURCE), null);
    assert.equal(storage.read('engineIds'), undefined);
    assert.equal(storage.read('telemetry'), undefined);
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

// --- renamed or moved, or a copy ---
//
// `mémoire.docx` renamed `mémoire_v2.docx` presents the identity it has always carried from a
// location it was never bound to, exactly as a copy kept beside the original does. Word cannot
// tell the two apart, so the student is asked — and until they answer, nothing of the file
// leaves: a window sent before the answer would have had to go to one record or the other.
test('a file renamed or moved, or a copy', async (t) => {
    const ORIGINAL = 'https://sp.test/Documents/Original.docx';
    const MOVED = {
        config: PAIRED.config,
        signedIn: true,
        engineIds: { [UUID]: 'f9' },
        engineSources: { [UUID]: ORIGINAL },
    };
    const opened = (options = {}) => agent({
        stored: MOVED,
        document: wordDocument({ properties: CARRIED }),
        documents: { f9: 'Original' },
        ...options,
    });
    // Everything the add-in left in storage, to open the same file again in another pane.
    const left = (storage) => Object.fromEntries([...storage.map]
        .map(([key, value]) => [key.slice(PREFIX.length), JSON.parse(value)]));
    const created = (calls) => calls.filter((c) => c.method === 'POST' && c.url.endsWith('/api/documents'));
    const pushedTo = (calls) => pushes(calls).map((c) => [c.url.split('/').at(-2), c.body.windows.map((w) => w.seq)]);

    await t.test('the question is asked only of a file bound elsewhere', async () => {
        // In place, the file is its own document: nothing to ask.
        const { internals } = opened({ stored: { ...MOVED, engineSources: { [UUID]: SOURCE } } });
        assert.equal(await internals.documentId(), UUID);
        assert.equal(internals.movedDocumentPending(), false);
        assert.equal(await internals.movedDocumentQuestion(), null);
    });

    await t.test('nothing measured before the answer leaves', async () => {
        const { calls, storage, internals } = opened();
        const id = await internals.documentId();
        assert.notEqual(id, UUID);
        assert.equal(internals.movedDocumentPending(), true);

        await internals.enqueue({ ...WINDOW, documentId: id, seq: 0 });
        await internals.enqueue({ ...WINDOW, documentId: id, seq: 1 });

        assert.deepEqual(pushes(calls), []);
        assert.deepEqual(created(calls), [], 'a record was opened before the student answered');
        assert.equal(storage.read('queue').length, 2, 'the windows wait');
    });

    await t.test('the question names the record the file would rejoin', async () => {
        const { internals } = opened();
        await internals.documentId();
        // The name the engine holds, and the file the identity was last seen as.
        assert.deepEqual({ ...await internals.movedDocumentQuestion() }, { name: 'Original', previous: 'Original' });
    });

    await t.test('an engine out of reach still asks, without the name', async () => {
        const { internals } = opened({ down: true });
        await internals.documentId();
        assert.deepEqual({ ...await internals.movedDocumentQuestion() }, { name: '', previous: 'Original' });
        // "Same" needs the engine's word on whose record it is: nothing is decided without it.
        await assert.rejects(() => internals.settleRelocation(true));
        assert.equal(internals.movedDocumentPending(), true);
    });

    await t.test('the same document: its windows go on into its record', async () => {
        const { calls, storage, properties, internals } = opened();
        const id = await internals.documentId();
        const followed = [];
        internals.onDocumentIdChange((docId) => followed.push(docId));
        await internals.enqueue({ ...WINDOW, documentId: id, seq: 0 });
        await internals.enqueue({ ...WINDOW, documentId: id, seq: 1 });

        const settled = await internals.settleRelocation(true);
        await internals.drain();

        assert.equal(settled.docId, UUID);
        assert.equal(settled.file.name, 'Original');
        // The pane and its sensor measure under the original identity from now on.
        assert.deepEqual(followed, [UUID]);
        assert.equal(await internals.documentId(), UUID);
        assert.equal(internals.movedDocumentPending(), false);
        // No new identity in the file, no second record, and the windows sealed before the
        // answer in the original one.
        assert.equal(properties.CertimensDocumentId, UUID);
        assert.deepEqual(created(calls), [], 'a second record was opened');
        assert.deepEqual(pushedTo(calls), [['f9', [0]], ['f9', [1]]]);
        assert.equal(storage.read('queue').length, 0);
        // The binding moved with the file, and the record is renamed after it.
        assert.equal(storage.read('engineSources')[UUID], SOURCE);
        assert.equal(storage.read('engineSources')[id], undefined);
        assert.ok(calls.some((c) => c.method === 'PUT' && c.url.endsWith('/api/documents/f9') && c.body.name === 'Mémoire'),
            'the record kept its old name');

        // Opened again, the file is simply where its identity is bound: nothing to ask.
        const again = agent({ stored: left(storage), document: wordDocument({ properties: { ...properties } }) });
        assert.equal(await again.internals.documentId(), UUID);
        assert.equal(again.internals.movedDocumentPending(), false);
    });

    await t.test('a location answered for as the same document follows without a word', async () => {
        const { storage, internals } = opened({ stored: { ...MOVED, relocations: { [UUID]: { [SOURCE]: 'same' } } } });
        assert.equal(await internals.documentId(), UUID);
        assert.equal(internals.movedDocumentPending(), false);
        assert.equal(storage.read('engineSources')[UUID], SOURCE);
    });

    await t.test('a copy: what happened before the question existed', async () => {
        const { calls, storage, properties, internals } = opened();
        const id = await internals.documentId();
        await internals.enqueue({ ...WINDOW, documentId: id, seq: 0 });

        const settled = await internals.settleRelocation(false);
        await internals.drain();

        assert.equal(settled.docId, id);
        assert.equal(settled.refused, false);
        assert.equal(properties.CertimensDocumentId, id);
        assert.equal(created(calls).length, 1);
        assert.deepEqual(pushedTo(calls), [['engine-1', [0]]]);
        assert.equal(storage.read('engineIds')[UUID], 'f9', 'the original lost its record');
        assert.equal(storage.read('engineSources')[UUID], ORIGINAL);
        assert.equal(await internals.resumeEngineDocument(id, SOURCE), null);

        // The answer is kept: even a file left unsaved, still carrying the original identity,
        // is not asked about again at this location.
        const again = agent({ stored: left(storage), document: wordDocument({ properties: CARRIED }) });
        assert.notEqual(await again.internals.documentId(), UUID);
        assert.equal(again.internals.movedDocumentPending(), false);
    });

    await t.test('no answer is a copy', async () => {
        const { calls, internals, windowListeners } = opened();
        const id = await internals.documentId();
        internals.startAgent();
        await internals.enqueue({ ...WINDOW, documentId: id, seq: 0 });
        assert.deepEqual(pushes(calls), []);

        windowListeners.get('pagehide')();      // the document closed, the question unanswered
        await internals.drain();

        assert.equal(internals.movedDocumentPending(), false);
        assert.equal(created(calls).length, 1);
        assert.deepEqual(pushedTo(calls), [['engine-1', [0]]]);
    });

    await t.test('a pane gone without a word holds nothing for ever', async () => {
        // Another pane drains a queue where a hold has run out — long before the test's clock —
        // and its windows leave as a copy's.
        const { calls, internals } = agent({
            stored: { ...PAIRED, held: { 'p-1': 1000 }, queue: [{ ...WINDOW, documentId: 'p-1', id: 'w1' }] },
        });
        await internals.drain();
        assert.deepEqual(pushedTo(calls), [['engine-1', [4]]]);
    });

    await t.test('a held window does not hold up the other documents', async () => {
        const { calls, storage, internals } = agent({
            stored: {
                ...PAIRED,
                held: { 'p-1': Number.MAX_SAFE_INTEGER },
                queue: [{ ...WINDOW, documentId: 'p-1', id: 'w1' }, { ...WINDOW, id: 'w2' }],
            },
        });
        await internals.drain();
        assert.deepEqual(pushedTo(calls), [['engine-1', [4]]]);
        assert.deepEqual(storage.read('queue').map((item) => item.id), ['w1']);
    });

    await t.test('a record that is not this account\'s cannot be rejoined', async () => {
        // The identity travels inside the file: the engine's ownership check stays the
        // authorisation, whatever the student answers.
        const asked = opened({ documentStatus: 403 });
        const id = await asked.internals.documentId();
        assert.equal(await asked.internals.movedDocumentQuestion(), null, 'asked about somebody else\'s record');
        assert.equal(asked.internals.movedDocumentPending(), false);
        await asked.internals.enqueue({ ...WINDOW, documentId: id, seq: 0 });
        assert.deepEqual(pushedTo(asked.calls), [['engine-1', [0]]]);

        const answered = opened({ documentStatus: 403 });
        const other = await answered.internals.documentId();
        const settled = await answered.internals.settleRelocation(true);
        assert.equal(settled.docId, other);
        assert.equal(settled.refused, true);
        assert.equal(answered.properties.CertimensDocumentId, other);
        assert.equal(answered.storage.read('engineSources')[UUID], ORIGINAL);
        assert.equal(answered.storage.read('relocations'), undefined, 'a refusal was remembered as an answer');
    });

    await t.test('too late: the provisional identity already has its record', async () => {
        // The hold ran out — a pane put to sleep long enough — and a window opened a record.
        const { calls, storage, internals } = opened();
        const id = await internals.documentId();
        storage.setItem(PREFIX + 'engineIds', JSON.stringify({ ...storage.read('engineIds'), [id]: 'engine-1' }));
        const settled = await internals.settleRelocation(true);
        assert.equal(settled.refused, true);
        assert.equal(settled.docId, id);
        assert.equal(storage.read('engineSources')[UUID], ORIGINAL);
        assert.deepEqual(pushes(calls), []);
    });

    await t.test('signing out ends the question: what waited leaves first, as a copy', async () => {
        const { calls, internals } = opened();
        const id = await internals.documentId();
        await internals.enqueue({ ...WINDOW, documentId: id, seq: 0 });
        await internals.logout();
        assert.equal(internals.movedDocumentPending(), false);
        assert.deepEqual(pushedTo(calls), [['engine-1', [0]]]);
    });
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

// --- the body ---
//
// What is pinned here is what the engine reads: the bytes, in their order. The vocabulary is
// closed — an unknown key is a refusal — so a key that moves or appears is a change of contract.

// A window of the same session, `seq` places further on.
const windowAt = (seq, extra = {}) => ({ ...WINDOW, seq, at: WINDOW.at + seq * 60000, mono: seq * 60000, ...extra });

const pushes = (calls) => calls.filter((c) => c.url.endsWith('/metrics'));

test('the body of a measurement is these bytes', async (t) => {
    await t.test('a window measured with the engine in reach leaves alone, in this order', async () => {
        const { calls, internals } = agent({ stored: PAIRED });

        await internals.pushItem(internals.getConfig(), internals.getState(), WINDOW);

        assert.equal(pushes(calls)[0].raw, '{"session":"p3Vq0hJmR2aXw9LkT1yZ5g","sent":1000000,'
            + '"unseen":["hesitations"],"windows":[{"seq":4,"at":1794478471120,"mono":61050,"ms":2000,'
            + '"why":"idle","active":1800,'
            + '"runs":[["gap",5750],["type",12,0],["move",2],["paste",73],["self",40],["other",1,0]],'
            + '"counts":{"corrections":1,"reformulations":0,"revisions":1,"jumps":2},'
            + '"text":{"len":96,"since":3,"at":11,"cut":0,"add":85,"kept":0},'
            + '"sum":{"keys":40,"chars":73,"pastes":1}}]}');
    });

    // Word delivers no keystroke: a silence under three seconds is never recorded, and the
    // engine must not read that absence as a writer who never searched for a word.
    await t.test('every request says what this sensor cannot see', async () => {
        const { calls, internals } = agent({ stored: PAIRED });

        await internals.pushItem(internals.getConfig(), internals.getState(), WINDOW, [windowAt(5)]);

        assert.deepEqual(pushes(calls)[0].body.unseen, ['hesitations']);
        assert.equal(Object.keys(pushes(calls)[0].body).join(','), 'session,sent,unseen,windows');
    });

    await t.test('`offline` between the reason and the effective time, and only when it is true', async () => {
        const { calls, internals } = agent({ stored: PAIRED });

        await internals.pushItem(internals.getConfig(), internals.getState(), { ...WINDOW, offline: true });
        await internals.pushItem(internals.getConfig(), internals.getState(), WINDOW);

        const [late, live] = pushes(calls).map((c) => Object.keys(c.body.windows[0]).join(','));
        assert.equal(late, 'seq,at,mono,ms,why,offline,active,runs,counts,text,sum');
        assert.equal(live, 'seq,at,mono,ms,why,active,runs,counts,text,sum');
    });

    // This sensor sees neither a key going down nor the document losing focus: no rhythm, no
    // departure, nothing dated from a return. Absent, never zero.
    await t.test('what Word cannot measure is in no window', async () => {
        const { calls, internals } = agent({ stored: PAIRED });

        await internals.pushItem(internals.getConfig(), internals.getState(),
            { ...WINDOW, flight: { med: 1, mad: 1, bins: [] }, dwell: { bins: [], rollover: 0 },
              counts: { ...WINDOW.counts, exits: 0, back_keys: 0, back_chars: 0 } });

        const [window] = pushes(calls)[0].body.windows;
        assert.ok(!('flight' in window) && !('dwell' in window));
        assert.deepEqual(Object.keys(window.counts), ['corrections', 'reformulations', 'revisions', 'jumps']);
    });

    await t.test('a first reading gives its size alone, and nothing is ever sent empty', async () => {
        const { calls, internals } = agent({ stored: PAIRED });

        await internals.pushItem(internals.getConfig(), internals.getState(), { ...WINDOW, text: { len: 96 } });

        assert.ok(pushes(calls)[0].raw.includes('"text":{"len":96},"sum"'));
        assert.ok(!pushes(calls)[0].raw.includes('null'));
    });

    await t.test('`kept` is left out when the sensor did not work it out', async () => {
        const { calls, internals } = agent({ stored: PAIRED });
        const text = { len: 9181, since: 3, at: 11, cut: 9000, add: 9085 };

        await internals.pushItem(internals.getConfig(), internals.getState(), { ...WINDOW, text });

        assert.equal(Object.keys(pushes(calls)[0].body.windows[0].text).join(','), 'len,since,at,cut,add');
    });

    await t.test('the order is rebuilt, whatever the queue hands back', async () => {
        // The window comes out of storage, which promises nothing about the order of its keys.
        const { calls, internals } = agent({ stored: PAIRED });
        const scrambled = {
            sum: { pastes: 1, chars: 73, keys: 40 },
            text: { kept: 0, add: 85, cut: 0, at: 11, since: 3, len: 96 },
            counts: { jumps: 2, revisions: 1, reformulations: 0, corrections: 1 },
            runs: WINDOW.runs, active: 1800, why: 'idle', ms: 2000, mono: 61050,
            at: WINDOW.at, seq: 4, session: WINDOW.session,
            documentName: 'Mémoire.docx', documentId: 'doc1',
        };

        await internals.pushItem(internals.getConfig(), internals.getState(), scrambled);
        await internals.pushItem(internals.getConfig(), internals.getState(), WINDOW);

        const [first, second] = pushes(calls);
        assert.equal(first.raw, second.raw);
    });

    await t.test('`sent` is the clock at each attempt, not at the sealing', async () => {
        // The first attempt meets a document deleted on the engine side: it is created again,
        // and the window leaves a second time — with the clock of that second time.
        let missing = 1;
        const { calls, time, internals } = agent({
            stored: PAIRED,
            metrics: () => {
                time.advance(30);
                return missing-- > 0 ? json({ error: 'not found' }, { status: 404 }) : json(null);
            },
        });

        await internals.pushItem(internals.getConfig(), internals.getState(), WINDOW);

        const [first, second] = pushes(calls).map((c) => c.body.sent);
        assert.equal(first, 1_000_000);
        assert.equal(second - first, 30000);
        assert.equal(calls.filter((c) => c.method === 'POST' && c.url.endsWith('/api/documents')).length, 1);
    });
});

// There is one body. Whatever the engine answers, the add-in does not look for another one to
// send: a refusal is this window being refused, and it is the caller's to drop.
test('no refusal makes the add-in send anything else', async (t) => {
    for (const code of ['invalid_body', 'unknown_field', 'metric_value_invalid']) {
        await t.test(`400 ${code} is a refusal, tried once`, async () => {
            const { calls, storage, internals } = agent({
                stored: PAIRED,
                metrics: () => json({ code, error: 'refused' }, { status: 400 }),
            });

            await assert.rejects(() => internals.pushItem(internals.getConfig(), internals.getState(), WINDOW));
            await assert.rejects(() => internals.pushItem(internals.getConfig(), internals.getState(), WINDOW));

            const sent = pushes(calls);
            assert.equal(sent.length, 2, 'one request per push, no second try');
            assert.equal(sent[0].raw, sent[1].raw);
            assert.deepEqual(Object.keys(sent[1].body), ['session', 'sent', 'unseen', 'windows']);
            // And nothing is remembered about the engine that refused — the refusal is counted
            // (SELF-TELEMETRY), which says nothing about that engine.
            assert.deepEqual([...storage.map.keys()].sort(), ['certimens.config', 'certimens.engineIds', 'certimens.signedIn', 'certimens.telemetry']);
            assert.deepEqual(storage.read('telemetry'), { 'error.rejected': 2 });
        });
    }

    await t.test('a document that stays missing is given up on after one new document', async () => {
        const { calls, internals } = agent({
            stored: PAIRED,
            metrics: () => json({ error: 'not found' }, { status: 404 }),
        });

        await assert.rejects(() => internals.pushItem(internals.getConfig(), internals.getState(), WINDOW));

        assert.equal(pushes(calls).length, 2);
    });
});

// The queue is one `localStorage`, shared by every document open in this Word, and whichever
// pane holds the lease drains all of it — its own windows and the others'.
test('a queue filled offline is caught up in batches', async (t) => {
    const queued = (windows) => windows.map((window, i) => ({ ...window, id: `w${i}` }));
    const late = (seq, extra) => windowAt(seq, { offline: true, ...extra });
    const seqs = (calls) => pushes(calls).map((c) => c.body.windows.map((w) => w.seq));

    await t.test('at most 64 windows of one session per request, in the order they were sealed', async () => {
        const windows = Array.from({ length: 70 }, (_, seq) => late(seq));
        const { calls, storage, internals } = agent({ stored: { ...PAIRED, queue: queued(windows) } });

        await internals.drain();

        assert.deepEqual(seqs(calls).map((batch) => batch.length), [64, 6]);
        assert.deepEqual(seqs(calls).flat(), windows.map((window) => window.seq));
        assert.ok(pushes(calls).every((c) => c.body.windows.every((w) => w.offline === true)));
        assert.deepEqual(storage.read('queue'), []);
    });

    await t.test('windows measured with the engine in reach leave one at a time', async () => {
        const { calls, internals } = agent({ stored: { ...PAIRED, queue: queued([windowAt(0), windowAt(1), late(2), late(3)]) } });

        await internals.drain();

        assert.deepEqual(seqs(calls), [[0], [1], [2, 3]]);
    });

    await t.test('two panes are two sessions, and never share a request', async () => {
        // Two documents measured at once fill the one queue in turns. Each pane numbered its
        // own windows, in its own memory: the numbers repeat, the sessions do not.
        const other = { session: 'B'.repeat(22), documentId: 'doc2' };
        const windows = [late(0), late(1), late(0, other), late(2), late(1, other), late(2, other)];
        const { calls, internals } = agent({
            stored: { ...PAIRED, engineIds: { doc1: 'engine-1', doc2: 'engine-2' }, queue: queued(windows) },
        });

        await internals.drain();

        const sent = pushes(calls);
        assert.deepEqual(seqs(calls), [[0, 1], [0], [2], [1, 2]]);
        assert.deepEqual(sent.map((c) => c.body.session === WINDOW.session), [true, false, true, false]);
        assert.deepEqual(sent.map((c) => c.url.split('/').at(-2)), ['engine-1', 'engine-2', 'engine-1', 'engine-2']);
        for (const session of [WINDOW.session, other.session]) {
            const own = sent.filter((c) => c.body.session === session).flatMap((c) => c.body.windows.map((w) => w.seq));
            assert.deepEqual(own, [0, 1, 2]);
        }
    });

    await t.test('the same session on two documents is never one request either', async () => {
        const { calls, internals } = agent({
            stored: { ...PAIRED, engineIds: { doc1: 'engine-1', doc2: 'engine-2' },
                      queue: queued([late(0), late(1, { documentId: 'doc2' })]) },
        });

        await internals.drain();

        assert.deepEqual(seqs(calls), [[0], [1]]);
    });

    await t.test('a window the engine refuses costs the batch nothing but itself', async () => {
        const windows = Array.from({ length: 5 }, (_, seq) => late(seq));
        const { calls, storage, internals } = agent({
            stored: { ...PAIRED, queue: queued(windows) },
            metrics: (body) => (body.windows.some((w) => w.seq === 2)
                ? json({ code: 'metric_value_invalid', error: 'refused' }, { status: 400 })
                : json(null)),
        });

        await internals.drain();

        const accepted = pushes(calls).filter((c) => !c.body.windows.some((w) => w.seq === 2));
        assert.deepEqual(accepted.flatMap((c) => c.body.windows.map((w) => w.seq)), [0, 1, 3, 4]);
        assert.deepEqual(storage.read('queue'), []);
        assert.equal(storage.read('status').state, 'synced');
    });

    await t.test('a number the engine already holds with another instant does not block the queue', async () => {
        const { calls, storage, internals } = agent({
            stored: { ...PAIRED, queue: queued([windowAt(0), windowAt(1)]) },
            metrics: (body) => (body.windows[0].seq === 0
                ? json({ code: 'conflict', error: 'conflict' }, { status: 409 })
                : json(null)),
        });

        await internals.drain();

        assert.deepEqual(seqs(calls), [[0], [1]]);
        assert.deepEqual(storage.read('queue'), []);
    });

    await t.test('an engine out of reach keeps every window, and what left does not leave twice', async () => {
        let reachable = true;
        const windows = Array.from({ length: 70 }, (_, seq) => late(seq));
        const { calls, storage, internals } = agent({
            stored: { ...PAIRED, queue: queued(windows) },
            metrics: () => {
                if (reachable) {
                    reachable = false;
                    return json(null);
                }
                return json({ error: 'unavailable' }, { status: 503 });
            },
        });

        await internals.drain();
        assert.equal(storage.read('queueSent'), 'w63');
        assert.equal(storage.read('status').state, 'offline');

        reachable = true;
        calls.length = 0;
        await internals.drain();
        assert.deepEqual(seqs(calls), [[64, 65, 66, 67, 68, 69]]);
    });

    // The queue outlives the code that filled it. An entry that is not a window this build can
    // send has no body to be turned into: it is dropped, and costs the others nothing.
    await t.test('an entry in any other shape is dropped, and the windows around it leave', async () => {
        const strangers = [
            { documentId: 'doc1', documentName: 'Mémoire.docx', values: { keystrokes_total: 5 },
              period: { start: '2026-10-09T08:00:00.000Z', end: '2026-10-09T08:00:02.000Z' } },
            { ...WINDOW, runs: [] },
            { ...WINDOW, runs: undefined },
            { ...WINDOW, at: '2026-10-09T08:00:00.000Z' },
            null,
        ];
        const queue = queued([windowAt(0), ...strangers.slice(0, 2), windowAt(1), ...strangers.slice(2), windowAt(2)]);
        const { calls, storage, internals } = agent({ stored: { ...PAIRED, queue } });

        assert.equal(internals.getState().queue.length, 3);
        await internals.drain();

        assert.deepEqual(seqs(calls), [[0], [1], [2]]);
        assert.deepEqual(storage.read('queue'), []);
        assert.equal(storage.read('status').state, 'synced');
    });

    await t.test('a queue holding nothing else is emptied by the next window measured', async () => {
        const { calls, storage, internals } = agent({
            stored: { ...PAIRED, queue: [{ id: 'old', documentId: 'doc1', values: { keystrokes_total: 5 } }] },
        });

        await internals.drain();
        assert.equal(pushes(calls).length, 0);

        await internals.enqueue(WINDOW);
        assert.deepEqual(seqs(calls), [[4]]);
        assert.deepEqual(storage.read('queue'), []);
    });
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

// --- WHAT THE AGENT SAYS OF ITSELF ---
//
// docs/moteur.md, "Ce que l'agent dit de lui-même": counters of a closed vocabulary, persisted,
// sent at most every fifteen minutes when paired, reset on a 204 alone. The same cases as the
// three other agents' suites (browser/tests/background.test.mjs, vscode/tests/engine.test.mjs,
// libreoffice/tests/test_engine.py).

const telemetryCalls = (calls) => calls.filter((c) => c.url.endsWith('/api/plugins/telemetry'));
const counters = (storage) => ({ ...(storage.read('telemetry') || {}) });
const answer = (status) => () => json(null, { status });

test('what the add-in counts about itself', async (t) => {
    await t.test('the vocabulary is the contract\'s, in its order', () => {
        const { internals } = agent();
        assert.deepEqual([...internals.TELEMETRY_EVENTS], ['installed', 'updated', 'started', 'error.runtime',
            'error.engine', 'error.rejected', 'error.auth', 'network.failure', 'queue.dropped']);
        assert.equal(internals.TELEMETRY_FLUSH_MS, 15 * 60 * 1000);
        assert.equal(internals.TELEMETRY_MAX_COUNT, 10000);
    });

    await t.test('a word of the vocabulary is counted and kept; anything else is not', () => {
        const { internals, storage } = agent();
        internals.countEvent('error.engine');
        internals.countEvent('error.engine');
        internals.countEvent('TypeError: le texte de l’étudiant');
        assert.deepEqual(counters(storage), { 'error.engine': 2 });
    });

    await t.test('each count stops at the cap', () => {
        const { internals, storage } = agent({ stored: { telemetry: { 'error.runtime': 9999 } } });
        for (let i = 0; i < 3; i++) internals.countEvent('error.runtime');
        assert.equal(counters(storage)['error.runtime'], 10000);
    });

    await t.test('a first opening is an install, every opening a start', () => {
        const { internals, storage } = agent();
        internals.noteLaunch();
        internals.noteLaunch();
        assert.deepEqual(counters(storage), { installed: 1, started: 2 });
    });

    await t.test('a build that changed is an update', () => {
        const { internals, storage } = agent({ stored: { telemetryVersion: '1.0.0' } });
        internals.noteLaunch();
        assert.deepEqual(counters(storage), { updated: 1, started: 1 });
    });

    await t.test('an add-in in use before it counted anything is updated, not installed', () => {
        for (const key of ['seenVersion', 'config']) {
            const { internals, storage } = agent({ stored: { [key]: key === 'config' ? { engineUrl: 'https://engine.test' } : '1.0.0' } });
            internals.noteLaunch();
            assert.deepEqual(counters(storage), { updated: 1, started: 1 }, key);
        }
    });

    await t.test('the work\'s calls count what the engine answered, or that it did not', async () => {
        const cases = [
            [{ down: true }, 'network.failure'],
            [{ metrics: () => json({ error: 'down' }, { status: 503 }) }, 'error.engine'],
            [{ metrics: () => json({ error: 'refused' }, { status: 409 }) }, 'error.rejected'],
            [{ metrics: () => json({ error: 'token' }, { status: 401 }) }, 'error.auth'],
        ];
        for (const [options, event] of cases) {
            const { internals, storage } = agent({ stored: PAIRED, ...options });
            await assert.rejects(() => internals.pushItem(internals.getConfig(), internals.getState(), WINDOW));
            assert.deepEqual(counters(storage), { [event]: 1 }, event);
        }
    });

    await t.test('a pairing still waiting for its confirmation is not a refusal', async () => {
        for (const answer of [json({ code: 'device_authorization_pending', error: 'pending' }, { status: 400 }),
            json({ code: 'device_slow_down', error: 'slow' }, { status: 400 }), json({ error: 'too many' }, { status: 429 })]) {
            const { internals, storage } = agent({ devicePoll: () => answer });
            const pairing = { engineUrl: 'https://engine.test', deviceCode: 'd', interval: 5000 };
            assert.equal(await internals.pollPairing(pairing), null);
            assert.deepEqual(counters(storage), {}, String(answer.status));
        }
    });

    await t.test('a document looked up and gone is an answer, not a refusal', async () => {
        const { internals, storage } = agent({ stored: PAIRED });
        assert.equal((await internals.docInfo('doc1')).engineId, null);
        assert.deepEqual(counters(storage), {});
    });

    await t.test('what the add-in refuses itself, without calling the engine, is counted nowhere', async () => {
        const { internals, storage, calls } = agent({ stored: { config: { engineUrl: 'http://8.8.8.8', token: 't' } } });
        await assert.rejects(() => internals.startPairing('http://8.8.8.8'));
        assert.equal(calls.length, 0);
        assert.deepEqual(counters(storage), {});
    });

    await t.test('a window a full queue pushes out is counted', async () => {
        const queue = Array.from({ length: 5000 }, (_, i) => ({ ...WINDOW, id: `w${i}` }));
        const { internals, storage } = agent({ stored: { queue, signedIn: true } });
        await internals.enqueue(WINDOW);
        assert.equal(storage.read('queue').length, internals.MAX_QUEUE);
        assert.deepEqual(counters(storage), { 'queue.dropped': 1 });
    });

    // The pane is the add-in's page, but Office.js runs in it too, from Microsoft's CDN.
    await t.test('the pane\'s own uncaught errors, and not Office.js\'s', () => {
        const { internals, storage, windowListeners } = agent();
        internals.watchErrors();
        const onError = windowListeners.get('error');
        const onRejection = windowListeners.get('unhandledrejection');
        onError({ filename: 'https://certimens.github.io/plugins/word/taskpane.js', message: 'boom' });
        onError({ filename: 'https://appsforoffice.microsoft.com/lib/1/hosted/office.js', message: 'boom' });
        // A cross-origin script, as the browser reports it: no detail at all.
        onError({ filename: '', message: 'Script error.' });
        // Another site that merely names ours in its address is not ours.
        onError({ filename: 'https://certimens.github.io.example.net/x.js', message: 'boom' });
        onRejection({ reason: { stack: 'Error: x\n    at drain (https://certimens.github.io/plugins/word/agent.js:10:5)' } });
        onRejection({ reason: { stack: 'Error: x\n    at e (https://appsforoffice.microsoft.com/lib/1/hosted/word-win32-16.01.js:1:1)' } });
        onRejection({ reason: 'a string, from nowhere in particular' });
        assert.deepEqual(counters(storage), { 'error.runtime': 2 });
    });
});

// Values from the add-in's realm, compared as data.
const plain = (value) => JSON.parse(JSON.stringify(value));
const BASE = 'https://certimens.github.io/plugins/word/';

// Where the add-in's code broke (`faultOf`): its own frames, as positions in its published
// source, and nothing else a stack carries.
test('a fault is where our code broke, and nothing else', async (t) => {
    const { internals } = agent();

    await t.test('V8: our frames, innermost first, without the message or the address', () => {
        const stack = [
            'TypeError: Cannot read properties of undefined (reading \'Mon mémoire\')',
            `    ${BASE}agent.js:1:1 is quoted in a message line, which is never read`,
            `    at flushTelemetry (${BASE}agent.js:1520:15)`,
            '    at https://appsforoffice.microsoft.com/lib/1/hosted/word-win32-16.01.js:10:2',
            '    at async Promise.all (index 0)',
            `    at new Queue (${BASE}agent.js:40:9)`,
            `    at ${BASE}taskpane.js:387:5`,
        ].join('\n');
        assert.deepEqual(plain(internals.faultOf('TypeError', stack, BASE)), {
            type: 'TypeError',
            frames: ['flushTelemetry@agent.js:1520:15', 'Queue@agent.js:40:9', 'taskpane.js:387:5'],
        });
    });

    await t.test('Safari and Firefox: the same, from their dialect', () => {
        const stack = `flush@${BASE}agent.js:323:15\nasync*drain@${BASE}agent.js:12:3\nlisten/<@${BASE}taskpane.js:16:13\n@https://example.org/a.js:1:1\n`;
        assert.deepEqual(plain(internals.faultOf('RangeError', stack, BASE).frames),
            ['flush@agent.js:323:15', 'drain@agent.js:12:3', 'taskpane.js:16:13']);
    });

    await t.test('a type that is not a name, a file in a folder, an inline script, no stack', () => {
        assert.equal(internals.faultOf('Cannot read \'Mon mémoire\'', '', BASE).type, 'Other');
        assert.deepEqual(plain(internals.faultOf('Error',
            `Error\n    at f (${BASE}lib/x.js:1:1)\n    at h (${BASE}taskpane.html:9:1)\n    at g (${BASE}x.js:2:2)`, BASE).frames), ['g@x.js:2:2']);
        assert.deepEqual(plain(internals.faultOf('Error', undefined, BASE).frames), []);
    });

    await t.test('at most a dozen frames', () => {
        const stack = 'Error\n' + Array.from({ length: 20 }, (_, i) => `    at f${i} (${BASE}agent.js:${i + 1}:1)`).join('\n');
        assert.equal(internals.faultOf('Error', stack, BASE).frames.length, 12);
    });
});

test('counting a fault', async (t) => {
    const boom = () => {
        const error = new TypeError('le texte de l’étudiant');
        error.stack = `TypeError: le texte de l’étudiant\n    at flush (${BASE}agent.js:323:15)`;
        return error;
    };

    await t.test('counted as error.runtime, kept once with its count, without the message', () => {
        const { internals, storage } = agent();
        internals.countRuntimeError(boom());
        internals.countRuntimeError(boom());
        assert.deepEqual(counters(storage), { 'error.runtime': 2 });
        assert.deepEqual(plain(storage.read('telemetryFaults')), [{ type: 'TypeError', frames: ['flush@agent.js:323:15'], count: 2 }]);
        assert.doesNotMatch(JSON.stringify(storage.read('telemetryFaults')), /étudiant/);
    });

    await t.test('ten distinct faults at most; the eleventh is still counted', () => {
        const { internals, storage } = agent();
        for (let i = 1; i <= 11; i++) {
            const error = new Error('x');
            error.stack = `Error: x\n    at f (${BASE}agent.js:${i}:1)`;
            internals.countRuntimeError(error);
        }
        assert.equal(storage.read('telemetryFaults').length, 10);
        assert.deepEqual(counters(storage), { 'error.runtime': 11 });
    });

    await t.test('from the window: the error event\'s error, the rejection\'s reason', () => {
        const { internals, storage, windowListeners } = agent();
        internals.watchErrors();
        windowListeners.get('error')({ filename: `${BASE}agent.js`, message: 'boom', error: boom() });
        windowListeners.get('error')({ filename: `${BASE}agent.js`, message: 'boom', error: null });
        windowListeners.get('unhandledrejection')({ reason: boom() });
        assert.deepEqual(plain(storage.read('telemetryFaults')), [
            { type: 'TypeError', frames: ['flush@agent.js:323:15'], count: 2 },
            { type: 'Other', frames: [], count: 1 },
        ]);
    });
});

test('sending the counters', async (t) => {
    await t.test('the faults leave with the counters, and are forgotten with them', async () => {
        const fault = { type: 'TypeError', frames: ['flush@agent.js:323:15'], count: 2 };
        const { internals, calls, storage } = agent({ stored: { ...PAIRED, telemetry: { 'error.runtime': 2 }, telemetryFaults: [fault] } });
        await internals.flushTelemetry();
        const [call] = telemetryCalls(calls);
        assert.deepEqual(call.body, { events: { 'error.runtime': 2 }, faults: [fault] });
        assert.deepEqual(plain(storage.read('telemetryFaults')), []);
    });

    await t.test('the faults are kept for next time when the engine does not answer', async () => {
        const fault = { type: 'TypeError', frames: ['flush@agent.js:323:15'], count: 2 };
        const { internals, storage } = agent({ down: true, stored: { ...PAIRED, telemetry: { 'error.runtime': 2 }, telemetryFaults: [fault] } });
        await internals.flushTelemetry();
        assert.deepEqual(plain(storage.read('telemetryFaults')), [fault]);
    });

    await t.test('the body is the counters and nothing else, in the vocabulary\'s order, with the usual headers', async () => {
        const { internals, calls } = agent({ stored: { ...PAIRED, telemetry: { started: 3, 'error.runtime': 1, installed: 1 } } });
        await internals.flushTelemetry();
        const [call] = telemetryCalls(calls);
        assert.equal(call.url, 'https://engine.test/api/plugins/telemetry');
        assert.equal(call.method, 'POST');
        assert.equal(call.raw, '{"events":{"installed":1,"started":3,"error.runtime":1}}');
        assert.equal(call.headers['Authorization'], 'Bearer api-token');
        assert.equal(call.headers['Content-Type'], 'application/json');
        // A build of a checkout is unstamped, and names its kind alone.
        assert.equal(call.headers['X-Certimens-Agent'], 'word');
    });

    await t.test('nothing leaves before pairing, and the counts wait for it', async () => {
        const { internals, calls, storage } = agent({ stored: { telemetry: { installed: 1 } } });
        await internals.flushTelemetry();
        assert.equal(calls.length, 0);
        assert.deepEqual(counters(storage), { installed: 1 });
    });

    await t.test('nothing leaves when there is nothing to say', async () => {
        const { internals, calls } = agent({ stored: PAIRED });
        await internals.flushTelemetry();
        assert.equal(calls.length, 0);
    });

    await t.test('at most once every fifteen minutes, across every open document', async () => {
        const { internals, calls, time, storage } = agent({ stored: { ...PAIRED, telemetry: { started: 1 } }, telemetry: answer(503) });
        await internals.flushTelemetry();
        time.advance(60);
        await internals.flushTelemetry();
        assert.equal(telemetryCalls(calls).length, 1, 'the minute tick does not send every minute');
        // Another document's instance, over the same storage: the claim stands for it too.
        const other = agent({ stored: Object.fromEntries([...storage.map].map(([k, v]) => [k.slice('certimens.'.length), JSON.parse(v)])),
            telemetry: answer(503) });
        other.time.advance(60);
        await other.internals.flushTelemetry();
        assert.equal(telemetryCalls(other.calls).length, 0);
        time.advance(15 * 60);
        await internals.flushTelemetry();
        assert.equal(telemetryCalls(calls).length, 2);
    });

    await t.test('a 204 takes off what was sent, and keeps what was counted during the send', async () => {
        let release;
        const { internals, storage } = agent({
            stored: { ...PAIRED, telemetry: { started: 2, 'error.engine': 1 } },
            telemetry: () => new Promise((resolve) => { release = resolve; }),
        });
        const flushing = internals.flushTelemetry();
        internals.countEvent('error.engine');
        internals.countEvent('network.failure');
        release(json(null, { status: 204 }));
        await flushing;
        assert.deepEqual(counters(storage), { 'error.engine': 1, 'network.failure': 1 });
    });

    await t.test('no answer, or a 5xx: kept for next time, and not counted', async () => {
        for (const options of [{ down: true }, { telemetry: answer(500) }, { telemetry: answer(429) }]) {
            const { internals, storage } = agent({ stored: { ...PAIRED, telemetry: { started: 1 } }, ...options });
            await internals.flushTelemetry();
            assert.deepEqual(counters(storage), { started: 1 }, JSON.stringify(Object.keys(options)));
        }
    });

    await t.test('a 400, a 413 or a 401: dropped, and not counted either', async () => {
        for (const status of [400, 413, 401]) {
            const { internals, storage } = agent({ stored: { ...PAIRED, telemetry: { started: 1 } }, telemetry: answer(status) });
            await internals.flushTelemetry();
            assert.deepEqual(counters(storage), {}, String(status));
        }
    });
});

test('signing out keeps the counters: they belong to no account', async () => {
    const { internals, storage } = agent({ stored: { ...PAIRED, config: { ...PAIRED.config, tokenId: 'tok-1' }, telemetry: { installed: 1 } } });
    await internals.logout();
    assert.deepEqual(counters(storage), { installed: 1 });
});

// What only shows with two things happening at once: a take-back in flight while the queue
// drains, a window sealed while the student signs out, an engine that refuses without being down.
test('the queue and the take-back do not wait on each other', async (t) => {
    const within = (promise, label) => Promise.race([
        promise,
        new Promise((_, reject) => { setTimeout(() => reject(new Error(label + ' never came back')), 500); }),
    ]);

    await t.test('a window sealed while the file is being taken back leaves, to the record it rejoins', async () => {
        const { calls, internals } = agent({
            stored: { config: PAIRED.config, signedIn: true },
            document: wordDocument({ properties: CARRIED }),
            documents: { f9: 'Mémoire' },
        });
        internals.startResume(UUID);
        await within(internals.enqueue({ ...WINDOW, documentId: UUID }), 'the drain');
        assert.ok(calls.some((c) => c.url.endsWith('/api/documents/f9/metrics')));
        assert.equal(calls.filter((c) => c.url.endsWith('/api/documents')).length, 0);
        await within(internals.createFileFor(UUID, 'Mémoire', 'Mémoire'), 'the creation');
    });

    await t.test('a file opened before pairing is taken back once somebody is signed in', async () => {
        const { calls, storage, internals } = agent({
            document: wordDocument({ properties: CARRIED }),
            documents: { f9: 'Mémoire' },
        });
        await internals.startResume(UUID).catch(() => null);    // nobody signed in: nothing asked
        assert.equal(calls.length, 0);
        await internals.adoptToken('https://engine.test', 'api-token');
        await internals.enqueue({ ...WINDOW, documentId: UUID });
        assert.equal(storage.read('engineIds')[UUID], 'f9');
        assert.equal(calls.filter((c) => c.method === 'POST' && c.url.endsWith('/api/documents')).length, 0,
            'a second document was opened');
    });

    await t.test('an engine out of reach decides nothing: no document is created in its place', async () => {
        const world = agent({
            stored: { config: PAIRED.config, signedIn: true },
            document: wordDocument({ properties: CARRIED }),
            documents: { f9: 'Mémoire' },
            down: true,
        });
        await world.internals.startResume(UUID).catch(() => null);
        await world.internals.enqueue({ ...WINDOW, documentId: UUID });
        assert.equal(world.calls.filter((c) => c.method === 'POST' && c.url.endsWith('/api/documents')).length, 0);
        assert.equal(world.storage.read('queue').length, 1, 'the window waits');
    });
});

test('signing out leaves nothing for the next account', async (t) => {
    await t.test('a window sealed after the sign-out is not queued', async () => {
        const { storage, internals } = agent({ stored: PAIRED });
        await internals.logout();
        await internals.enqueue(WINDOW);    // the idle timer of a keystroke typed while signing out
        assert.equal(storage.read('queue'), undefined);
        assert.equal(storage.read('signedIn'), false);
    });

    await t.test('what waits is sent first, whatever another pane\'s lease says', async () => {
        const { calls, storage, internals } = agent({
            stored: { ...PAIRED, queue: [{ ...WINDOW, id: 'w1' }], drainLease: { owner: 'another-pane', until: Date.now() + 30000 } },
        });
        await internals.logout();
        assert.deepEqual(pushes(calls).map((c) => c.body.windows.map((w) => w.seq)), [[4]]);
        assert.equal(storage.read('drainLease'), undefined);
    });

    await t.test('the lease is given back when the drain is over', async () => {
        const { storage, internals } = agent({ stored: { ...PAIRED, queue: [{ ...WINDOW, id: 'w1' }] } });
        await internals.drain();
        assert.equal(storage.read('drainLease'), undefined);
    });
});

test('`offline` is an engine out of reach, not an engine that refused', async (t) => {
    await t.test('a window queued behind a 5xx is not stamped', async () => {
        const { storage, internals } = agent({ stored: PAIRED, metrics: () => json({ error: 'boom' }, { status: 503 }) });
        await internals.enqueue(WINDOW);
        await internals.enqueue({ ...WINDOW, seq: 5 });
        assert.equal(storage.read('status').reached, true);
        assert.deepEqual(storage.read('queue').map((item) => item.offline), [undefined, undefined]);
    });

    await t.test('a window queued with no answer at all is', async () => {
        const { storage, internals } = agent({ stored: PAIRED, down: true });
        await internals.enqueue(WINDOW);
        await internals.enqueue({ ...WINDOW, seq: 5 });
        assert.deepEqual(storage.read('queue').map((item) => item.offline), [undefined, true]);
    });
});

test('a file name is a name, not an address', () => {
    const named = (url) => agent({ document: wordDocument({ url }) }).internals.documentName();
    assert.equal(named('C:\\Users\\a\\Rapport 100% final.docx'), 'Rapport 100% final');
    assert.equal(named('https://sp.test/Documents/M%C3%A9moire.docx'), 'Mémoire');
});

// The engine keeps one living document per name and per account, and two files called
// « Mémoire » are an ordinary thing to have.
test('a document whose name is taken', async (t) => {
    const UNLINKED = { ...PAIRED, engineIds: {} };
    const nameTaken = () => json({ error: 'taken', code: 'document_name_taken' }, { status: 409 });
    const created = (calls) => calls.filter((c) => c.method === 'POST' && c.url.endsWith('/api/documents')).map((c) => c.body.name);

    await t.test('from a sealed window, it takes a free name and the window leaves', async () => {
        let refusals = 1;
        const { calls, storage, internals } = agent({ stored: UNLINKED, creation: () => (refusals-- > 0 ? nameTaken() : null) });
        await internals.enqueue(WINDOW);
        const names = created(calls);
        assert.equal(names.length, 2);
        assert.match(names[1], /^Mémoire\.docx \(\d{4}-\d\d-\d\d \d\d\.\d\d\.\d\d\)$/);
        assert.equal(pushes(calls).length, 1);
        assert.equal(storage.read('queue').length, 0);
    });

    await t.test('typed by the student, it is said and nothing is created behind them', async () => {
        const { calls, internals } = agent({ stored: UNLINKED, creation: nameTaken });
        await assert.rejects(() => internals.createFileFor('doc1', 'Mémoire', 'Mémoire'),
            (err) => err.code === 'document_name_taken' && err.message === 'error.nameTaken');
        assert.equal(created(calls).length, 1);
    });

    await t.test('a creation refused keeps the window: it is not the window that was refused', async () => {
        const { storage, internals } = agent({ stored: UNLINKED, creation: nameTaken });
        await internals.enqueue(WINDOW);
        assert.equal(storage.read('queue').length, 1);
    });
});

// --- "Signaler un problème" ---
//
// The pane opens the help form of the Certimens space, prefilled with a block describing the
// agent (docs/moteur.md, "Signaler un problème"). report.js builds it — the same file the
// extension's service worker loads — and this agent hands it its own values.
test('the problem report', async (t) => {
    const blockOf = (url) => {
        const fragment = new URL(url).hash;
        const details = new URLSearchParams(fragment.slice(fragment.indexOf('?') + 1)).get('details');
        return details.split('\n').map((line) => [line.slice(0, line.indexOf(': ')), line.slice(line.indexOf(': ') + 2)]);
    };

    await t.test('the link: the engine, the fragment, problem mode', () => {
        const { internals } = agent({ stored: PAIRED });
        const url = internals.reportLink();
        assert.match(url, /^https:\/\/engine\.test\/#report\?kind=problem&details=[^&#]+$/);
        assert.ok(url.startsWith(`https://engine.test/${internals.REPORT_FRAGMENT}?`));
    });

    await t.test('eleven lines, in the contract\'s order, with what this pane knows', () => {
        const { internals } = agent({
            stored: {
                ...PAIRED, paused: true,
                queue: [{ ...WINDOW, id: 'a' }, { ...WINDOW, id: 'b', seq: 5 }],
                status: { state: 'offline', reached: true },
                telemetry: { 'queue.dropped': 3, started: 4, bogus: 9 },
            },
        });
        const lines = blockOf(internals.reportLink());
        assert.deepEqual(lines.map(([key]) => key), ['agent', 'host', 'os', 'language', 'engine', 'signed_in',
            'paused', 'status', 'queued', 'counters', 'at']);
        assert.deepEqual(lines.map(([key]) => key), [...internals.REPORT_KEYS]);
        const values = Object.fromEntries(lines);
        // A checkout still holds the build placeholder: the declaration is then the kind alone,
        // exactly what the header says.
        assert.match(values.agent, /^word(\/.+)?$/);
        assert.equal(values.host, 'Word PC 16.0.18129.20158');
        assert.equal(values.os, 'Windows');
        assert.equal(values.language, 'en');
        assert.equal(values.engine, 'https://engine.test');
        assert.equal(values.signed_in, 'yes');
        assert.equal(values.paused, 'yes');
        assert.equal(values.status, 'offline (reached)');
        assert.equal(values.queued, '2');
        assert.equal(values.counters, 'started=4 queue.dropped=3');
        assert.match(values.at, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
    });

    await t.test('Word on the web names no system, and an old Word names nothing', () => {
        const online = agent({ document: wordDocument({ diagnostics: { host: 'Word', platform: 'OfficeOnline', version: '16.0.19000.10000' } }) });
        const values = Object.fromEntries(blockOf(online.internals.reportLink()));
        assert.equal(values.host, 'Word OfficeOnline 16.0.19000.10000');
        assert.equal(values.os, 'unknown');
        // Not signed in, nothing measured, nothing counted: still eleven lines.
        assert.equal(values.signed_in, 'no');
        assert.equal(values.status, 'idle');
        assert.equal(values.counters, 'none');

        const old = agent({ document: wordDocument({ diagnostics: null }) });
        const bare = Object.fromEntries(blockOf(old.internals.reportLink()));
        assert.equal(bare.host, 'unknown');
        assert.equal(bare.os, 'unknown');
    });

    await t.test('no token, no device code, no e-mail, nothing of the document', () => {
        const { internals } = agent({
            stored: {
                ...PAIRED,
                config: { engineUrl: 'https://engine.test/sous-chemin', token: 'secret-api-token', tokenId: 'tok-9',
                    email: 'etudiante@univ-exemple.fr', displayName: 'Camille Martin', language: 'fr' },
                pairing: { deviceCode: 'device-secret', token: 'pending-secret' },
                titles: { doc1: 'Mémoire de master' }, queue: [{ ...WINDOW, id: 'a' }],
            },
        });
        const block = decodeURIComponent(internals.reportLink());
        for (const secret of ['secret-api-token', 'tok-9', 'etudiante', 'Camille', 'device-secret', 'pending-secret',
            'doc1', 'engine-1', 'Mémoire', 'sp.test', 'sous-chemin']) {
            assert.ok(!block.includes(secret), `${secret} is in the report`);
        }
    });

    await t.test('an address the rule refuses sends the link to the default engine', () => {
        for (const engineUrl of REFUSED) {
            const { internals } = agent({ stored: { config: { engineUrl, token: 'api-token' } } });
            assert.ok(internals.reportLink().startsWith('https://monespace.certimens.fr/#report?kind=problem&details='), engineUrl);
        }
    });

    await t.test('the block is capped on a line boundary, and a newline never forges a line', () => {
        const { internals } = agent();
        const long = Object.fromEntries(internals.REPORT_KEYS.map((key) => [key, 'z'.repeat(5000)]));
        const block = internals.reportBlock(long);
        assert.ok(block.length <= 1500);
        block.split('\n').forEach((line, i) => assert.ok(line.startsWith(`${internals.REPORT_KEYS[i]}: `) && line.endsWith('z')));
        assert.equal(internals.reportBlock({ host: 'Word\nengine: https://evil.test' }).split('\n').length, internals.REPORT_KEYS.length);
    });
});
