// Certimens — telemetry sensor running inside the editor (Google Docs, or Word Online's editing
// iframe).
//
// It reproduces the biometric engine of the desktop agents (agent_mac.py / agent_windows.py) but
// directly in the browser: no keystroke is recorded, only counters are
// kept. Each measurement "window" is flushed to the background (which pushes it to the engine) after
// 2 s of inactivity, at 200 keystrokes, when the student leaves the document (another tab, another
// window, minimized browser, closed page) or saves (Ctrl/Cmd+S). Its period spans from the
// first to the last activity: idle time is never counted in it.

const FLUSH_KEYSTROKES = 200;       // flush at 200 keystrokes, like the desktop agents
const IDLE_FLUSH_MS = 2000;         // flush after 2 s of inactivity
const FLIGHT_MAX_MS = 800;          // beyond this, the gap between two keystrokes isn't a "flight time"
const PAUSE_MIN_S = 3;              // cognitive pause: inactivity between 3 s and PAUSE_MAX_S then resuming
// PAUSE_MAX_S bounds what counts as thinking rather than leaving. It was 60 s, which made every
// deliberation longer than a minute count as **nothing at all** — neither a pause nor effective
// time — although pausing one to five minutes over a paragraph is the clearest mark of someone
// actually composing. Beyond five minutes the student has left the document, which is not
// cognitive friction. ACTIVE_GAP_MAX_S stays at 60 s: it bounds a different rule (what a gap adds
// to effective time), and the two were only ever the same number by accident.
const PAUSE_MAX_S = 300;
const ACTIVE_GAP_MAX_S = 60;       // beyond this a gap adds nothing to the effective time
const INJECTION_MIN_CHARS = 15;     // a shorter paste isn't counted as an injection
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
// A silence of one to three seconds, hands still on the keyboard: the writer is looking for a
// word. Shorter is a flight time, longer is a cognitive pause — the band between the two was
// measured nowhere, and it is the one thing someone retyping a finished text does not produce.
const HESITATION_MIN_MS = 1000;
const HESITATION_MAX_MS = 3000;
// What the engine is told about *why* a window was sealed, for each of the triggers that can
// seal one. The engine cannot tell them apart on its own: a save cutting a burst in two looks
// like a writer who never stops, and a departure to another tab looks like a pause for thought.
// Only `away` and `end` mean nobody was looking at the document.
//
// The wire vocabulary is six words and it is the same for the four agents (docs/mesures.md); the
// triggers on the left are this agent's own. A trigger missing from the table sends nothing,
// which the engine reads as an agent that did not say — `make check` is what keeps one from
// going missing.
const WIRE_FLUSH_REASONS = {
    idle: 'idle',           // 2 s without activity: the writer stopped
    volume: 'volume',       // FLUSH_KEYSTROKES reached: the counter stopped, not the writer
    save: 'save',           // Ctrl/Cmd+S in the middle of a burst
    focus: 'focus',         // focus moved off the document without the student leaving it
    blur: 'away',           // the student left (departure counted)
    hidden: 'away',         // the tab was hidden, which is the same departure
    pause: 'end',           // measuring suspended
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
let paused = false;

try {
    chrome.storage.local.get(['debug', 'paused']).then(({ debug: on, paused: off }) => {
        debug = !!on;
        paused = !!off;
    }, () => {});
    chrome.storage.onChanged.addListener((changes, area) => {
        if (area !== 'local') return;
        if (changes.debug) debug = !!changes.debug.newValue;
        if (changes.paused) {
            paused = !!changes.paused.newValue;
            debugLog(paused ? 'measuring paused' : 'measuring resumed');
            if (paused) flush('pause');
        }
    });
} catch (_) { /* extension reloaded: the page keeps measuring without the debug mode */ }

// --- COUNTING CHARACTERS ---
// How many characters a text holds, counted in code points exactly as `[...text].length` does —
// and without the array that spreading one allocates, an element per character, on a document
// read at every window. A text holding no high surrogate has as many code points as UTF-16
// units, which a native scan answers in one pass; the loop is only for the rest, emoji and the
// astral planes. The count must stay identical: the engine counts a deposited document the same
// way, and `real_volume_chars` is compared with it.
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
        // No real_volume_chars, on purpose. CodeMirror only renders the visible lines:
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
        start: null,
        last: null,
        activeMs: 0,
        keystrokes: 0,
        corrections: 0,
        reformulations: 0,
        navigation: 0,
        macroRevisions: 0,
        pauses: 0,
        injectedChars: 0,
        maxInjectedChars: 0,
        injectedCharsAfterReturn: 0,
        pasteEvents: 0,
        selfPasteEvents: 0,
        selfPasteChars: 0,
        focusLosses: 0,
        hesitations: 0,
        keystrokesAfterReturn: 0,
        flights: [],
    };
}

