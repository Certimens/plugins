const STATUS_LABEL = {
    idle: 'En attente de mesures',
    synced: '🟢 Synchronisé',
    offline: '🟠 Moteur injoignable — les mesures sont conservées et renvoyées chaque minute',
    auth_error: '🔴 Identifiants refusés',
    unconfigured: '🔴 Agent non configuré',
};

// Debug journal: what each measurement window carried, in the wording of the engine's page.
const COUNTER_LABELS = {
    total_keystrokes: 'frappes',
    immediate_corrections: 'corrections immédiates',
    deferred_reformulations: 'reformulations différées',
    macro_revisions: 'révisions massives',
    navigation_jumps: 'sauts de navigation',
    cognitive_pauses: 'pauses',
    paste_events: 'collages',
    focus_losses: 'sorties du document',
    total_injected_chars: 'caractères injectés',
    effective_time_seconds: 's effectives',
    real_volume: 'caractères dans le document',
    median_flight_ms: 'ms entre frappes (médiane)',
    mad_ms: 'ms d\'écart médian',
};

const fields = { engineUrl: $('engineUrl'), email: $('email'), password: $('password') };

async function load() {
    const { config } = await chrome.storage.local.get('config');
    fields.engineUrl.value = config?.engineUrl || DEFAULT_ENGINE_URL;
    fields.email.value = config?.email || '';
    // The password isn't stored (only a token is): the field stays empty, filled in at
    // login and, once the token is obtained, never asked again.
    if (config?.token) showMessage(`Connecté : ${config.email}. Reconnectez-vous pour changer de compte.`, true);
}

async function refreshStatus() {
    const s = await chrome.runtime.sendMessage({ type: 'CERTIMENS_STATUS' });
    if (!s?.ok) return;
    $('status').replaceChildren(
        ...[
            `État : ${STATUS_LABEL[s.status.state] || s.status.state}`,
            s.status.message ? `Détail : ${s.status.message}` : null,
            `Mesures en attente d'envoi : ${s.queued}`,
            `Documents suivis : ${s.documents}`,
            s.extendedDropped ? 'Mesures étendues (collages, sorties, cadence) refusées par le moteur : elles ne sont plus envoyées. Reconnectez-vous pour réessayer.' : null,
            s.status.at ? `Dernière tentative : ${new Date(s.status.at).toLocaleString('fr-FR')}` : null,
        ].filter(Boolean).map((line) => Object.assign(document.createElement('div'), { textContent: line })),
    );
}

$('form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const engineUrl = await requestEngineAccess(fields.engineUrl.value);
    if (!engineUrl) return;
    const button = e.submitter;
    button.disabled = true;
    showMessage('Connexion…', true);
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
        showMessage(`Connecté en tant que ${res.me.email}.`, true);
    } else {
        showMessage(errorText(res), false);
    }
    refreshStatus();
});

$('test').addEventListener('click', async () => {
    showMessage('Test en cours…', true);
    const res = await chrome.runtime.sendMessage({ type: 'CERTIMENS_WHOAMI' });
    if (res.ok) showMessage(`Connecté en tant que ${res.me.email} (${res.me.role}).`, true);
    else showMessage(errorText(res), false);
    refreshStatus();
});

async function refreshDebug() {
    const { debug, debugLog = [] } = await chrome.storage.local.get(['debug', 'debugLog']);
    $('debug').checked = !!debug;
    const lines = [...debugLog].reverse().map((entry) => {
        const counters = Object.entries(entry.values)
            .filter(([, value]) => value)
            .map(([type, value]) => `${value} ${COUNTER_LABELS[type] || type}`);
        const time = new Date(entry.at).toLocaleTimeString('fr-FR');
        return `${time} · ${entry.reason} · ${counters.join(', ') || 'aucun compteur'}`;
    });
    $('debugLog').replaceChildren(...(lines.length ? lines : ['Journal vide.'])
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
