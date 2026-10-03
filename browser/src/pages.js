// What the popup and the options page share, and the Word task pane must not have.
//
// ui.js is the window itself — the same markup, the same stylesheet, the same helpers — and it
// is a symbolic link into the add-in: everything it declares runs in a task pane too. These two
// reach for `chrome.*`, which no Office pane has. Kept in ui.js they were dead code shipped to
// Word, and a landmine for whoever called one of them from the pane.
//
// Loaded after i18n.js and ui.js, whose `t` and `showMessage` they use.

// The language of a page: the Certimens account's if the student is logged in, the browser's
// otherwise. Called before anything is rendered — a page that flashed French before switching
// to English would be worse than one that never switched. The pane has its own, from Word's
// display language (`taskpane.js`).
function startLanguage(config) {
    document.documentElement.lang = setLanguage(config && config.language, chrome.i18n.getUILanguage());
    applyTranslations();
}

// What the student last saw, against what is running — and the line in ui.js when the two
// differ. The store installed the new version without asking and without saying so; this window
// is the first place that can mention it.
//
// `version_name` is the readable label (`1.4.2-a9085f3` on a build of a branch), `version` the
// plain number a store demands. The comparison is a straight inequality: a version going
// backwards is as much a change as one going forward, and the student is owed the same line.
//
// **An install that has never written the key is a fresh one, not an update**: it records the
// version without a word, and the first notice is the one after the *next* update. That is also
// what the installs already out there get the day this ships — nobody is told they updated to
// the version they have been running for a month.
async function showUpdateIfNew() {
    const manifest = chrome.runtime.getManifest();
    const version = manifest.version_name || manifest.version;
    const { seenVersion } = await chrome.storage.local.get('seenVersion');
    if (seenVersion === version) return;
    await chrome.storage.local.set({ seenVersion: version });
    if (seenVersion) showUpdateNotice(version);
}

// Requests access to the engine host (Firefox doesn't automatically grant host_permissions in MV3)
// and returns its normalized address, or null after showing the error. Must be called with no
// prior await: Firefox requires permissions.request() to be called directly in the
// click handler. If already granted, access is confirmed without asking anything.
async function requestEngineAccess(rawUrl) {
    const engineUrl = rawUrl.trim().replace(/\/+$/, '');
    // Before the browser's dialog, not after: an address the agent will refuse to call must not
    // first have the student grant a permission for it. `engineUrlAllowed` is also what the
    // worker applies on the way out (constants.js) — this is the same refusal, worded.
    if (!engineUrlAllowed(engineUrl)) {
        showMessage(t('error.engineUrlInsecure'), false);
        return null;
    }
    try {
        if (await chrome.permissions.request({ origins: [new URL(engineUrl).origin + '/*'] })) return engineUrl;
        showMessage(t('error.permissionDenied'), false);
    } catch (err) {
        showMessage(err instanceof TypeError && /URL/i.test(err.message)
            ? t('error.engineUrlInvalid')
            : t('error.permissionFailed', { message: err.message }), false);
    }
    return null;
}

// "Signaler un problème", from the popup or the options page. The worker builds the link and
// opens the tab: it holds the state the block describes, and a page asking it for the
// configuration would be asking for the token. Said only when it fails — otherwise the form
// opening in its tab is the answer.
async function openReport() {
    const res = await chrome.runtime.sendMessage({ type: 'CERTIMENS_REPORT' });
    if (!res?.ok) showMessage(errorText(res || {}), false);
}

// Bytes as base64, for the two deposits a page makes: a .docx, and the text of a page.
//
// In slices: `String.fromCharCode(...bytes)` passes every byte as an argument, and an engine
// stops taking arguments somewhere past a hundred thousand — a long copy threw a RangeError,
// the click did nothing, and the student was told nothing.
function toBase64(bytes) {
    let binary = '';
    for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(binary);
}

// An uncaught exception in this page, told to the worker for its `error.runtime` counter and its
// faults (background.js, SELF-TELEMETRY). The exception's type and stack cross to the worker, in
// the browser's memory; what the worker keeps of them, and sends, is only where our code broke
// (`faultOf`) — never the message, which could quote what the student wrote. An extension page
// runs nothing but the extension's own scripts, so every error here is ours. Once per page: a
// broken render would otherwise say the same thing at every redraw.
let runtimeErrorReported = false;
function reportPageError(/** @type {any} */ event) {
    if (runtimeErrorReported) return;
    runtimeErrorReported = true;
    const error = event?.error ?? event?.reason;
    const real = error && typeof error === 'object' && typeof error.stack === 'string';
    try {
        Promise.resolve(chrome.runtime.sendMessage({
            type: 'CERTIMENS_RUNTIME_ERROR',
            name: real ? String(error.name) : '',
            stack: real ? error.stack : '',
        })).catch(() => {});
    } catch (_) { /* the extension is being reloaded: nobody to tell */ }
}
window.addEventListener('error', reportPageError);
window.addEventListener('unhandledrejection', reportPageError);
