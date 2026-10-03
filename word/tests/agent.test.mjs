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
    'startResume', 'createFileFor', 'enqueue', 'drain'];
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
        // `raw` is the body as it left: the key order and the absence of indentation are part
        // of the contract, and neither survives being parsed.
        calls.push({ url, method: init.method, body, raw: init.body, headers: init.headers || {} });
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
    return { storage, calls, time, properties: doc.props, settings: doc.settings,
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
            // And nothing is remembered about the engine that refused.
            assert.deepEqual([...storage.map.keys()].sort(), ['certimens.config', 'certimens.engineIds']);
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