let measure = newMeasure();
let lastPressTime = 0;
let lastEventTime = 0;
let lastActivityTime = 0;
let isNavigating = false;
let mouseClickedRecently = false;
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

// A keystroke, and whether it lands in the seconds after coming back to the document.
//
// The mirror of injected_chars_after_return, and the gesture it catches is the one no counter saw
// until now: leave the document, read something, come back and **type** it. Pasting after a
// return was measured; typing after one was the whole second-screen vector, invisible.
function countKeystroke(now) {
    measure.keystrokes++;
    if (lastReturnAt && now - lastReturnAt < RETURN_WINDOW_MS) measure.keystrokesAfterReturn++;
}

// Any activity opens the window if needed, pushes back its end and restarts the idle timer.
function markActivity(now) {
    if (measure.start === null) measure.start = now;
    measure.last = now;
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => flush('idle'), IDLE_FLUSH_MS);
}

// Resuming after 3 s to PAUSE_MAX_S of inactivity counts as a cognitive pause.
function trackPause(now) {
    if (lastEventTime > 0) {
        const gapS = (now - lastEventTime) / 1000;
        if (gapS > PAUSE_MIN_S && gapS <= PAUSE_MAX_S) measure.pauses++;
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
    if (paused || e.repeat || !e.isTrusted) return;
    // A modifier pressed on its own is not a keystroke: it writes nothing, and the near-zero gap
    // it leaves before the character it modifies would pass for an impossibly fast one — which is
    // exactly what flight_mad_ms and flight_median_ms are meant to tell apart. Word and VS Code,
    // which count characters, never see one; counting them here made the same student look
    // faster and more prolific in the browser than in an editor. It is dropped before anything else, so a
    // Shift pressed between a click and a Backspace no longer spends the click either.
    if (MODIFIER_KEYS.has(e.key)) return;
    // A dead key is a modifier that does not say so: `^` waiting for the `e` it will turn into
    // `ê` writes nothing by itself, so the rule above is its rule too. Counting it made the
    // browser report two keystrokes where Word and VS Code, counting characters, report one.
    if (e.key === 'Dead') return;
    const now = Date.now();
    markActivity(now);
    trackPause(now);

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
        if (flight < FLIGHT_MAX_MS) {
            measure.flights.push(flight);
            if (measure.flights.length > 500) measure.flights.shift();
        } else if (flight >= HESITATION_MIN_MS && flight <= HESITATION_MAX_MS) {
            // The band between a flight time and a cognitive pause: someone searching for a
            // word. It used to fall through both rules and be counted nowhere.
            measure.hesitations++;
        }
    }
    lastPressTime = now;

    if (composing) {
        trackActiveTime(now);
        countKeystroke(now);
        if (measure.keystrokes >= FLUSH_KEYSTROKES) flush('volume');
        return;
    }

    const key = e.key;
    const mod = e.ctrlKey || e.metaKey;
    const lower = key.length === 1 ? key.toLowerCase() : key;
    const pasting = isPasteShortcut(e, mod, lower);

    // Ctrl/Cmd+A selects the whole document; Shift with a navigation key extends a selection.
    // Shift alone must not count: it is also how capitals are typed.
    if (mod && lower === 'a') selectionScope = 'all';
    else if (e.shiftKey && NAV_KEYS.has(key)) selectionScope = 'range';

    if (key === 'Backspace' || key === 'Delete') {
        // Erasing a selection is scored by what it spans, not by what preceded it.
        if (consumeSelection()) {
            // counted above
        } else if (mouseClickedRecently) measure.macroRevisions++;
        else if (isNavigating) measure.reformulations++;
        else measure.corrections++;
        // The jump is spent on this deletion: what follows is erased on the spot and counts as
        // immediate corrections. Otherwise a single click or arrow key turned every later
        // deletion into a reformulation, and "immediate corrections" stayed at zero for a
        // student who clicks before correcting — which is what everyone does.
        debugLog('deletion', mouseClickedRecently ? 'mass revision (after a click)'
            : isNavigating ? 'deferred reformulation (after a move)' : 'immediate correction');
        isNavigating = false;
    } else if (NAV_KEYS.has(key)) {
        measure.navigation++;
        isNavigating = true;
        // A navigation without Shift collapses the selection instead of extending it.
        if (!e.shiftKey) selectionScope = null;
    } else {
        // A character typed over a selection replaces it. Ctrl/Cmd shortcuts are excluded: they
        // act on the selection (copy, select-all) rather than replacing it — Ctrl+X and Ctrl+V
        // are accounted for on their own below and in the paste handler. Shift+Insert carries no
        // Ctrl and pastes all the same, so it is excluded by the same reason rather than by the
        // same test: left in, it spent the selection here and the paste handler then counted a
        // revision for a block that had replaced nothing.
        if (!mod && !pasting) consumeSelection();
        isNavigating = false;
    }
    mouseClickedRecently = false;

    // Cutting or undoing settles the pending selection itself: the cut is the very deletion the
    // selection was waiting for, and an undo collapses it. Left pending, it would be spent a
    // second time by the next character typed or pasted — one action, two revisions.
    //
    // **Redo is not an undo**, and Shift is what tells them apart: Cmd/Ctrl+Shift+Z puts back
    // what the student had taken out, which is the opposite of a correction. Counted as one, it
    // inflated `immediate_corrections` for anybody who hesitates out loud — and on a Mac, where
    // Cmd+Shift+Z *is* the redo, for anybody who uses it at all. The selection collapses either
    // way, so that part is settled before the test.
    if (mod && lower === 'x') { measure.macroRevisions++; selectionScope = null; }
    if (mod && lower === 'z') {
        selectionScope = null;
        if (!e.shiftKey) measure.corrections++;
    }

    trackActiveTime(now);
    // A paste does write — but what it writes is weighed in the paste handler, one keystroke for
    // the student's own text coming back and none for an injection, and weighed there whatever
    // pasted it: the menu, the toolbar and a drag have no key to count. Counting the key as well
    // made the same gesture cost two keystrokes from the keyboard and one from the menu, and an
    // injection cost one from the keyboard and none from the menu. Ctrl/Cmd+C stays an ordinary
    // keystroke: it puts nothing into the document, so no other handler counts it.
    if (!pasting) countKeystroke(now);

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
// `real_volume_chars` is compared with the deposited document. And it spends the gesture that
// opened the menu, exactly as a deletion spends the click that precedes it — without this, the
// right click that produced the suggestions would make the next Backspace read as a mass
// revision, for somebody who only fixed a typo.
function recordSpellCorrection(now) {
    markActivity(now);
    trackPause(now);
    measure.corrections++;
    isNavigating = false;
    mouseClickedRecently = false;
    selectionScope = null;
    debugLog('spelling chosen in the corrector → immediate correction');
}

function onMouseDown(e) {
    if (paused || !e.isTrusted) return;
    // The corrector draws its suggestions **inside** the editing area, so this is tested before
    // the area itself: otherwise choosing a spelling counted a jump through the document, and
    // each correction cost the student two crossings of their own text.
    if (editor.correctionMenu && e.target instanceof Element && e.target.closest(editor.correctionMenu)) {
        recordSpellCorrection(Date.now());
        return;
    }
    // Only clicks in the document body are navigation jumps (not the menus).
    if (e.target instanceof Element && !e.target.closest(editor.editorArea)) return;
    const now = Date.now();
    markActivity(now);
    trackPause(now);
    measure.navigation++;
    isNavigating = true;
    mouseClickedRecently = true;
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
    if (paused || !e.isTrusted || !mouseDownAt) return;
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
    if (paused || !text) return;
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
    if (paused || !e.isTrusted) return;
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
            // A copy nothing could be read from leaves nothing to recognise later, and used to
            // say so nowhere: the restitution then failed in silence, one paste later.
            if (text) rememberOwnText(text);
            else debugLog('copy seen, but nothing readable in the selection');
        }, COPY_RETRY_MS);
    }, 0);
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
    if (paused || !text) return;
    const now = Date.now();
    markActivity(now);
    trackPause(now);
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
        // Counted so the engine can tell a revision through a corrector from a revision made by
        // hand: both weigh as a mass revision, and only this says which one it was.
        measure.selfPasteEvents++;
        // And how much came back, not only how often: four restitutions say nothing about
        // whether a paragraph or a third of the document went through the corrector.
        measure.selfPasteChars += chars;
        debugLog('restitution of %d characters: %s, not an injection', chars,
            own.again ? 'duplication' : 'revision');
        return;
    }

    measure.pasteEvents++;
    if (chars > INJECTION_MIN_CHARS) {
        measure.injectedChars += chars;
        // The largest single injection, which the total alone hides: twenty pastes of a
        // hundred characters and one of two thousand give the same total.
        if (chars > measure.maxInjectedChars) measure.maxInjectedChars = chars;
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
    if (paused || !e.isTrusted || !e.clipboardData) return;
    recordInjection(e.clipboardData.getData('text/plain'));
}

