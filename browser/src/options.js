async function load() {
    const { config } = /** @type {CertimensStored} */ (
        await chrome.storage.local.get('config'));
    // The account's language, as soon as it is known; the browser's until then.
    startLanguage(config);
    // After the language and not before: the notice is a sentence, and this page settles which
    // language it is in only once the config has been read.
    void showUpdateIfNew();
    fillEngineUrl(config?.engineUrl);
    showLogout(!!config?.token);
    if (config?.token) showMessage(t('pair.reconnectToChange', { email: config.displayName || config.email }), true);
    // A pairing may already be in flight — asked for here or from the popup, they are the same
    // exchange, held by the background.
    void resumePairing();
}

// The log out, offered only when there is a session to end, with the sentence that says what
// pressing it does — the one the popup hangs on its icon.
function showLogout(held) {
    $('logout').hidden = !held;
    $('logout').title = t('account.logoutTip');
}

// Draws a pairing in flight, or puts the form back to its initial state when there is none.
function showPairing(pairing) {
    $('pairing').hidden = !pairing;
    $('pairStart').hidden = !!pairing;
    if (!pairing) return;
    $('userCode').textContent = pairing.userCode;
    $('pairOpen').href = pairing.verificationUriComplete;
    showMessage(t('pair.showCode'), true);
}

// Picks a pairing back up: the student confirmed the code in another tab and came back.
async function resumePairing() {
    const res = await chrome.runtime.sendMessage({ type: 'CERTIMENS_PAIR_STATE' });
    if (!res?.ok) {
        showPairing(null);
        showMessage(errorText(res || {}), false);
        return;
    }
    if (res.me) {
        showPairing(null);
        showLogout(true);
        showMessage(t('pair.connectedAs', { email: res.me.display_name || res.me.email }), true);
        return;
    }
    showPairing(res.pairing);
}

// Unlike the popup, this page is a tab that stays open: the student goes off to confirm the
// code in their Certimens space and comes back to it, so coming back is what picks the pairing
// up. Without this they would read "waiting for your confirmation" over an exchange that
// finished, until the retry alarm got to it a minute later.
document.addEventListener('visibilitychange', () => {
    if (document.hidden) return;
    void resumePairing();
    // The periodic refresh below holds its breath while the tab is hidden, so coming back is
    // what redraws it — rather than up to five seconds of a panel that stopped being true.
    refreshStatus();
    refreshDebug();
});

// The one place that ends a session from a page that stays open: the popup closes on itself and
// can just redraw, this page has to say what happened and take its own button away.
$('logout').addEventListener('click', async () => {
    await chrome.runtime.sendMessage({ type: 'CERTIMENS_LOGOUT' });
    showLogout(false);
    showMessage(t('account.loggedOut'), true);
    refreshStatus();
});

$('pairCancel').addEventListener('click', async () => {
    await chrome.runtime.sendMessage({ type: 'CERTIMENS_PAIR_CANCEL' });
    showPairing(null);
    showMessage('', true);
});

async function refreshStatus() {
    const s = await chrome.runtime.sendMessage({ type: 'CERTIMENS_STATUS' });
    if (!s?.ok) return;
    $('status').replaceChildren(
        ...[
            s.paused ? t('pause.status') : null,
            t('status.state', { state: t(`status.${s.status.state}`) }),
            s.status.message ? t('status.detail', { message: s.status.message }) : null,
            t('status.queued', { count: s.queued }),
            t('status.documents', { count: s.documents }),
            s.extendedDropped ? t('status.extendedDropped') : null,
            s.status.at ? t('status.lastAttempt', { at: new Date(s.status.at).toLocaleString(dateLocale()) }) : null,
        ].filter(Boolean).map((line) => Object.assign(document.createElement('div'), { textContent: line })),
    );
}

$('form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const engineUrl = await requestEngineAccess(engineUrlValue());
    if (!engineUrl) return;
    const button = e.submitter;
    button.disabled = true;
    showMessage(t('pair.asking'), true);
    // No password is asked for, here or anywhere: the engine hands out a code, the student
    // confirms it in their Certimens space, and this agent is given an API token.
    const res = await chrome.runtime.sendMessage({ type: 'CERTIMENS_PAIR_START', engineUrl });
    button.disabled = false;
    if (res.ok) {
        showPairing(res.pairing);
    } else {
        showMessage(errorText(res), false);
    }
    refreshStatus();
});

$('test').addEventListener('click', async () => {
    showMessage(t('options.testing'), true);
    const res = await chrome.runtime.sendMessage({ type: 'CERTIMENS_WHOAMI' });
    if (res.ok) showMessage(t('options.testedAs', { email: res.me.email, role: res.me.role }), true);
    else showMessage(errorText(res), false);
    refreshStatus();
});

async function refreshDebug() {
    const { debug, debugLog = [] } = /** @type {CertimensStored} */ (
        await chrome.storage.local.get(['debug', 'debugLog']));
    $('debug').checked = !!debug;
    const lines = [...debugLog].reverse().map((entry) => {
        const counters = Object.entries(entry.values)
            .filter(([, value]) => value)
            .map(([type, value]) => `${value} ${t(`counter.${type}`)}`);
        const time = new Date(entry.at).toLocaleTimeString(dateLocale());
        return `${time} · ${entry.reason} · ${counters.join(', ') || t('counter.none')}`;
    });
    $('debugLog').replaceChildren(...(lines.length ? lines : [t('options.emptyLog')])
        .map((line) => Object.assign(document.createElement('div'), { textContent: line })));
}

