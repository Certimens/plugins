// Certimens — telemetry sensor running inside the editor (Google Docs, Word Online's editing
// iframe, Overleaf, or a site the student added).
//
// No keystroke is recorded: what is kept is the ordered runs of what happened ("20 keystrokes in
// 4 s", a silence, a paste of 240 characters), a few counts only this side can classify, the
// distribution of the rhythm and how far the text moved. Each measurement "window" is sealed and
// handed to the background (which pushes it to the engine) after 2 s of inactivity, at 200
// keystrokes, when the student leaves the document (another tab, another window, minimized
// browser, closed page) or saves (Ctrl/Cmd+S). It spans from the first to the last activity:
// idle time is never counted in it.

const FLUSH_KEYSTROKES = 200;       // flush at 200 keystrokes, like the desktop agents
const IDLE_FLUSH_MS = 2000;         // flush after 2 s of inactivity
const FLIGHT_MAX_MS = 800;          // beyond this, the gap between two keystrokes isn't a "flight time"
// A silence between two counted keystrokes is written into the runs from this length on, at its
// real duration. The sensor does not classify it: whether it is a writer looking for a word or
// one thinking a paragraph over is read by the engine, in the duration. Shorter is rhythm, and
// rhythm leaves as a histogram.
const GAP_MIN_MS = 1000;
// Up to this, a silence is the short kind — a word being looked for — and a key taken by a
// composition (an accent palette, an IME) cannot attest one: it says nothing of a search for a
// word. Such a silence is written only when it is longer. This constant is this agent's own.
const SHORT_GAP_MAX_MS = 3000;
const ACTIVE_GAP_MAX_S = 60;       // beyond this a gap adds nothing to the effective time
// A shorter paste is not an injection. The engine applies the same rule to the runs it
// receives; it is held here too because the session's running total of injected characters
// (`sum.chars`) is kept by the sensor, and so is what was injected on coming back.
const INJECTION_MIN_CHARS = 15;
// A text the student sends to a corrector (Scribens, Antidote, a translator) and pastes back is
// not an injection: it is their own writing, revised. What leaves the document is remembered as
// hashed word shingles — never as text — and a paste that overlaps them enough is counted as the
// massive revision it is. A corrector changes a few words in a hundred, so four-word shingles
// survive it in large majority; 70 % leaves room for a rewritten sentence or two.
const SHINGLE_WORDS = 4;            // a shingle is four consecutive words
const SELF_PASTE_RATIO = 0.7;       // overlap above which a paste is the student's own text
const SELF_PASTE_TTL_MS = 60 * 60 * 1000;  // how long what left the document stays comparable
const SELF_PASTE_MAX_COPIES = 20;   // only the last copies are kept: the memory is bounded
// How long after coming back to the document a paste still counts as "brought back from
// elsewhere". Leaving, consulting something, coming back and pasting is one gesture; fifteen
// seconds is long enough to find the paragraph again and short enough not to catch a paste made
// in the middle of a writing session that happens to follow a departure.
const RETURN_WINDOW_MS = 15 * 1000;
// How many characters taken out in one unbroken run stop being a typo and start being a phrase
// the writer decided against. A mis-hit letter costs one to a few erases; past this many it is a
// word or a clause coming out, which is a reformulation whatever key did it.
const ERASE_RUN_REFORMULATES = 6;
// How many moves before writing again count as having gone somewhere. One is a brush against an
// arrow, or a caret nudged by a character; two or more is a trip back into the text.
const NAV_STEPS_AWAY = 2;
// What the engine is told about *why* a window was sealed, for each of the triggers that can
// seal one. The engine cannot tell them apart on its own: a save cutting a burst in two looks
// like a writer who never stops, and a departure to another tab looks like a pause for thought.
// Only `away` and `end` mean nobody was looking at the document.
//
// The wire vocabulary (`why`) is six words and it is the same for the four agents
// (docs/mesures.md); the triggers on the left are this agent's own. The word is mandatory: a
// window sealed on a trigger missing from the table would be refused, so the worker drops it —
// `make check` is what keeps one from going missing.
const WIRE_FLUSH_REASONS = {
    idle: 'idle',           // 2 s without activity: the writer stopped
    volume: 'volume',       // FLUSH_KEYSTROKES reached: the counter stopped, not the writer
    save: 'save',           // Ctrl/Cmd+S in the middle of a burst
    focus: 'focus',         // focus moved off the document without the student leaving it
    blur: 'away',           // the student left (departure counted)
    hidden: 'away',         // the tab was hidden, which is the same departure
    pause: 'end',           // measuring suspended
    logout: 'end',          // the student signed out: the session that measured it is over
    pagehide: 'end',        // the page is going away
};
// Google Docs stages a copy in its hidden iframe after the copy handler has run: how long we
// give it before giving up on reading what left the document.
const COPY_RETRY_MS = 50;
// How long a volume reading stays good enough to reuse. Every reader is expensive — a network
// export for Google Docs, a forced layout for the two that read `innerText` — and a window
// closes several times a minute for somebody who is writing. The LibreOffice agent has held its
// own read to 5 s from the start; this is the same rule, with the longer delay the export
// deserves. An editor carries its own in `volumeMaxAgeMs`.
const VOLUME_REFRESH_MS = 30 * 1000;
const LOCAL_VOLUME_REFRESH_MS = 5000;
const VOLUME_TIMEOUT_MS = 5000;

// --- WHAT A WINDOW CARRIES ---
// A window is numbered within a session, and it carries the ordered runs of what happened, the
// few counts only the sensor can classify, the distribution of the rhythm and how far the text
// moved between two readings (docs/moteur.md, "Le corps de mesure"). Every one of these is a
// number or a category. None is a character, a key or a fingerprint of the text — and nothing
// the engine can work out from the runs (how many keystrokes, pastes, pauses) travels beside
// them.
//
// The most runs a window may carry: the engine refuses more. A window is sealed before it gets
// there, TIMELINE_RESERVE runs early because one gesture adds up to three (the silence that
// ended, the keystroke, the undo it was).
const TIMELINE_MAX_RUNS = 512;
const TIMELINE_RESERVE = 4;
// Lower edges of the histograms, in milliseconds. The last flight bin stops at FLIGHT_MAX_MS,
// the last dwell bin is open. The four agents and the engine hold the same edges, and `make
// check` compares them: a histogram with other edges is a different measurement under the same
// name.
const FLIGHT_BINS_MS = [0, 20, 40, 60, 80, 100, 130, 160, 200, 250, 320, 400, 500, 650];
const DWELL_BINS_MS = [0, 20, 40, 60, 80, 100, 120, 150, 200, 300];
// Random bytes behind a session id: 128 bits, drawn when the sensor starts measuring a document.
const SESSION_ID_BYTES = 16;
const SESSION_ID_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
// Keys held down at once, remembered only to pair each press with its release: ten fingers. And
// how long a press may wait for a release before it is taken for one the page never delivered —
// focus moved while the key was down — rather than for a key still held.
const KEYS_DOWN_MAX = 10;
const KEY_STALE_MS = 10 * 1000;
// How many words on either side of a text span are still compared word for word, to say how
// much of what was inserted was already there (see keptChars). The protocol stops at 2 000;
// this sensor stops at half of that, because the comparison grows with the product of the two
// sides and runs on the student's thread: a thousand words a side is about 3 ms on a
// development machine, two thousand is three times that. Past the limit the figure is left
// out, which the protocol allows and the engine reads as "not computed".
const TEXT_KEPT_MAX_WORDS = 1000;

// What a page takes text in, for a site the student added. A textarea holds its text in
// `value`, a rich editor in a contenteditable element; the three class names are the bodies of
// the editors Moodle and Canvas ship with.
const SITE_EDITOR_AREA = 'textarea, [contenteditable="true"], [contenteditable=""], .ProseMirror, .ql-editor, .cm-content';

// The platforms a page added by the student may be, recognised by what the page carries.
//
// A fingerprint rots: this only ever **refines**, it never gates. A page nobody recognises
// keeps the generic behaviour — the longest editing area and the page title — and the sensor
// works there exactly the same.
const PLATFORMS = [
    {
        name: 'Moodle',
        // Moodle puts the page's own route in the body class (`path-mod-assign`) and names
        // itself in the generator meta. Either is enough.
        recognise: () => /(^|\s)path-mod-/.test(document.body?.className || '')
            || /moodle/i.test(/** @type {HTMLMetaElement} */
                (document.querySelector('meta[name="generator"]'))?.content || ''),
        // The online-text field of an assignment: on a Moodle, that *is* the copy. The generic
        // rule would take the longest area of the page, which is usually the same one — but a
        // long forum post further down the page would beat it.
        area: '#id_onlinetext_editoreditable, [id^="id_onlinetext"], [id$="_editoreditable"]',
        // The assignment's title, rather than "Devoir : Dissertation | Mon établissement".
        title: () => document.querySelector('.page-header-headings h1, #region-main h2, h1.h2')?.textContent,
    },
    {
        name: 'Canvas',
        recognise: () => !!document.querySelector('#application.ic-app, body.ic-app')
            || /(^|\s)context-course/.test(document.body?.className || ''),
        area: '.ic-RichContentEditor [contenteditable="true"], #submission_body',
        title: () => document.querySelector('h1.title, .assignment-title h1, h1')?.textContent,
    },
];

// The platform of this page, read once: a page does not change identity under the student.
let platform;
function pagePlatform() {
    if (platform === undefined) {
        platform = PLATFORMS.find((candidate) => {
            try {
                return candidate.recognise();
            } catch (_) {
                return false;   // a fingerprint that throws is a fingerprint that does not match
            }
        }) || null;
    }
    return platform;
}

const NAV_KEYS = new Set(['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown']);
// Every modifier key value UI Events defines, plus the legacy `OS` older Firefoxes send for the
// Windows/Command key. `Meta` is Command on macOS, so a student on a Mac is covered by the same
// name — and `Fn`, which only a laptop keyboard has, is named here precisely because whether it
// fires a key event at all depends on the browser: naming it costs nothing and settles the
// question. The list is values, not guesses: a key missing from it would be counted as a
// keystroke it never was.
const MODIFIER_KEYS = new Set([
    'Shift', 'Control', 'Alt', 'Meta', 'AltGraph', 'CapsLock', 'OS',
    'Fn', 'FnLock', 'NumLock', 'ScrollLock', 'Symbol', 'SymbolLock', 'Hyper', 'Super',
]);

// --- DEBUG MODE ---
// Switched on from the options page. It logs what the sensor counts (categories and counters
// only — never a character, never a key) so a student's "my deletions aren't counted" can be
// checked against what the engine displays.
let debug = false;

// The prefix belongs **inside** the format string: `console.log('[Certimens]', 'x: %d', 1)`
// prints the `%d` as it is, because the browser only substitutes when the specifiers are in the
// first argument. Every formatted line below used to reach the console with its `%s` showing.
function debugLog(format, ...args) {
    if (debug) console.log('[Certimens] ' + format, ...args);
}

