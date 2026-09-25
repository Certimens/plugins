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
const VOLUME_REFRESH_MS = 30 * 1000;
const VOLUME_TIMEOUT_MS = 5000;

const NAV_KEYS = new Set(['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown']);
const MODIFIER_KEYS = new Set(['Shift', 'Control', 'Alt', 'Meta', 'AltGraph', 'CapsLock', 'OS']);

// --- DEBUG MODE ---
// Switched on from the options page. It logs what the sensor counts (categories and counters
// only — never a character, never a key) so a student's "my deletions aren't counted" can be
// checked against what the engine displays.
let debug = false;

function debugLog(...args) {
    if (debug) console.log('[Certimens]', ...args);
}

try {
    chrome.storage.local.get('debug').then(({ debug: on }) => { debug = !!on; }, () => {});
    chrome.storage.onChanged.addListener((changes, area) => {
        if (area === 'local' && changes.debug) debug = !!changes.debug.newValue;
    });
} catch (_) { /* extension reloaded: the page keeps measuring without the debug mode */ }

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
// iframes, and how to read the document's real volume.
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
        // .docx export done by the background (see fetchGoogleDocsVolume).
        canExport: true,
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
        // No export: the editing iframe has no access to the file (WOPI token not exposed),
        // so the popup offers to send a downloaded copy.
        canExport: false,
    },
};
const editor = location.hostname === 'docs.google.com' ? EDITORS.gdocs : EDITORS.word;

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
        pasteEvents: 0,
        focusLosses: 0,
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

let idleTimer = null;

let cachedVolume = null;
let cachedVolumeAt = 0;

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
    debugLog('sélection remplacée → %s', selectionScope === 'all' ? 'révision massive' : 'reformulation différée');
    selectionScope = null;
    return true;
}

// --- 2. CAPTURE ---
function onKeyDown(e) {
    if (e.repeat || !e.isTrusted) return;
    const now = Date.now();
    markActivity(now);
    trackPause(now);

    if (lastPressTime > 0) {
        const flight = now - lastPressTime;
        if (flight < FLIGHT_MAX_MS) {
            measure.flights.push(flight);
            if (measure.flights.length > 500) measure.flights.shift();
        }
    }
    lastPressTime = now;

    const key = e.key;
    const mod = e.ctrlKey || e.metaKey;
    const lower = key.length === 1 ? key.toLowerCase() : key;

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
        debugLog('suppression', mouseClickedRecently ? 'révision massive (après un clic)'
            : isNavigating ? 'reformulation différée (après un déplacement)' : 'correction immédiate');
        isNavigating = false;
    } else if (NAV_KEYS.has(key)) {
        measure.navigation++;
        isNavigating = true;
        // A navigation without Shift collapses the selection instead of extending it.
        if (!e.shiftKey) selectionScope = null;
    } else if (!MODIFIER_KEYS.has(key)) {
        // A character typed over a selection replaces it. Ctrl/Cmd shortcuts are excluded: they
        // act on the selection (copy, select-all) rather than replacing it — Ctrl+X and Ctrl+V
        // are accounted for on their own below and in the paste handler.
        if (!mod) consumeSelection();
        isNavigating = false;
    }
    mouseClickedRecently = false;

    // Cutting or undoing settles the pending selection itself: the cut is the very deletion the
    // selection was waiting for, and an undo collapses it. Left pending, it would be spent a
    // second time by the next character typed or pasted — one action, two revisions.
    if (mod && lower === 'x') { measure.macroRevisions++; selectionScope = null; }
    if (mod && lower === 'z') { measure.corrections++; selectionScope = null; }

    trackActiveTime(now);
    measure.keystrokes++;

    if (mod && lower === 's') flush('save');
    else if (measure.keystrokes >= FLUSH_KEYSTROKES) flush('volume');
}

function onMouseDown(e) {
    if (!e.isTrusted) return;
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
    debugLog('clic dans le document → saut de navigation');
}

// DRAG_MIN_PX separates a click from a drag: a press and release a few pixels apart is still a
// click (the pointer always moves a little), beyond it the student swept a selection.
const DRAG_MIN_PX = 5;

function onMouseUp(e) {
    if (!e.isTrusted || !mouseDownAt) return;
    const moved = Math.abs(e.clientX - mouseDownAt.x) + Math.abs(e.clientY - mouseDownAt.y);
    mouseDownAt = null;
    if (moved < DRAG_MIN_PX) return;
    // A dragged selection spans a block, like Ctrl/Cmd+A.
    selectionScope = 'all';
    debugLog('sélection à la souris');
}

function recordInjection(text) {
    if (!text) return;
    const now = Date.now();
    markActivity(now);
    trackPause(now);
    // Pasting over a selection replaces it: the classic "select everything, paste the answer"
    // used to count as an injection only, never as a revision.
    consumeSelection();
    measure.pasteEvents++;
    const chars = [...text.replace(/[\r\n]/g, '')].length;
    if (chars > INJECTION_MIN_CHARS) measure.injectedChars += chars;
    debugLog('collage de %d caractères', chars);
}

function onPaste(e) {
    if (!e.isTrusted || !e.clipboardData) return;
    recordInjection(e.clipboardData.getData('text/plain'));
}

