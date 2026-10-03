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
        'pair.intro': 'Connectez votre agent à votre espace Certimens. Aucun mot de passe ne vous sera demandé ici.',
        'pair.submit': 'Se connecter',
        'pair.asking': 'Connexion…',
        'pair.showCode': 'Saisissez ce code dans votre espace Certimens.',
        'pair.open': 'Ouvrir mon espace Certimens',
        'pair.waiting': "En attente de votre confirmation. Revenez ici une fois le code validé.",
        'pair.cancel': 'Annuler',
        'pair.connectedAs': 'Connecté en tant que {email}.',
        'pair.reconnectToChange': 'Connecté : {email}. Reconnectez-vous pour changer de compte.',
        'pair.clientBrowser': 'Extension navigateur',
        'pair.clientWord': 'Complément Word',
        'pair.expired': "Ce code a expiré. Reconnectez-vous pour en obtenir un nouveau.",
        'pair.denied': "Cette demande a été refusée depuis votre espace Certimens. Reconnectez-vous si c'était bien vous.",
        'login.advanced': 'Paramètres avancés',
        'login.engineUrl': 'Adresse du moteur',
        'login.engineUrlHelp': "À ne changer que si votre établissement héberge son propre moteur.",
        'account.connected': 'Connecté :',
        'account.logout': 'Se déconnecter',
        'account.logoutTip': 'Se déconnecter — le jeton d’accès est révoqué sur le moteur ; la mesure s’arrête jusqu’à la prochaine connexion.',
        'account.loggedOut': 'Déconnecté. Le jeton d’accès a été révoqué.',

        // Said once, after an update the host installed without asking and without saying so.
        'update.installed': 'Certimens a été mis à jour en version {version}.',
        'update.notes': 'Voir les nouveautés',

        'error.credentials': 'Accès refusé ou révoqué — reconnectez-vous.',
        'error.engineUnreachable': 'Moteur injoignable ({message}).',
        'error.networkError': 'erreur réseau',
        'error.permissionDenied': "Permission refusée pour l'adresse du moteur.",
        'error.engineUrlInvalid': 'Adresse du moteur invalide.',
        'error.engineUrlInsecure': "Adresse du moteur refusée : en http, votre jeton voyagerait en clair. Utilisez https, ou une adresse de réseau local.",
        'error.permissionFailed': 'Permission impossible : {message}',
        'error.authRefused': 'Accès refusé : reconnectez-vous.',
        // Refusals the agent itself words, rather than passing on a raw engine message: they are
        // shown to the student through upload.failed / submit.refused, so they read as fragments.
        'error.noFile': "créez d'abord son document Certimens",
        'error.tooLarge': 'document trop volumineux (18 Mo maximum)',
        'error.notEnrolled': "vous n'êtes pas rattaché à ce devoir",
        'error.deadlinePassed': "l'échéance de ce devoir est passée — demandez à l'enseignant de la repousser",
        'error.docRead': 'lecture du document impossible ({message})',
        'error.pickDocx': 'choisissez le fichier .docx téléchargé depuis Word',
        'error.exportPermission': "autorisez l'extension à lire les exports Google Docs (bouton « Envoyer le .docx »)",
        'error.exportBlocked': 'export Google Docs bloqué ({message})',
        'error.exportRefused': 'export Google Docs refusé ({status})',
        'error.exportExpired': 'export Google Docs refusé (session Google expirée ?)',
        'error.invalidGoogleDoc': 'document Google Docs invalide',

        'doc.open': 'Document ouvert',
        'doc.linked': 'Document Certimens associé : les mesures y sont envoyées.',
        'doc.submittedTo': 'Rendu sur : {title}',
        'doc.submittedGeneric': 'Rendu sur un devoir',
        'doc.openInCertimens': 'Ouvrir dans Certimens',
        'doc.name': 'Nom du document',
        'doc.create': 'Créer le document',
        'doc.submit': 'Rendre sur ce devoir',
        'doc.changeAssignment': 'Changer de devoir',
        'doc.none': "Ouvrez un document Google Docs, Word Online ou Overleaf pour créer son document Certimens. Si vous rédigez sur cette page, dites-le : la mesure commencera ici.",
        'doc.alreadyUploaded': 'Un document est déjà envoyé : un nouvel envoi le remplace.',
        'doc.deadlinePassed': 'Échéance passée : la copie rendue ne change plus. La mesure, elle, continue — et tout rouvre si l’enseignant repousse l’échéance.',
        'doc.wordSaveHint': 'Dans Word : Fichier › Enregistrer sous › Télécharger une copie, puis choisissez ce fichier.',

        'assignment.label': 'Devoir',
        'assignment.choose': '— Choisir un devoir —',
        'assignment.none': "— Aucun devoir pour l'instant —",
        'assignment.due': '{title} (avant le {date})',
        'assignment.overdue': '{title} — échéance passée le {date}, rendu impossible',

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
        'doc.textHint': 'Le texte que vous avez écrit dans la page sera envoyé, et rien d’autre.',
        'doc.platform': '{platform} reconnu.',
        'upload.sendText': 'Envoyer le texte de cette page',
        'upload.noText': 'Rien à envoyer : aucune zone de rédaction trouvée sur cette page.',
        'sites.measureHere': 'Mesurer cette page',
        'sites.measureHereTip': 'Mesurer ce que vous écrivez sur {host}. Le navigateur vous demandera l’autorisation pour cette seule adresse, et vous pourrez la retirer dans les réglages.',
        'sites.title': 'Autres sites où vous écrivez',
        'sites.help': "L'extension mesure Google Docs, Word Online et Overleaf d'elle-même. Si vous rédigez ailleurs — le Moodle de votre établissement, un Canvas, un wiki —, le plus simple est d'ouvrir la page et de cliquer sur « Mesurer cette page » dans la fenêtre de l'extension. Vous pouvez aussi ajouter l'adresse ici. Les sites ajoutés sont listés ci-dessous, et se retirent d'un clic. Rien d'autre n'est lu sur ces sites : ni vos mots de passe, ni les pages que vous visitez, seulement la façon dont vous écrivez dans la zone de texte.",
        'sites.label': 'Adresse de la page où vous écrivez',
        'sites.add': 'Ajouter ce site',
        'sites.remove': 'Retirer',
        'sites.removeTip': 'Ne plus mesurer ce site, et rendre l’autorisation au navigateur',
        'sites.empty': 'Aucun site ajouté.',
        'sites.added': '{host} est mesuré. Rouvrez la page pour commencer.',
        'sites.removed': '{host} n’est plus mesuré.',
        'sites.invalid': 'Adresse invalide : collez l’adresse complète de la page où vous écrivez (https://…).',
        'sites.denied': 'Sans cette autorisation, ce site ne peut pas être mesuré.',
        'sites.unsupported': 'Ce navigateur ne sait pas ajouter de site : il mesure Google Docs, Word Online et Overleaf.',
        'sites.proposedTitle': 'Proposés par votre établissement',
        'sites.proposedHelp': 'Votre établissement indique les adresses où ses étudiants rédigent. Rien n’est mesuré tant que vous n’avez pas accepté : votre navigateur vous demandera l’autorisation, adresse par adresse, et vous pourrez la retirer ensuite.',
        'sites.proposedAdd': 'Mesurer ce site',
        'sites.proposedAddTip': 'Mesurer ce que vous écrivez sur {host}. Le navigateur vous demandera l’autorisation pour cette seule adresse.',
        'options.tokenNote': "Aucun mot de passe n'est demandé : le code que vous confirmez dans votre espace Certimens donne à l'extension un jeton d'accès, gardé dans son stockage local sur cet ordinateur uniquement. Il est révoqué à la déconnexion et reste révocable depuis votre espace Certimens.",
        'options.link': 'Paramètres et état de synchronisation',

        'status.idle': 'En attente de mesures',
        'status.synced': '🔵 Synchronisé',
        'status.offline': '🟠 Moteur injoignable — les mesures sont conservées et renvoyées chaque minute',
        'status.auth_error': '🔴 Accès refusé',
        'status.unconfigured': '🔴 Agent non configuré',
        'status.state': 'État : {state}',
        'status.detail': 'Détail : {message}',
        'status.queued': "Mesures en attente d'envoi : {count}",
        'status.documents': 'Documents suivis : {count}',
        'status.extendedDropped': 'Certaines mesures ne sont pas reconnues par ce moteur : elles ne sont plus envoyées, les autres continuent. Reconnectez-vous pour réessayer.',
        'status.lastAttempt': 'Dernière tentative : {at}',

        'sync.synced': 'Mesures à jour.',
        'sync.offline': 'Moteur injoignable : {count} mesure(s) en attente, renvoi automatique.',
        'sync.auth_error': 'Accès refusé par le moteur.',
        'sync.unconfigured': "Non connecté : les mesures sont gardées jusqu'à la connexion.",
        'sync.queued': '{count} mesure(s) en attente.',

        'word.webNote': "Sur Word pour le web, l'extension navigateur Certimens mesure déjà la rédaction : n'utilisez que l'un des deux, sinon l'activité est comptée deux fois.",
        'word.measureUnavailable': 'Mesure indisponible dans cette version de Word.',

        'counter.keystrokes_total': 'frappes',
        'counter.immediate_corrections': 'corrections immédiates',
        'counter.deferred_reformulations': 'reformulations différées',
        'counter.macro_revisions': 'révisions massives',
        'counter.navigation_jumps': 'sauts de navigation',
        'counter.cognitive_pauses': 'pauses',
        'counter.paste_events': 'collages',
        'counter.self_paste_events': 'restitutions de son texte',
        'counter.focus_losses': 'sorties du document',
        'counter.injected_chars_total': 'caractères injectés',
        'counter.injected_chars_max': 'caractères dans le plus gros collage',
        'counter.injected_chars_after_return': 'caractères collés après un retour',
        'counter.effective_time_ms': 'ms de frappe effective',
        'counter.real_volume_chars': 'caractères dans le document',
        'counter.flight_median_ms': 'ms entre frappes (médiane)',
        'counter.flight_mad_ms': "ms d'écart médian",
        'counter.none': 'aucun compteur',
    },
    en: {
        'pair.intro': 'Connect your agent to your Certimens space. No password is ever asked for here.',
        'pair.submit': 'Log in',
        'pair.asking': 'Connecting…',
        'pair.showCode': 'Type this code into your Certimens space.',
        'pair.open': 'Open my Certimens space',
        'pair.waiting': 'Waiting for your confirmation. Come back here once the code is approved.',
        'pair.cancel': 'Cancel',
        'pair.connectedAs': 'Signed in as {email}.',
        'pair.reconnectToChange': 'Signed in: {email}. Log in again to change account.',
        'pair.clientBrowser': 'Browser extension',
        'pair.clientWord': 'Word add-in',
        'pair.expired': 'This code expired. Log in again to get a new one.',
        'pair.denied': 'This request was refused from your Certimens space. Log in again if it really was you.',
        'login.advanced': 'Advanced settings',
        'login.engineUrl': 'Engine address',
        'login.engineUrlHelp': 'Only change this if your institution hosts its own engine.',
        'account.connected': 'Logged in:',
        'account.logout': 'Log out',
        'account.logoutTip': 'Log out — the access token is revoked on the engine; measurement stops until you log in again.',
        'account.loggedOut': 'Logged out. The access token has been revoked.',

        'update.installed': 'Certimens has been updated to version {version}.',
        'update.notes': "See what's new",

        'error.credentials': 'Access refused or revoked — log in again.',
        'error.engineUnreachable': 'Engine unreachable ({message}).',
        'error.networkError': 'network error',
        'error.permissionDenied': 'Permission refused for the engine address.',
        'error.engineUrlInvalid': 'Invalid engine address.',
        'error.engineUrlInsecure': 'Engine address refused: over http your token would travel in the clear. Use https, or a local network address.',
        'error.permissionFailed': 'Permission failed: {message}',
        'error.authRefused': 'Access refused: log in again.',
        'error.noFile': 'create its Certimens document first',
        'error.tooLarge': 'document too large (18 MB maximum)',
        'error.notEnrolled': 'you are not enrolled in this assignment',
        'error.deadlinePassed': 'this assignment’s deadline has passed — ask your teacher to push it',
        'error.docRead': 'cannot read the document ({message})',
        'error.pickDocx': 'choose the .docx file downloaded from Word',
        'error.exportPermission': 'allow the extension to read Google Docs exports (the “Send the .docx” button)',
        'error.exportBlocked': 'Google Docs export blocked ({message})',
        'error.exportRefused': 'Google Docs export refused ({status})',
        'error.exportExpired': 'Google Docs export refused (Google session expired?)',
        'error.invalidGoogleDoc': 'invalid Google Docs document',

        'doc.open': 'Open document',
        'doc.linked': 'Linked to a Certimens document: measurements are sent to it.',
        'doc.submittedTo': 'Submitted to: {title}',
        'doc.submittedGeneric': 'Submitted to an assignment',
        'doc.openInCertimens': 'Open in Certimens',
        'doc.name': 'Document name',
        'doc.create': 'Create the document',
        'doc.submit': 'Submit to this assignment',
        'doc.changeAssignment': 'Change assignment',
        'doc.none': 'Open a Google Docs, Word Online or Overleaf document to create its Certimens document. If you are writing on this page, say so: measuring will start here.',
        'doc.alreadyUploaded': 'A document has already been sent: sending another replaces it.',
        'doc.deadlinePassed': 'Deadline passed: the copy handed in no longer changes. Measurement goes on — and everything reopens if the teacher pushes the deadline.',
        'doc.wordSaveHint': 'In Word: File › Save As › Download a copy, then pick that file.',

        'assignment.label': 'Assignment',
        'assignment.choose': '— Choose an assignment —',
        'assignment.none': '— No assignment yet —',
        'assignment.due': '{title} (due {date})',
        'assignment.overdue': '{title} — deadline passed on {date}, cannot submit',

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
        'doc.textHint': 'The text you wrote in the page will be sent, and nothing else.',
        'doc.platform': '{platform} recognised.',
        'upload.sendText': 'Send the text of this page',
        'upload.noText': 'Nothing to send: no writing area found on this page.',
        'sites.measureHere': 'Measure this page',
        'sites.measureHereTip': 'Measure what you write on {host}. The browser will ask you for permission for that one address, and you can take it back from the settings.',
        'sites.title': 'Other sites where you write',
        'sites.help': "The extension measures Google Docs, Word Online and Overleaf on its own. If you write somewhere else — your institution's Moodle, a Canvas, a wiki — the simplest way is to open the page and click « Measure this page » in the extension window. You can also add the address here. Added sites are listed below, and are removed with one click. Nothing else is read on those sites: not your passwords, not the pages you visit, only the way you write in the text area.",
        'sites.label': 'Address of the page where you write',
        'sites.add': 'Add this site',
        'sites.remove': 'Remove',
        'sites.removeTip': 'Stop measuring this site, and give the permission back to the browser',
        'sites.empty': 'No site added.',
        'sites.added': '{host} is now measured. Reopen the page to start.',
        'sites.removed': '{host} is no longer measured.',
        'sites.invalid': 'Invalid address: paste the full address of the page where you write (https://…).',
        'sites.denied': 'Without that permission, this site cannot be measured.',
        'sites.unsupported': 'This browser cannot add a site: it measures Google Docs, Word Online and Overleaf.',
        'sites.proposedTitle': 'Proposed by your institution',
        'sites.proposedHelp': 'Your institution lists the addresses where its students write. Nothing is measured until you accept: your browser will ask you for permission, one address at a time, and you can take it back afterwards.',
        'sites.proposedAdd': 'Measure this site',
        'sites.proposedAddTip': 'Measure what you write on {host}. The browser will ask you for permission for that one address.',
        'options.tokenNote': 'No password is ever asked for: the code you confirm in your Certimens space gives the extension an access token, stored locally by the extension on this computer only. It is revoked when you log out, and stays revocable from your Certimens space.',
        'options.link': 'Settings and synchronisation status',

        'status.idle': 'Waiting for measurements',
        'status.synced': '🔵 Synchronised',
        'status.offline': '🟠 Engine unreachable — measurements are kept and resent every minute',
        'status.auth_error': '🔴 Access refused',
        'status.unconfigured': '🔴 Agent not configured',
        'status.state': 'Status: {state}',
        'status.detail': 'Detail: {message}',
        'status.queued': 'Measurements waiting to be sent: {count}',
        'status.documents': 'Documents tracked: {count}',
        'status.extendedDropped': 'Some measurements are not recognised by this engine: they are no longer sent, the others continue. Log in again to retry.',
        'status.lastAttempt': 'Last attempt: {at}',

        'sync.synced': 'Measurements up to date.',
        'sync.offline': 'Engine unreachable: {count} measurement(s) waiting, resent automatically.',
        'sync.auth_error': 'Access refused by the engine.',
        'sync.unconfigured': 'Not logged in: measurements are kept until you do.',
        'sync.queued': '{count} measurement(s) waiting.',

        'word.webNote': 'On Word for the web, the Certimens browser extension already measures your writing: use only one of the two, or the activity is counted twice.',
        'word.measureUnavailable': 'Measurement is unavailable in this version of Word.',

        'counter.keystrokes_total': 'keystrokes',
        'counter.immediate_corrections': 'immediate corrections',
        'counter.deferred_reformulations': 'deferred reformulations',
        'counter.macro_revisions': 'mass revisions',
        'counter.navigation_jumps': 'navigation jumps',
        'counter.cognitive_pauses': 'pauses',
        'counter.paste_events': 'pastes',
        'counter.self_paste_events': 'own text pasted back',
        'counter.focus_losses': 'document exits',
        'counter.injected_chars_total': 'injected characters',
        'counter.injected_chars_max': 'characters in the largest paste',
        'counter.injected_chars_after_return': 'characters pasted after a return',
        'counter.effective_time_ms': 'ms of effective typing',
        'counter.real_volume_chars': 'characters in the document',
        'counter.flight_median_ms': 'ms between keystrokes (median)',
        'counter.flight_mad_ms': 'ms median deviation',
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
