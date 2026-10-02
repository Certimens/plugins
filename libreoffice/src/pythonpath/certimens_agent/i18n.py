"""Interface languages of the LibreOffice agent (the counterpart of browser/i18n.js).

Two languages and one rule, the engine's own: a tag
starting with "en" gives English, everything else French. French is the default because the
product is sold to French higher education — an unknown locale lands there rather than in a
language the student's school does not use.

Where the language comes from, in order: the Certimens account (the student sets it once in
their space and it arrives with the login), then LibreOffice's own interface language, then
French. The keys are those of browser/i18n.js wherever the string is the same one: a message
shown by two agents must read the same in both.
"""

DEFAULT_LANGUAGE = 'fr'

MESSAGES = {
    'fr': {
        'window.login': 'Certimens — Connexion',
        'login.intro': 'Connectez-vous à votre espace Certimens.',
        'login.email': 'E-mail',
        'login.password': 'Mot de passe',
        'login.engineUrl': 'Adresse du moteur',
        'login.submit': 'Se connecter',
        'login.missing': 'Renseignez votre e-mail et votre mot de passe.',
        'login.busy': 'Connexion…',
        'account.connectedAs': 'Connecté : {name}',
        'account.logout': 'Se déconnecter',
        'account.logoutTip': 'Se déconnecter — le jeton d’accès est révoqué sur le moteur ; la mesure s’arrête jusqu’à la prochaine connexion.',
        'account.loggingOut': 'Déconnexion…',
        'common.close': 'Fermer',
        'common.loading': 'Chargement…',

        'error.credentials': 'Identifiants incorrects ou accès révoqué — reconnectez-vous.',
        'error.engineUnreachable': 'Moteur injoignable ({message}).',
        'error.networkError': 'erreur réseau',
        'error.unknown': 'erreur inconnue',
        'error.unexpected': 'Erreur : {message}',
        # Wording shared with browser/i18n.js, key for key: tests/test_i18n.py holds the two
        # dictionaries to it, so that the same refusal reads the same from one agent to the next.
        'error.noFile': "créez d'abord son document Certimens",
        'error.tooLarge': 'document trop volumineux (18 Mo maximum)',
        'error.notEnrolled': "vous n'êtes pas rattaché à ce devoir",
        'sync.auth_error': 'Identifiants refusés par le moteur.',

        'doc.unlinked': "Ce document n'a pas encore de document Certimens.",
        'doc.name': 'Nom du document',
        'doc.create': 'Créer le document',
        'doc.creating': 'Création du document…',
        'doc.linked': 'Document Certimens associé : les mesures y sont envoyées.',
        'doc.openInCertimens': 'Ouvrir dans Certimens',
        'doc.submittedTo': 'Rendu sur : {title}',
        'doc.notSubmitted': 'Pas encore rendu sur un devoir.',
        'doc.alreadyUploaded': 'Un document est déjà envoyé : un nouvel envoi le remplace.',
        'doc.gone': "Le document Certimens associé n'existe plus : recréez-le.",
        'doc.submit': 'Rendre sur ce devoir',
        'doc.changeAssignment': 'Changer de devoir',

        'assignment.fallbackTitle': 'Devoir',
        'assignment.choose': '— Choisir un devoir —',
        'assignment.none': "— Aucun devoir pour l'instant —",
        'assignment.dateFormat': '%d/%m',
        'assignment.due': '{title} (avant le {date})',
        'assignment.overdue': '{title} (échu le {date})',
        'assignment.required': 'Choisissez un devoir.',

        'submit.refused': 'Rendu impossible : {message}.',
        'submit.busy': 'Rendu en cours…',
        'submit.done': 'Document rendu.',
        'create.existed': 'Ce document était déjà enregistré.',
        'create.created': 'Document créé.',

        'upload.send': 'Envoyer le document',
        'upload.pick': 'Choisir un fichier .docx…',
        'upload.pickTitle': 'Choisir le document .docx à envoyer',
        'upload.pickFilter': 'Document Word (.docx)',
        'upload.notDocxReason': "ce fichier n'est pas un document .docx",
        'upload.exportFailed': ('Export automatique impossible ({message}). Enregistrez le document en .docx, '
                                'puis choisissez-le ci-dessous.'),
        'upload.busy': 'Envoi du document…',
        'upload.doneWithSize': 'Document envoyé ({size} Ko).',

        'pause.suspend': 'Suspendre la mesure',
        'pause.suspendTip': 'Suspendre la mesure — plus rien n’est compté jusqu’à ce que vous la repreniez, même après un redémarrage.',
        'pause.resumeTip': 'Reprendre la mesure — les fenêtres de mesure repartent aussitôt.',
        'pause.resume': 'Reprendre la mesure',
        'pause.paused': ('Mesure suspendue. Elle le reste jusqu’à ce que vous la repreniez, '
                         'même après un redémarrage.'),
        'pause.resumed': 'Mesure reprise.',

        'infobar.unlinked': "Ce document n'est pas encore associé à votre espace Certimens.",
        'infobar.link': 'Associer…',

        'token.libreoffice': 'Extension LibreOffice ({date})',
    },
    'en': {
        'window.login': 'Certimens — Log in',
        'login.intro': 'Log in to your Certimens space.',
        'login.email': 'Email',
        'login.password': 'Password',
        'login.engineUrl': 'Engine address',
        'login.submit': 'Log in',
        'login.missing': 'Enter your email and your password.',
        'login.busy': 'Logging in…',
        'account.connectedAs': 'Logged in: {name}',
        'account.logout': 'Log out',
        'account.logoutTip': 'Log out — the access token is revoked on the engine; measurement stops until you log in again.',
        'account.loggingOut': 'Logging out…',
        'common.close': 'Close',
        'common.loading': 'Loading…',

        'error.credentials': 'Wrong credentials, or access revoked — log in again.',
        'error.engineUnreachable': 'Engine unreachable ({message}).',
        'error.networkError': 'network error',
        'error.unknown': 'unknown error',
        'error.unexpected': 'Error: {message}',
        'error.noFile': 'create its Certimens document first',
        'error.tooLarge': 'document too large (18 MB maximum)',
        'error.notEnrolled': 'you are not enrolled in this assignment',
        'sync.auth_error': 'Credentials refused by the engine.',

        'doc.unlinked': 'This document has no Certimens document yet.',
        'doc.name': 'Document name',
        'doc.create': 'Create the document',
        'doc.creating': 'Creating the document…',
        'doc.linked': 'Linked to a Certimens document: measurements are sent to it.',
        'doc.openInCertimens': 'Open in Certimens',
        'doc.submittedTo': 'Submitted to: {title}',
        'doc.notSubmitted': 'Not submitted to an assignment yet.',
        'doc.alreadyUploaded': 'A document has already been sent: sending another replaces it.',
        'doc.gone': 'The linked Certimens document no longer exists: create it again.',
        'doc.submit': 'Submit to this assignment',
        'doc.changeAssignment': 'Change assignment',

        'assignment.fallbackTitle': 'Assignment',
        'assignment.choose': '— Choose an assignment —',
        'assignment.none': '— No assignment yet —',
        'assignment.dateFormat': '%d %b',
        'assignment.due': '{title} (due {date})',
        'assignment.overdue': '{title} (overdue since {date})',
        'assignment.required': 'Choose an assignment.',

        'submit.refused': 'Submission refused: {message}.',
        'submit.busy': 'Submitting…',
        'submit.done': 'Document submitted.',
        'create.existed': 'This document was already registered.',
        'create.created': 'Document created.',

        'upload.send': 'Send the document',
        'upload.pick': 'Choose a .docx file…',
        'upload.pickTitle': 'Choose the .docx document to send',
        'upload.pickFilter': 'Word document (.docx)',
        'upload.notDocxReason': 'this file is not a .docx document',
        'upload.exportFailed': ('Automatic export failed ({message}). Save the document as .docx, '
                                'then choose it below.'),
        'upload.busy': 'Sending the document…',
        'upload.doneWithSize': 'Document sent ({size} KB).',

        'pause.suspend': 'Pause measurement',
        'pause.suspendTip': 'Pause measurement — nothing is counted until you resume it, even after a restart.',
        'pause.resumeTip': 'Resume measurement — measurement windows start again straight away.',
        'pause.resume': 'Resume measurement',
        'pause.paused': ('Measurement paused. It stays paused until you resume it, '
                         'even after a restart.'),
        'pause.resumed': 'Measurement resumed.',

        'infobar.unlinked': 'This document is not linked to your Certimens space yet.',
        'infobar.link': 'Link…',

        'token.libreoffice': 'LibreOffice extension ({date})',
    },
}