function onDrop(e) {
    if (!e.isTrusted || !e.dataTransfer) return;
    recordInjection(e.dataTransfer.getData('text/plain'));
}

// The student really leaves the document (another tab, another window, address bar). A
// focus shift from the page to the editing iframe doesn't count: hasFocus() stays true.
function onWindowBlur() {
    setTimeout(() => {
        if (document.hasFocus()) return;
        if (editor.blurMeansLeaving) measure.focusLosses++;
        debugLog('sortie du document (fenêtre), comptée : %s', editor.blurMeansLeaving);
        flush('blur');
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

document.addEventListener('keydown', onTopKeyDown, true);
document.addEventListener('paste', onTopPaste, true);
document.addEventListener('mousedown', onMouseDown, true);
document.addEventListener('mouseup', onMouseUp, true);
window.addEventListener('blur', onWindowBlur);
document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'hidden') return;
    if (!editor.blurMeansLeaving) measure.focusLosses++;
    debugLog('page masquée, sortie comptée : %s', !editor.blurMeansLeaving);
    flush('hidden');
});
window.addEventListener('pagehide', () => flush('pagehide'));

scanEditorIframes();
let scanScheduled = false;
new MutationObserver(() => {
    if (scanScheduled) return;
    scanScheduled = true;
    setTimeout(() => { scanScheduled = false; scanEditorIframes(); }, 500);
}).observe(document.documentElement, { subtree: true, childList: true });

// Rename in the editor: the background renames the engine file. The title is polled
// periodically (Word Online doesn't always reflect it in document.title).
const TITLE_CHECK_MS = 3000;
let lastTitle = null;

// Tells the background about the opened document, as soon as it's visible: if it doesn't yet have an
// engine file, the creation popup opens.
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
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message.type !== 'CERTIMENS_ACTIVE_DOC') return false;
    const id = editor.documentId();
    if (id) sendResponse({ id, name: editor.documentName(), canExport: editor.canExport });
    return false;
});

// --- 4. REAL DOCUMENT VOLUME ---
// Character count of the document, excluding line breaks (like the engine's .docx count).
const INVISIBLE_CHARS = /[\r\n\uFEFF\u200B]/g;

// Google Docs: text export of the document. Google redirects the export to googleusercontent.com,
// which the page (and thus this script, bound by its CORS) can't read: the background does it,
// with its host permissions and the student's session.
async function fetchGoogleDocsVolume(docId) {
    if (Date.now() - cachedVolumeAt < VOLUME_REFRESH_MS) return cachedVolume;
    try {
        const res = await Promise.race([
            chrome.runtime.sendMessage({ type: 'CERTIMENS_GDOCS_VOLUME', documentId: docId }),
            new Promise((resolve) => setTimeout(() => resolve({ ok: false, message: 'délai dépassé' }), VOLUME_TIMEOUT_MS)),
        ]);
        if (res?.ok) {
            cachedVolume = res.volume;
            cachedVolumeAt = Date.now();
        } else {
            console.warn('Certimens : export texte impossible, volume non mis à jour.', res?.message);
        }
    } catch (err) {
        // extension reloaded: we keep the last known value
        console.warn('Certimens : export texte impossible, volume non mis à jour.', err);
    }
    return cachedVolume;
}

// Word Online: text shown in the editing area (local read, so always up to date).
async function readWordVolume() {
    const body = document.getElementById('WACViewPanel_EditingElement');
    if (body) cachedVolume = [...body.innerText.replace(INVISIBLE_CHARS, '')].length;
    return cachedVolume;
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
        effective_time_seconds: Math.round(done.activeMs / 1000),
        total_keystrokes: done.keystrokes,
        total_injected_chars: done.injectedChars,
        immediate_corrections: done.corrections,
        deferred_reformulations: done.reformulations,
        navigation_jumps: done.navigation,
        macro_revisions: done.macroRevisions,
        cognitive_pauses: done.pauses,
        paste_events: done.pasteEvents,
        focus_losses: done.focusLosses,
    };
    // Without at least two flight times, the rhythm isn't measurable: we send nothing
    // rather than a 0 that would skew the average.
    if (done.flights.length >= 2) {
        values.mad_ms = Math.round(medianAbsoluteDeviation(done.flights) * 100) / 100;
        values.median_flight_ms = Math.round(median(done.flights) * 100) / 100;
    }
    // The page is closing: no time to wait for an export, we reuse the last value.
    const volume = reason === 'pagehide' && editor.remoteVolume ? cachedVolume : await editor.volume(docId);
    if (volume !== null) values.real_volume = volume;

    debugLog('fenêtre envoyée (%s), %d frappes', reason, done.keystrokes, values);
    try {
        chrome.runtime.sendMessage({
            type: 'CERTIMENS_METRICS',
            documentId: docId,
            documentName: editor.documentName(),
            reason,
            period: { start: new Date(done.start).toISOString(), end: new Date(end).toISOString() },
            values,
        });
    } catch (_) {
        // extension reloaded: this page context is orphaned, the window is lost
        console.warn("Certimens : l'extension a été rechargée, rechargez cette page pour reprendre la mesure.");
    }
}
