"""What the documentation site says, in French and in English.

Prose, and nothing else: how a page is built is `build-site.py`'s business. The two languages
must hold the same pages, built the same way, down to the number of steps — the build refuses
otherwise, because a step written in one language alone is invisible to everyone who reads the
other.

The slugs are the agents' folder names (`browser`, `word`, `libreoffice`, `vscode`) and are the
same in both languages: they are what ties a French page to its English twin, and what the
`hreflang` links are built from.

**The store addresses are below, in one table.** Nothing is published yet — the first submission
to each store is made by hand (docs/publication.md) — so they are empty, and the pages then name
the store without linking to it. Filling one in is a one-line change, and the sentence around it
does not move.
"""

# Fill in as each listing goes live. An empty value is not a mistake: it is a listing that does
# not exist yet, and a page that links to nothing would be worse than a page that says where to
# look.
STORES = {
    'chrome': '',
    'firefox': '',
    'edge': '',
    'opera': '',
    'safari': '',
    'appsource': '',
    'libreoffice': '',
    'marketplace': '',
    'openvsx': '',
}

REPOSITORY = 'https://github.com/certimens/plugins'
RELEASES = REPOSITORY + '/releases'
WORD_MANIFEST = 'https://certimens.github.io/plugins/word/manifest.xml'
# The manifest sits in the very folder the French page is served from, so it is linked rather
# than merely quoted. The href is root-absolute — it has to work from the English page too, and
# it must keep working the day the custom domain is switched on.
WORD_MANIFEST_LINK = (f'<a href="/plugins/word/manifest.xml"><code>{WORD_MANIFEST}</code></a>')


def store(key, label):
    """The store's name, linked once its listing exists."""
    url = STORES[key]
    return f'<a href="{url}">{label}</a>' if url else f'<strong>{label}</strong>'


# The furniture around the pages. The website's own header and footer are reused class for
# class — same host, so its stylesheet, its logo and its pages are all one link away — and these
# are the few strings that are ours.
NAV_LABEL = {'fr': 'Navigation principale', 'en': 'Main navigation'}
MENU_LABEL = {'fr': 'Ouvrir le menu', 'en': 'Open the menu'}
LOGIN = {'fr': 'Connexion', 'en': 'Sign in'}
SKIP = {'fr': 'Aller au contenu', 'en': 'Skip to content'}

# What this part of the site is called, in the website's menu and in the footer column that
# lists the four agents.
PLUGINS = {'fr': 'Plugins', 'en': 'Plugins'}

# The website's own menu, item for item, with ours inserted before Contact. `None` as an address
# means **this** documentation's home page, which the build writes as a relative link.
#
# This is the one thing on the site that is copied rather than linked: a menu is markup, not a
# stylesheet, and there is no way to share it across two repositories without fetching HTML at
# build time. **It will drift**: an item added to the website's menu has to be added here too,
# and nothing will say so (docs/publication.md).
NAV_ITEMS = {
    'fr': [
        ('La Certification', '/#certification'),
        ('Notre Expertise', '/#expertise'),
        ('Questions Fréquentes', '/#faq'),
        ('Plugins', None),
        ('Contact', '/contact/'),
    ],
    'en': [
        ('The Certification', '/en/#certification'),
        ('Our Expertise', '/en/#expertise'),
        ('FAQ', '/en/#faq'),
        ('Plugins', None),
        ('Contact', '/en/contact/'),
    ],
}

# The language switch, worded in the language it leads to — as the website words it.
LANG_SWITCH = {
    'fr': ('EN', 'Switch to English'),
    'en': ('FR', 'Basculer en français'),
}

TAGLINE = {
    'fr': 'Les agents de mesure de Certimens, et comment les installer.',
    'en': 'The Certimens measurement agents, and how to install them.',
}

# Where the word mark goes back to: the website's home, in the reader's language.
SITE_HOME = {'fr': '/', 'en': '/en/'}

# The website's own pages, on the same host, plus the one address that is ours.
ABOUT = {
    'fr': [
        ('Le site Certimens', '/'),
        ('Contact', '/contact/'),
        ('Mentions légales', '/mentions-legales/'),
        ('Le code des agents', REPOSITORY),
    ],
    'en': [
        ('The Certimens website', '/en/'),
        ('Contact', '/en/contact/'),
        ('Legal notice', '/en/legal-notice/'),
        ('The source of the agents', REPOSITORY),
    ],
}

# The line under the hairline. The website says "tous droits réservés" there, which is true of
# the website and false of these four agents: they are AGPL, and the page that explains how to
# install them is the right place to say so.
BOTTOM = {
    'fr': '© 2026 Certimens — les agents de mesure sont libres, sous licence AGPL-3.0-only.',
    'en': '© 2026 Certimens — the measurement agents are free software, under the AGPL-3.0-only.',
}

# One icon per agent, for the cards of the home page. They go in the website's own `.card__icon`
# — a slate disc that turns gold when the card is hovered — and they are drawn like its burger:
# a 24 stroke grid, `currentColor`, round joins.
#
# **None of them is a vendor's logo**, and that is deliberate: the Word, LibreOffice and VS Code
# marks belong to their owners, and a published page that wears them is making a claim about a
# relationship nobody granted. A document, a pen, a window and a pair of brackets say which tool
# is meant without borrowing anything.
#
# They are not translated, so they live here once rather than in each language's list.
ICON = (
    '<svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" '
    'stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">%s</svg>'
)