_language = DEFAULT_LANGUAGE


def normalize_language(tag):
    return 'en' if str(tag or '').lower().startswith('en') else DEFAULT_LANGUAGE


def set_language(account, host=None):
    """account: the Certimens account's language, empty until the student logs in.
    host: LibreOffice's own interface language."""
    global _language
    _language = normalize_language(account or host or DEFAULT_LANGUAGE)
    return _language


def language():
    return _language


def office_language(ctx):
    """LibreOffice's interface language (its ooLocale setting), or '' when it cannot be read — in
    which case the default applies, as everywhere else. Imported lazily so this module stays
    testable without LibreOffice, like the rest of the agent."""
    try:
        from com.sun.star.beans import PropertyValue
        nodepath = PropertyValue()
        nodepath.Name = 'nodepath'
        nodepath.Value = '/org.openoffice.Setup/L10N'
        provider = ctx.ServiceManager.createInstanceWithContext(
            'com.sun.star.configuration.ConfigurationProvider', ctx)
        node = provider.createInstanceWithArguments(
            'com.sun.star.configuration.ConfigurationAccess', (nodepath,))
        return node.getByName('ooLocale') or ''
    except Exception:
        return ''


def t(key, **values):
    """t('doc.submittedTo', title=…) — placeholders are {name}. An unknown key returns itself
    rather than an empty string: a missing translation must be visible, not silent."""
    text = MESSAGES[_language].get(key) or MESSAGES[DEFAULT_LANGUAGE].get(key) or key
    return text.format(**values) if values else text
