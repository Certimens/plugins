// Certimens — VS Code extension, interface languages (the counterpart of browser/i18n.js).
//
// Two languages and one rule, the engine's own: a tag
// starting with "en" gives English, everything else French. French is the default because the
// product is sold to French higher education — an unknown locale lands there rather than in a
// language the student's school does not use.
//
// Where the language comes from, in order: the Certimens account (the student sets it once in
// their space and it arrives with the login), then the editor's own display language, then
// French. The keys match browser/i18n.js wherever the string is the same one.
//
// What is declared in package.json — the extension's name, its commands, its settings — is
// translated by the editor instead, from package.nls.json (French, the fallback) and
// package.nls.en.json: those strings are read before any code of ours runs.

const DEFAULT_LANGUAGE = 'fr';

const MESSAGES = {
    fr: {
        'pair.intro': 'Connectez votre agent à votre espace Certimens. Aucun mot de passe ne vous sera demandé ici.',
        'pair.submit': 'Se connecter',
        'pair.open': 'Ouvrir mon espace Certimens',
        'pair.waiting': "En attente de votre confirmation. Revenez ici une fois le code validé.",
        'pair.cancel': 'Annuler',
        'pair.expired': "Ce code a expiré. Reconnectez-vous pour en obtenir un nouveau.",
        'pair.denied': "Cette demande a été refusée depuis votre espace Certimens. Reconnectez-vous si c'était bien vous.",
        'notify.pairCode': 'Certimens : saisissez le code {code} dans votre espace pour autoriser cette extension.',
        'notify.pairConnected': 'Certimens : connecté en tant que {email}.',
        'pair.clientVscode': 'Extension VS Code',
        'login.advanced': 'Paramètres avancés',
        'login.engineUrl': 'Adresse du moteur',
        'login.engineUrlHelp': "À ne changer que si votre établissement héberge son propre moteur.",
        'account.connected': 'Connecté :',
        'account.logout': 'Se déconnecter',
        'account.logoutTip': 'Se déconnecter — le jeton d’accès est révoqué sur le moteur ; la mesure s’arrête jusqu’à la prochaine connexion.',
        'logout.done': 'Certimens : déconnecté, le jeton a été révoqué.',

        // Said once, after an update the Marketplace installed without saying so.
        'update.installed': 'Certimens a été mis à jour en version {version}.',
        'update.notes': 'Voir les nouveautés',

        'error.credentials': 'Accès refusé ou révoqué — reconnectez-vous.',
        'error.prefix': 'Certimens : {message}',
        'error.noEditor': 'ouvrez le fichier à rendre',
        'error.notMeasured': "ce fichier n'est pas mesuré (hors projet, ou exclu)",
        'error.noToken': 'aucun jeton : connectez-vous à Certimens',
        'error.engineUrlInsecure': "Adresse du moteur refusée : en http, votre jeton voyagerait en clair. Utilisez https, ou une adresse de réseau local.",
        // Shared word for word with browser/i18n.js: the same refusal must read the same from
        // one agent to the next (tests/i18n.test.mjs holds the two dictionaries to it).
        'error.noFile': "créez d'abord son document Certimens",
        'error.tooLarge': 'document trop volumineux (18 Mo maximum)',
        'error.notEnrolled': "vous n'êtes pas rattaché à ce devoir",
        'error.deadlinePassed': "l'échéance de ce devoir est passée — demandez à l'enseignant de la repousser",
        'error.networkError': 'erreur réseau',
        'error.engineUnreachable': 'Moteur injoignable ({message}).',

        // bar.* is the status bar and notify.* the toasts: both say what the popup and the
        // task pane say, but with the editor's icons and the product's name in front, so they
        // are their own strings rather than a reuse of the shared ones.
        'bar.paused': '$(debug-pause) Certimens : mesure suspendue',
        'bar.pausedTip': 'La mesure est suspendue. Ouvrez le panneau Certimens pour la reprendre.',
        'bar.offline': '$(shield) Certimens : hors ligne',
        'bar.offlineTip': 'Connectez-vous pour mesurer votre rédaction.',
        'bar.queued': '$(sync) Certimens : {count} en attente',
        'bar.queuedTip': 'Mesures en attente d’envoi.',
        'bar.measuring': '$(shield) Certimens : {count} fichier',
        'bar.measuringPlural': '$(shield) Certimens : {count} fichiers',
        'bar.measuringTip': 'Mesure active. Cliquez pour ouvrir le panneau Certimens.',

        'panel.notConnected': 'Non connecté.',
        'panel.authRefused': 'Accès refusé — reconnectez-vous.',
        'panel.queued': '{count} mesure en attente d’envoi.',
        'panel.queuedPlural': '{count} mesures en attente d’envoi.',
        'panel.synced': 'Mesures synchronisées.',
        'panel.pausedQueued': '{count} mesure d’avant la pause encore à envoyer.',
        'panel.pausedQueuedPlural': '{count} mesures d’avant la pause encore à envoyer.',
        'panel.openFile': 'Fichier ouvert',
        'panel.linked': 'Document Certimens associé : les mesures y sont envoyées.',
        'panel.unlinked': 'Aucun document Certimens : il sera créé dès que vous écrirez.',
        'panel.submit': 'Rendre ce fichier…',
        'panel.noFile': 'Ouvrez un fichier de votre projet : chaque fichier est mesuré séparément.',
        'panel.measured': 'Mesuré dans cette session',
        'panel.measuredNone': 'Aucun pour l’instant.',
        'panel.pausedAlert': 'Mesure suspendue : rien n’est mesuré tant que vous ne la reprenez pas.',

        'pause.suspend': 'Suspendre la mesure',
        'pause.suspendTip': 'Suspendre la mesure — plus rien n’est compté jusqu’à ce que vous la repreniez, même après un redémarrage.',
        'pause.resumeTip': 'Reprendre la mesure — les fenêtres de mesure repartent aussitôt.',
        'pause.resume': 'Reprendre la mesure',
        'notify.paused': 'Certimens : mesure suspendue. Rien n’est mesuré tant que vous ne la reprenez pas.',
        'notify.resumed': 'Certimens : mesure reprise.',

        'submit.assignmentTitle': 'Certimens — rattacher à un devoir',
        // The same lines as the picker in the other three agents: the editor puts the title
        // inside the label rather than beside it, so the whole label comes from the dictionary.
        'assignment.due': '{title} (avant le {date})',
        'assignment.overdue': '{title} — échéance passée le {date}, rendu impossible',
        'submit.sent': 'Certimens : {name} envoyé.',
        'submit.sentNoAssignment': 'Certimens : {name} envoyé, sans devoir.',
        'notify.submitted': 'Certimens : {name} rendu pour « {assignment} ».',
    },
    en: {
        'pair.intro': 'Connect your agent to your Certimens space. No password is ever asked for here.',
        'pair.submit': 'Log in',
        'pair.open': 'Open my Certimens space',
        'pair.waiting': 'Waiting for your confirmation. Come back here once the code is approved.',
        'pair.cancel': 'Cancel',
        'pair.expired': 'This code expired. Log in again to get a new one.',
        'pair.denied': 'This request was refused from your Certimens space. Log in again if it really was you.',
        'notify.pairCode': 'Certimens: type the code {code} into your space to authorize this extension.',
        'notify.pairConnected': 'Certimens: signed in as {email}.',
        'pair.clientVscode': 'VS Code extension',
        'login.advanced': 'Advanced settings',
        'login.engineUrl': 'Engine address',
        'login.engineUrlHelp': 'Only change this if your institution hosts its own engine.',
        'account.connected': 'Logged in:',
        'account.logout': 'Log out',
        'account.logoutTip': 'Log out — the access token is revoked on the engine; measurement stops until you log in again.',
        'logout.done': 'Certimens: logged out, the token has been revoked.',

        'update.installed': 'Certimens has been updated to version {version}.',
        'update.notes': "See what's new",

        'error.credentials': 'Access refused or revoked — log in again.',
        'error.prefix': 'Certimens: {message}',
        'error.noEditor': 'open the file you want to submit',
        'error.notMeasured': 'this file is not measured (outside the project, or excluded)',
        'error.noToken': 'no token: log in to Certimens',
        'error.engineUrlInsecure': 'Engine address refused: over http your token would travel in the clear. Use https, or a local network address.',
        'error.noFile': 'create its Certimens document first',
        'error.tooLarge': 'document too large (18 MB maximum)',
        'error.notEnrolled': 'you are not enrolled in this assignment',
        'error.deadlinePassed': 'this assignment’s deadline has passed — ask your teacher to push it',
        'error.networkError': 'network error',
        'error.engineUnreachable': 'Engine unreachable ({message}).',

        'bar.paused': '$(debug-pause) Certimens: measurement paused',
        'bar.pausedTip': 'Measurement is paused. Open the Certimens panel to resume it.',
        'bar.offline': '$(shield) Certimens: offline',
        'bar.offlineTip': 'Log in to have your writing measured.',
        'bar.queued': '$(sync) Certimens: {count} waiting',
        'bar.queuedTip': 'Measurements waiting to be sent.',
        'bar.measuring': '$(shield) Certimens: {count} file',
        'bar.measuringPlural': '$(shield) Certimens: {count} files',
        'bar.measuringTip': 'Measuring. Click to open the Certimens panel.',

        'panel.notConnected': 'Not logged in.',
        'panel.authRefused': 'Access refused — log in again.',
        'panel.queued': '{count} measurement waiting to be sent.',
        'panel.queuedPlural': '{count} measurements waiting to be sent.',
        'panel.synced': 'Measurements synchronised.',
        'panel.pausedQueued': '{count} measurement from before the pause still to send.',
        'panel.pausedQueuedPlural': '{count} measurements from before the pause still to send.',
        'panel.openFile': 'Open file',
        'panel.linked': 'Linked to a Certimens document: measurements are sent to it.',
        'panel.unlinked': 'No Certimens document: one is created as soon as you write.',
        'panel.submit': 'Submit this file…',
        'panel.noFile': 'Open a file of your project: each file is measured separately.',
        'panel.measured': 'Measured in this session',
        'panel.measuredNone': 'None so far.',
        'panel.pausedAlert': 'Measurement paused: nothing is measured until you resume it.',

        'pause.suspend': 'Pause measurement',
        'pause.suspendTip': 'Pause measurement — nothing is counted until you resume it, even after a restart.',
        'pause.resumeTip': 'Resume measurement — measurement windows start again straight away.',
        'pause.resume': 'Resume measurement',
        'notify.paused': 'Certimens: measurement paused. Nothing is measured until you resume it.',
        'notify.resumed': 'Certimens: measurement resumed.',

        'submit.assignmentTitle': 'Certimens — attach to an assignment',
        'assignment.due': '{title} (due {date})',
        'assignment.overdue': '{title} — deadline passed on {date}, cannot submit',
        'submit.sent': 'Certimens: {name} sent.',
        'submit.sentNoAssignment': 'Certimens: {name} sent, with no assignment.',
        'notify.submitted': 'Certimens: {name} submitted for “{assignment}”.',
    },
};