// --- SITES ADDED BY THE STUDENT ---
//
// No manifest can name the Moodle of every institution, and asking every student for access to
// the whole web to serve a few would be the wrong trade. So the address is added here, and the
// browser asks for the permission **here** too: `chrome.permissions.request` wants a user
// gesture, which a service worker does not have.

// The match pattern of an address: its origin, and every page of it. Narrower would break on
// the next page of the same Moodle; wider would be asking for a site the student did not name.
function siteMatch(rawUrl) {
    const url = new URL(rawUrl.trim());
    if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new TypeError('scheme');
    return url.origin + '/*';
}

// What the student reads: the host, not the pattern. `https://moodle.x.fr/*` is our vocabulary.
function siteHost(match) {
    return match.replace(/^https?:\/\//, '').replace(/\/\*$/, '');
}

function siteRow(match) {
    const row = Object.assign(document.createElement('div'), { className: 'row' });
    row.append(Object.assign(document.createElement('span'), { textContent: siteHost(match) }));
    const remove = Object.assign(document.createElement('button'), {
        type: 'button', className: 'link small', textContent: t('sites.remove'), title: t('sites.removeTip'),
    });
    remove.addEventListener('click', async () => {
        await chrome.runtime.sendMessage({ type: 'CERTIMENS_REMOVE_SITE', match });
        showMessage(t('sites.removed', { host: siteHost(match) }), true);
        refreshSites();
    });
    row.append(remove);
    return row;
}

// --- WHAT THE SCHOOL PROPOSES ---
//
// A third source, beside the editors the extension ships with and the addresses the student
// types below: the school names where its students write, and the agent reads that list.
//
// It proposes, it does not grant — and this page is where that distinction is kept honest. One
// button per address, never a "take them all": what the browser then shows names the single
// origin it is about, which is the only moment the student is really being asked. A proposal
// refused is simply a proposal left on the page.
function proposedRow(match) {
    const row = Object.assign(document.createElement('div'), { className: 'row' });
    row.append(Object.assign(document.createElement('span'), { textContent: siteHost(match) }));
    const add = Object.assign(document.createElement('button'), {
        type: 'button',
        className: 'link small',
        textContent: t('sites.proposedAdd'),
        title: t('sites.proposedAddTip', { host: siteHost(match) }),
    });
    // No await before the request: a browser only accepts one straight out of the click.
    add.addEventListener('click', () => void addProposed(match));
    row.append(add);
    return row;
}

async function addProposed(match) {
    if (!chrome.scripting?.registerContentScripts) {
        showMessage(t('sites.unsupported'), false);
        return;
    }
    try {
        if (!await chrome.permissions.request({ origins: [match] })) {
            showMessage(t('sites.denied'), false);
            return;
        }
    } catch (err) {
        showMessage(t('error.permissionFailed', { message: err.message }), false);
        return;
    }
    await chrome.runtime.sendMessage({ type: 'CERTIMENS_ADD_SITE', match });
    showMessage(t('sites.added', { host: siteHost(match) }), true);
    refreshSites();
}

function showProposed(proposed) {
    const sites = proposed || [];
    // Nothing proposed, nothing to show: an empty card would only tell the student that their
    // school has not got round to it.
    $('proposed').hidden = sites.length === 0;
    if ($('proposed').hidden) return;
    $('proposedHelp').textContent = t('sites.proposedHelp');
    $('proposedList').replaceChildren(...sites.map(proposedRow));
}

async function refreshSites({ reread = false } = {}) {
    const res = await chrome.runtime.sendMessage({
        type: reread ? 'CERTIMENS_REFRESH_SITES' : 'CERTIMENS_SITES',
    });
    const sites = res?.ok ? res.sites : [];
    $('siteList').replaceChildren(...(sites.length
        ? sites.map(siteRow)
        : [Object.assign(document.createElement('div'), { textContent: t('sites.empty') })]));
    showProposed(res?.ok ? res.proposed : null);
}

$('siteForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    let match;
    try {
        match = siteMatch($('siteUrl').value);
    } catch (_) {
        showMessage(t('sites.invalid'), false);
        return;
    }
    // A browser too old for dynamic registration would take the permission and measure nothing:
    // better to say so than to let the student believe their Moodle is covered.
    if (!chrome.scripting?.registerContentScripts) {
        showMessage(t('sites.unsupported'), false);
        return;
    }
    try {
        if (!await chrome.permissions.request({ origins: [match] })) {
            showMessage(t('sites.denied'), false);
            return;
        }
    } catch (err) {
        showMessage(t('error.permissionFailed', { message: err.message }), false);
        return;
    }
    await chrome.runtime.sendMessage({ type: 'CERTIMENS_ADD_SITE', match });
    $('siteUrl').value = '';
    showMessage(t('sites.added', { host: siteHost(match) }), true);
    refreshSites();
});

$('debug').addEventListener('change', () => chrome.storage.local.set({ debug: $('debug').checked }));
$('clearLog').addEventListener('click', () => chrome.storage.local.set({ debugLog: [] }).then(refreshDebug));

$('version').textContent = 'v' + chrome.runtime.getManifest().version;
load();
refreshStatus();
refreshDebug();
// Asked again on opening rather than taken from the cache: the student is looking at the list
// now, and their school may have named an address since the daily read.
refreshSites({ reread: true });
setInterval(() => {
    // Each refresh is a message to the service worker, and a message is what wakes one. A tab
    // left open in the background would keep it awake for hours to redraw a panel nobody is
    // looking at; what is drawn here is read again the moment the tab comes back.
    if (document.hidden) return;
    refreshStatus();
    refreshDebug();
}, 5000);