// --- SUSPENDED MEASUREMENT ---
// Switched from the popup, and read here rather than pushed: every document open in the browser
// must follow the same state, and a page loaded after the pause must start suspended too.
//
// Suspending stops the *measurement*, not the sending: the window in progress is flushed on the
// way in, and the queue keeps draining. What was measured before the pause is already the
// engine's; holding it back would only turn a pause into a late, suspicious batch.
//
// Both flags start closed and open only once the stored value has been read. The read is a round
// trip to the browser process while every listener below is already live, so starting at
// "measuring" meant a page loaded during a suspension measured until the answer came back — and
// the correcting path only assigns, so what that gap counted was kept and left later inside the
// suspension. Starting closed loses nothing worth having: the editing area the counting path
// filters on is not built at document idle either, and a rejected read now leaves the sensor
// quiet rather than measuring for the page's whole life.
let paused = true;
// Measurement belongs to a session. Signing out revokes the token, and nothing the student
// writes afterwards is theirs to send — the queue would hold it for whichever account pairs
// next. The flag carries no credential: it says a session exists, not whose.
let signedIn = false;

try {
    chrome.storage.local.get(['debug', 'paused', 'signedIn']).then(({ debug: on, paused: off, signedIn: live }) => {
        debug = !!on;
        paused = !!off;
        signedIn = !!live;
    }, () => {});
    chrome.storage.onChanged.addListener((changes, area) => {
        if (area !== 'local') return;
        if (changes.debug) debug = !!changes.debug.newValue;
        if (changes.signedIn) {
            signedIn = !!changes.signedIn.newValue;
            if (!signedIn) {
                debugLog('signed out: measuring stops here');
                flush('logout');
                closeSession();
            }
        }
        if (changes.paused) {
            paused = !!changes.paused.newValue;
            debugLog(paused ? 'measuring paused' : 'measuring resumed');
            if (paused) {
                flush('pause');
                closeSession();
            }
        }
    });
} catch (_) { /* extension reloaded: the page keeps measuring without the debug mode */ }

// The one question every counting handler asks. A suspension and a sign-out stop the same thing
// for different reasons, and a handler that remembers only one of them is how both shipped.
function measuring() {
    return !paused && signedIn;
}

// --- COUNTING CHARACTERS ---
// How many characters a text holds, counted in code points exactly as `[...text].length` does —
// and without the array that spreading one allocates, an element per character, on a document
// read at every window. A text holding no high surrogate has as many code points as UTF-16
// units, which a native scan answers in one pass; the loop is only for the rest, emoji and the
// astral planes. The count must stay identical: the engine counts a deposited document the same
// way, and the size sent in `text.len` is compared with it.
const HIGH_SURROGATE = /[\uD800-\uDBFF]/;

function codePoints(text) {
    if (!HIGH_SURROGATE.test(text)) return text.length;
    let count = text.length;
    for (let i = 0; i < text.length - 1; i++) {
        const unit = text.charCodeAt(i);
        if (unit >= 0xd800 && unit <= 0xdbff) {
            const low = text.charCodeAt(i + 1);
            if (low >= 0xdc00 && low <= 0xdfff) {
                count--;
                i++;
            }
        }
    }
    return count;
}

// --- THE CLOCK ---
// Every duration this sensor measures — the length of a window, a silence, a run, a flight
// time, how long a key is held, the effective typing time — is read on the monotonic clock, in
// whole milliseconds. The wall clock is the student's to set, and a duration read on it would
// move with it; it only dates a window (`at`, in markActivity) and things that are never sent.
// Never zero: several "not yet" states below are a zero.
function tick() {
    return Math.max(1, Math.round(performance.now()));
}