function onDrop(e) {
    if (paused || !e.isTrusted || !e.dataTransfer) return;
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
    if (!debug || paused) return;
    const since = lastPressTime > 0 ? Date.now() - lastPressTime : -1;
    const extra = (e.dataTransfer ? ', with a dataTransfer' : '') + (e.isTrusted ? '' : ', untrusted');
    debugLog('input probe: %s %s, %d characters, %d ms since the last keystroke%s',
        e.type, e.inputType || '(no type)', e.data ? codePoints(e.data) : 0, since, extra);
}

// Back in the document after having really left it. Nothing is counted here: the return only
// dates what follows it, and only a departure that was counted opens one.
function noteReturn() {
    if (paused || !awayFrom) return;
    lastReturnAt = Date.now();
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
    if (paused) return;
    setTimeout(() => {
        if (document.hasFocus()) return;
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
const attached = new WeakSet();

function attachEditorDocument(doc) {
    if (!doc || attached.has(doc)) return;
    attached.add(doc);
    doc.addEventListener('keydown', onKeyDown, true);
    doc.addEventListener('paste', onPaste, true);
    doc.addEventListener('drop', onDrop, true);
    // Cutting is a copy that also deletes: the deletion is scored by onKeyDown (Ctrl/Cmd+X),
    // what leaves the document is remembered here.
    doc.addEventListener('copy', onCopy, true);
    doc.addEventListener('cut', onCopy, true);
    // Dragging a block from one paragraph to another drops it back as a paste: the text moved,
    // it did not come from outside.
    doc.addEventListener('dragstart', onCopy, true);
    // Debug mode only, and it counts nothing: see onProbeInput.
    doc.addEventListener('beforeinput', onProbeInput, true);
    doc.addEventListener('input', onProbeInput, true);
}

function attachIframe(iframe) {
    const tryAttach = () => {
        try { attachEditorDocument(iframe.contentDocument); } catch (_) { /* cross-origin iframe */ }
    };
    if (!attached.has(iframe)) {
        attached.add(iframe);
        iframe.addEventListener('load', tryAttach);
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
    if (!debug || paused) return;
    if (e.target instanceof Element && e.target.closest(editor.editorArea)) onProbeInput(e);
}

// Copying is only remembered from the document itself: a comment or a menu is not what the
// student wrote, and pasting it back has no reason to be excused as a revision.
function onTopCopy(e) {
    if (e.target instanceof Element && e.target.closest(editor.editorArea)) onCopy(e);
}

document.addEventListener('keydown', onTopKeyDown, true);
document.addEventListener('paste', onTopPaste, true);
document.addEventListener('beforeinput', onTopProbeInput, true);
document.addEventListener('input', onTopProbeInput, true);
document.addEventListener('copy', onTopCopy, true);
document.addEventListener('cut', onTopCopy, true);
document.addEventListener('dragstart', onTopCopy, true);
document.addEventListener('mousedown', onMouseDown, true);
document.addEventListener('mouseup', onMouseUp, true);
window.addEventListener('blur', onWindowBlur);
document.addEventListener('visibilitychange', () => {
    if (paused) return;
    if (document.visibilityState !== 'hidden') {
        noteReturn();
        return;
    }
    // A hidden tab is a left document, whatever the editor. This signal arrives at once, where
    // the blur path has to wait for a turn the hidden tab may not get in time.
    noteDeparture('hidden');
});
window.addEventListener('focus', noteReturn);
window.addEventListener('pagehide', () => {
    if (!paused) flush('pagehide');
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
    const onVisible = () => {
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
// Each reader answers what it can read **now**, and `null` when it cannot: whether that answer
// is worth asking for again is `documentVolume`'s business, not theirs.
async function fetchGoogleDocsVolume(docId) {
    try {
        const res = await Promise.race([
            chrome.runtime.sendMessage({ type: 'CERTIMENS_GDOCS_VOLUME', documentId: docId }),
            new Promise((resolve) => setTimeout(() => resolve({ ok: false, message: 'timed out' }), VOLUME_TIMEOUT_MS)),
        ]);
        if (res?.ok) return res.volume;
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

async function readSiteVolume() {
    const text = siteText();
    return text === null ? null : codePoints(text.replace(INVISIBLE_CHARS, ''));
}

async function readWordVolume() {
    const body = document.getElementById('WACViewPanel_EditingElement');
    // `innerText` forces a synchronous layout of the whole editing panel — the single most
    // expensive thing this sensor does, which is why `documentVolume` holds it to one read every
    // `volumeMaxAgeMs` instead of one per window.
    return body ? codePoints(body.innerText.replace(INVISIBLE_CHARS, '')) : null;
}

// The document's size, read at most once per `volumeMaxAgeMs`. A window closes after 2 s of
// inactivity, at 200 keystrokes, on every departure and on every save — several times a minute
// for somebody who is writing — and reading the document is the one thing in that path whose
// cost grows with the document.
//
// A reader that answers `null` has failed or has nothing to read: the last known value is served
// and **its age is left alone**, so the next window asks again instead of standing on a stale
// number for the whole delay.
async function documentVolume(docId, reason) {
    // The page is closing: no time to wait for an export, we reuse the last value.
    if (reason === 'pagehide' && editor.remoteVolume) return cachedVolume;
    if (cachedVolumeAt > 0 && Date.now() - cachedVolumeAt < editor.volumeMaxAgeMs) return cachedVolume;
    const volume = await editor.volume(docId);
    if (volume === null || volume === undefined) return cachedVolume;
    cachedVolume = volume;
    cachedVolumeAt = Date.now();
    return volume;
}

// --- 5. FLUSH TO THE BACKGROUND ---
async function flush(reason) {
    clearTimeout(idleTimer);
    lastActivityTime = 0;
    if (!hasActivity()) {
        // Clicks only: their counters carry over to the next window, but not their time, otherwise
        // the period would swallow the inactivity that follows.
        measure.start = null;
        measure.last = null;
        return;
    }
    const docId = editor.documentId();
    if (!docId) return;

    const done = measure;
    measure = newMeasure();

    const end = Math.max(done.last, done.start + 1000); // the engine requires end > start
    const values = {
        effective_time_ms: done.activeMs,
        keystrokes_total: done.keystrokes,
        injected_chars_total: done.injectedChars,
        immediate_corrections: done.corrections,
        deferred_reformulations: done.reformulations,
        navigation_jumps: done.navigation,
        macro_revisions: done.macroRevisions,
        cognitive_pauses: done.pauses,
        paste_events: done.pasteEvents,
        self_paste_events: done.selfPasteEvents,
        self_paste_chars_total: done.selfPasteChars,
        lexical_hesitations: done.hesitations,
        keystrokes_after_return: done.keystrokesAfterReturn,
        injected_chars_max: done.maxInjectedChars,
        injected_chars_after_return: done.injectedCharsAfterReturn,
        focus_losses: done.focusLosses,
    };
    // Without at least two flight times, the rhythm isn't measurable: we send nothing
    // rather than a 0 that would skew the average.
    if (done.flights.length >= 2) {
        values.flight_mad_ms = Math.round(medianAbsoluteDeviation(done.flights) * 100) / 100;
        values.flight_median_ms = Math.round(median(done.flights) * 100) / 100;
    }
    const volume = await documentVolume(docId, reason);
    if (volume !== null) values.real_volume_chars = volume;

    debugLog('window sent (%s), %d keystrokes', reason, done.keystrokes, values);
    try {
        chrome.runtime.sendMessage({
            type: 'CERTIMENS_METRICS',
            documentId: docId,
            documentName: editor.documentName(),
            reason,
            flush: WIRE_FLUSH_REASONS[reason],
            period: { start: new Date(done.start).toISOString(), end: new Date(end).toISOString() },
            values,
        });
    } catch (_) {
        // extension reloaded: this page context is orphaned, the window is lost
        console.warn('Certimens: the extension was reloaded, reload this page to resume measuring.');
    }
}