AGENT_ICONS = {
    # A browser window, with its bar and two dots.
    'browser': ICON % '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 9h18"/>'
                      '<path d="M6 6.5h.01"/><path d="M9 6.5h.01"/>',
    # A text document, with its folded corner.
    'word': ICON % '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/>'
                   '<path d="M14 3v5h5"/><path d="M9 13h6"/><path d="M9 17h4"/>',
    # A pen: Writer is where the document is written rather than read.
    'libreoffice': ICON % '<path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4z"/>',
    # Brackets and a slash: code.
    'vscode': ICON % '<path d="m8 16-4-4 4-4"/><path d="m16 8 4 4-4 4"/><path d="m13.5 6-3 12"/>',
}

AGENTS_FR = [
    ('browser', 'Extension navigateur', 'Google Docs, Word Online, Overleaf, et les sites que votre établissement propose. Chrome, Firefox, Edge, Safari, Opera.'),
    ('word', 'Complément Word', 'Word pour Windows et Mac, et Word sur le web.'),
    ('libreoffice', 'Extension LibreOffice', 'LibreOffice Writer, sur Windows, macOS et Linux.'),
    ('vscode', 'Extension VS Code', "Un projet de code, fichier par fichier, dans l'éditeur."),
]

AGENTS_EN = [
    ('browser', 'Browser extension', 'Google Docs, Word Online, Overleaf, and the sites your institution suggests. Chrome, Firefox, Edge, Safari, Opera.'),
    ('word', 'Word add-in', 'Word for Windows and Mac, and Word on the web.'),
    ('libreoffice', 'LibreOffice extension', 'LibreOffice Writer, on Windows, macOS and Linux.'),
    ('vscode', 'VS Code extension', 'A code project, file by file, inside the editor.'),
]

NO_PASSWORD_FR = ('Aucun agent Certimens ne vous demandera <strong>jamais</strong> de mot de passe. '
                  'La connexion se fait par un code court que l’agent affiche et que vous confirmez '
                  'dans votre espace Certimens. Un agent qui réclame un mot de passe n’est pas le nôtre.')
NO_PASSWORD_EN = ('No Certimens agent will <strong>ever</strong> ask you for a password. Signing in '
                  'goes through a short code the agent displays and that you confirm in your '
                  'Certimens space. An agent asking for a password is not one of ours.')

LOGOUT_FR = ('<strong>Se déconnecter avant de désinstaller.</strong> La déconnexion révoque le jeton '
             'd’accès sur le moteur ; désinstaller sans se déconnecter efface le jeton de votre poste '
             'mais le laisse valide. Vous pouvez aussi le révoquer à tout moment depuis votre espace '
             'Certimens.')
LOGOUT_EN = ('<strong>Log out before uninstalling.</strong> Logging out revokes the access token on '
             'the engine; uninstalling without logging out erases the token from your machine but '
             'leaves it valid. You can also revoke it at any time from your Certimens space.')


# --- FRENCH ---------------------------------------------------------------------------------