function median(values) {
    if (values.length === 0) return 0;
    const sorted = [...values].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

// Median absolute deviation (MAD) of flight times: regularity of the typing rhythm.
function medianAbsoluteDeviation(values) {
    if (values.length < 2) return 0;
    const med = median(values);
    return median(values.map((v) => Math.abs(v - med)));
}

// --- 0. SUPPORTED EDITORS ---
// Each editor describes: the document's stable id, its name, the editing area (keystrokes
// and clicks outside this area — menus, comments — don't count), its possible input
// iframes, how to read the document's real volume, and where its corrector draws the spellings
// it suggests (`correctionMenu`, see recordSpellCorrection). That last one is left `null` where
// the DOM has not been read in a real document: a selector nobody has checked would quietly
// count nothing, and counting nothing is what the agent already does.
const EDITORS = {
    gdocs: {
        documentId() {
            const match = location.href.match(/^https:\/\/docs\.google\.com\/document\/d\/([a-zA-Z0-9-_]+)/);
            return match ? match[1] : null;
        },
        documentName() {
            return document.title.replace(/\s+-\s+Google\s+\S+$/, '').trim() || 'Google Doc';
        },
        editorArea: '.kix-appview-editor',
        // Google Docs receives keystrokes in a dedicated iframe (same origin).
        inputIframes: 'iframe.docs-texteventtarget-iframe',
        // The whole Docs is in this page: losing focus means leaving the document.
        blurMeansLeaving: true,
        remoteVolume: true,
        volume: fetchGoogleDocsVolume,
        volumeMaxAgeMs: VOLUME_REFRESH_MS,
        // Where the corrector draws the spellings it offers. To be read in a real document
        // before being filled in: see TESTING.md, a selector nobody has checked counts nothing.
        correctionMenu: null,
        // .docx export done by the background (see fetchGoogleDocsVolume).
        deposit: 'export',
    },
    word: {
        // The Word Online editor is the wordeditorframe.aspx iframe, where this script runs; the
        // document is identified there by its WOPISrc, stable from one opening to the next (the prefix
        // distinguishes these ids from Google Docs ones).
        documentId() {
            const src = [...new URLSearchParams(location.search)].find(([key]) => key.toLowerCase() === 'wopisrc')?.[1];
            return src ? 'word:' + src.split('?')[0] : null;
        },
        documentName() {
            const title = document.querySelector('#documentTitle, [data-unique-id="DocumentTitleContent"], #BreadcrumbTitle')?.textContent
                || document.title.replace(/\s+-\s+(Microsoft\s+)?Word.*$/i, '');
            return title.trim() || 'Document Word';
        },
        editorArea: '#WACViewPanel',
        inputIframes: null,
        // A click in the Microsoft 365 header (parent page) makes the iframe lose focus
        // without leaving the document: only hiding the page counts as leaving.
        blurMeansLeaving: false,
        remoteVolume: false,
        volume: readWordVolume,
        volumeMaxAgeMs: LOCAL_VOLUME_REFRESH_MS,
        // Word Online draws its own suggestion menu rather than the browser's. Same as above.
        correctionMenu: null,
        // No export: the editing iframe has no access to the file (WOPI token not exposed),
        // so the popup offers to send a downloaded copy.
        deposit: 'pick',
    },
    // A site the student added themselves, from the options page: a Moodle, a Canvas, a wiki —
    // anything with a text field they write their assignment in. There is no editor we know by
    // name here, so nothing is addressed by its own selectors: the document is the page, and
    // the editing area is whatever the page uses to take text.
    //
    // Every establishment has its own domain, so this cannot be a manifest entry: the student
    // adds the address, the browser asks them for the permission, and the service worker
    // registers the content script for it (see background.js, "SITES ADDED BY THE STUDENT").
    site: {
        // The page is the document. Its query string is part of the id because that is where a
        // Moodle names the assignment — and the id never leaves the machine, only the title does.
        documentId() {
            return 'site:' + location.hostname + location.pathname + location.search;
        },
        documentName() {
            const titled = pagePlatform()?.title?.();
            return (titled || document.title).trim() || location.hostname;
        },
        // The fields a page takes text in. Written as one selector because `closest()` reads it:
        // a keystroke outside an editing area — a search box, a menu — is not writing.
        editorArea: SITE_EDITOR_AREA,
        // The rich editors of Moodle and Canvas (TinyMCE, CKEditor) put their body in a
        // same-origin iframe. Named rather than `iframe`, which would attach this sensor to
        // every advertisement on an arbitrary page.
        inputIframes: 'iframe.tox-edit-area__iframe, iframe[id$="_ifr"], iframe.cke_wysiwyg_frame',
        blurMeansLeaving: true,
        remoteVolume: false,
        // Readable, unlike Overleaf: the whole text is in the field, nothing is virtualised.
        volume: readSiteVolume,
        volumeMaxAgeMs: LOCAL_VOLUME_REFRESH_MS,
        // An arbitrary page has no corrector of its own: what underlines a word there is the
        // browser's, whose menu is not in the page and whose clicks never reach this script.
        correctionMenu: null,
        // The copy is in the page, not in a file: on a Moodle's online-text assignment there is
        // no document to pick. The student sends the text of the field they wrote in — on an
        // explicit click, like every other deposit.
        deposit: 'text',
    },
    overleaf: {
        // The project id in the URL, stable from one opening to the next. A project holds
        // several .tex files, but the engine document is the project: the student writes a
        // dissertation, not a file, and Overleaf's own editor switches between them without
        // reloading the page.
        documentId() {
            const match = location.pathname.match(/^\/project\/([a-f0-9]+)/);
            return match ? 'overleaf:' + match[1] : null;
        },
        documentName() {
            const shown = document.querySelector('.project-name, [class*="project-name"]')?.textContent;
            return (shown || document.title.replace(/\s+-\s+Overleaf.*$/i, '')).trim() || 'Projet Overleaf';
        },
        // CodeMirror 6: the editable area is a contenteditable div, not an iframe.
        editorArea: '.cm-editor',
        inputIframes: null,
        // The whole project is in this page: losing focus means leaving the document.
        blurMeansLeaving: true,
        remoteVolume: false,
        // No `text` block, on purpose. CodeMirror only renders the visible lines:
        // counting the characters in the DOM would report a fraction of a long document, and that
        // would move with the scrollbar. A wrong volume is worse than none — the engine
        // distinguishes an absent measurement from a zero (see docs/mesures.md).
        volume: () => null,
        volumeMaxAgeMs: LOCAL_VOLUME_REFRESH_MS,
        // CodeMirror brings no corrector of its own: the browser's, again, is out of reach.
        correctionMenu: null,
        // No export either: the sources are not reachable from the page without the project's
        // own session plumbing, so the popup offers to send a downloaded copy.
        deposit: 'pick',
    },
};
// Which editor this page is. A host, an entry: adding an editor is adding one above, never a
// test scattered elsewhere.
//
// The fall-through is `site` and no longer Word Online: since the student can register this
// script on an address of their own, "not one of the editors we know" no longer means "the
// Word Online iframe", which the manifest used to be alone in matching.
const editor = (() => {
    const host = location.hostname;
    if (host === 'docs.google.com') return EDITORS.gdocs;
    if (host.endsWith('overleaf.com')) return EDITORS.overleaf;
    if (host.endsWith('.officeapps.live.com') || host.endsWith('.cloud.microsoft')) return EDITORS.word;
    return EDITORS.site;
})();

// --- 1. MEASUREMENT WINDOW ---
function newMeasure() {
    return {
        // The wall clock at the first activity, or null while the window is not open.
        start: null,
        activeMs: 0,
        // What only the sensor can classify: these leave in `counts`.
        corrections: 0,
        reformulations: 0,
        navigation: 0,
        macroRevisions: 0,
        focusLosses: 0,
        keystrokesAfterReturn: 0,
        injectedCharsAfterReturn: 0,
        // What the engine works out from the runs, and what the session's running totals
        // (`sum`) are made of. Kept here for those totals and for the 200-keystroke seal; none
        // of the three leaves as a figure of the window.
        keystrokes: 0,
        injectedChars: 0,
        pasteEvents: 0,
        flights: [],
        // The first and the last activity, on the monotonic clock (see tick).
        monoStart: 0,
        monoLast: 0,
        // The ordered runs of this window (see addRun).
        /** @type {{ kind: string, n: number, born: number, from: number | null, to: number | null }[]} */
        runs: [],
        // How long the `type` keys were held, by bin, and how many were pressed while another
        // one was still down.
        dwell: DWELL_BINS_MS.map(() => 0),
        rollover: 0,
    };
}

let measure = newMeasure();
let lastPressTime = 0;
let lastEventTime = 0;
let lastActivityTime = 0;
// How far the writer has travelled since they last wrote anything. It replaces a boolean: a
// deletion only needs to know the caret moved at all, but an *insertion* has to tell a real trip
// back through the text from a single arrow press, and a boolean cannot. See NAV_STEPS_AWAY.
let navSteps = 0;
// Whether the last move was a click. A click is already a trip in `navSteps`; this only names it
// in the debug log, where "after a click" and "after a move" are the two things a tester checks.
let mouseClickedRecently = false;
// Erases pressed in an unbroken run, and whether that run has already been read as a
// reformulation. Anything that is not an erase ends the run. See ERASE_RUN_REFORMULATES.
let eraseRun = 0;
let eraseRunReformulated = false;
// Scope of the selection the next keystroke would replace: 'all' for a Ctrl/Cmd+A or a mouse
// drag (a block), 'range' for a Shift+navigation selection (a targeted span), null for none.
// Typing or pasting over a selection deletes it — a revision the sensor used to miss entirely,
// since it only ever watched Backspace, Delete, Ctrl+X and Ctrl+Z.
let selectionScope = null;
let mouseDownAt = null;

// The document was left (a counted focus loss), then came back: the instant of the return is
// what tells an injection brought back from elsewhere from one made while writing. Set only
// where a departure is actually counted, so a focus shift inside the page is not a return.
let awayFrom = 0;
let lastReturnAt = 0;

let idleTimer = null;

let cachedVolume = null;
let cachedVolumeAt = 0;

// --- THE SESSION ---
// One per stretch of measuring one document: opened by the first window sealed after the page
// loaded, after a suspension was lifted or after pairing again, closed when measuring stops.
// It numbers the windows and holds the running totals, and both move **when a window is
// sealed**, not when it is sent: a window that never arrives then shows — the next one carries
// a number that skips and totals the received windows do not add up to.
//
// It lives here, in the page, and not in the service worker, for that very reason. The worker
// is what a sealed window may fail to reach — it is asleep, the extension was reloaded, the
// message is dropped — and a number handed out by the side that never saw the window could not
// say that one went missing. Nothing of it is stored: the id is random, tied to neither the
// account nor the machine, and it dies with the page. The only copy that outlives it is the
// one a queued window carries.
//
// `origin` is the zero of the monotonic clock, `reading` the last text read and the window
// that carried it — the one thing kept of the text, in memory, until the next reading replaces
// it or the session closes.
/** @type {null | { id: string, documentId: string, origin: number, seq: number, closed: boolean,
 *   sum: { keys: number, chars: number, pastes: number },
 *   reading: null | { seq: number, text: string } }} */
let session = null;

function newSessionId() {
    const bytes = crypto.getRandomValues(new Uint8Array(SESSION_ID_BYTES));
    // base64url by hand: `btoa` would need the bytes as a string first, and its alphabet is
    // not the one the engine accepts.
    let id = '';
    for (let i = 0; i < bytes.length; i += 3) {
        const chunk = (bytes[i] << 16) | ((bytes[i + 1] || 0) << 8) | (bytes[i + 2] || 0);
        const digits = Math.min(4, Math.ceil((bytes.length - i) * 8 / 6));
        for (let d = 0; d < digits; d++) id += SESSION_ID_ALPHABET[(chunk >> (18 - 6 * d)) & 63];
    }
    return id;
}

// Measuring stops: what the session kept of the text goes with it, and whatever is measured
// next belongs to a new one. So does the last keystroke: a silence never crosses a session — it
// is measured from the last keystroke of the current one, so the first keystroke of the next
// session ends no silence and its first window carries none at its head.
function closeSession() {
    endSession();
    keysDown.clear();
    lastEventTime = 0;
    lastPressTime = 0;
}

// The session alone, without the keyboard's clock: for a page that became another document
// while the student was typing, whose keystrokes go on.
function endSession() {
    if (session) {
        session.closed = true;
        session.reading = null;
    }
    session = null;
}

// --- THE RUNS ---
// What happened in the window, in order: twenty keystrokes in four seconds, a silence, three
// clicks, a paste of 240 characters. This is the one statement of those facts: the engine
// counts the keystrokes, the pastes, the injected characters and the silences from it, so no
// figure can contradict the runs it came from.
//
// A run never records a key, and a `type` run is never cut on what was typed: a space, a
// comma and a letter are the same keystroke here, so no run has the length of a word.
//
// `born` is when the run began and orders it against a silence; `from` and `to` bound what it
// reports as its duration, and stay null for a run that has none. Only the four keystroke
// kinds have one: a click, a paste, a copy are instants, and a click in particular often falls
// inside a silence, where a duration of its own would count the same time twice.
//
// A window never outgrows TIMELINE_MAX_RUNS: `sealIfFull` runs before every gesture, and the
// reserve it keeps is larger than what one gesture adds.
const KEYSTROKE_RUNS = new Set(['type', 'erase', 'nav', 'other']);

function pushRun(kind, n, now, timed) {
    measure.runs.push({ kind, n, born: now, from: timed ? now : null, to: timed ? now : null });
}

// A run as it is sent, in the shape of its kind: `[kind, n, ms]` for keystrokes, `["gap", ms]`
// for a silence, `[kind, n]` for a gesture that has no duration.
function wireRun(run) {
    if (run.kind === 'gap') return ['gap', run.to - run.from];
    if (KEYSTROKE_RUNS.has(run.kind)) return [run.kind, run.n, run.from === null ? 0 : run.to - run.from];
    return [run.kind, run.n];
}

// One more of `kind`. Two consecutive runs never share a kind, so it joins the last run when
// it can. `timed` is false for what must not stretch a duration: a paste, or the keystroke a
// restitution stands for, which is not on the keyboard's clock.
function addRun(kind, n, now, timed = true) {
    const last = measure.runs[measure.runs.length - 1];
    if (!last || last.kind !== kind) {
        pushRun(kind, n, now, timed);
        return;
    }
    last.n += n;
    if (timed) {
        if (last.from === null) last.from = now;
        last.to = now;
    }
}

// A click, a copy, a corrector's spelling: the only gestures that can pile up without the
// window ever being sealed — a window with no keystroke and no paste is carried over, not sent.
// Past the reserve they are no longer added, which keeps room for the gesture that will finally
// seal it.
function addLooseRun(kind, n, now, timed) {
    if (measure.runs.length >= TIMELINE_MAX_RUNS - TIMELINE_RESERVE) return;
    addRun(kind, n, now, timed);
}

// A paste is one run per gesture, whatever precedes it: two pastes in a row stay two runs.
function addPasteRun(kind, chars, now) {
    pushRun(kind, chars, now, false);
}

// A silence between two counted keystrokes, from `since` to `now`. It takes its place where
// the silence began: before the clicks and the pastes made during it, which carry no duration
// of their own — so the durations of the runs never overlap, which is what lets the engine
// add them up against the length of the window. A silence that began before the window opened
// is the first run, whatever opened the window before the first keystroke.
function addGap(since, now) {
    const runs = measure.runs;
    let at = runs.length;
    if (since < measure.monoStart) at = 0;
    else while (at > 0 && runs[at - 1].born > since) at--;
    runs.splice(at, 0, { kind: 'gap', n: 1, born: since, from: since, to: now });
}

// A window about to outgrow the runs the engine accepts is sealed first, like one that
// reached FLUSH_KEYSTROKES: the counter stopped, not the writer. Called before a gesture is
// counted, never in the middle of one.
function sealIfFull() {
    if (measure.runs.length >= TIMELINE_MAX_RUNS - TIMELINE_RESERVE && hasActivity()) flush('volume');
}

// --- KEYS HELD DOWN ---
// How long a key stays down, and whether the next one lands before it is released, is the
// part of a rhythm a script replaying keystrokes does not have. Only `type` keys are followed.
// A press is remembered under its physical position (`code`) for as long as it takes to meet
// its release, and for nothing else: the entry holds an instant, the map is bounded and emptied
// when the document is left, and no code is ever logged or sent.
/** @type {Map<string, { at: number, rolled: boolean }>} */
const keysDown = new Map();

function noteKeyDown(code, now) {
    if (!code) return;
    let held = false;
    for (const [other, press] of keysDown) {
        if (other === code || now - press.at > KEY_STALE_MS) keysDown.delete(other);
        else held = true;
    }
    if (keysDown.size >= KEYS_DOWN_MAX) keysDown.delete(keysDown.keys().next().value);
    keysDown.set(code, { at: now, rolled: held });
}

// The release of a key followed above. Both figures are counted here, in the window open when
// the key comes up: a keystroke is counted when the key goes down and its hold when it comes
// back, so a window sealed between the two leaves the hold to the next one. The engine allows
// for exactly that — a couple of holds more than the window has `type` keystrokes.
function onKeyUp(e) {
    if (!e.isTrusted || !e.code) return;
    const press = keysDown.get(e.code);
    if (!press) return;
    keysDown.delete(e.code);
    if (!measuring()) return;
    measure.dwell[binOf(DWELL_BINS_MS, tick() - press.at)]++;
    if (press.rolled) measure.rollover++;
}

// The bin a duration falls in: the last one whose lower edge it reaches.
function binOf(edges, value) {
    let bin = edges.length - 1;
    while (bin > 0 && value < edges[bin]) bin--;
    return bin;
}

function histogram(edges, values) {
    const counts = edges.map(() => 0);
    for (const value of values) counts[binOf(edges, value)]++;
    return counts;
}

// A histogram as it is sent: the zeros at its tail are not, and one that is all zeros is `[]`.
function trimmed(bins) {
    let length = bins.length;
    while (length > 0 && bins[length - 1] === 0) length--;
    return bins.slice(0, length);
}

// A keystroke, and whether it lands in the seconds after coming back to the document.
//
// The mirror of what is injected after a return (`counts.back_chars`), and the gesture it
// catches is leaving the document, reading something, coming back and **typing** it: pasting
// after a return was measured, typing after one was the whole second-screen vector, invisible.
//
// It is also the only place a silence is read from — see trackSilence — and the only place
// a keystroke enters the runs: `kind` is the category the caller has just given the key for
// its own counts (`type`, `erase`, `nav`, `other`), not a second reading of it.
function countKeystroke(now, kind, composing = false) {
    trackSilence(now, composing);
    measure.keystrokes++;
    addRun(kind, 1, now);
    if (lastReturnAt && now - lastReturnAt < RETURN_WINDOW_MS) measure.keystrokesAfterReturn++;
}

// Any activity opens the window if needed, pushes back its end and restarts the idle timer.
function markActivity(now) {
    sealIfFull();
    if (measure.start === null) {
        // The one reading of the wall clock a window takes: it dates the window (`at`), and
        // measures nothing.
        measure.start = Date.now();
        measure.monoStart = now;
    }
    measure.monoLast = now;
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => flush('idle'), IDLE_FLUSH_MS);
}

