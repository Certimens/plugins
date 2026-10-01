// Certimens — VS Code extension, interface languages (the counterpart of extension/i18n.js).
//
// Two languages and one rule, the engine's own: a tag
// starting with "en" gives English, everything else French. French is the default because the
// product is sold to French higher education — an unknown locale lands there rather than in a
// language the student's school does not use.
//
// Where the language comes from, in order: the Certimens account (the student sets it once in
// their space and it arrives with the login), then the editor's own display language, then
// French. The keys match extension/i18n.js wherever the string is the same one.
//
// What is declared in package.json — the extension's name, its commands, its settings — is
// translated by the editor instead, from package.nls.json (French, the fallback) and
// package.nls.en.json: those strings are read before any code of ours runs.

const DEFAULT_LANGUAGE = 'fr';

const MESSAGES = {
    fr: {
        'login.engineTitle': 'Certimens — moteur',
        'login.enginePrompt': 'Adresse de votre espace Certimens',
        'login.emailTitle': 'Certimens — identifiant',
        'login.emailPrompt': 'Adresse e-mail',
        'login.passwordTitle': 'Certimens — mot de passe',
        'login.passwordPrompt': 'Mot de passe (échangé contre un jeton, jamais conservé)',
        'login.done': 'Certimens : connecté en tant que {email}.',
        'login.intro': 'Connectez-vous à votre espace Certimens.',
        'login.email': 'E-mail',
        'login.password': 'Mot de passe',
        'login.engineUrl': 'Adresse du moteur',
        'login.submit': 'Se connecter',
        'account.connected': 'Connecté :',
        'account.logout': 'Se déconnecter',
        'account.logoutTip': 'Se déconnecter — le jeton d’accès est révoqué sur le moteur ; la mesure s’arrête jusqu’à la prochaine connexion.',
        'logout.done': 'Certimens : déconnecté, le jeton a été révoqué.',

        'error.credentials': 'Identifiants incorrects ou accès révoqué — reconnectez-vous.',
        'error.prefix': 'Certimens : {message}',
        'error.noEditor': 'ouvrez le fichier à rendre',
        'error.notMeasured': "ce fichier n'est pas mesuré (hors projet, ou exclu)",
        'error.noToken': 'aucun jeton : connectez-vous à Certimens',
        // Shared word for word with extension/i18n.js: the same refusal must read the same from
        // one agent to the next (tests/i18n.test.mjs holds the two dictionaries to it).
        'error.noFile': "créez d'abord son document Certimens",
        'error.tooLarge': 'document trop volumineux (18 Mo maximum)',
        'error.notEnrolled': "vous n'êtes pas rattaché à ce devoir",
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
        'panel.authRefused': 'Identifiants refusés — reconnectez-vous.',
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
        'submit.sent': 'Certimens : {name} envoyé.',
        'submit.sentNoAssignment': 'Certimens : {name} envoyé, sans devoir.',
        'notify.submitted': 'Certimens : {name} rendu pour « {assignment} ».',

        'token.vscode': 'Extension VS Code ({date})',
    },
    en: {
        'login.engineTitle': 'Certimens — engine',
        'login.enginePrompt': 'Address of your Certimens space',
        'login.emailTitle': 'Certimens — account',
        'login.emailPrompt': 'Email address',
        'login.passwordTitle': 'Certimens — password',
        'login.passwordPrompt': 'Password (exchanged for a token, never stored)',
        'login.done': 'Certimens: logged in as {email}.',
        'login.intro': 'Log in to your Certimens space.',
        'login.email': 'Email',
        'login.password': 'Password',
        'login.engineUrl': 'Engine address',
        'login.submit': 'Log in',
        'account.connected': 'Logged in:',
        'account.logout': 'Log out',
        'account.logoutTip': 'Log out — the access token is revoked on the engine; measurement stops until you log in again.',
        'logout.done': 'Certimens: logged out, the token has been revoked.',

        'error.credentials': 'Wrong credentials, or access revoked — log in again.',
        'error.prefix': 'Certimens: {message}',
        'error.noEditor': 'open the file you want to submit',
        'error.notMeasured': 'this file is not measured (outside the project, or excluded)',
        'error.noToken': 'no token: log in to Certimens',
        'error.noFile': 'create its Certimens document first',
        'error.tooLarge': 'document too large (18 MB maximum)',
        'error.notEnrolled': 'you are not enrolled in this assignment',
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
        'panel.authRefused': 'Credentials refused — log in again.',
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
        'submit.sent': 'Certimens: {name} sent.',
        'submit.sentNoAssignment': 'Certimens: {name} sent, with no assignment.',
        'notify.submitted': 'Certimens: {name} submitted for “{assignment}”.',

        'token.vscode': 'VS Code extension ({date})',
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
