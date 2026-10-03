// What the popup offers on a page the extension does not know (src/popup.js).
//
// The manifest names three editors. Everywhere else nothing is declared in advance: the student
// says "this is where I write" from the page itself, and the popup asks for permission for that
// single address. What is tested here is the filter — who the offer is made to, and above all
// who it is not made to.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clock, load } from './helpers/sandbox.mjs';

const INTERNALS = ['pageToOffer', 'offerToMeasure', 'showUpload', 'current'];

// A page element, reduced to what the popup touches of it. One per identifier, so that a test
// can read what the popup displayed or hid.
function fakeElement() {
    return {
        hidden: false,
        title: '',
        href: '',
        value: '',
        textContent: '',
        classList: { add() {}, remove() {}, toggle() {} },
        style: {},
        addEventListener() {},
        removeEventListener() {},
        replaceChildren() {},
        setAttribute() {},
        removeAttribute() {},
        append() {},
    };
}

/**
 * Loads the popup as it ships, with the globals its neighbours (ui.js, i18n.js) and the browser
 * give it. `tab` is the active tab — `url` is only present there because the student opened the
 * popup, and that gesture is what `activeTab` asks for.
 */
function popup({ tab = {}, sites = [], scripting = true } = {}) {
    const time = clock();
    const elements = new Map();
    const element = (id) => {
        if (!elements.has(id)) elements.set(id, fakeElement());
        return elements.get(id);
    };
    const requested = [];
    const globals = {
        Date: class extends Date {
            static now() {
                return time.now;
            }
        },
        setTimeout: () => 0,
        clearTimeout: () => {},
        setInterval: () => 0,
        clearInterval: () => {},
        document: { addEventListener() {}, getElementById: element, querySelectorAll: () => [] },
        window: { addEventListener() {}, close() {} },
        // Declared by constants.js, i18n.js, ui.js and pages.js, loaded before the popup in
        // the page — in that order, which is popup.html's.
        DEFAULT_ENGINE_URL: 'https://engine.test',
        GOOGLE_EXPORT_ORIGINS: ['https://docs.google.com/document/*'],
        $: element,
        t: (key) => key,
        setLanguage: () => {},
        dateLocale: () => 'fr-FR',
        renderIconActions: () => {},
        showIcon: () => {},
        showAccount: () => {},
        showMessage: () => {},
        clearMessage: () => {},
        errorText: () => '',
        fillEngineUrl: () => {},
        engineUrlValue: () => '',
        deadlinePassed: () => false,
        renderAssignments: () => {},
        updateSubmitButton: () => {},
        startLanguage: () => {},
        showUpdateIfNew: () => {},
        requestEngineAccess: async (url) => url,
        chrome: {
            // Not connected: `render()` stops right away, and the test calls what it wants.
            runtime: {
                sendMessage: (message) => Promise.resolve(message.type === 'CERTIMENS_SITES'
                    ? { ok: true, sites }
                    : { ok: true, configured: false, status: { state: 'idle' } }),
                openOptionsPage: () => {},
                getManifest: () => ({ version: '0.0.0' }),
            },
            tabs: {
                query: () => Promise.resolve([tab]),
                sendMessage: () => Promise.reject(new Error('no content script')),
            },
            permissions: {
                request: ({ origins }) => {
                    requested.push(...origins);
                    return Promise.resolve(true);
                },
            },
            scripting: scripting ? { registerContentScripts: () => {}, executeScript: () => Promise.resolve() } : undefined,
            action: { setBadgeText: () => Promise.resolve() },
            storage: { local: { get: () => Promise.resolve({}), set: () => Promise.resolve() } },
        },
        URL,
        btoa: (text) => Buffer.from(text, 'binary').toString('base64'),
    };
    return { element, requested, internals: load(new URL('../src/popup.js', import.meta.url), { globals, expose: INTERNALS }) };
}

const MOODLE = { id: 7, url: 'https://moodle.mon-etablissement.fr/mod/assign/view.php?id=42' };