// A silence of GAP_MIN_MS or more between two **counted keystrokes** is written into the runs,
// at its real length and uncapped. It is not classified here: the engine reads a hesitation or
// a pause in the duration, and a silence too long to be either is still sent as what it was.
//
// Between two keystrokes, and nothing else: trackSilence is called by countKeystroke alone, so
// `lastEventTime` is the last counted keystroke. A click, a paste (its shortcut included,
// which counts no keystroke), a spelling chosen in the corrector neither end a silence nor
// restart one: stopping, reading with the mouse in hand and typing again is **one** silence,
// written when the typing resumes — and a window holding a paste and no keystroke holds no
// silence at all.
//
// One exception: a key taken by a composition says nothing of a search for a word, so the
// short silence it ends is not written. Past SHORT_GAP_MAX_MS it is, like any other.
function trackSilence(now, composing) {
    if (lastEventTime > 0) {
        const gap = now - lastEventTime;
        if (gap >= GAP_MIN_MS && !(composing && gap <= SHORT_GAP_MAX_MS)) addGap(lastEventTime, now);
    }
    lastEventTime = now;
}

// Effective time: the real gap if <= 2 s, a flat 250 ms if < ACTIVE_GAP_MAX_S, nothing beyond.
function trackActiveTime(now) {
    if (lastActivityTime > 0) {
        const gap = now - lastActivityTime;
        if (gap <= 2000) measure.activeMs += gap;
        else if (gap < ACTIVE_GAP_MAX_S * 1000) measure.activeMs += 250;
    }
    lastActivityTime = now;
}

function hasActivity() {
    return measure.keystrokes > 0 || measure.pasteEvents > 0;
}

// A selection about to be replaced is a deletion of everything it spans: a whole-document or
// dragged selection weighs as a mass revision, a Shift+navigation one as a deferred
// reformulation — the same scale the deletion keys already use. Returns true when one was spent.
// Anything that is not an erase ends the run, so the next one is judged on its own length.
function endEraseRun() {
    eraseRun = 0;
    eraseRunReformulated = false;
}

// One more character out of the run. Returns true the one time the run crosses
// ERASE_RUN_REFORMULATES: that press is read as a reformulation, and the ones after it as
// nothing — hammering Backspace through a phrase is **one** gesture.
function extendEraseRun() {
    eraseRun++;
    if (eraseRun < ERASE_RUN_REFORMULATES || eraseRunReformulated) return false;
    eraseRunReformulated = true;
    return true;
}

function consumeSelection() {
    if (!selectionScope) return false;
    if (selectionScope === 'all') measure.macroRevisions++;
    else measure.reformulations++;
    debugLog('selection replaced → %s', selectionScope === 'all' ? 'mass revision' : 'deferred reformulation');
    selectionScope = null;
    return true;
}

// What pastes from the keyboard. `mod` is Ctrl **or Cmd**, so a student on a Mac is covered by
// the same test: a shortcut named on one side only would make them a student who never pastes.
// Shift is deliberately not excluded — Ctrl/Cmd+Shift+V is "paste without formatting", which is
// a paste, and on macOS so is Cmd+Option+Shift+V. Shift+Insert is the third one, which Windows
// and Linux still honour and which Mac keyboards do not have. All of them raise a `paste` event,
// and that is where the gesture is counted.
function isPasteShortcut(e, mod, lower) {
    return (mod && lower === 'v') || (e.shiftKey && lower === 'Insert');
}

// --- 2. CAPTURE ---
function onKeyDown(e) {
    if (!measuring() || !e.isTrusted) return;
    // A held key repeats, and the repeats are not keystrokes: Backspace held down is **one**
    // deletion, whatever the keyboard's repeat rate. But what it takes out is a run like any
    // other, and only its length can say whether a phrase went out with it. The repeats feed
    // the run and nothing else — no keystroke, no rhythm, no activity. Word and VS Code need no
    // such rule: they see the characters go.
    if (e.repeat) {
        if ((e.key === 'Backspace' || e.key === 'Delete') && !e.ctrlKey && !e.metaKey && !e.altKey
                && extendEraseRun()) {
            measure.reformulations++;
            debugLog('held erase → deferred reformulation (run of %d)', eraseRun);
        }
        return;
    }
    // A modifier pressed on its own is not a keystroke: it writes nothing, and the near-zero gap
    // it leaves before the character it modifies would pass for an impossibly fast one — which is
    // exactly what the flight times are meant to tell apart. Word and VS Code,
    // which count characters, never see one; counting them here made the same student look
    // faster and more prolific in the browser than in an editor. It is dropped before anything else, so a
    // Shift pressed between a click and a Backspace no longer spends the click either.
    if (MODIFIER_KEYS.has(e.key)) return;
    // A dead key is a modifier that does not say so: `^` waiting for the `e` it will turn into
    // `ê` writes nothing by itself, so the rule above is its rule too. Counting it made the
    // browser report two keystrokes where Word and VS Code, counting characters, report one.
    if (e.key === 'Dead') return;
    const now = tick();
    markActivity(now);

    // A key taken by a composition — the accent palette macOS opens on a held letter, an IME —
    // does write, eventually, so it is a keystroke. But it says nothing about where the student
    // is in their document, and nothing about the rhythm of their typing.
    //
    // The arrows that walk that palette are why this matters: counted as navigation jumps, they
    // also told the next deletion it was a deferred reformulation — for somebody who never left
    // their line. Like a modifier, such a key does not spend the click that precedes it either.
    const composing = e.isComposing || e.key === 'Process';

    if (!composing && lastPressTime > 0) {
        const flight = now - lastPressTime;
        // What lies above a flight time is a silence, and silences are written by
        // trackSilence.
        if (flight < FLIGHT_MAX_MS) {
            measure.flights.push(flight);
            if (measure.flights.length > 500) measure.flights.shift();
        }
    }
    lastPressTime = now;

    if (composing) {
        trackActiveTime(now);
        // It does write, eventually: a `type` keystroke, whose key is not read and whose hold
        // is not timed.
        countKeystroke(now, 'type', true);
        if (measure.keystrokes >= FLUSH_KEYSTROKES) flush('volume');
        return;
    }

    const key = e.key;
    const mod = e.ctrlKey || e.metaKey;
    const lower = key.length === 1 ? key.toLowerCase() : key;
    const pasting = isPasteShortcut(e, mod, lower);
    // What the runs will call this keystroke. It follows the branch taken below, and the
    // last one is split on the only thing the sensor already asks of such a key: whether it
    // writes. A character, Enter and Tab do; a shortcut and a named key (Escape, F5) do not.
    // AltGr reaches the browser as Ctrl+Alt on Windows and types `@`, `#`, `{` or `€` on a
    // French keyboard: it is no shortcut, and reading it as one would cut a run on a class of
    // characters — the one thing a run must never be cut on.
    const shortcut = mod && !(e.ctrlKey && e.altKey && !e.metaKey);
    let kind = !shortcut && (key.length === 1 || key === 'Enter' || key === 'Tab') ? 'type' : 'other';

    // Ctrl/Cmd+A selects the whole document; Shift with a navigation key extends a selection.
    // Shift alone must not count: it is also how capitals are typed.
    if (mod && lower === 'a') selectionScope = 'all';
    else if (e.shiftKey && NAV_KEYS.has(key)) selectionScope = 'range';

    if (key === 'Backspace' || key === 'Delete') {
        kind = 'erase';
        // Erasing a selection is scored by what it spans, not by what preceded it — and it ends
        // the run, like everything else that is not one more press into it.
        //
        // That last part is a guard and not a repair: every way of making a selection already
        // passes through a handler that ends the run (Shift+arrow through the navigation branch,
        // Ctrl/Cmd+A and a dragged selection's mousedown through theirs), so the state cannot
        // currently survive into here. It is written down anyway because the invariant was
        // holding in three distant places at once, and the next way of setting a selection would
        // have reopened it in silence — a run already credited leaves `eraseRunReformulated`
        // set, and the presses after it fall through both branches below and are counted nowhere
        // at all.
        if (consumeSelection()) {
            endEraseRun();
        } else {
            // Ctrl/Cmd+Backspace takes a whole word out in one press, and so does Option+Delete
            // on a Mac. Whoever reaches for it is not repairing a mis-hit letter: they are
            // removing a word they have decided against, which is the same act as walking back
            // to it and erasing it. (Writer binds the word erase to Ctrl/Cmd alone, which is why
            // the LibreOffice sensor reads no Alt here.)
            const wordErase = mod || e.altKey;
            if (wordErase || navSteps > 0) {
                measure.reformulations++;
                debugLog('deletion → deferred reformulation (%s)',
                    wordErase ? 'whole word' : mouseClickedRecently ? 'after a click' : 'after a move');
                // The trip is spent on this one deletion, and so is the run: what follows is
                // being erased on the spot and reads as an immediate correction again. That rule
                // predates the widening and stays deliberate — without it one click turned every
                // later deletion into a reformulation, and immediate corrections stayed at zero
                // for a student who clicks before correcting, which is what everyone does.
                endEraseRun();
            } else if (extendEraseRun()) {
                // The run has gone past what a typo costs. It is read once and the rest of it is
                // not counted again: it used to arrive as twenty immediate corrections.
                measure.reformulations++;
                debugLog('deletion → deferred reformulation (run of %d)', eraseRun);
            } else if (!eraseRunReformulated) {
                measure.corrections++;
                debugLog('deletion → immediate correction');
            }
        }
        navSteps = 0;
    } else if (NAV_KEYS.has(key)) {
        kind = 'nav';
        measure.navigation++;
        // An arrow is a nudge by one character or one line. Anything else — Home, End, a page,
        // or an arrow with Ctrl/Cmd/Option, which crosses a word or a line — is a jump, the one
        // an editor gives a shortcut for. VS Code measures the same thing by distance.
        navSteps += (!mod && !e.altKey && key.startsWith('Arrow')) ? 1 : NAV_STEPS_AWAY;
        endEraseRun();
        // A navigation without Shift collapses the selection instead of extending it.
        if (!e.shiftKey) selectionScope = null;
    } else {
        // A character typed over a selection replaces it. Ctrl/Cmd shortcuts are excluded: they
        // act on the selection (copy, select-all) rather than replacing it — Ctrl+X and Ctrl+V
        // are accounted for on their own below and in the paste handler. Shift+Insert carries no
        // Ctrl and pastes all the same, so it is excluded by the same reason rather than by the
        // same test: left in, it spent the selection here and the paste handler then counted a
        // revision for a block that had replaced nothing.
        const replaced = !mod && !pasting && consumeSelection();
        // Writing again after travelling back through the text is a reformulation even when
        // nothing was erased first: inserting the word that was missing, or typing the new
        // wording in front of the old one. This branch used to drop the trip in silence, which
        // is why going back with the arrows and typing produced navigation jumps and no
        // reformulation at all.
        //
        // A selection just spent is **not** charged twice. Shift+arrows both extend a selection
        // and move the caret, and a dragged selection leaves its click behind it, so without
        // this the one act of typing over a selected span would be scored as the span *and* as
        // the trip that selected it — one action, two revisions.
        if (!mod && !pasting && !replaced && navSteps >= NAV_STEPS_AWAY) {
            measure.reformulations++;
            debugLog('insertion after a trip → deferred reformulation');
        }
        navSteps = 0;
        endEraseRun();
    }
    mouseClickedRecently = false;

    // Cutting or undoing settles the pending selection itself: the cut is the very deletion the
    // selection was waiting for, and an undo collapses it. Left pending, it would be spent a
    // second time by the next character typed or pasted — one action, two revisions.
    //
    // **Redo is not an undo**, and Shift is what tells them apart: Cmd/Ctrl+Shift+Z puts back
    // what the student had taken out, which is the opposite of a correction. Counted as one, it
    // inflated the corrections of anybody who hesitates out loud — and on a Mac, where
    // Cmd+Shift+Z *is* the redo, for anybody who uses it at all. The selection collapses either
    // way, so that part is settled before the test.
    if (mod && lower === 'x') { measure.macroRevisions++; selectionScope = null; }
    const undone = mod && lower === 'z' && !e.shiftKey;
    if (mod && lower === 'z') {
        selectionScope = null;
        if (undone) measure.corrections++;
    }

    trackActiveTime(now);
    // A paste does write — but what it writes is weighed in the paste handler, one keystroke for
    // the student's own text coming back and none for an injection, and weighed there whatever
    // pasted it: the menu, the toolbar and a drag have no key to count. Counting the key as well
    // made the same gesture cost two keystrokes from the keyboard and one from the menu, and an
    // injection cost one from the keyboard and none from the menu. Ctrl/Cmd+C stays an ordinary
    // keystroke: it puts nothing into the document, so no other handler counts it.
    if (!pasting) countKeystroke(now, kind);
    // The undo is the keystroke just counted, said a second time for what it did.
    if (undone) addRun('undo', 1, now, false);
    if (!pasting && kind === 'type') noteKeyDown(e.code, now);

    if (mod && lower === 's') flush('save');
    else if (measure.keystrokes >= FLUSH_KEYSTROKES) flush('volume');
}

