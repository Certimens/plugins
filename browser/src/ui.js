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

// An SVG element does not implement the `hidden` property — it lives on HTMLElement — so setting
// it in JavaScript only creates a dead expando and the icon never swaps. The attribute has to be
// written by hand; the stylesheet acts on it.
function showIcon(svg, visible) {
    if (visible) svg.removeAttribute('hidden');
    else svg.setAttribute('hidden', '');
}

// The header's icon actions, shared by the popup and the Word task pane.
//
// An icon names nothing on its own: each button carries its action as an accessible name, and the
// sentence that says what pressing it does as a tooltip. The pause is a toggle, so it also
// carries aria-pressed — and its colour only ever seconds the banner, which keeps saying in plain
// words that the measurement is suspended.
function renderIconActions(paused) {
    $('actions').hidden = false;
    const pause = $('pause');
    pause.setAttribute('aria-pressed', String(!!paused));
    pause.setAttribute('aria-label', t(paused ? 'pause.resume' : 'pause.suspend'));
    pause.title = t(paused ? 'pause.resumeTip' : 'pause.suspendTip');
    showIcon($('iconPause'), !paused);
    showIcon($('iconPlay'), !!paused);
    const logout = $('logout');
    logout.setAttribute('aria-label', t('account.logout'));
    logout.title = t('account.logoutTip');
}

// Displays a message in the #message element (its other classes are kept).
// Who is logged in. The engine always computes a display name and falls back to the e-mail
// itself when the account carries neither first nor last name, so the second line only shows
// when it adds something. An engine too old to send a name leaves it empty: the first line
// falls back to the e-mail on its own, and the second disappears.
function showAccount(displayName, email) {
    const name = displayName || email || '';
    $('who').textContent = name;
    const second = $('whoEmail');
    if (!second) return;
    second.textContent = email || '';
    second.hidden = !email || email === name;
}

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

// The engine address lives behind "advanced settings". The field is still filled in, so the
// section only opens by itself when it holds something other than the default engine — an
// institution hosting its own. A disclosure that never has anything to say would be noise.
function fillEngineUrl(engineUrl) {
    const url = engineUrl || DEFAULT_ENGINE_URL;
    $('engineUrl').value = url;
    const box = $('advanced');
    if (box) box.open = url !== DEFAULT_ENGINE_URL;
}

// What the form submits. An emptied field means the default engine, not a failed login: the
// input is no longer `required` precisely because a hidden required field would block the submit
// without the browser being able to show the student which field it is complaining about.
function engineUrlValue() {
    return $('engineUrl').value.trim() || DEFAULT_ENGINE_URL;
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
