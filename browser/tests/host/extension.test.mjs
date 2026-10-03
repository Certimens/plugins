// The extension in a **real Chromium**, unpacked as the store will serve it
// (`make test-host`).
//
// Every other test of this agent replaces `chrome.*` with objects of our own: they check our
// rules, and can say nothing about what only happens once installed — a manifest the browser
// refuses, a service worker that throws on startup, a page missing a `<script>` tag, a content
// script never injected. That is the class of failure where the extension installs and does
// nothing, and it is the one the store does not review.
//
// The page measured is **ours**, served at Overleaf's address through Playwright's
// interception: the manifest says `https://*.overleaf.com/project/*`, and that is the rule we
// want to see apply. Nothing here touches the real Overleaf, which would need an account and
// would change its DOM without warning — that DOM is still checked by hand (TESTING.md).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { chromium } from 'playwright';

const here = dirname(fileURLToPath(import.meta.url));
const UNPACKED = resolve(here, '..', '..', 'dist', 'chrome');

const PROJECT = 'https://www.overleaf.com/project/abcdef0123456789abcdef01';

// An editing page reduced to what the `overleaf` entry of EDITORS looks at: the identifier in
// the address, the project name, and the CodeMirror area where the student writes.
const FIXTURE = `<!doctype html>
<html lang="fr"><head><meta charset="utf-8"><title>Mémoire de master - Overleaf</title></head>
<body>
  <header><span class="project-name">Mémoire de master</span></header>
  <div class="cm-editor"><div class="cm-content" contenteditable="true"></div></div>
</body></html>`;

// The browser, the extension loaded into it, and its service worker. The profile is
// throwaway: the extension keeps its state in chrome.storage, which lives with it.
async function browser() {
    const profile = await mkdtemp(join(tmpdir(), 'certimens-profile-'));
    const context = await chromium.launchPersistentContext(profile, {
        // An extension does not load in Chromium's historical headless mode: the container
        // brings the display (xvfb), and that is why it exists.
        headless: false,
        args: [
            `--disable-extensions-except=${UNPACKED}`,
            `--load-extension=${UNPACKED}`,
            // Chromium's sandbox demands privileges root does not have in a container; the
            // isolation, here, is the container itself.
            '--no-sandbox',
        ],
    });
    const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
    return {
        context,
        worker,
        // The identifier Chromium gave the extension: it is in the worker's address.
        id: new URL(worker.url()).host,
        async close() {
            await context.close();
            await rm(profile, { recursive: true, force: true });
        },
    };
}

// Opens a page of the extension and returns what the console spat out. A page that renders
// while throwing is a broken page: nothing else would say so.
async function open(context, url) {
    const problems = [];
    const page = await context.newPage();
    page.on('pageerror', (err) => problems.push(String(err)));
    page.on('console', (message) => {
        if (message.type() === 'error') problems.push(message.text());
    });
    await page.goto(url);
    return { page, problems };
}

// The queue is the agent's own storage. Emptied before a test, it says exactly what that test
// produced: they all share one browser, and would otherwise read each other's windows.
async function clearQueue(chrome) {
    await chrome.worker.evaluate(() => chrome.storage.local.set({ queue: [], queueSent: 0 }));
}

async function queued(chrome) {
    return chrome.worker.evaluate(async () => {
        const { queue = [] } = await chrome.storage.local.get('queue');
        return queue;
    });
}

// A window goes out two seconds after the last keystroke; this waits past that, with margin for
// a container under load.
const SENT = 3500;

function total(windows, type) {
    return windows.reduce((sum, item) => sum + (item.values[type] || 0), 0);
}