// A spelling chosen in the editor's own corrector, which is the immediate correction it is.
//
// Fixing a typo by clicking the right spelling and fixing it with Backspace are the same
// editorial act — a decision about a letter — and only one of them was earning its writer the
// revision it is made of. The engine's own editor counts it (docs/mesures.md, "La correction
// orthographique"), so an agent that did not would report the same student as less thorough for
// having used a feature of their word processor.
//
// **No keystroke is invented**: the word the student did not retype was not typed, and
// the size of the text is compared with the deposited document. And it spends the gesture that
// opened the menu, exactly as a deletion spends the click that precedes it — without this, the
// right click that produced the suggestions would make the next Backspace read as a mass
// revision, for somebody who only fixed a typo.
function recordSpellCorrection(now) {
    markActivity(now);
    measure.corrections++;
    addLooseRun('fix', 1, now, false);
    navSteps = 0;
    mouseClickedRecently = false;
    selectionScope = null;
    endEraseRun();
    debugLog('spelling chosen in the corrector → immediate correction');
}

function onMouseDown(e) {
    if (!measuring() || !e.isTrusted) return;
    // The corrector draws its suggestions **inside** the editing area, so this is tested before
    // the area itself: otherwise choosing a spelling counted a jump through the document, and
    // each correction cost the student two crossings of their own text.
    if (editor.correctionMenu && e.target instanceof Element && e.target.closest(editor.correctionMenu)) {
        recordSpellCorrection(tick());
        return;
    }
    // Only clicks in the document body are navigation jumps (not the menus).
    if (e.target instanceof Element && !e.target.closest(editor.editorArea)) return;
    const now = tick();
    markActivity(now);
    measure.navigation++;
    addLooseRun('click', 1, now, false);
    navSteps = NAV_STEPS_AWAY;
    mouseClickedRecently = true;
    endEraseRun();
    // A press collapses whatever was selected; the release decides whether a new selection was
    // dragged (see onMouseUp).
    selectionScope = null;
    mouseDownAt = { x: e.clientX, y: e.clientY };
    debugLog('click in the document → navigation jump');
}

// DRAG_MIN_PX separates a click from a drag: a press and release a few pixels apart is still a
// click (the pointer always moves a little), beyond it the student swept a selection.
const DRAG_MIN_PX = 5;

function onMouseUp(e) {
    if (!measuring() || !e.isTrusted || !mouseDownAt) return;
    const moved = Math.abs(e.clientX - mouseDownAt.x) + Math.abs(e.clientY - mouseDownAt.y);
    mouseDownAt = null;
    if (moved < DRAG_MIN_PX) return;
    // A dragged selection spans a block, like Ctrl/Cmd+A.
    selectionScope = 'all';
    debugLog('selection with the mouse');
}

// --- RESTITUTION OF ONE'S OWN TEXT ---
// Normalisation absorbs exactly what a corrector changes: case, accents, punctuation and
// spacing. What is left is the sequence of words, which a correction leaves nearly intact.
function normalizeWords(text) {
    const words = text.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase()
        .replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
    return words ? words.split(' ') : [];
}

// FNV-1a over the words of a shingle, read in place: `count` words starting at `from`, joined
// by one space. What is kept is a number, from which the words cannot be read back.
//
// The shingles of a text slide one word at a time, so slicing the window out and joining it
// allocated two objects per word of the document — on a dissertation pasted back from a
// corrector, that is the cost paid inside the paste handler, where the answer is needed before
// the paste can be classified. Reading the words where they are gives **the same number**: the
// bytes hashed are those of the same joined string, separator included.
//
// That number is a contract: the same text must hash the same in the four agents, so the test
// suite pins known values rather than trusting the next rewrite.
function hashShingle(words, from, count) {
    let hash = 0x811c9dc5;
    for (let w = from; w < from + count; w++) {
        if (w > from) {
            hash ^= 32;     // the space the words used to be joined by
            hash = Math.imul(hash, 0x01000193) >>> 0;
        }
        const word = words[w];
        for (let i = 0; i < word.length; i++) {
            const code = word.codePointAt(i);
            hash ^= code;
            hash = Math.imul(hash, 0x01000193) >>> 0;
            if (code > 0xffff) i++;     // a surrogate pair is one code point
        }
    }
    return hash;
}

function shingles(text) {
    const words = normalizeWords(text);
    if (words.length === 0) return new Set();
    // Shorter than a shingle — a couple of words moved from one sentence to another — is hashed
    // whole rather than dropped. Without it, moving "developpement durable" inside the document
    // was an injection: nothing had been remembered when it left, so nothing could recognise it
    // coming back. One fingerprint over the whole sequence can only ever match a paste just as
    // short, so it still cannot excuse a text taken from somewhere else.
    if (words.length < SHINGLE_WORDS) return new Set([hashShingle(words, 0, words.length)]);
    const set = new Set();
    for (let i = 0; i + SHINGLE_WORDS <= words.length; i++) {
        set.add(hashShingle(words, i, SHINGLE_WORDS));
    }
    return set;
}

// What left the document, hashed: { seenAt, shingles, restituted }. seenAt is the last time the
// copy was seen — when it left, then each time it came back: a block the student keeps pasting
// stays comparable as long as they keep using it, and only a copy nothing comes back to ages out.
let ownText = [];

function rememberOwnText(text) {
    if (!measuring() || !text) return;
    const set = shingles(text);
    if (set.size === 0) return;    // nothing but punctuation: no words to recognise later
    ownText.push({ seenAt: Date.now(), shingles: set, restituted: false });
    if (ownText.length > SELF_PASTE_MAX_COPIES) forgetLeastRecent();
    debugLog('text copied: %d fingerprints kept', set.size);
}

// The memory is bounded, and what goes is the copy nothing has come back to for the longest —
// not the oldest one. Copying five other things in between would otherwise make the block the
// student is still pasting unrecognisable.
function forgetLeastRecent() {
    let oldest = 0;
    for (let i = 1; i < ownText.length; i++) {
        if (ownText[i].seenAt < ownText[oldest].seenAt) oldest = i;
    }
    ownText.splice(oldest, 1);
}

// Is this paste the student's own text coming back? Containment rather than a symmetric
// similarity: the student may paste back one corrected paragraph out of the three they copied.
// Returns null when the text is not theirs, otherwise { again }: true from the second return of
// the same copy, which is a duplication and not a revision.
function matchOwnText(text) {
    const now = Date.now();
    ownText = ownText.filter((copy) => now - copy.seenAt < SELF_PASTE_TTL_MS);
    const set = shingles(text);
    if (set.size === 0) return null;
    let seen = 0;
    const from = [];
    for (const hash of set) {
        const copy = ownText.find((candidate) => candidate.shingles.has(hash));
        if (!copy) continue;
        seen++;
        if (!from.includes(copy)) from.push(copy);
    }
    const ratio = seen / set.size;
    if (ratio > 0) debugLog('paste: %d%% taken from the copied text', Math.round(ratio * 100));
    if (ratio < SELF_PASTE_RATIO) return null;
    const again = from.every((copy) => copy.restituted);
    for (const copy of from) {
        copy.seenAt = now;
        copy.restituted = true;
    }
    return { again };
}

