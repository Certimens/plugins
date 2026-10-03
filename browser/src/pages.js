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