test('the extension in a real Chromium', async (t) => {
    const chrome = await browser();
    t.after(() => chrome.close());

    await t.test('the browser accepts the manifest and starts the service worker', () => {
        assert.match(chrome.id, /^[a-p]{32}$/, 'extension identifier expected');
    });

    await t.test('the popup renders, without throwing anything', async () => {
        const { page, problems } = await open(chrome.context, `chrome-extension://${chrome.id}/popup.html`);
        // Not paired: the login form is what must be there, translated.
        await page.waitForSelector('#login:not([hidden])');
        assert.deepEqual(problems, [], 'console errors in the popup');
        const label = await page.textContent('[data-i18n="pair.start"], #pairStart button, #login button');
        assert.ok(label && label.trim().length > 0, 'the login button has no text');
        await page.close();
    });

    await t.test('the options page renders, without throwing anything', async () => {
        const { page, problems } = await open(chrome.context, `chrome-extension://${chrome.id}/options.html`);
        await page.waitForSelector('#siteForm');
        assert.deepEqual(problems, [], 'console errors in the options page');
        await page.close();
    });

    await t.test('the sensor injects itself into a page the manifest names', async () => {
        await chrome.context.route('https://www.overleaf.com/project/**', (route) =>
            route.fulfill({ contentType: 'text/html; charset=utf-8', body: FIXTURE }));
        const page = await chrome.context.newPage();
        await page.goto(PROJECT);
        await page.waitForSelector('.cm-content');

        // The service worker queries the tab: if the content script is not there, nobody
        // answers. That is the whole path — manifest rule, injection, messaging.
        const document = await chrome.worker.evaluate(async () => {
            const [tab] = await chrome.tabs.query({ url: 'https://www.overleaf.com/*' });
            return chrome.tabs.sendMessage(tab.id, { type: 'CERTIMENS_ACTIVE_DOC' });
        });
        assert.equal(document.id, 'overleaf:abcdef0123456789abcdef01');
        assert.equal(document.name, 'Mémoire de master');
        // Overleaf cannot export the copy: the student uploads a downloaded file.
        assert.equal(document.deposit, 'pick');
        await page.close();
    });

    // Leaving for another tab is the one thing no stub reproduces: it takes a real `blur` and a
    // `document.hasFocus()` that really turns false. Playwright keeps every page believing it is
    // focused — that is what makes clicks and typing deterministic — so this test is also the
    // place where that emulation has to be switched off, or the sensor is told nothing and the
    // departure is never counted.
    //
    // What it pins is the carry-over: the departure lands on the window open at that moment,
    // which holds nothing else (the typing window went out two seconds after the last
    // keystroke), and an empty window is not sent. The count therefore reaches the queue only
    // once the student writes again — so a student who leaves and never comes back is not
    // reported as having left.
    await t.test('leaving the document for another tab is counted', async () => {
        const page = await chrome.context.newPage();
        await page.goto(PROJECT);
        await page.click('.cm-content');
        await page.keyboard.type('Premier jet du memoire.', { delay: 15 });
        await page.waitForTimeout(3500);

        const cdp = await chrome.context.newCDPSession(page);
        await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: false });
        const elsewhere = await chrome.context.newPage();
        await elsewhere.goto('about:blank');
        await elsewhere.bringToFront();
        await page.waitForTimeout(500);
        await page.bringToFront();

        await page.click('.cm-content');
        await page.keyboard.type('Suite apres etre revenu.', { delay: 15 });
        await page.waitForTimeout(3500);

        const queued = await chrome.worker.evaluate(async () => {
            const { queue = [] } = await chrome.storage.local.get('queue');
            return queue;
        });
        const left = queued.filter((item) => item.values.focus_losses > 0);
        assert.ok(left.length > 0,
            `no window carries focus_losses (${queued.length} queued: ${
                queued.map((item) => item.values.focus_losses).join(', ')})`);
        await elsewhere.close();
        await page.close();
    });

    // A real copy and a real paste, through the system clipboard: the sensor reads the
    // selection inside the `copy` event and the text inside the `paste` event, and both are
    // refused unless the browser marks them trusted — which `dispatchEvent` never does. The
    // phrase is two words long on purpose: shorter than a shingle, which used to leave no
    // fingerprint at all, so moving it inside one's own document came back as an injection.
    await t.test('a phrase moved inside the document is not an injection', async () => {
        const page = await chrome.context.newPage();
        await page.goto(PROJECT);
        await page.click('.cm-content');
        await page.keyboard.type('developpement durable', { delay: 15 });
        await page.keyboard.press('Shift+Home');
        await page.keyboard.press('Control+c');
        // The fingerprint is not computed inside the copy handler: hashing a whole dissertation
        // there would be felt under the student's own Ctrl+C, so it is pushed to the next turn
        // (`setTimeout(0)`). A human takes far longer than this to reach Ctrl+V; a test does not.
        await page.waitForTimeout(200);
        await page.keyboard.press('End');
        await page.keyboard.press('Control+v');
        await page.waitForTimeout(3500);

        const queued = await chrome.worker.evaluate(async () => {
            const { queue = [] } = await chrome.storage.local.get('queue');
            return queue;
        });
        const restitution = queued.filter((item) => item.values.self_paste_events > 0);
        assert.ok(restitution.length > 0,
            `the paste was not recognised as the student's own text (${
                queued.map((i) => `paste=${i.values.paste_events} self=${i.values.self_paste_events}`).join(' | ')})`);
        for (const item of queued) {
            assert.equal(item.values.injected_chars_total, 0,
                'one\'s own phrase, moved, counted as injected characters');
        }
        await page.close();
    });

    await t.test('what is really typed reaches the service worker', async () => {
        const page = await chrome.context.newPage();
        await page.goto(PROJECT);
        await page.click('.cm-content');
        await page.keyboard.type('Dans ce memoire nous etudions la redaction.', { delay: 15 });
        // The window goes out on its own after 2 s without activity (IDLE_FLUSH_MS).
        await page.waitForTimeout(3500);

        const queued = await chrome.worker.evaluate(async () => {
            const { queue = [] } = await chrome.storage.local.get('queue');
            return queue;
        });
        const window = queued.find((item) => item.documentId === 'overleaf:abcdef0123456789abcdef01');
        assert.ok(window, `no window queued for this project (${queued.length} in all)`);
        assert.ok(window.values.keystrokes_total > 10,
            `keystrokes counted: ${window.values.keystrokes_total}`);
        // Overleaf sends no volume: CodeMirror only renders the visible lines, and a wrong
        // volume would mislead the engine. The absence is intended, a zero is not.
        assert.equal(window.values.real_volume_chars, undefined);
        await page.close();
    });

    // The question this answers: clicking around produces "navigation jump" in the console, yet
    // nothing reaches the engine until the student types. A window with neither keystroke nor
    // paste is not sent — its period would be the time spent reading, not writing — but its
    // counters are **not** cleared: they ride along with the next window that does carry
    // typing. Nothing is lost; it arrives attached to the writing it preceded.
    await t.test('clicks alone make no window, and are not lost either', async () => {
        await clearQueue(chrome);
        const page = await chrome.context.newPage();
        await page.goto(PROJECT);
        await page.click('.cm-content');
        await page.click('.cm-content');
        await page.waitForTimeout(SENT);
        assert.deepEqual(await queued(chrome), [], 'a window without a keystroke was sent');

        await page.keyboard.type('Enfin une phrase.', { delay: 15 });
        await page.waitForTimeout(SENT);
        const windows = await queued(chrome);
        assert.equal(windows.length, 1, 'one window expected for this typing');
        assert.ok(windows[0].values.navigation_jumps >= 2,
            `the clicks did not join the next window (${windows[0].values.navigation_jumps})`);
        await page.close();
    });

    // The three deletion boxes, told apart by what precedes them — the rule that is hardest to
    // produce by hand, and the one a reader of the counters is most likely to doubt.
    await t.test('a deletion after an arrow key is a deferred reformulation', async () => {
        await clearQueue(chrome);
        const page = await chrome.context.newPage();
        await page.goto(PROJECT);
        await page.click('.cm-content');
        await page.keyboard.type('une phrase a reprendre', { delay: 15 });
        await page.keyboard.press('ArrowLeft');
        await page.keyboard.press('Backspace');
        await page.waitForTimeout(SENT);

        const windows = await queued(chrome);
        assert.equal(total(windows, 'deferred_reformulations'), 1);
        assert.equal(total(windows, 'immediate_corrections'), 0,
            'the move before the deletion was not spent');
        assert.equal(total(windows, 'macro_revisions'), 0);
        await page.close();
    });

    await t.test('a deletion after a click is a mass revision', async () => {
        await clearQueue(chrome);
        const page = await chrome.context.newPage();
        await page.goto(PROJECT);
        await page.click('.cm-content');
        await page.keyboard.type('une phrase a reprendre', { delay: 15 });
        await page.click('.cm-content');
        await page.keyboard.press('Backspace');
        await page.waitForTimeout(SENT);

        const windows = await queued(chrome);
        assert.equal(total(windows, 'macro_revisions'), 1);
        assert.equal(total(windows, 'deferred_reformulations'), 0,
            'a click is not a keyboard move');
        await page.close();
    });

    await t.test('text from elsewhere, pasted, is an injection', async () => {
        await clearQueue(chrome);
        await chrome.context.grantPermissions(['clipboard-read', 'clipboard-write'],
            { origin: 'https://www.overleaf.com' });
        const page = await chrome.context.newPage();
        await page.goto(PROJECT);
        await page.click('.cm-content');
        await page.keyboard.type('Introduction.', { delay: 15 });
        await page.evaluate(() => navigator.clipboard.writeText(
            "L'intelligence artificielle transforme radicalement les methodes de travail."));
        await page.keyboard.press('Control+v');
        await page.waitForTimeout(SENT);

        const windows = await queued(chrome);
        assert.ok(total(windows, 'paste_events') >= 1, 'the paste was not counted');
        assert.ok(total(windows, 'injected_chars_total') > 50,
            `characters injected: ${total(windows, 'injected_chars_total')}`);
        assert.equal(total(windows, 'self_paste_events'), 0,
            'foreign text was taken for the student\'s own');
        await page.close();
    });

    // Suspension travels through `chrome.storage`, which is the only thing that reaches a
    // content script already running in a page: no stub can show that this plumbing works.
    await t.test('suspended, nothing is counted; resumed, counting starts again', async () => {
        await clearQueue(chrome);
        const page = await chrome.context.newPage();
        await page.goto(PROJECT);
        await page.click('.cm-content');
        await chrome.worker.evaluate(() => chrome.storage.local.set({ paused: true }));
        await page.waitForTimeout(200);
        await page.keyboard.type('Rien de ceci ne doit etre compte.', { delay: 10 });
        await page.waitForTimeout(SENT);
        const duringPause = await queued(chrome);

        await chrome.worker.evaluate(() => chrome.storage.local.set({ paused: false }));
        await page.waitForTimeout(200);
        await page.keyboard.type('Et ceci doit l etre.', { delay: 10 });
        await page.waitForTimeout(SENT);
        const after = await queued(chrome);

        assert.deepEqual(duringPause, [], 'a suspended sensor still sent a window');
        assert.ok(total(after, 'keystrokes_total') > 5,
            `nothing counted after resuming (${total(after, 'keystrokes_total')})`);
        await page.close();
    });

    // The silent breakage this whole suite exists for: an editor renames the area the sensor
    // filters on, every keystroke is dropped, the document is still announced — because its
    // identifier comes from the address — and the agent looks healthy while counting nothing.
    // The page below is the fixture with its editing area taken out.
    await t.test('a page without its editing area says so instead of counting nothing', async () => {
        const mute = PROJECT.replace(/[0-9a-f]{24}$/, 'ffffffffffffffffffffffff');
        await chrome.context.route(mute, (route) => route.fulfill({
            contentType: 'text/html; charset=utf-8',
            body: FIXTURE.replace('<div class="cm-editor">', '<div class="editor-v2">'),
        }));
        const warnings = [];
        const page = await chrome.context.newPage();
        page.on('console', (message) => {
            if (message.type() === 'warning' && message.text().includes('Certimens')) {
                warnings.push(message.text());
            }
        });
        await page.goto(mute);
        await page.waitForTimeout(7000);   // EDITOR_AREA_GRACE_MS, and then some
        assert.ok(warnings.some((line) => line.includes('.cm-editor')),
            `nothing was said about the missing editing area (${warnings.join(' | ') || 'no warning'})`);
        await page.close();
    });

    // The negative of the injection test, and the one that matters for the student: the same
    // page served from an address the manifest does not name must be measured by nobody.
    await t.test('the sensor stays out of a page the manifest does not name', async () => {
        await chrome.context.route('https://example.org/**', (route) =>
            route.fulfill({ contentType: 'text/html; charset=utf-8', body: FIXTURE }));
        const page = await chrome.context.newPage();
        await page.goto('https://example.org/project/abcdef0123456789abcdef01');
        await page.waitForSelector('.cm-content');
        const answer = await chrome.worker.evaluate(async () => {
            const [tab] = await chrome.tabs.query({ url: 'https://example.org/*' });
            try {
                return await chrome.tabs.sendMessage(tab.id, { type: 'CERTIMENS_ACTIVE_DOC' });
            } catch {
                return null;
            }
        });
        assert.ok(!answer, 'the sensor answered on a page the manifest does not name');
        await page.close();
    });
});
