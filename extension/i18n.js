// Certimens — interface languages, shared by the browser extension and the Word add-in (which
// loads this file from the extension, like ui.css and ui.js).
//
// Two languages, one rule, the engine's own: a tag that
// starts with "en" gives English, everything else gives French. French is the default because
// the product is sold to French higher education — an unknown locale lands there rather than in
// a language the student's school does not use.
//
// Where the language comes from, in order:
//   1. the Certimens account, whose language the student sets once in their space (it arrives
//      with the login response and is kept in the config);
//   2. the host's interface language (the browser, Word, LibreOffice, the editor);
//   3. French.
// The account wins because it is the one the student chose deliberately, and because it is the
// language their Certimens space and their e-mails are already in.

const DEFAULT_LANGUAGE = 'fr';

// One key per string, named after what it says rather than where it appears: the same message is
// shown in the popup, in the Word task pane and in the options page.
const MESSAGES = {
    fr: {
        'login.intro': 'Connectez-vous à votre espace Certimens.',
        'login.email': 'E-mail',
        'login.password': 'Mot de passe',
        'login.engineUrl': 'Adresse du moteur',
        'login.submit': 'Se connecter',
        'login.connecting': 'Connexion…',
        'login.loggedInAs': 'Connecté en tant que {email}.',
        'login.reconnectToChange': 'Connecté : {email}. Reconnectez-vous pour changer de compte.',
        'account.connected': 'Connecté :',
        'account.logout': 'Se déconnecter',
        'account.logoutTip': 'Se déconnecter — le jeton d’accès est révoqué sur le moteur ; la mesure s’arrête jusqu’à la prochaine connexion.',

        'error.credentials': 'Identifiants incorrects ou accès révoqué — reconnectez-vous.',
        'error.engineUnreachable': 'Moteur injoignable ({message}).',
        'error.networkError': 'erreur réseau',
        'error.permissionDenied': "Permission refusée pour l'adresse du moteur.",
        'error.engineUrlInvalid': 'Adresse du moteur invalide.',
        'error.permissionFailed': 'Permission impossible : {message}',
        'error.authRefused': 'Identifiants refusés : reconnectez-vous.',

        'doc.open': 'Document ouvert',
        'doc.linked': 'Document Certimens associé : les mesures y sont envoyées.',
        'doc.submittedTo': 'Rendu sur : {title}',
        'doc.submittedGeneric': 'Rendu sur un devoir',
        'doc.openInCertimens': 'Ouvrir dans Certimens',
        'doc.name': 'Nom du document',
        'doc.create': 'Créer le document',
        'doc.submit': 'Rendre sur ce devoir',
        'doc.changeAssignment': 'Changer de devoir',
        'doc.none': 'Ouvrez un document Google Docs ou Word Online pour créer son document Certimens.',
        'doc.alreadyUploaded': 'Un document est déjà envoyé : un nouvel envoi le remplace.',
        'doc.wordSaveHint': 'Dans Word : Fichier › Enregistrer sous › Télécharger une copie, puis choisissez ce fichier.',

        'assignment.label': 'Devoir',
        'assignment.choose': '— Choisir un devoir —',
        'assignment.none': "— Aucun devoir pour l'instant —",
        'assignment.due': '{title} (avant le {date})',
        'assignment.overdue': '{title} (échu le {date})',

        'submit.refused': 'Rendu impossible : {message}.',
        'submit.done': 'Document rendu.',
        'create.existed': 'Ce document était déjà enregistré.',
        'create.created': 'Document créé.',
        'create.createdAndSubmitted': 'Document créé et rendu.',

        'upload.sendDocx': 'Envoyer le .docx',
        'upload.pickDocx': 'Envoyer un .docx…',
        'upload.sending': 'Envoi du document…',
        'upload.done': 'Document envoyé.',
        'upload.failed': 'Envoi impossible : {message}.',
        'upload.notDocx': "Ce fichier n'est pas un document .docx.",
        'upload.exportDenied': "Autorisation refusée : l'extension ne peut pas lire l'export Google Docs.",

        'pause.suspend': 'Suspendre la mesure',
        'pause.suspendTip': 'Suspendre la mesure — plus rien n’est compté jusqu’à ce que vous la repreniez, même après un redémarrage.',
        'pause.resumeTip': 'Reprendre la mesure — les fenêtres de mesure repartent aussitôt.',
        'pause.resume': 'Reprendre la mesure',
        'pause.alert': "Mesure suspendue : rien n'est mesuré tant que vous ne la reprenez pas.",
        'pause.paused': 'Mesure suspendue. Elle le reste jusqu’à ce que vous la repreniez, même après un redémarrage.',
        'pause.resumed': 'Mesure reprise.',
        'pause.status': "⏸ Mesure suspendue : rien n'est mesuré. Reprenez-la depuis la fenêtre de l'extension.",
        'pause.queued': '{count} mesure(s) d’avant la pause encore à envoyer.',

        'options.intro': "Agent de rédaction pour Google Docs et Word Online. Il mesure votre rédaction (rythme, pauses, corrections, collages) et l'envoie à votre espace Certimens. Aucun texte ni aucune touche n'est enregistré : uniquement des compteurs.",
        'options.test': 'Tester la connexion',
        'options.testing': 'Test en cours…',
        'options.testedAs': 'Connecté en tant que {email} ({role}).',
        'options.sync': 'Synchronisation',
        'options.loading': "Chargement de l'état…",
        'options.debug': 'Mode debug',
        'options.debugLabel': 'Journaliser les mesures',
        'options.debugHelp': "Chaque fenêtre de mesure envoyée au moteur est notée ci-dessous, et le détail (suppression comptée en correction, en reformulation ou en révision massive) s'affiche dans la console du document. Des compteurs uniquement : ni texte ni touches.",
        'options.clearLog': 'Vider le journal',
        'options.emptyLog': 'Journal vide.',
        'options.tokenNote': "Le mot de passe n'est pas conservé : la connexion crée un jeton d'accès, gardé dans le stockage local de l'extension sur cet ordinateur uniquement. Il est révoqué à la déconnexion et reste révocable depuis votre espace Certimens.",
        'options.link': 'Paramètres et état de synchronisation',

        'status.idle': 'En attente de mesures',
        'status.synced': '🟢 Synchronisé',
        'status.offline': '🟠 Moteur injoignable — les mesures sont conservées et renvoyées chaque minute',
        'status.auth_error': '🔴 Identifiants refusés',
        'status.unconfigured': '🔴 Agent non configuré',
        'status.state': 'État : {state}',
        'status.detail': 'Détail : {message}',
        'status.queued': "Mesures en attente d'envoi : {count}",
        'status.documents': 'Documents suivis : {count}',
        'status.extendedDropped': 'Mesures étendues (collages, sorties, cadence) refusées par le moteur : elles ne sont plus envoyées. Reconnectez-vous pour réessayer.',
        'status.lastAttempt': 'Dernière tentative : {at}',

        'sync.synced': 'Mesures à jour.',
        'sync.offline': 'Moteur injoignable : {count} mesure(s) en attente, renvoi automatique.',
        'sync.auth_error': 'Identifiants refusés par le moteur.',
        'sync.unconfigured': "Non connecté : les mesures sont gardées jusqu'à la connexion.",
        'sync.queued': '{count} mesure(s) en attente.',

        'word.webNote': "Sur Word pour le web, l'extension navigateur Certimens mesure déjà la rédaction : n'utilisez que l'un des deux, sinon l'activité est comptée deux fois.",
        'word.measureUnavailable': 'Mesure indisponible dans cette version de Word.',

        'token.browser': 'Agent navigateur ({date})',
        'token.word': 'Complément Word ({date})',

        'counter.total_keystrokes': 'frappes',
        'counter.immediate_corrections': 'corrections immédiates',
        'counter.deferred_reformulations': 'reformulations différées',
        'counter.macro_revisions': 'révisions massives',
        'counter.navigation_jumps': 'sauts de navigation',
        'counter.cognitive_pauses': 'pauses',
        'counter.paste_events': 'collages',
        'counter.focus_losses': 'sorties du document',
        'counter.total_injected_chars': 'caractères injectés',
        'counter.effective_time_seconds': 's effectives',
        'counter.real_volume': 'caractères dans le document',
        'counter.median_flight_ms': 'ms entre frappes (médiane)',
        'counter.mad_ms': "ms d'écart médian",
        'counter.none': 'aucun compteur',
    },
    en: {
        'login.intro': 'Log in to your Certimens space.',
        'login.email': 'Email',
        'login.password': 'Password',
        'login.engineUrl': 'Engine address',
        'login.submit': 'Log in',
        'login.connecting': 'Logging in…',
        'login.loggedInAs': 'Logged in as {email}.',
        'login.reconnectToChange': 'Logged in: {email}. Log in again to switch account.',
        'account.connected': 'Logged in:',
        'account.logout': 'Log out',
        'account.logoutTip': 'Log out — the access token is revoked on the engine; measurement stops until you log in again.',

        'error.credentials': 'Wrong credentials, or access revoked — log in again.',
        'error.engineUnreachable': 'Engine unreachable ({message}).',
        'error.networkError': 'network error',
        'error.permissionDenied': 'Permission refused for the engine address.',
        'error.engineUrlInvalid': 'Invalid engine address.',
        'error.permissionFailed': 'Permission failed: {message}',
        'error.authRefused': 'Credentials refused: log in again.',

        'doc.open': 'Open document',
        'doc.linked': 'Linked to a Certimens document: measurements are sent to it.',
        'doc.submittedTo': 'Submitted to: {title}',
        'doc.submittedGeneric': 'Submitted to an assignment',
        'doc.openInCertimens': 'Open in Certimens',
        'doc.name': 'Document name',
        'doc.create': 'Create the document',
        'doc.submit': 'Submit to this assignment',
        'doc.changeAssignment': 'Change assignment',
        'doc.none': 'Open a Google Docs or Word Online document to create its Certimens document.',
        'doc.alreadyUploaded': 'A document has already been sent: sending another replaces it.',
        'doc.wordSaveHint': 'In Word: File › Save As › Download a copy, then pick that file.',

        'assignment.label': 'Assignment',
        'assignment.choose': '— Choose an assignment —',
        'assignment.none': '— No assignment yet —',
        'assignment.due': '{title} (due {date})',
        'assignment.overdue': '{title} (overdue since {date})',

        'submit.refused': 'Submission refused: {message}.',
        'submit.done': 'Document submitted.',
        'create.existed': 'This document was already registered.',
        'create.created': 'Document created.',
        'create.createdAndSubmitted': 'Document created and submitted.',

        'upload.sendDocx': 'Send the .docx',
        'upload.pickDocx': 'Send a .docx…',
        'upload.sending': 'Sending the document…',
        'upload.done': 'Document sent.',
        'upload.failed': 'Upload failed: {message}.',
        'upload.notDocx': 'This file is not a .docx document.',
        'upload.exportDenied': 'Permission refused: the extension cannot read the Google Docs export.',

        'pause.suspend': 'Pause measurement',
        'pause.suspendTip': 'Pause measurement — nothing is counted until you resume it, even after a restart.',
        'pause.resumeTip': 'Resume measurement — measurement windows start again straight away.',
        'pause.resume': 'Resume measurement',
        'pause.alert': 'Measurement paused: nothing is measured until you resume it.',
        'pause.paused': 'Measurement paused. It stays paused until you resume it, even after a restart.',
        'pause.resumed': 'Measurement resumed.',
        'pause.status': '⏸ Measurement paused: nothing is measured. Resume it from the extension window.',
        'pause.queued': '{count} measurement(s) from before the pause still to send.',

        'options.intro': 'Writing agent for Google Docs and Word Online. It measures how you write (rhythm, pauses, corrections, pastes) and sends that to your Certimens space. No text and no keystroke is ever recorded: counters only.',
        'options.test': 'Test the connection',
        'options.testing': 'Testing…',
        'options.testedAs': 'Logged in as {email} ({role}).',
        'options.sync': 'Synchronisation',
        'options.loading': 'Loading status…',
        'options.debug': 'Debug mode',
        'options.debugLabel': 'Log measurements',
        'options.debugHelp': 'Every measurement window sent to the engine is listed below, and the detail (a deletion counted as a correction, a reformulation or a mass revision) appears in the document console. Counters only: no text, no keystrokes.',
        'options.clearLog': 'Clear the log',
        'options.emptyLog': 'Empty log.',
        'options.tokenNote': 'Your password is not kept: logging in creates an access token, stored locally by the extension on this computer only. It is revoked when you log out, and stays revocable from your Certimens space.',
        'options.link': 'Settings and synchronisation status',

        'status.idle': 'Waiting for measurements',
        'status.synced': '🟢 Synchronised',
        'status.offline': '🟠 Engine unreachable — measurements are kept and resent every minute',
        'status.auth_error': '🔴 Credentials refused',
        'status.unconfigured': '🔴 Agent not configured',
        'status.state': 'Status: {state}',
        'status.detail': 'Detail: {message}',
        'status.queued': 'Measurements waiting to be sent: {count}',
        'status.documents': 'Documents tracked: {count}',
        'status.extendedDropped': 'Extended measurements (pastes, document exits, rhythm) refused by the engine: they are no longer sent. Log in again to retry.',
        'status.lastAttempt': 'Last attempt: {at}',

        'sync.synced': 'Measurements up to date.',
        'sync.offline': 'Engine unreachable: {count} measurement(s) waiting, resent automatically.',
        'sync.auth_error': 'Credentials refused by the engine.',
        'sync.unconfigured': 'Not logged in: measurements are kept until you do.',
        'sync.queued': '{count} measurement(s) waiting.',

        'word.webNote': 'On Word for the web, the Certimens browser extension already measures your writing: use only one of the two, or the activity is counted twice.',
        'word.measureUnavailable': 'Measurement is unavailable in this version of Word.',

        'token.browser': 'Browser agent ({date})',
        'token.word': 'Word add-in ({date})',

        'counter.total_keystrokes': 'keystrokes',
        'counter.immediate_corrections': 'immediate corrections',
        'counter.deferred_reformulations': 'deferred reformulations',
        'counter.macro_revisions': 'mass revisions',
        'counter.navigation_jumps': 'navigation jumps',
        'counter.cognitive_pauses': 'pauses',
        'counter.paste_events': 'pastes',
        'counter.focus_losses': 'document exits',
        'counter.total_injected_chars': 'injected characters',
        'counter.effective_time_seconds': 'effective s',
        'counter.real_volume': 'characters in the document',
        'counter.median_flight_ms': 'ms between keystrokes (median)',
        'counter.mad_ms': 'ms median deviation',
        'counter.none': 'no counter',
    },
};