// Copying, cutting or starting to drag is how the text leaves the document — for a corrector, or
// for another place in the same page. The selection is read from the document the event came
// from: Word Online's editing iframe, or the hidden input Google Docs keeps for the clipboard.
// Where it cannot be read, nothing is remembered and the paste is counted as it has always been.
//
// The clipboard itself is never read: a copy event carries no data yet, and asking the browser
// for the clipboard would need a permission the extension has no business holding.
function onCopy(e) {
    if (!measuring() || !e.isTrusted) return;
    const doc = (e.target && e.target.ownerDocument) || document;
    // Google Docs copies through a hidden iframe which, when this handler runs, holds a single
    // **placeholder** character — the text itself lands there a moment later. Keeping the first
    // non-empty selection therefore kept that one character and stopped looking, so only a
    // second Ctrl+C, finding the real text the first had left behind, was ever remembered. The
    // selection is read now, on the next turn and once more a moment later, and the **longest**
    // of the three wins: a stand-in of one character cannot outweigh a paragraph.
    //
    // Reading a selection three times costs nothing. Hashing is what cannot happen here: Ctrl+A
    // then Ctrl+C over a whole dissertation is tens of milliseconds, and the student would feel
    // them under their own copy. Between a copy and its return from a corrector there are
    // seconds, never the fraction of one these deferrals wait.
    const seen = [readSelection(doc)];
    setTimeout(() => {
        seen.push(readSelection(doc));
        setTimeout(() => {
            seen.push(readSelection(doc));
            const text = seen.reduce((best, one) => (one.length > best.length ? one : best), '');
            noteCopy(text);
            // A copy nothing could be read from leaves nothing to recognise later, and used to
            // say so nowhere: the restitution then failed in silence, one paste later.
            if (text) rememberOwnText(text);
            else debugLog('copy seen, but nothing readable in the selection');
        }, COPY_RETRY_MS);
    }, 0);
}

// Text left the document: the runs say so, with the size the selection had — counted
// like a paste, line breaks aside — or zero when the gesture was seen and its text was not.
// It opens no window and enters no count: a copy is not writing.
function noteCopy(text) {
    if (!measuring()) return;
    sealIfFull();
    addLooseRun('copy', codePoints(text.replace(/[\r\n]/g, '')), tick(), false);
}

// What was copied, looked for in every document that could hold it, keeping the **longest** of
// them. Google Docs draws its text on a canvas and stages what leaves the document in a hidden
// input iframe: the document the event came from can hold a one-character stand-in while the
// text sits in another, so the first non-empty selection is not the right answer — the longest
// is. Nothing is retained: the iframes are looked up live, so a page that replaces them leaks no
// document here.
function readSelection(from) {
    let best = String(from.getSelection() || '');
    const consider = (doc) => {
        const text = String(doc.getSelection() || '');
        if (text.length > best.length) best = text;
    };
    if (from !== document) consider(document);
    if (editor.inputIframes) {
        for (const iframe of document.querySelectorAll(editor.inputIframes)) {
            try {
                if (iframe.contentDocument) consider(iframe.contentDocument);
            } catch (_) { /* cross-origin iframe */ }
        }
    }
    return best;
}

function recordInjection(text) {
    if (!measuring() || !text) return;
    const now = tick();
    markActivity(now);
    // Pasting over a selection replaces it: the classic "select everything, paste the answer"
    // used to count as an injection only, never as a revision.
    const replaced = consumeSelection();
    const chars = codePoints(text.replace(/[\r\n]/g, ''));

    // The student's own text, come back from a corrector: a revision of what they wrote, not a
    // paste of someone else's words. It is scored as the block it replaces — one keystroke for
    // the block, as a deletion at the scale of a selection is — and never as an injection.
    // Pasted a second time, it is a duplication: the paragraph was not revised twice over.
    const own = matchOwnText(text);
    if (own) {
        if (!replaced && !own.again) measure.macroRevisions++;
        measure.keystrokes++;
        // The keystroke the block stands for, then the block itself. Neither is on the
        // keyboard's clock: the keystroke is counted, not timed.
        addRun('other', 1, now, false);
        // The `self` run is what lets the engine tell a revision through a corrector from a
        // revision made by hand — both weigh as a mass revision — and how much came back: one
        // run per gesture, with its size.
        addPasteRun('self', chars, now);
        debugLog('restitution of %d characters: %s, not an injection', chars,
            own.again ? 'duplication' : 'revision');
        return;
    }

    // One run per paste, whatever its size: the engine counts the pastes, adds up the ones
    // long enough to be injections and finds the largest, all from these runs.
    measure.pasteEvents++;
    addPasteRun('paste', chars, now);
    if (chars > INJECTION_MIN_CHARS) {
        measure.injectedChars += chars;
        // Brought back from outside: the student left the document, and what they pasted on
        // coming back arrived from wherever they went.
        if (lastReturnAt && now - lastReturnAt < RETURN_WINDOW_MS) {
            measure.injectedCharsAfterReturn += chars;
            debugLog('paste within %d s of a return to the document', RETURN_WINDOW_MS / 1000);
        }
    }
    debugLog('paste of %d characters', chars);
}

function onPaste(e) {
    if (!measuring() || !e.isTrusted || !e.clipboardData) return;
    recordInjection(e.clipboardData.getData('text/plain'));
}

function onDrop(e) {
    if (!measuring() || !e.isTrusted || !e.dataTransfer) return;
    recordInjection(e.dataTransfer.getData('text/plain'));
}

// --- THE INSERTION PROBE (debug mode only; it measures nothing) ---
// An open question, and the three editors are the only place it can be answered: when a
// suggestion is accepted — Smart Compose in Docs, Word's text predictions, an assistant plugged
// into Overleaf — does the editing document announce it, and under what name? This sensor counts
// keys and pastes, so the characters a suggestion posts are counted nowhere at all
// (docs/mesures.md, "Écarts assumés"), and before giving that volume a metric of its own we
// have to know which editor is able to report it.
//
// `beforeinput` and `input` are where the answer should be: `inputType` names the gesture —
// `insertReplacementText` is the one autocompletion is specified to use, `insertText` the one
// typing uses — and the gap since the last counted keystroke is what tells a character somebody
// typed from a block that arrived on its own. Both events are listened to because their
// difference is itself a finding: an editor that cancels `beforeinput` and writes the text
// itself only fires the second, and one that inserts its suggestion straight into the DOM fires
// neither. **Silence is an answer too** — it closes this route for that editor and leaves the
// volume residue as the only one.
//
// What is printed is a type and two counts. The inserted text is never read beyond its length
// and nothing is kept: the debug mode prints counters and categories, and this is not where that
// changes (docs/mesures.md, "Confidentialité"). Measuring suspended, it prints nothing either —
// an agent that is not looking at what the student writes is not looking at it in the console.
function onProbeInput(e) {
    if (!debug || !measuring()) return;
    const since = lastPressTime > 0 ? tick() - lastPressTime : -1;
    const extra = (e.dataTransfer ? ', with a dataTransfer' : '') + (e.isTrusted ? '' : ', untrusted');
    debugLog('input probe: %s %s, %d characters, %d ms since the last keystroke%s',
        e.type, e.inputType || '(no type)', e.data ? codePoints(e.data) : 0, since, extra);
}

// Back in the document after having really left it. Nothing is counted here: the return only
// dates what follows it, and only a departure that was counted opens one.
function noteReturn() {
    if (!measuring() || !awayFrom) return;
    lastReturnAt = tick();
    awayFrom = 0;
    debugLog('return to the document');
}

// A departure is counted **once**, from whichever signal reaches us first. Switching tab fires
// both `visibilitychange` and `blur`, and the blur path must wait a turn before it can ask
// `document.hasFocus()` — a turn a hidden tab is not given for up to a second, because the
// browser throttles timers there. A student who comes straight back is focused again by then,
// the deferred check bails out, and the departure was never counted at all: anybody working in
// two tabs saw "sorties du document" stay at zero for ever. `awayFrom` is what keeps the two
// signals from counting the same departure twice.
function noteDeparture(reason) {
    if (!awayFrom) {
        measure.focusLosses++;
        awayFrom = Date.now();
        debugLog('document left (%s)', reason);
    }
    flush(reason);
}

// The student really leaves the document (another tab, another window, address bar). A
// focus shift from the page to the editing iframe doesn't count: hasFocus() stays true.
function onWindowBlur() {
    if (!measuring()) return;
    setTimeout(() => {
        if (document.hasFocus()) return;
        // A key held while focus leaves is released somewhere this script does not listen.
        keysDown.clear();
        // Word Online's iframe loses focus to a click in the Microsoft 365 header without the
        // student leaving anything: there, only the page being hidden says a departure.
        if (editor.blurMeansLeaving) noteDeparture('blur');
        // Focus left the page without the student leaving the document — Word Online hands it
        // to its own header. The window closes, but nothing about the writing stopped, and the
        // engine has to be told which of the two this was.
        else flush('focus');
    }, 0);
}

// --- 3. ATTACHING TO THE EDITOR DOCUMENTS ---

// Every listener this script registers goes through here, and an event the user agent did not
// generate is dropped.
//
// We run in an isolated world, but we listen on the same document and window as the page: script
// in a measured page can dispatch any of these names itself, and a constructed event carries
// `isTrusted` false. The counting handlers each tested that flag; the four lifecycle listeners
// did not, and a forged pair of `focus` and `visibilitychange` ran the count of departures up
// without bound — a counter the page's author chose, arriving under the student's own token, in the one
// record this product exists to produce. Registering through a single helper is what keeps a
// listener added later from quietly becoming the next exception.
function listen(target, type, handler, capture = false) {
    target.addEventListener(type, (e) => {
        if (!e || !e.isTrusted) {
            // Not an error: a page is free to dispatch what it likes, and we are free to ignore
            // it. Worth seeing while diagnosing an editor that seems to count nothing.
            if (debug) debugLog('ignored an untrusted %s — the page dispatched it, not the browser', type);
            return;
        }
        handler(e);
    }, capture);
}

const attached = new WeakSet();

function attachEditorDocument(doc) {
    if (!doc || attached.has(doc)) return;
    attached.add(doc);
    listen(doc, 'keydown', onKeyDown, true);
    // Only to time how long a key was held: see onKeyUp. It reads no key.
    listen(doc, 'keyup', onKeyUp, true);
    listen(doc, 'paste', onPaste, true);
    listen(doc, 'drop', onDrop, true);
    // Cutting is a copy that also deletes: the deletion is scored by onKeyDown (Ctrl/Cmd+X),
    // what leaves the document is remembered here.
    listen(doc, 'copy', onCopy, true);
    listen(doc, 'cut', onCopy, true);
    // Dragging a block from one paragraph to another drops it back as a paste: the text moved,
    // it did not come from outside.
    listen(doc, 'dragstart', onCopy, true);
    // Debug mode only, and it counts nothing: see onProbeInput.
    listen(doc, 'beforeinput', onProbeInput, true);
    listen(doc, 'input', onProbeInput, true);
}

