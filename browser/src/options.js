const fields = { engineUrl: $('engineUrl'), email: $('email'), password: $('password') };

async function load() {
    const { config } = await chrome.storage.local.get('config');
    // The account's language, as soon as it is known; the browser's until then.
    startLanguage(config);
    fields.engineUrl.value = config?.engineUrl || DEFAULT_ENGINE_URL;
    fields.email.value = config?.email || '';
    // The password isn't stored (only a token is): the field stays empty, filled in at
    // login and, once the token is obtained, never asked again.
    if (config?.token) showMessage(t('login.reconnectToChange', { email: config.email }), true);
}

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
    const engineUrl = await requestEngineAccess(fields.engineUrl.value);
    if (!engineUrl) return;
    const button = e.submitter;
    button.disabled = true;
    showMessage(t('login.connecting'), true);
    // Login exchanges the password for an API token: only the token is kept.
    const res = await chrome.runtime.sendMessage({
        type: 'CERTIMENS_LOGIN',
        engineUrl,
        email: fields.email.value.trim(),
        password: fields.password.value,
    });
    button.disabled = false;
    if (res.ok) {
        fields.password.value = '';
        showMessage(t('login.loggedInAs', { email: res.me.email }), true);
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
    const { debug, debugLog = [] } = await chrome.storage.local.get(['debug', 'debugLog']);
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

$('debug').addEventListener('change', () => chrome.storage.local.set({ debug: $('debug').checked }));
$('clearLog').addEventListener('click', () => chrome.storage.local.set({ debugLog: [] }).then(refreshDebug));

$('version').textContent = 'v' + chrome.runtime.getManifest().version;
load();
refreshStatus();
refreshDebug();
setInterval(() => {
    refreshStatus();
    refreshDebug();
}, 5000);
