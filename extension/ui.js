// Shared code for the popup and the options page (loaded before popup.js / options.js).

const DEFAULT_ENGINE_URL = 'https://monespace.certimens.fr';

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
    if (res.status === 401) return 'Identifiants incorrects ou accès révoqué — reconnectez-vous.';
    return `Moteur injoignable (${res.message || 'erreur réseau'}).`;
}

// Requests access to the engine host (Firefox doesn't automatically grant host_permissions in MV3)
// and returns its normalized address, or null after showing the error. Must be called with no
// prior await: Firefox requires permissions.request() to be called directly in the
// click handler. If already granted, access is confirmed without asking anything.
async function requestEngineAccess(rawUrl) {
    const engineUrl = rawUrl.trim().replace(/\/+$/, '');
    try {
        if (await chrome.permissions.request({ origins: [new URL(engineUrl).origin + '/*'] })) return engineUrl;
        showMessage("Permission refusée pour l'adresse du moteur.", false);
    } catch (err) {
        showMessage(err instanceof TypeError && /URL/i.test(err.message) ? 'Adresse du moteur invalide.' : `Permission impossible : ${err.message}`, false);
    }
    return null;
}