function attachIframe(iframe) {
    const tryAttach = () => {
        try { attachEditorDocument(iframe.contentDocument); } catch (_) { /* cross-origin iframe */ }
    };
    if (!attached.has(iframe)) {
        attached.add(iframe);
        listen(iframe, 'load', tryAttach);
    }
    tryAttach();
}

function scanEditorIframes() {
    if (editor.inputIframes) document.querySelectorAll(editor.inputIframes).forEach(attachIframe);
}

// Keystrokes typed directly in the page (accessibility mode), excluding comments and menus.
function onTopKeyDown(e) {
    if (e.target instanceof Element && e.target.closest(editor.editorArea)) onKeyDown(e);
}

function onTopPaste(e) {
    if (e.target instanceof Element && e.target.closest(editor.editorArea)) onPaste(e);
}

// The same probe, for the text an editor takes in the page itself rather than in an input
// iframe: Word Online and Overleaf have none, and the other two are still typed into directly in
// accessibility mode. The debug test comes first rather than inside onProbeInput, because this
// fires on every character inserted and finding the editing area from the event is itself work.
function onTopProbeInput(e) {
    if (!debug || !measuring()) return;
    if (e.target instanceof Element && e.target.closest(editor.editorArea)) onProbeInput(e);
}

// Copying is only remembered from the document itself: a comment or a menu is not what the
// student wrote, and pasting it back has no reason to be excused as a revision.
function onTopCopy(e) {
    if (e.target instanceof Element && e.target.closest(editor.editorArea)) onCopy(e);
}

listen(document, 'keydown', onTopKeyDown, true);
// Not filtered on the editing area: a release only ever meets a press that was counted there.
listen(document, 'keyup', onKeyUp, true);
listen(document, 'paste', onTopPaste, true);
listen(document, 'beforeinput', onTopProbeInput, true);
listen(document, 'input', onTopProbeInput, true);
listen(document, 'copy', onTopCopy, true);
listen(document, 'cut', onTopCopy, true);
listen(document, 'dragstart', onTopCopy, true);
listen(document, 'mousedown', onMouseDown, true);
listen(document, 'mouseup', onMouseUp, true);
listen(window, 'blur', onWindowBlur);
listen(document, 'visibilitychange', () => {
    if (!measuring()) return;
    if (document.visibilityState !== 'hidden') {
        noteReturn();
        return;
    }
    // A hidden tab is a left document, whatever the editor. This signal arrives at once, where
    // the blur path has to wait for a turn the hidden tab may not get in time.
    keysDown.clear();
    noteDeparture('hidden');
});
listen(window, 'focus', noteReturn);
listen(window, 'pagehide', () => {
    if (measuring()) flush('pagehide');
});

// Every editor is recognised by one selector, and a redesign that renames it makes the sensor
// drop every keystroke, click, copy and paste **in silence**: the document is still announced —
// its identifier comes from the address — so the agent looks healthy while counting nothing.
// TESTING.md calls that the first cause of real breakage, and it used to be found by reading an
// empty journal, days later. The page is given time to build itself, then asked once.
const EDITOR_AREA_GRACE_MS = 5000;

setTimeout(() => {
    if (document.querySelector(editor.editorArea)) return;
    console.warn(`Certimens: editing area "${editor.editorArea}" is not in this page, so nothing`
        + ' will be measured here. The editor has most likely changed its markup.');
}, EDITOR_AREA_GRACE_MS);

scanEditorIframes();
let scanScheduled = false;
// Only where there is something to find. The observer watches the whole tree of a page an editor
// rewrites continuously, and its callback has nothing to do when the editor declares no input
// iframe — which is the case of Word Online and of Overleaf, the two that rewrite the most.
if (editor.inputIframes) {
    new MutationObserver(() => {
        if (scanScheduled) return;
        scanScheduled = true;
        setTimeout(() => { scanScheduled = false; scanEditorIframes(); }, 500);
    }).observe(document.documentElement, { subtree: true, childList: true });
}

// Rename in the editor: the background renames the engine document. The title is polled
// periodically (Word Online doesn't always reflect it in document.title).
const TITLE_CHECK_MS = 3000;
let lastTitle = null;

// Tells the background about the opened document, as soon as it's visible: if it doesn't yet have an
// engine document, the creation popup opens.
function announceDocument() {
    const docId = editor.documentId();
    if (!docId || document.visibilityState !== 'visible') return false;
    lastTitle = editor.documentName();
    try { chrome.runtime.sendMessage({ type: 'CERTIMENS_DOC_OPENED', documentId: docId, documentName: lastTitle }); } catch (_) { /* extension reloaded */ }
    return true;
}

setInterval(() => {
    const docId = editor.documentId();
    const title = editor.documentName();
    if (!docId || title === lastTitle) return;
    lastTitle = title;
    try { chrome.runtime.sendMessage({ type: 'CERTIMENS_DOC_TITLE', documentId: docId, documentName: title }); } catch (_) { /* extension reloaded */ }
}, TITLE_CHECK_MS);

if (!announceDocument()) {
    // The one listener not registered through `listen`: it removes itself, which needs the
    // reference that was registered. It carries the same guard by hand.
    const onVisible = (e) => {
        if (!e || !e.isTrusted) return;
        if (announceDocument()) document.removeEventListener('visibilitychange', onVisible);
    };
    document.addEventListener('visibilitychange', onVisible);
}

// The popup asks which document is open in the tab (only the editor frame replies).
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    // One of our own windows, and not a tab: the popup asks through `chrome.tabs.sendMessage`,
    // so it arrives here with no `tab` of its own. This handler hands over the text the student
    // wrote — the one thing a measured page ever gives up — and what may ask for it is worth
    // naming rather than assuming.
    if (sender.id !== chrome.runtime.id || sender.tab) return false;
    // The text the student wrote, asked for by the popup and sent only when they click: this is
    // the one thing a page ever hands over, and it is the same deposit as the .docx elsewhere.
    if (message.type === 'CERTIMENS_PAGE_TEXT') {
        sendResponse({ text: editor.deposit === 'text' ? siteText() : null });
        return false;
    }
    if (message.type !== 'CERTIMENS_ACTIVE_DOC') return false;
    const id = editor.documentId();
    if (id) sendResponse({ id, name: editor.documentName(), deposit: editor.deposit, platform: pagePlatform()?.name || null });
    return false;
});

// --- 4. REAL DOCUMENT VOLUME ---
// Character count of the document, excluding line breaks (like the engine's .docx count).
const INVISIBLE_CHARS = /[\r\n\uFEFF\u200B]/g;

// Google Docs: text export of the document. Google redirects the export to googleusercontent.com,
// which the page (and thus this script, bound by its CORS) can't read: the background does it,
// with its host permissions and the student's session.
// Each reader answers what it can read **now** — the size of the document and, when it has it,
// the text that size was counted on — and `null` when it cannot: whether that answer is worth
// asking for again is `documentVolume`'s business, not theirs.
async function fetchGoogleDocsVolume(docId) {
    try {
        const res = await Promise.race([
            chrome.runtime.sendMessage({ type: 'CERTIMENS_GDOCS_VOLUME', documentId: docId }),
            new Promise((resolve) => setTimeout(() => resolve({ ok: false, message: 'timed out' }), VOLUME_TIMEOUT_MS)),
        ]);
        // The text comes back with its size when the worker is satisfied that this page is the
        // document it exported — it is only ever compared with the previous export, here, and
        // never leaves this script (see textSpan).
        if (res?.ok) return { volume: res.volume, text: res.text };
        console.warn('Certimens: text export failed, volume not updated.', res?.message);
    } catch (err) {
        // extension reloaded: we keep the last known value
        console.warn('Certimens: text export failed, volume not updated.', err);
    }
    return null;
}

// Word Online: text shown in the editing area (local read, so always up to date).
// The volume of a site the student added: the longest editing area of the page. A page holds
// several — a search box, a comment field — and the assignment is the long one. Nothing is
// returned when the page has no such field at all, rather than a zero the engine would read as
// an empty document.
// The text the student wrote on a page we do not know by name: the platform's own field when
// the page is one we recognise, the longest editing area otherwise. Null when the page holds no
// field at all — a page that is not an editor at all is not an empty document.
function siteText() {
    let longest = null;
    const read = (root, selector) => {
        for (const area of root.querySelectorAll(selector)) {
            const text = typeof area.value === 'string' ? area.value : (area.innerText || '');
            if (longest === null || text.length > longest.length) longest = text;
        }
    };
    const known = pagePlatform()?.area;
    // The platform's field first: a long forum post further down the page would otherwise beat
    // the copy itself.
    if (known) read(document, known);
    if (longest === null) read(document, SITE_EDITOR_AREA);
    for (const iframe of document.querySelectorAll(editor.inputIframes)) {
        try {
            if (iframe.contentDocument) read(iframe.contentDocument, known || SITE_EDITOR_AREA);
        } catch (_) { /* cross-origin iframe */ }
    }
    return longest;
}

// A reading of a text held in the page: its size, and the text it was counted on.
function reading(raw) {
    const text = raw.replace(INVISIBLE_CHARS, '');
    return { volume: codePoints(text), text };
}

async function readSiteVolume() {
    const text = siteText();
    return text === null ? null : reading(text);
}

async function readWordVolume() {
    const body = document.getElementById('WACViewPanel_EditingElement');
    // `innerText` forces a synchronous layout of the whole editing panel — the single most
    // expensive thing this sensor does, which is why `documentVolume` holds it to one read every
    // `volumeMaxAgeMs` instead of one per window.
    return body ? reading(body.innerText) : null;
}

// The document's size, read at most once per `volumeMaxAgeMs`. A window closes after 2 s of
// inactivity, at 200 keystrokes, on every departure and on every save — several times a minute
// for somebody who is writing — and reading the document is the one thing in that path whose
// cost grows with the document.
//
// A reader that answers `null` has failed or has nothing to read: the last known value is served
// and **its age is left alone**, so the next window asks again instead of standing on a stale
// number for the whole delay.
//
// `fresh` says the document was actually read for this window, and `text` is what was read
// when the reader holds it: the two a text span needs, and a cached size has neither.
async function documentVolume(docId, reason) {
    // The page is closing: no time to wait for an export, we reuse the last value.
    if (reason === 'pagehide' && editor.remoteVolume) return { volume: cachedVolume, fresh: false };
    if (cachedVolumeAt > 0 && Date.now() - cachedVolumeAt < editor.volumeMaxAgeMs) return { volume: cachedVolume, fresh: false };
    const read = await editor.volume(docId);
    if (read === null || read === undefined) return { volume: cachedVolume, fresh: false };
    cachedVolume = read.volume;
    cachedVolumeAt = Date.now();
    return { volume: read.volume, text: read.text, fresh: true };
}