test('measuring a page the extension does not know', async (t) => {
    await t.test('any page is offered, for its origin alone', async () => {
        const { internals } = popup({ tab: MOODLE });

        const offer = await internals.pageToOffer();

        // The origin, and all its pages: narrower would break on the next page of the same
        // Moodle, wider would ask for a site the student did not name.
        assert.deepEqual({ ...offer }, {
            tabId: 7, match: 'https://moodle.mon-etablissement.fr/*', host: 'moodle.mon-etablissement.fr',
        });
    });

    await t.test('an editor already known is not', async () => {
        // Otherwise the popup would offer to add docs.google.com while its script starts up.
        for (const url of ['https://docs.google.com/document/d/AbC/edit',
            'https://www.overleaf.com/project/abc',
            'https://x-edit.officeapps.live.com/we/wordeditorframe.aspx',
            'https://contoso.cloud.microsoft/we/wordeditorframe.aspx']) {
            const { internals } = popup({ tab: { id: 1, url } });
            assert.equal(await internals.pageToOffer(), null, url);
        }
    });

    await t.test('an internal browser page is not', async () => {
        for (const url of ['chrome://extensions', 'about:debugging', 'file:///home/etudiant/memoire.html']) {
            const { internals } = popup({ tab: { id: 1, url } });
            assert.equal(await internals.pageToOffer(), null, url);
        }
    });

    await t.test('a site already added is no longer', async () => {
        const { internals } = popup({ tab: MOODLE, sites: ['https://moodle.mon-etablissement.fr/*'] });

        assert.equal(await internals.pageToOffer(), null);
    });

    await t.test('without the tab\'s address, nothing is offered', async () => {
        // `activeTab` only gives the address once the popup is open; before that, there is
        // nothing to offer, and above all nothing to guess.
        const { internals } = popup({ tab: { id: 1 } });

        assert.equal(await internals.pageToOffer(), null);
    });

    await t.test('a browser without dynamic registration offers nothing', async () => {
        // Taking the permission and then measuring nothing would be worse than offering
        // nothing.
        const { internals } = popup({ tab: MOODLE, scripting: false });

        assert.equal(await internals.pageToOffer(), null);
    });

    await t.test('the button only appears when there is something to offer', async () => {
        const { element, internals } = popup({ tab: MOODLE });

        await internals.offerToMeasure();

        assert.equal(element('measureHere').hidden, false);
        assert.match(element('measureHere').title, /measureHereTip/);
    });
});

test('handing in the copy, one control per editor', async (t) => {
    // Four editors, three ways of handing the document in — and it is the editor that says so,
    // not the popup. Two controls visible at once, or none, would be an editor added without
    // its hand-in mode.
    const CONTROLS = ['exportDocx', 'pickDocx', 'sendText'];

    const shown = ({ deposit, frozen = false, platform = null }) => {
        const { element, internals } = popup();
        internals.current.doc = { deposit, platform };
        internals.current.frozen = frozen;
        internals.showUpload({});
        return {
            visible: CONTROLS.filter((id) => !element(id).hidden),
            hint: element('uploadHint').textContent,
        };
    };

    await t.test('Google Docs: the export, and it alone', () => {
        assert.deepEqual(shown({ deposit: 'export' }).visible, ['exportDocx']);
    });

    await t.test('Word Online and Overleaf: picking a downloaded copy', () => {
        assert.deepEqual(shown({ deposit: 'pick' }).visible, ['pickDocx']);
    });

    await t.test('an added site: sending the page\'s text', () => {
        const { visible, hint } = shown({ deposit: 'text' });
        assert.deepEqual(visible, ['sendText']);
        // The sentence saying what goes out, right above the button that sends it.
        assert.match(hint, /doc\.textHint/);
    });

    await t.test('a recognised platform is named before the press', () => {
        // "This is indeed that page": the student must read it before sending what they wrote.
        assert.match(shown({ deposit: 'text', platform: 'Moodle' }).hint, /doc\.platform/);
    });

    await t.test('a frozen copy offers none of them', () => {
        // The deadline has passed: the engine would refuse the hand-in, and a button whose
        // refusal teaches nothing is no better than no button.
        assert.deepEqual(shown({ deposit: 'text', frozen: true }).visible, []);
    });

    await t.test('an editor that says nothing falls back to picking a file', () => {
        // The fallback must never be "send the page's text": that would take content out of an
        // editor that asked for nothing.
        assert.deepEqual(shown({ deposit: undefined }).visible, ['pickDocx']);
    });
});