PAGES_FR = {
    '': {
        'title': 'Installer Certimens',
        'description': "Certimens mesure comment un document a été rédigé. L'agent s'installe dans l'outil où vous écrivez : choisissez le vôtre.",
        'blocks': [
            ('p', 'Un agent Certimens compte la façon dont vous écrivez — rythme de frappe, pauses, '
                  'corrections, collages, déplacements dans le document — et envoie ces compteurs à '
                  'votre espace Certimens. Votre enseignant y voit que le travail a bien été rédigé, '
                  'et non collé depuis ailleurs.'),
            ('note', 'info', '<strong>Aucun texte que vous écrivez ne quitte votre poste.</strong> '
                             'Les agents n’envoient que des compteurs. Le seul moment où un document '
                             'part, c’est quand vous cliquez vous-même sur « rendre ».'),
            ('h2', 'Choisissez votre outil'),
            ('agents', AGENTS_FR),
            ('h2', 'Ce qu’il vous faut'),
            ('steps', [
                'Un <strong>compte Certimens</strong>, fourni par votre établissement.',
                'L’agent qui correspond à l’outil dans lequel vous rédigez.',
                'Rien d’autre : l’adresse du serveur est déjà celle qu’il faut.',
            ]),
            ('note', 'info', NO_PASSWORD_FR),
            ('h2', 'Vous équipez un établissement ?'),
            ('p', 'Chaque page porte, repliée en bas, une <strong>installation manuelle</strong> : les '
                  'paquets de chaque version, le dépôt par stratégie d’entreprise, et ce qu’il faut '
                  'savoir avant de déployer sur un parc. Les quatre agents sont libres, sous licence '
                  f'AGPL-3.0, et leur code est <a href="{REPOSITORY}">public</a>.'),
            ('p', 'Un établissement qui héberge son propre serveur Certimens saisit son adresse une '
                  'fois, dans les paramètres avancés de la fenêtre de connexion. Ils ne s’ouvrent '
                  'd’eux-mêmes que si l’adresse enregistrée n’est pas celle par défaut : un étudiant '
                  'n’a donc rien à y faire.'),
            ('figure', 'advanced', 'Les paramètres avancés de la fenêtre de connexion, dans les quatre agents.'),
        ],
    },

    'browser': {
        'title': 'Extension navigateur',
        'description': 'Pour rédiger dans Google Docs, Word Online ou Overleaf — et sur les sites que votre établissement propose.',
        'blocks': [
            ('h2', 'Ce que l’extension mesure'),
            ('p', 'Elle mesure la rédaction dans <strong>Google Docs</strong>, <strong>Word Online</strong> '
                  'et <strong>Overleaf</strong>, ainsi que sur les adresses que votre établissement '
                  'propose ou que vous ajoutez vous-même — le Moodle de votre école, par exemple. '
                  'Partout ailleurs, elle ne fait rien.'),
            ('h2', 'Installer depuis la boutique'),
            ('steps', [
                f'Ouvrez la boutique de votre navigateur : {store("chrome", "Chrome Web Store")}, '
                f'{store("firefox", "Firefox Browser Add-ons")}, {store("edge", "Edge Add-ons")}, '
                f'{store("opera", "Opera Add-ons")} ou, pour Safari, {store("safari", "l’App Store")}.',
                'Cherchez <strong>Certimens</strong> et lancez l’installation.',
                'Acceptez les autorisations demandées : elles couvrent les trois éditeurs ci-dessus '
                'et l’adresse de votre espace Certimens, rien de plus.',
                'Épinglez l’écu doré dans la barre d’outils : c’est par là que tout passe.',
            ]),
            ('h2', 'Se connecter'),
            ('steps', [
                'Cliquez sur l’écu, puis sur <em>Se connecter</em>.',
                'L’extension affiche un <strong>code court</strong> et ouvre votre espace Certimens '
                'dans un nouvel onglet.',
                'Connectez-vous à votre espace si ce n’est pas déjà fait, et confirmez le code.',
                'Revenez à l’onglet de votre document : l’extension s’est connectée toute seule.',
            ]),
            ('figure', 'pairing', 'Ce que l’extension affiche pendant que vous confirmez le code.'),
            ('note', 'info', NO_PASSWORD_FR),
            ('h2', 'Vérifier que la mesure tourne'),
            ('p', 'Ouvrez un document dans Google Docs, écrivez quelques lignes, puis cliquez sur '
                  'l’écu. La fenêtre doit afficher le document suivi et <em>Mesures à jour</em>. Si '
                  'elle dit que des mesures sont en attente, c’est que le serveur n’a pas répondu : '
                  'rien n’est perdu, elles repartiront toutes seules.'),
            ('h2', 'Les adresses de votre établissement'),
            ('p', 'Si votre école a déclaré où ses étudiants rédigent, ces adresses apparaissent dans '
                  'les réglages de l’extension, prêtes à être acceptées. Elles sont <em>proposées</em> : '
                  'c’est votre navigateur qui demande l’autorisation, une adresse à la fois, et vous '
                  'pouvez les refuser toutes comme en ajouter une que personne n’a proposée.'),
            ('h2', 'Mises à jour'),
            ('p', 'Votre navigateur met l’extension à jour tout seul, en silence. La prochaine fois que '
                  'vous ouvrirez sa fenêtre, elle vous dira une fois quelle version elle est devenue, '
                  'avec un lien vers ce qui a changé.'),
            ('advanced', 'Installation manuelle (avancé)', [
                ('p', 'Pour un essai, un poste sans accès aux boutiques, ou un déploiement sur un parc. '
                      f'Chaque version publie ses paquets sur la <a href="{RELEASES}">page des '
                      'releases</a>.'),
                ('steps', [
                    'Téléchargez le paquet de votre navigateur : <code>…-chrome.zip</code>, '
                    '<code>…-firefox.zip</code> ou <code>…-safari.zip</code>, et décompressez-le.',
                    'Chrome, Edge, Opera, Brave, Vivaldi : <code>chrome://extensions</code>, activez le '
                    '<em>mode développeur</em>, puis <em>Charger l’extension non empaquetée</em> et '
                    'désignez le dossier décompressé.',
                    'Firefox : <code>about:debugging</code> → <em>Ce Firefox</em> → <em>Charger un '
                    'module temporaire</em>, et désignez le <code>manifest.json</code>.',
                    'Safari : le paquet se convertit en application avec Xcode, sur un Mac.',
                ]),
                ('note', 'warning', 'Une extension chargée ainsi <strong>n’est pas mise à jour</strong>, '
                                    'Chrome affiche un avertissement à chaque démarrage, et Firefox '
                                    'l’oublie en se fermant. Pour équiper un parc, passez par la '
                                    '<strong>stratégie d’entreprise</strong> du navigateur, qui installe '
                                    'depuis la boutique sans demander à l’utilisateur.'),
            ]),
            ('h2', 'Se déconnecter, désinstaller'),
            ('p', LOGOUT_FR),
        ],
    },

    'word': {
        'title': 'Complément Word',
        'description': 'Pour rédiger dans Word sur Windows, sur Mac, ou dans Word sur le web.',
        'blocks': [
            ('h2', 'Ce que le complément mesure'),
            ('p', 'Il mesure la rédaction dans <strong>Word pour Microsoft 365</strong> (Windows et Mac) '
                  'et dans <strong>Word sur le web</strong>. Word ne livre pas les frappes à un '
                  'complément : la mesure se fait en comparant le texte à lui-même, et les compteurs '
                  'sont donc un peu moins fins qu’ailleurs. Word 2016 et 2019 ne sont pas gérés.'),
            ('h2', 'Installer depuis la boutique'),
            ('steps', [
                'Dans Word : <em>Accueil › Compléments › Plus de compléments</em>.',
                f'Cherchez <strong>Certimens</strong> dans {store("appsource", "la boutique Office")} '
                'et cliquez sur <em>Ajouter</em>.',
                'Le volet Certimens s’ouvre sur le côté droit du document.',
            ]),
            ('note', 'info', 'Si votre établissement gère les postes, le complément peut déjà être '
                             'déployé : il apparaît alors dans <em>Mes compléments</em> sans rien '
                             'installer.'),
            ('h2', 'Se connecter'),
            ('steps', [
                'Dans le volet, cliquez sur <em>Se connecter</em>.',
                'Le volet affiche un <strong>code court</strong> et un lien vers votre espace Certimens.',
                'Confirmez le code dans votre espace, puis revenez à Word.',
                'Le volet se connecte tout seul et affiche votre nom.',
            ]),
            ('figure', 'pairing', 'Ce que le volet affiche pendant que vous confirmez le code.'),
            ('note', 'info', NO_PASSWORD_FR),
            ('h2', 'Vérifier que la mesure tourne'),
            ('p', 'Écrivez quelques lignes, puis regardez le volet : il doit nommer le document suivi et '
                  'dire que les mesures sont à jour. <strong>Vous pouvez fermer le volet</strong> : la '
                  'mesure continue tant que le document est ouvert.'),
            ('h2', 'Sur Word pour le web'),
            ('p', 'Si vous avez aussi l’extension navigateur, les deux mesurent la même rédaction et '
                  'l’activité est comptée deux fois. Le volet vous le rappelle : n’en gardez qu’un seul '
                  'des deux.'),
            ('h2', 'Mises à jour'),
            ('p', 'Il n’y a rien à faire : le complément est servi depuis son site et se recharge tout '
                  'seul à la prochaine ouverture du volet. Il vous dira une fois quelle version il est '
                  'devenu.'),
            ('advanced', 'Installation manuelle (avancé)', [
                ('p', 'Le complément n’est pas un fichier à installer : c’est un site, et le manifest ne '
                      'contient que des adresses. Le charger à la main revient à désigner ce manifest.'),
                ('steps', [
                    f'Le manifest est à l’adresse {WORD_MANIFEST_LINK} ; enregistrez-le.',
                    'Dans Word : <em>Accueil › Compléments › Plus de compléments › Mes compléments › '
                    'Charger mon complément</em>, puis désignez le fichier.',
                    'Pour un parc : <em>Centre d’administration Microsoft 365 › Paramètres › Applications '
                    'intégrées › Charger une application personnalisée</em>, avec le même manifest.',
                ]),
                ('note', 'warning', 'Ne redéployez un manifest que s’il a vraiment changé : le code, lui, '
                                    'est repris du site à chaque ouverture. Un manifest déployé sur un '
                                    'parc ne se remplace pas en un clic.'),
            ]),
            ('h2', 'Se déconnecter, désinstaller'),
            ('p', LOGOUT_FR),
        ],
    },

    'libreoffice': {
        'title': 'Extension LibreOffice',
        'description': 'Pour rédiger dans LibreOffice Writer, sur Windows, macOS ou Linux.',
        'blocks': [
            ('h2', 'Ce que l’extension mesure'),
            ('p', 'Elle mesure la rédaction dans <strong>LibreOffice Writer</strong>, à partir de la '
                  'version 7.0. Writer laisse une extension écouter le clavier et la souris : les '
                  'compteurs y sont aussi fins que dans le navigateur. Sous Linux, le paquet '
                  '<code>libreoffice-script-provider-python</code> de votre distribution est nécessaire.'),
            ('h2', 'Installer depuis le catalogue'),
            ('steps', [
                f'Téléchargez le fichier <code>.oxt</code> depuis {store("libreoffice", "extensions.libreoffice.org")}.',
                'Dans Writer : <em>Outils › Gestionnaire des extensions › Ajouter</em>, puis désignez le '
                'fichier téléchargé.',
                'Redémarrez LibreOffice : un menu <strong>Certimens</strong> apparaît dans Writer.',
            ]),
            ('h2', 'Se connecter'),
            ('steps', [
                'Menu <strong>Certimens</strong> → la fenêtre de connexion s’ouvre.',
                'Elle affiche un <strong>code court</strong> et l’adresse de votre espace Certimens.',
                'Confirmez le code dans votre espace, depuis votre navigateur.',
                'La fenêtre se referme sur votre nom : vous êtes connecté.',
            ]),
            ('figure', 'pairing', 'Ce que la fenêtre affiche pendant que vous confirmez le code.'),
            ('note', 'info', NO_PASSWORD_FR),
            ('h2', 'Vérifier que la mesure tourne'),
            ('p', 'Un document qui n’est pas encore associé affiche un bandeau en haut de Writer, avec un '
                  'bouton <em>Associer…</em>. Une fois associé, écrivez quelques lignes puis rouvrez le '
                  'menu Certimens : la fenêtre nomme le document suivi.'),
            ('h2', 'Mises à jour'),
            ('p', 'LibreOffice s’en charge : <em>Outils › Gestionnaire des extensions › Vérifier les mises '
                  'à jour</em> propose la version la plus récente et l’installe. La vérification '
                  'périodique de LibreOffice regarde aussi les extensions installées.'),
            ('advanced', 'Installation manuelle (avancé)', [
                ('p', 'Le catalogue se remplit à la main, quelques jours après une version. Le fichier '
                      f'<code>.oxt</code> de chaque version est disponible tout de suite sur la '
                      f'<a href="{RELEASES}">page des releases</a>, et c’est de là que les mises à jour '
                      'automatiques sont servies.'),
                ('steps', [
                    'Téléchargez <code>certimens-libreoffice-X.Y.Z.oxt</code> depuis la release.',
                    'En ligne de commande : <code>unopkg add certimens-libreoffice-X.Y.Z.oxt</code>, puis '
                    'redémarrez LibreOffice.',
                    'Pour un parc : <code>unopkg add --shared</code> installe l’extension pour tous les '
                    'utilisateurs de la machine, avec les droits d’administration.',
                ]),
                ('note', 'info', 'Quelle que soit la façon dont elle a été installée, l’extension sait '
                                 'ensuite se mettre à jour toute seule : elle interroge son propre flux '
                                 'de mise à jour, pas le catalogue.'),
            ]),
            ('h2', 'Se déconnecter, désinstaller'),
            ('p', LOGOUT_FR),
        ],
    },

    'vscode': {
        'title': 'Extension VS Code',
        'description': 'Pour un travail rendu sous forme de code : l’extension mesure le projet fichier par fichier.',
        'blocks': [
            ('h2', 'Ce que l’extension mesure'),
            ('p', 'Elle mesure la rédaction <strong>fichier par fichier</strong> dans un projet ouvert '
                  'sous Visual Studio Code 1.90 ou plus récent. Les dépendances, la sortie de '
                  'compilation et les fichiers générés sont ignorés, et un fichier n’existe côté '
                  'Certimens que lorsque vous y avez réellement écrit.'),
            ('h2', 'Installer depuis le Marketplace'),
            ('steps', [
                'Dans VS Code, ouvrez la vue <em>Extensions</em> (<code>Ctrl+Maj+X</code>, '
                '<code>Cmd+Maj+X</code> sur Mac).',
                f'Cherchez <strong>Certimens</strong> dans {store("marketplace", "le Marketplace")} et '
                'cliquez sur <em>Install</em>.',
                'L’écu Certimens apparaît dans la barre d’activité, à gauche.',
            ]),
            ('note', 'info', 'En une commande : <code>code --install-extension certimens.certimens</code>.'),
            ('h2', 'Se connecter'),
            ('steps', [
                'Ouvrez le panneau Certimens, ou lancez <em>Certimens : se connecter</em> depuis la '
                'palette de commandes.',
                'Le panneau affiche un <strong>code court</strong> et un lien vers votre espace.',
                'Confirmez le code dans votre espace Certimens.',
                'Le panneau affiche votre nom, et la barre d’état indique les fichiers mesurés.',
            ]),
            ('figure', 'pairing', 'Ce que le panneau affiche pendant que vous confirmez le code.'),
            ('note', 'info', NO_PASSWORD_FR),
            ('h2', 'Vérifier que la mesure tourne'),
            ('p', 'Écrivez dans un fichier du projet, puis regardez la barre d’état en bas : elle compte '
                  'les fichiers mesurés. Le jeton d’accès est conservé dans le coffre de l’éditeur, '
                  'jamais dans <code>settings.json</code> — il ne part donc ni dans un dépôt git ni dans '
                  'la synchronisation des réglages.'),
            ('h2', 'Mises à jour'),
            ('p', 'VS Code met l’extension à jour tout seul. Le panneau vous dira une fois quelle version '
                  'elle est devenue, avec un lien vers ce qui a changé.'),
            ('advanced', 'Installation manuelle (avancé)', [
                ('p', 'Pour VSCodium, Cursor, Gitpod, un poste sans Marketplace, ou pour essayer une '
                      'version avant tout le monde.'),
                ('steps', [
                    f'Téléchargez <code>certimens-vscode-X.Y.Z.vsix</code> depuis la '
                    f'<a href="{RELEASES}">page des releases</a>.',
                    'Dans VS Code : vue <em>Extensions</em> → menu <em>…</em> → <em>Install from '
                    'VSIX…</em>, puis désignez le fichier.',
                    'En ligne de commande : <code>code --install-extension '
                    'certimens-vscode-X.Y.Z.vsix</code>.',
                    f'Les éditeurs servis par Open VSX trouvent aussi l’extension sur '
                    f'{store("openvsx", "open-vsx.org")}.',
                ]),
                ('note', 'warning', 'Une extension installée depuis un <code>.vsix</code> '
                                    '<strong>n’est pas mise à jour</strong> : il faudra réinstaller le '
                                    'fichier suivant à la main.'),
            ]),
            ('h2', 'Se déconnecter, désinstaller'),
            ('p', LOGOUT_FR),
        ],
    },
}