// --- HOW FAR THE TEXT MOVED BETWEEN TWO READINGS ---
// The longest prefix and the longest suffix the two readings share, without overlap, and what
// lies between them on each side: where the change begins, how much went, how much came. Three
// lengths, counted in characters exactly as the size of the text is, so the size of the earlier
// reading, less what went (`cut`), plus what came (`add`), is the size of this one.
//
// It is an envelope, not an edit: two places touched between two readings give one span from
// the first to the last, with the untouched text between them on both sides. `kept` is what
// tells that case from a paragraph replaced by another of the same size — how much of what was
// inserted was already there (see keptChars) — and it is left out when it was not computed.
//
// Lengths only: nothing of either text is in the answer. The comparison is two scans and, for
// a span of bounded size, one table; it adds no reading of its own (see documentVolume for how
// often one happens).
function textSpan(before, after) {
    const shortest = Math.min(before.length, after.length);
    let prefix = 0;
    while (prefix < shortest && before.charCodeAt(prefix) === after.charCodeAt(prefix)) prefix++;
    // A pair of surrogates is one character: a boundary never falls inside one.
    if (prefix > 0 && isHighSurrogate(before.charCodeAt(prefix - 1))) prefix--;
    let suffix = 0;
    while (suffix < shortest - prefix
            && before.charCodeAt(before.length - 1 - suffix) === after.charCodeAt(after.length - 1 - suffix)) suffix++;
    if (suffix > 0 && isLowSurrogate(before.charCodeAt(before.length - suffix))) suffix--;
    const removed = before.slice(prefix, before.length - suffix);
    const inserted = after.slice(prefix, after.length - suffix);
    /** @type {{ at: number, cut: number, add: number, kept?: number }} */
    const span = { at: codePoints(before.slice(0, prefix)), cut: codePoints(removed), add: codePoints(inserted) };
    const kept = keptChars(removed, inserted);
    if (kept !== null) span.kept = kept;
    return span;
}

// Among what was inserted, how many characters were already in what was removed, in the same
// order: the longest common subsequence of the two, taken word by word. A word goes with the
// blanks that follow it, so the pieces add up to the whole text and an untouched stretch is
// kept in full, spaces included. Null when either side is too long to compare (see
// TEXT_KEPT_MAX_WORDS).
//
// The words are compared and dropped inside this call. What comes out is one number, no
// greater than either side.
function keptChars(removed, inserted) {
    const gone = removed.match(/\S+\s*|\s+/g) || [];
    const come = inserted.match(/\S+\s*|\s+/g) || [];
    // Nothing on one side: nothing can have been kept, however long the other is.
    if (gone.length === 0 || come.length === 0) return 0;
    if (gone.length > TEXT_KEPT_MAX_WORDS || come.length > TEXT_KEPT_MAX_WORDS) return null;
    // Each distinct word becomes a number, so the table below compares integers.
    const ids = new Map();
    const numbered = (words) => Int32Array.from(words, (word) => {
        if (!ids.has(word)) ids.set(word, ids.size);
        return ids.get(word);
    });
    const a = numbered(gone);
    const b = numbered(come);
    const weights = Int32Array.from(gone, codePoints);
    // Two rows of the table are enough: only the best total is wanted, not the path to it.
    let above = new Int32Array(b.length + 1);
    let row = new Int32Array(b.length + 1);
    for (let i = 0; i < a.length; i++) {
        for (let j = 0; j < b.length; j++) {
            row[j + 1] = a[i] === b[j] ? above[j] + weights[i] : Math.max(above[j + 1], row[j]);
        }
        [above, row] = [row, above];
    }
    return above[b.length];
}

function isHighSurrogate(unit) {
    return unit >= 0xd800 && unit <= 0xdbff;
}

function isLowSurrogate(unit) {
    return unit >= 0xdc00 && unit <= 0xdfff;
}

// --- 5. SEALING A WINDOW, THEN SENDING IT ---
// Two steps, and the line between them matters. **Sealing** is synchronous: the window is
// taken, numbered, and the session's running totals move, all before anything is awaited — so
// two windows can never swap numbers, and a window that is lost afterwards has still been
// counted. **Sending** waits for the size of the document, which on Google Docs is a network
// export: the sealed windows queue up behind it and leave in the order they were numbered.

// Sealed windows waiting for a reading of the document, oldest first.
const outbox = [];
let pumping = null;

async function flush(reason) {
    clearTimeout(idleTimer);
    lastActivityTime = 0;
    if (!hasActivity()) {
        // Clicks only: what they counted carries over to the next window, but not their time,
        // otherwise the window would swallow the inactivity that follows. The runs they left
        // are carried with them, and never had a duration to carry.
        measure.start = null;
        return;
    }
    const docId = editor.documentId();
    if (!docId) {
        // No document to send to: the window stays open, waiting for the page to become one.
        // It is not allowed to outgrow what a window may carry meanwhile — one that would is
        // given up whole, since a window is never sent short of its runs.
        if (measure.runs.length >= TIMELINE_MAX_RUNS - TIMELINE_RESERVE) measure = newMeasure();
        return;
    }

    const done = measure;
    measure = newMeasure();
    outbox.push(seal(done, docId, reason));

    // The page is closing and an export may still be in flight ahead of this window: nothing
    // behind it would ever leave. Everything sealed goes now, with the last size known.
    if (reason === 'pagehide' && editor.remoteVolume) {
        for (const sealed of outbox.splice(0)) deliver(sealed, { volume: cachedVolume, fresh: false });
        return;
    }
    await pump();
}

// The window as it will be sent, less what only a reading of the document can add.
function seal(done, docId, reason) {
    // A page that turned into another document without reloading starts a new session too:
    // a session measures one document.
    if (session && session.documentId !== docId) endSession();
    if (!session) {
        // A silence never crosses a session: one that began before this window did began in
        // the session before, and is not this one's to tell.
        if (done.runs[0]?.kind === 'gap' && done.runs[0].born < done.monoStart) done.runs.shift();
        session = {
            id: newSessionId(),
            documentId: docId,
            // The zero of the monotonic clock: the first activity this session measured.
            origin: done.monoStart,
            seq: 0,
            closed: false,
            sum: { keys: 0, chars: 0, pastes: 0 },
            reading: null,
        };
    }
    // Numbered and added to the running totals in one go, here and nowhere else. The totals
    // are the three figures the engine works out from the runs of each window: a window that
    // never arrives then shows as a number that skips *and* as totals the received windows do
    // not add up to.
    const seq = session.seq++;
    session.sum.keys += done.keystrokes;
    session.sum.chars += done.injectedChars;
    session.sum.pastes += done.pasteEvents;

    /** @type {Record<string, any>} */
    const window = {
        seq,
        // The first activity, on the wall clock and on a clock the student cannot set, whose
        // zero is the start of the session.
        at: done.start,
        mono: Math.max(0, done.monoStart - session.origin),
        // From the first to the last activity, on the monotonic clock. A window of a single
        // instant is sent as one second: the engine takes nothing shorter.
        ms: Math.max(1000, done.monoLast - done.monoStart),
        why: WIRE_FLUSH_REASONS[reason],
        active: done.activeMs,
        runs: done.runs.map(wireRun),
        counts: {
            corrections: done.corrections,
            reformulations: done.reformulations,
            revisions: done.macroRevisions,
            jumps: done.navigation,
            exits: done.focusLosses,
            back_keys: done.keystrokesAfterReturn,
            back_chars: done.injectedCharsAfterReturn,
        },
    };
    // The distribution of the flight times, never their order, with their median and their
    // median absolute deviation. Without at least two flight times the rhythm isn't
    // measurable: the block is left out rather than sent with zeros that would skew an average.
    if (done.flights.length >= 2) {
        window.flight = {
            med: Math.round(median(done.flights) * 100) / 100,
            mad: Math.round(medianAbsoluteDeviation(done.flights) * 100) / 100,
            bins: trimmed(histogram(FLIGHT_BINS_MS, done.flights)),
        };
    }
    // The holds and the overlaps are always sent — this sensor sees keys released — and a
    // window in which no `type` key was released says so with an empty histogram.
    window.dwell = { bins: trimmed(done.dwell), rollover: done.rollover };

    return {
        documentId: docId,
        documentName: editor.documentName(),
        reason,
        owner: session,
        session: session.id,
        window,
        sum: { ...session.sum },
        keystrokes: done.keystrokes,
    };
}

// One window at a time, oldest first: the reading a window carries is compared with the one
// the window before it carried, so they cannot be read in any other order.
function pump() {
    if (!pumping) {
        pumping = (async () => {
            try {
                while (outbox.length > 0) {
                    const sealed = outbox[0];
                    const read = await documentVolume(sealed.documentId, sealed.reason);
                    // Sent meanwhile by a closing page: see flush.
                    if (outbox[0] !== sealed) continue;
                    outbox.shift();
                    deliver(sealed, read);
                }
            } finally {
                pumping = null;
            }
        })();
    }
    return pumping;
}

// What the window says of the text. The size alone when it is known without a new reading to
// compare — a cached size, or the first reading of a session — and the size with how far the
// text moved at every new reading that follows another one, an identical one included. Null
// when the text could not be read at all: the block is then left out.
function textBlock(sealed, read) {
    if (read.volume === null || read.volume === undefined) return null;
    const { owner } = sealed;
    /** @type {Record<string, number>} */
    let text = { len: read.volume };
    // A fresh reading is compared with the one before it in this session, then takes its
    // place: only one is ever held. Nothing is compared once the session is closed, whose
    // reading is gone.
    if (read.fresh && typeof read.text === 'string' && !owner.closed) {
        if (owner.reading) text = { ...text, since: owner.reading.seq, ...textSpan(owner.reading.text, read.text) };
        owner.reading = { seq: sealed.window.seq, text: read.text };
    }
    return text;
}

function deliver(sealed, read) {
    const window = sealed.window;
    const text = textBlock(sealed, read);
    if (text) window.text = text;
    // Last, as the engine reads it: the running totals of the session up to this window.
    window.sum = sealed.sum;

    debugLog('window sent (%s), %d keystrokes', sealed.reason, sealed.keystrokes, window.counts);
    try {
        chrome.runtime.sendMessage({
            type: 'CERTIMENS_METRICS',
            documentId: sealed.documentId,
            documentName: sealed.documentName,
            // The trigger, in this agent's own words: for the debug journal, never sent.
            reason: sealed.reason,
            session: sealed.session,
            // The window exactly as the engine will read it (docs/moteur.md). An absent block
            // is absent here too, never empty.
            window,
        });
    } catch (_) {
        // extension reloaded: this page context is orphaned, the window is lost
        console.warn('Certimens: the extension was reloaded, reload this page to resume measuring.');
    }
}
