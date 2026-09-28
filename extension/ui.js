// Shared code for the popup and the options page (loaded after i18n.js, before popup.js /
// options.js).

const DEFAULT_ENGINE_URL = 'https://monespace.certimens.fr';

// The language of a page: the Certimens account's if the student is logged in, the browser's
// otherwise. Called before anything is rendered — a page that flashed French before switching to
// English would be worse than one that never switched.
function startLanguage(config) {
    document.documentElement.lang = setLanguage(config && config.language, chrome.i18n.getUILanguage());
    applyTranslations();
}

const $ = (id) => document.getElementById(id);

// Displays a message in the #message element (its other classes are kept).
function showMessage(text, ok) {
    const el = $('message');
    el.textContent = text;
    el.classList.toggle('ok', ok);
    el.classList.toggle('error', !ok);
}

function clearMessage() {
    $('message').textContent = '';
}

// Error text for a { ok: false, status, message } response from the background.
function errorText(res) {
    // 401 at login: wrong email/password; 401 afterwards: token revoked.
    if (res.status === 401) return t('error.credentials');
    return t('error.engineUnreachable', { message: res.message || t('error.networkError') });
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