# --- ENGLISH --------------------------------------------------------------------------------

PAGES_EN = {
    '': {
        'title': 'Install Certimens',
        'description': 'Certimens measures how a document was written. The agent goes into the tool you write in: pick yours.',
        'blocks': [
            ('p', 'A Certimens agent counts the way you write — typing rhythm, pauses, corrections, '
                  'pastes, movements through the document — and sends those counters to your Certimens '
                  'space. Your teacher sees there that the work was really written, and not pasted in '
                  'from somewhere else.'),
            ('note', 'info', '<strong>None of the text you write ever leaves your machine.</strong> '
                             'The agents send counters and nothing else. The only moment a document '
                             'goes out is when you click “hand in” yourself.'),
            ('h2', 'Pick your tool'),
            ('agents', AGENTS_EN),
            ('h2', 'What you need'),
            ('steps', [
                'A <strong>Certimens account</strong>, provided by your institution.',
                'The agent matching the tool you write in.',
                'Nothing else: the server address is already the right one.',
            ]),
            ('note', 'info', NO_PASSWORD_EN),
            ('h2', 'Equipping an institution?'),
            ('p', 'Every page carries a <strong>manual installation</strong>, folded away at the bottom: '
                  'each version’s packages, deployment through enterprise policy, and what to know '
                  'before rolling it out to a fleet. The four agents are free software under the '
                  f'AGPL-3.0, and their code is <a href="{REPOSITORY}">public</a>.'),
            ('p', 'An institution hosting its own Certimens server enters its address once, in the '
                  'advanced settings of the sign-in window. They only open by themselves when the '
                  'stored address is not the default one: a student has nothing to do there.'),
            ('figure', 'advanced', 'The advanced settings of the sign-in window, in all four agents.'),
        ],
    },

    'browser': {
        'title': 'Browser extension',
        'description': 'For writing in Google Docs, Word Online or Overleaf — and on the sites your institution suggests.',
        'blocks': [
            ('h2', 'What the extension measures'),
            ('p', 'It measures writing in <strong>Google Docs</strong>, <strong>Word Online</strong> and '
                  '<strong>Overleaf</strong>, as well as on the addresses your institution suggests or '
                  'that you add yourself — your school’s Moodle, for instance. Everywhere else, it does '
                  'nothing.'),
            ('h2', 'Install from the store'),
            ('steps', [
                f'Open your browser’s store: {store("chrome", "Chrome Web Store")}, '
                f'{store("firefox", "Firefox Browser Add-ons")}, {store("edge", "Edge Add-ons")}, '
                f'{store("opera", "Opera Add-ons")} or, for Safari, {store("safari", "the App Store")}.',
                'Search for <strong>Certimens</strong> and install it.',
                'Accept the permissions it asks for: they cover the three editors above and the address '
                'of your Certimens space, and nothing more.',
                'Pin the gold shield to the toolbar: everything goes through it.',
            ]),
            ('h2', 'Sign in'),
            ('steps', [
                'Click the shield, then <em>Log in</em>.',
                'The extension displays a <strong>short code</strong> and opens your Certimens space in '
                'a new tab.',
                'Sign in to your space if you are not already, and confirm the code.',
                'Go back to your document’s tab: the extension has signed in on its own.',
            ]),
            ('figure', 'pairing', 'What the extension shows while you confirm the code.'),
            ('note', 'info', NO_PASSWORD_EN),
            ('h2', 'Check that measurement is running'),
            ('p', 'Open a document in Google Docs, write a few lines, then click the shield. The window '
                  'should name the document being tracked and say <em>Measurements up to date</em>. If '
                  'it says measurements are waiting, the server did not answer: nothing is lost, they '
                  'will go out on their own.'),
            ('h2', 'Your institution’s addresses'),
            ('p', 'If your school has declared where its students write, those addresses appear in the '
                  'extension’s settings, ready to be accepted. They are <em>suggested</em>: your browser '
                  'is what asks for permission, one address at a time, and you can refuse them all as '
                  'well as add one nobody suggested.'),
            ('h2', 'Updates'),
            ('p', 'Your browser updates the extension on its own, silently. The next time you open its '
                  'window, it will tell you once which version it has become, with a link to what '
                  'changed.'),
            ('advanced', 'Manual installation (advanced)', [
                ('p', 'For a trial, a machine with no access to the stores, or a fleet deployment. Every '
                      f'version publishes its packages on the <a href="{RELEASES}">releases page</a>.'),
                ('steps', [
                    'Download your browser’s package: <code>…-chrome.zip</code>, '
                    '<code>…-firefox.zip</code> or <code>…-safari.zip</code>, and unzip it.',
                    'Chrome, Edge, Opera, Brave, Vivaldi: <code>chrome://extensions</code>, turn on '
                    '<em>developer mode</em>, then <em>Load unpacked</em> and point at the unzipped '
                    'folder.',
                    'Firefox: <code>about:debugging</code> → <em>This Firefox</em> → <em>Load Temporary '
                    'Add-on</em>, and point at <code>manifest.json</code>.',
                    'Safari: the package is turned into an application with Xcode, on a Mac.',
                ]),
                ('note', 'warning', 'An extension loaded this way <strong>is not updated</strong>, Chrome '
                                    'shows a warning at every start, and Firefox forgets it on exit. To '
                                    'equip a fleet, go through the browser’s <strong>enterprise '
                                    'policy</strong>, which installs from the store without asking the '
                                    'user.'),
            ]),
            ('h2', 'Log out, uninstall'),
            ('p', LOGOUT_EN),
        ],
    },

    'word': {
        'title': 'Word add-in',
        'description': 'For writing in Word on Windows, on Mac, or in Word on the web.',
        'blocks': [
            ('h2', 'What the add-in measures'),
            ('p', 'It measures writing in <strong>Word for Microsoft 365</strong> (Windows and Mac) and '
                  'in <strong>Word on the web</strong>. Word does not hand keystrokes to an add-in: '
                  'measurement works by comparing the text with itself, so the counters are a little '
                  'coarser than elsewhere. Word 2016 and 2019 are not supported.'),
            ('h2', 'Install from the store'),
            ('steps', [
                'In Word: <em>Home › Add-ins › More Add-ins</em>.',
                f'Search for <strong>Certimens</strong> in {store("appsource", "the Office store")} and '
                'click <em>Add</em>.',
                'The Certimens pane opens on the right-hand side of the document.',
            ]),
            ('note', 'info', 'If your institution manages the machines, the add-in may already be '
                             'deployed: it then appears under <em>My Add-ins</em> with nothing to '
                             'install.'),
            ('h2', 'Sign in'),
            ('steps', [
                'In the pane, click <em>Log in</em>.',
                'The pane displays a <strong>short code</strong> and a link to your Certimens space.',
                'Confirm the code in your space, then come back to Word.',
                'The pane signs in on its own and shows your name.',
            ]),
            ('figure', 'pairing', 'What the pane shows while you confirm the code.'),
            ('note', 'info', NO_PASSWORD_EN),
            ('h2', 'Check that measurement is running'),
            ('p', 'Write a few lines, then look at the pane: it should name the document being tracked '
                  'and say the measurements are up to date. <strong>You can close the pane</strong>: '
                  'measurement carries on as long as the document is open.'),
            ('h2', 'On Word for the web'),
            ('p', 'If you also have the browser extension, both measure the same writing and the '
                  'activity is counted twice. The pane reminds you: keep only one of the two.'),
            ('h2', 'Updates'),
            ('p', 'There is nothing to do: the add-in is served from its site and reloads itself the next '
                  'time the pane opens. It will tell you once which version it has become.'),
            ('advanced', 'Manual installation (advanced)', [
                ('p', 'The add-in is not a file to install: it is a site, and the manifest holds nothing '
                      'but addresses. Loading it by hand means pointing at that manifest.'),
                ('steps', [
                    f'The manifest lives at {WORD_MANIFEST_LINK}; save it.',
                    'In Word: <em>Home › Add-ins › More Add-ins › My Add-ins › Upload My Add-in</em>, '
                    'then point at the file.',
                    'For a fleet: <em>Microsoft 365 admin center › Settings › Integrated apps › Upload '
                    'custom apps</em>, with the same manifest.',
                ]),
                ('note', 'warning', 'Only redeploy a manifest when it has really changed: the code itself '
                                    'is taken from the site at every opening. A manifest deployed to a '
                                    'fleet is not replaced in one click.'),
            ]),
            ('h2', 'Log out, uninstall'),
            ('p', LOGOUT_EN),
        ],
    },

    'libreoffice': {
        'title': 'LibreOffice extension',
        'description': 'For writing in LibreOffice Writer, on Windows, macOS or Linux.',
        'blocks': [
            ('h2', 'What the extension measures'),
            ('p', 'It measures writing in <strong>LibreOffice Writer</strong>, from version 7.0 onwards. '
                  'Writer lets an extension listen to the keyboard and the mouse, so the counters are as '
                  'fine-grained as in the browser. On Linux, your distribution’s '
                  '<code>libreoffice-script-provider-python</code> package is required.'),
            ('h2', 'Install from the catalogue'),
            ('steps', [
                f'Download the <code>.oxt</code> file from {store("libreoffice", "extensions.libreoffice.org")}.',
                'In Writer: <em>Tools › Extension Manager › Add</em>, then point at the downloaded file.',
                'Restart LibreOffice: a <strong>Certimens</strong> menu appears in Writer.',
            ]),
            ('h2', 'Sign in'),
            ('steps', [
                '<strong>Certimens</strong> menu → the sign-in window opens.',
                'It displays a <strong>short code</strong> and the address of your Certimens space.',
                'Confirm the code in your space, from your browser.',
                'The window closes on your name: you are signed in.',
            ]),
            ('figure', 'pairing', 'What the window shows while you confirm the code.'),
            ('note', 'info', NO_PASSWORD_EN),
            ('h2', 'Check that measurement is running'),
            ('p', 'A document that is not linked yet shows a bar at the top of Writer, with a '
                  '<em>Link…</em> button. Once it is linked, write a few lines then open the Certimens '
                  'menu again: the window names the document being tracked.'),
            ('h2', 'Updates'),
            ('p', 'LibreOffice takes care of it: <em>Tools › Extension Manager › Check for Updates</em> '
                  'offers the most recent version and installs it. LibreOffice’s periodic check looks at '
                  'installed extensions too.'),
            ('advanced', 'Manual installation (advanced)', [
                ('p', 'The catalogue is filled in by hand, a few days after a version. Every version’s '
                      f'<code>.oxt</code> file is available straight away on the '
                      f'<a href="{RELEASES}">releases page</a>, and that is where automatic updates are '
                      'served from.'),
                ('steps', [
                    'Download <code>certimens-libreoffice-X.Y.Z.oxt</code> from the release.',
                    'From the command line: <code>unopkg add certimens-libreoffice-X.Y.Z.oxt</code>, then '
                    'restart LibreOffice.',
                    'For a fleet: <code>unopkg add --shared</code> installs the extension for every user '
                    'of the machine, with administrator rights.',
                ]),
                ('note', 'info', 'However it was installed, the extension then knows how to update '
                                 'itself: it asks its own update feed, not the catalogue.'),
            ]),
            ('h2', 'Log out, uninstall'),
            ('p', LOGOUT_EN),
        ],
    },

    'vscode': {
        'title': 'VS Code extension',
        'description': 'For work handed in as code: the extension measures the project file by file.',
        'blocks': [
            ('h2', 'What the extension measures'),
            ('p', 'It measures writing <strong>file by file</strong> in a project opened under Visual '
                  'Studio Code 1.90 or newer. Dependencies, build output and generated files are '
                  'ignored, and a file only exists on the Certimens side once you have actually written '
                  'in it.'),
            ('h2', 'Install from the Marketplace'),
            ('steps', [
                'In VS Code, open the <em>Extensions</em> view (<code>Ctrl+Shift+X</code>, '
                '<code>Cmd+Shift+X</code> on Mac).',
                f'Search for <strong>Certimens</strong> in {store("marketplace", "the Marketplace")} and '
                'click <em>Install</em>.',
                'The Certimens shield appears in the activity bar, on the left.',
            ]),
            ('note', 'info', 'In one command: <code>code --install-extension certimens.certimens</code>.'),
            ('h2', 'Sign in'),
            ('steps', [
                'Open the Certimens panel, or run <em>Certimens: log in</em> from the command palette.',
                'The panel displays a <strong>short code</strong> and a link to your space.',
                'Confirm the code in your Certimens space.',
                'The panel shows your name, and the status bar reports the files being measured.',
            ]),
            ('figure', 'pairing', 'What the panel shows while you confirm the code.'),
            ('note', 'info', NO_PASSWORD_EN),
            ('h2', 'Check that measurement is running'),
            ('p', 'Write in a file of the project, then look at the status bar at the bottom: it counts '
                  'the files being measured. The access token is kept in the editor’s secret storage, '
                  'never in <code>settings.json</code> — so it goes neither into a git repository nor '
                  'into settings sync.'),
            ('h2', 'Updates'),
            ('p', 'VS Code updates the extension on its own. The panel will tell you once which version '
                  'it has become, with a link to what changed.'),
            ('advanced', 'Manual installation (advanced)', [
                ('p', 'For VSCodium, Cursor, Gitpod, a machine without the Marketplace, or to try a '
                      'version before everyone else.'),
                ('steps', [
                    f'Download <code>certimens-vscode-X.Y.Z.vsix</code> from the '
                    f'<a href="{RELEASES}">releases page</a>.',
                    'In VS Code: <em>Extensions</em> view → <em>…</em> menu → <em>Install from VSIX…</em>, '
                    'then point at the file.',
                    'From the command line: <code>code --install-extension '
                    'certimens-vscode-X.Y.Z.vsix</code>.',
                    f'Editors served by Open VSX find the extension on {store("openvsx", "open-vsx.org")} '
                    'as well.',
                ]),
                ('note', 'warning', 'An extension installed from a <code>.vsix</code> <strong>is not '
                                    'updated</strong>: the next file will have to be installed by hand.'),
            ]),
            ('h2', 'Log out, uninstall'),
            ('p', LOGOUT_EN),
        ],
    },
}


CONTENT = {
    language: {
        'pages': pages,
        'agents': agents,
        'about': ABOUT[language],
        'bottom': BOTTOM[language],
        'lang_switch': LANG_SWITCH[language],
        'login': LOGIN[language],
        'menu': MENU_LABEL[language],
        'nav': NAV_LABEL[language],
        'nav_items': NAV_ITEMS[language],
        'plugins': PLUGINS[language],
        'site_home': SITE_HOME[language],
        'skip': SKIP[language],
        'tagline': TAGLINE[language],
    }
    for language, pages, agents in (('fr', PAGES_FR, AGENTS_FR), ('en', PAGES_EN, AGENTS_EN))
}