let language = DEFAULT_LANGUAGE;

// The engine's rule, reimplemented rather than asked for: the agents must pick a language before
// they have ever reached the engine.
function normalizeLanguage(tag) {
    return String(tag || '').toLowerCase().startsWith('en') ? 'en' : DEFAULT_LANGUAGE;
}

// account: the language of the Certimens account, empty until the student logs in.
// host: what the browser, Word or the editor announces.
function setLanguage(account, host) {
    language = normalizeLanguage(account || host || DEFAULT_LANGUAGE);
    return language;
}

function currentLanguage() {
    return language;
}

// The locale dates are formatted in. Kept here so a date never comes out French in an English
// interface, which is the sort of detail that makes a translation look unfinished.
function dateLocale() {
    return language === 'en' ? 'en-GB' : 'fr-FR';
}

// t('doc.submittedTo', { title }) — placeholders are {name}. An unknown key returns itself
// rather than an empty string: a missing translation must be visible, not silent.
function t(key, vars) {
    const text = MESSAGES[language][key] || MESSAGES[DEFAULT_LANGUAGE][key] || key;
    if (!vars) return text;
    return text.replace(/\{(\w+)\}/g, (match, name) => (name in vars ? String(vars[name]) : match));
}

// Translates the static markup: data-i18n="key" fills the text, and
// data-i18n-attr="placeholder:key" an attribute. The pages ship in no language of their own —
// everything a student reads comes from the dictionary above.
function applyTranslations(root) {
    const scope = root || document;
    for (const el of scope.querySelectorAll('[data-i18n]')) el.textContent = t(el.dataset.i18n);
    for (const el of scope.querySelectorAll('[data-i18n-attr]')) {
        for (const pair of el.dataset.i18nAttr.split(',')) {
            const [attr, key] = pair.split(':');
            el.setAttribute(attr.trim(), t(key.trim()));
        }
    }
}

// The Word add-in and the extension load this as a classic script; nothing else consumes it.