let language = DEFAULT_LANGUAGE;

function normalizeLanguage(tag) {
    return String(tag || '').toLowerCase().startsWith('en') ? 'en' : DEFAULT_LANGUAGE;
}

function setLanguage(account, host) {
    language = normalizeLanguage(account || host || DEFAULT_LANGUAGE);
    return language;
}

function currentLanguage() {
    return language;
}

function dateLocale() {
    return language === 'en' ? 'en-GB' : 'fr-FR';
}

// t('notify.submitted', { name, assignment }) — placeholders are {name}. An unknown key returns
// itself rather than an empty string: a missing translation must be visible, not silent.
function t(key, vars) {
    const text = MESSAGES[language][key] || MESSAGES[DEFAULT_LANGUAGE][key] || key;
    if (!vars) return text;
    return text.replace(/\{(\w+)\}/g, (match, name) => (name in vars ? String(vars[name]) : match));
}

// French and English agree on where the plural starts, which is the only reason one helper can
// serve both: a count of 0 or 1 takes the singular key, anything else the "…Plural" one.
function plural(key, count, vars) {
    return t(count > 1 ? `${key}Plural` : key, { count, ...vars });
}

module.exports = { t, plural, setLanguage, currentLanguage, normalizeLanguage, dateLocale, MESSAGES };
