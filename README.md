# Certimens — Agent de rédaction (Google Docs, Word Online, Word, LibreOffice, VS Code)

| Dossier      | Contenu                                                                  |
| ------------ | ------------------------------------------------------------------------ |
| `extension/` | L'extension navigateur (sources, chargeables telles quelles)             |
| `word/`      | Le complément Word (Office Add-in), publié sur GitHub Pages              |
| `libreoffice/` | L'extension LibreOffice Writer (`.oxt`, Python)                        |
| `vscode/`    | L'extension Visual Studio Code (`.vsix`), pour les devoirs rendus en code |
| `scripts/`   | `build.mjs` : tous les paquets dans `dist/` ; `safari.sh` : projet Xcode |
| `store/`     | Visuels et textes des fiches des stores (non inclus dans l'extension)    |
| `legacy/`    | Anciens agents de bureau et « Web Shield », plus utilisés (voir son README) |

Extension navigateur (Manifest V3 : Chrome, Edge, Opera, Brave, Vivaldi, Arc, Firefox, Firefox
pour Android, Safari macOS et iOS) qui mesure la rédaction **directement
dans Google Docs et Word Online**, sans agent de bureau Python, et pousse les mesures au moteur via
`POST /api/files/:id/metrics`, authentifiées par un jeton d'API (Bearer) créé à la connexion et
conservé à la place du mot de passe (l'ancien mot de passe stocké est migré une fois au prochain
envoi, puis effacé).

Aucun texte ni aucune touche n'est enregistré : seulement des compteurs par fenêtre de mesure.

## Fonctionnement

Les chemins ci-dessous sont relatifs à `extension/`.

- `content.js` écoute l'éditeur : dans Google Docs, l'iframe de saisie
  (`.docs-texteventtarget-iframe`) et les clics dans le corps du document ; dans Word Online, il
  tourne dans l'iframe d'édition (`wordeditorframe.aspx` sur `*.officeapps.live.com`) et écoute
  la zone `#WACViewPanel`. Ce qui diffère d'un éditeur à l'autre est décrit dans `EDITORS`. Il reprend les définitions des agents de bureau
  (`legacy/desktop-agents/agent_mac.py`) : flight times < 800 ms, pauses 3–60 s, correction / reformulation / macro
  selon le contexte du Backspace, etc.
- Une fenêtre est vidée après **2 s sans activité**, à **200 frappes**, sur **Ctrl/Cmd+S**, quand
  l'étudiant **quitte le document** (autre onglet ou fenêtre, navigateur réduit) et à la fermeture
  de la page. Sa période va de la première à la dernière activité : l'inactivité n'y est pas
  comptée (le moteur pondère les moyennes par la durée des périodes).
- `background.js` crée au premier envoi un fichier moteur par document Google
  (`POST /api/files`, nommé d'après le titre du doc), puis envoie les mesures. Hors-ligne, elles
  restent dans une file (`chrome.storage.local`) renvoyée chaque minute. Le badge affiche
  `ON`, le nombre de mesures en attente, ou `OFF` (non configuré / identifiants refusés).

### Word Online

- Le document est identifié par le paramètre `WOPISrc` de l'iframe d'édition (stable d'une
  ouverture à l'autre), son nom par le titre affiché dans Word.
- `real_volume` est lu dans la page (texte de `#WACViewPanel_EditingElement`), sans export.
- `focus_losses` ne compte que le masquage de la page (autre onglet, navigateur réduit) : un clic
  dans l'en-tête Microsoft 365 fait perdre le focus à l'iframe sans quitter le document. Passer à
  une autre fenêtre ferme quand même la fenêtre de mesure.
- Les sélecteurs de Word Online ne sont pas documentés par Microsoft : à revérifier si la mesure
  s'arrête après une mise à jour de Word.

## Complément Word

Un **complément Office** (*Office Add-in*, le plugin Word) dans `word/` mesure la rédaction dans
**Word pour Windows et Mac (Microsoft 365, Mac 2019+) et Word sur le web**, avec le même volet
que la popup de l'extension : connexion, fichier Certimens du document, rendu sur un devoir,
envoi du .docx (lu directement dans Word, sans téléchargement).

- `sensor.js` : un complément ne reçoit pas les frappes du document. Chaque modification locale
  (changement de sélection, paragraphe modifié, WordApi 1.6) déclenche une relecture du texte ;
  la différence avec la lecture précédente dit ce qui a été inséré ou effacé. Les modifications
  des co-auteurs sont ignorées. Mêmes metrics que l'extension, sauf `mad_ms`,
  `median_flight_ms` (pas de temps entre frappes) et `focus_losses`. Une « frappe » y est un
  caractère inséré ou effacé ; le détail est en tête du fichier.
- `agent.js` : l'équivalent de `background.js` (file hors-ligne dans `localStorage`, renvoyée
  chaque minute). Chaque document garde son identifiant dans ses réglages (il suit le .docx).
- `taskpane.html` / `taskpane.js` : le volet. Il reste chargé volet fermé (runtime partagé) ;
  une fois le fichier créé, Word rouvre le complément avec le document.
- `index.html` : la page d'accueil du site. Word ne la charge jamais (il va droit à
  `taskpane.html`), mais GitHub Pages ne sert aucun listing de dossier : sans elle, l'adresse
  du site répond 404 alors que tous les fichiers sont bien là. Le build y injecte la version.
- Le complément est une page web servie par **GitHub Pages**
  (`https://certimens.github.io/plugins/word/`, variable `WORD_BASE_URL` du build) : le moteur
  autorise cette origine en CORS sur `/api` (`internal/api/server.go` du moteur,
  `wordAddinOrigins`, avec `https://localhost:3000` pour le développement).
- Le build reprend `ui.css`, `ui.js`, les polices et les icônes de `extension/`.

> Sur Word pour le web, ne pas l'utiliser en même temps que l'extension navigateur : la rédaction
> serait comptée deux fois (le volet le rappelle).

**Tester en local** : `npm run build && npm run word:serve` (HTTPS sur `localhost:3000`,
certificat de développement installé au premier lancement), puis charger
`dist/word-localhost.xml` :

- Word sur le web : *Accueil › Compléments › Plus de compléments › Mes compléments ›
  Charger mon complément* ;
- Windows / Mac : `npx office-addin-debugging start dist/word-localhost.xml desktop`.

Le bouton **Certimens** apparaît dans l'onglet *Accueil*. Pour un moteur local, saisir
`http://localhost:8080` comme adresse du moteur.

**Publier le site sans faire de release** : le complément est une page web, donc il suffit de
republier GitHub Pages. Le workflow `.github/workflows/pages.yml` le fait à la demande, depuis
n'importe quelle branche :

```bash
gh workflow run pages.yml --ref ma-branche     # ou Actions › Word add-in (GitHub Pages) › Run workflow
```

Il construit la branche, valide le manifest et déploie `dist/word/` sur
`https://certimens.github.io/plugins/word/` — les mêmes adresses que la release, donc **rien à
recharger côté Word** : il suffit de fermer et rouvrir le volet. Deux réserves :

- le workflow n'apparaît dans *Actions* (et n'est lançable) qu'une fois `pages.yml` présent sur
  la branche par défaut ; ensuite `--ref` choisit la branche à publier. Si GitHub répond
  *branch is not allowed to deploy to github-pages*, c'est la règle de l'environnement :
  *Settings › Environments › github-pages › Deployment branches* limite le déploiement à la
  branche par défaut, à élargir (ou publier depuis `main`) ;
- c'est le site de production qui est remplacé : les étudiants déjà équipés reçoivent ce build.
  La prochaine release le réécrasera avec celui du tag. Pour un essai qui n'engage personne,
  `npm run word:serve` et `dist/word-localhost.xml` restent la bonne piste.

**Vérifier ce qui est en ligne** : l'adresse du site (`…/plugins/word/`) sert `index.html`, et
chaque fichier se teste directement, sans Word :

```bash
for f in manifest.xml taskpane.html taskpane.js agent.js sensor.js ui.css ui.js; do
  curl -s -o /dev/null -w "%{http_code} $f\n" "https://certimens.github.io/plugins/word/$f"
done
curl -s https://certimens.github.io/plugins/word/manifest.xml | grep -E '<Version>|SourceLocation'
```

Sept `200` et la version attendue dans le manifest : le site est bon. Un `404` **sur tous** les
fichiers veut dire que Pages n'est pas activé (*Settings › Pages › Source : GitHub Actions*) ou
qu'aucun déploiement n'a eu lieu ; un `404` sur un seul fichier vient du build.

Si le volet montre encore l'ancien code, c'est le cache : Pages sert les fichiers avec une
durée de vie de quelques minutes, et Word garde son propre cache (*Insérer › Compléments › Mes
compléments* pour recharger, ou vider `%LOCALAPPDATA%\Microsoft\Office\16.0\Wef` sous Windows,
`~/Library/Containers/com.microsoft.Word/Data/Library/Caches` sous macOS).

## Extension LibreOffice

Une extension Writer en Python (UNO) dans `libreoffice/`, paquet `dist/libreoffice.oxt`
(LibreOffice 7.0+ ; sous Linux, le paquet `libreoffice-script-provider-python` de la
distribution est nécessaire). Contrairement au complément Word, LibreOffice laisse une extension
écouter le clavier et la souris d'un document : **mêmes metrics et mêmes définitions que
l'extension navigateur**, flight times et sorties du document compris.

- `certimens.py` : le composant UNO `fr.certimens.Agent`, démarré au lancement de LibreOffice
  (`Jobs.xcu`) et appelé par le menu **Certimens** de Writer (`Addons.xcu`).
- `pythonpath/certimens_agent/` :
  - `measure.py` : les fenêtres de mesure (la logique de `content.js`), sans LibreOffice ;
  - `sensor.py` : touches et clics du document (`XUserInputInterception`), collages de toute
    origine (commandes `.uno:Paste*` interceptées), sortie de LibreOffice, enregistrement ;
    une barre d'information propose d'associer un document encore inconnu ;
  - `engine.py` : moteur et file hors-ligne (`certimens.json` du profil LibreOffice, lisible
    par l'utilisateur seul), envoyée depuis un fil dédié ; pas de CORS, les appels partent de
    LibreOffice ;
  - `agent.py` : un agent par session, attaché à chaque document Writer ;
  - `dialogs.py` : les fenêtres du menu **Certimens** (l'équivalent de la popup de
    l'extension), construites contrôle par contrôle faute de HTML : connexion, puis fichier
    Certimens du document, devoir et envoi du .docx. Les appels au moteur partent d'un fil
    dédié — sinon LibreOffice resterait figé le temps de la réponse.
- Chaque document garde son identifiant dans ses propriétés personnalisées (il suit le fichier,
  `.odt` comme `.docx`) ; le nom du fichier est répercuté sur le moteur après
  *Enregistrer sous*.
- `tests/` : `npm run test:libreoffice` (sans LibreOffice).

**Envoyer le document** : le bouton *Envoyer le document* exporte le document ouvert au format
.docx par le filtre Word de Writer (`storeToURL`, une copie : le document garde son URL, son
format et son état enregistré) et l'envoie au fichier Certimens. Si cet export est refusé
(filtre absent de l'installation, dossier temporaire en lecture seule), la fenêtre affiche à la
place *Choisir un fichier .docx…*, comme la popup le fait pour Word Online : l'étudiant
enregistre lui-même une copie .docx et la désigne. Dans les deux cas, un nouvel envoi remplace
le document déjà envoyé, et le moteur plafonne la requête à 25 Mio (soit 18 Mo de document).

**Installer** : *Outils › Gestionnaire des extensions › Ajouter* → `libreoffice.oxt`, puis
redémarrer LibreOffice. En ligne de commande : `unopkg add dist/libreoffice.oxt`.

**Publier** : [extensions.libreoffice.org](https://extensions.libreoffice.org) n'a pas d'API :
déposer à la main le `.oxt` de chaque release GitHub (`certimens-agent-X.Y.Z-libreoffice.oxt`).
L'identifiant `fr.certimens.agent` (`description.xml`) ne doit plus changer.

## Extension VS Code

Une extension pour **Visual Studio Code** dans `vscode/`, paquet `dist/certimens-vscode.vsix`
(VS Code 1.90+), pour les devoirs qui se rendent en code plutôt qu'en traitement de texte. C'est
le seul agent qui mesure **un projet entier, fichier par fichier** : chaque fichier écrit devient
un fichier Certimens distinct, avec ses propres fenêtres de mesure — ce qu'un enseignant corrige,
ce sont des fichiers, pas un projet en bloc.

- `sensor.js` : les fenêtres de mesure, une instance par document ouvert, sans aucune dépendance
  à l'API de VS Code — c'est ce qui rend les règles vérifiables sans éditeur
  (`tests/vscode-sensor.test.mjs`).
- `engine.js` : moteur et file hors-ligne (stockage global de l'extension), jeton d'API dans le
  **SecretStorage** de l'éditeur et non dans `settings.json`, qui se synchronise entre machines et
  se lit par-dessus l'épaule. Pas de CORS : les appels partent de Node, pas d'une page.
- `extension.js` : l'hôte. Il traduit les événements de l'éditeur en mesures, tient un capteur par
  document, la barre d'état et les commandes.
- `panel.js` : le panneau latéral (webview), le même écran que la popup de l'extension et que le
  volet Word ; il réutilise `ui.css`, ne détient aucun état et ne voit jamais le jeton.

VS Code ne livre pas les frappes : il signale **ce qui change** dans le document
(`onDidChangeTextDocument`, un événement par modification, avec le texte inséré et la longueur de
ce qu'il remplace) et **d'où vient le curseur** (`onDidChangeTextEditorSelection`, avec l'origine
du déplacement : clavier, souris ou commande). C'est plus que ce que donne Office — l'origine d'un
déplacement étant connue, la règle « une suppression solde le déplacement qui la précède » y tient
— et moins qu'un navigateur, aucune touche n'étant jamais vue. Un déplacement qui suit une frappe
de moins de 50 ms est l'écho du curseur, pas une navigation : sans cette règle,
`navigation_jumps` suivrait exactement `total_keystrokes`.

**Rien n'est créé tant que l'étudiant n'a pas écrit** : ouvrir un projet de quatre cents fichiers
n'en crée aucun côté moteur. Le réglage `certimens.exclude` écarte en plus les dépendances, la
sortie de compilation et les fichiers générés.

Un fichier est identifié par un condensé du chemin du dossier de travail et son chemin **relatif**
dans le projet ; ce qui part au moteur est `projet/chemin/du/fichier`, jamais le chemin absolu,
qui nomme le compte de l'étudiant. Un fichier renommé ou déplacé garde ses mesures : le fichier
moteur est renommé (`PUT /api/files/:id`), pas remplacé.

**Rendre un fichier** : la commande *Certimens : rendre ce fichier* (palette de commandes, ou le
bouton du panneau) envoie le fichier ouvert (`PUT /api/files/:id`, base64, 18 Mo maximum) puis
propose les devoirs auxquels l'étudiant est rattaché. C'est **la seule** action qui fait sortir du
texte du poste ; la mesure, elle, n'envoie que des compteurs.

**Installer** : `code --install-extension dist/certimens-vscode.vsix`, ou *Extensions › … ›
Installer à partir d'un VSIX*. En développement, `npm run vscode:dev` construit le paquet et ouvre
une fenêtre VS Code sur `dist/vscode/` — le dossier `vscode/` seul ne suffit pas, `media/` (la
feuille de style, les polices et l'icône partagées avec l'extension navigateur) est rempli par le
build.

**Côté moteur** : la famille de client `vscode` doit être connue de
`internal/file/adapters/inbound/http/ingestion.go` (dépôt `Certimens/engine`), sinon chaque envoi
est marqué `client_unknown` sur le fichier. L'agent s'annonce par son `User-Agent`
(`Certimens-VSCode/X.Y.Z (VS Code … ; Node …)`) : contrairement à un navigateur ou à `urllib`,
Node n'ajoute de lui-même aucun en-tête qui le trahisse.

## Langues

Les agents parlent **français et anglais**. Le français est la langue par défaut : le produit est
vendu à l'enseignement supérieur français, et une locale inconnue y atterrit plutôt que dans une
langue que l'établissement n'utilise pas.

La règle est celle du moteur (`internal/user/domain.NormalizeLanguage`) : **une étiquette qui
commence par `en` donne l'anglais, tout le reste donne le français.** Elle est réimplémentée dans
chaque agent plutôt que demandée au moteur — un agent doit choisir sa langue avant d'avoir jamais
joint le moteur. La langue vient, dans cet ordre :

1. **le compte Certimens**, dont la langue arrive avec la réponse de connexion (`me.language`) et
   est conservée dans la configuration de l'agent ;
2. **la langue de l'hôte** — le navigateur, Word, LibreOffice, l'éditeur ;
3. **le français**.

Le compte l'emporte parce que c'est la langue que l'étudiant a choisie dans son espace, et celle
de ses e-mails.

| Agent | Textes de l'interface | Fiche et manifest |
| --- | --- | --- |
| Navigateur | `extension/i18n.js` | `extension/_locales/{fr,en}/messages.json` (`__MSG_…__` dans le manifest) |
| Word | `extension/i18n.js`, partagé et copié par le build | `<Override Locale="en-us">` dans `word/manifest.xml` |
| LibreOffice | `libreoffice/pythonpath/certimens_agent/i18n.py` | `description.xml` et `description/description-{fr,en}.txt` |
| VS Code | `vscode/i18n.js` | `vscode/package.nls.json` (français, le repli) et `package.nls.en.json` |

Le manifest d'un agent est lu **avant** notre code : c'est l'hôte qui le traduit, d'après sa
propre langue d'interface. Le nom dans la barre d'outils peut donc être anglais pendant que le
volet est français, si le compte dit l'anglais et le navigateur le français. Rien d'autre n'est
possible pour un texte que l'hôte lit avant nous.

Aucune page ne porte plus de texte en dur : `data-i18n="clé"` côté extension et Word, injection à
la construction côté VS Code. Les suites vérifient la parité des clés, les variables (`{title}`,
`{count}`) et le fait qu'une clé commune à deux agents porte bien le **même** message
(`tests/i18n.test.mjs`, `libreoffice/tests/test_i18n.py`).

Ajouter une troisième langue commence **côté moteur** : `domain.NormalizeLanguage` n'en connaît
que deux, et l'étudiant choisirait sinon dans son espace une langue que le moteur refuse
d'enregistrer.

## Metrics envoyées

| Type                      | Mesure                                                                 |
| ------------------------- | ---------------------------------------------------------------------- |
| `total_keystrokes`        | Frappes (hors répétition automatique)                                  |
| `effective_time_seconds`  | Temps de frappe effectif                                               |
| `immediate_corrections`   | Backspace/Suppr en cours de frappe, Ctrl/Cmd+Z                         |
| `deferred_reformulations` | **Première** Backspace/Suppr après un déplacement au clavier, ou remplacement d'une sélection Maj+flèches |
| `macro_revisions`         | **Première** Backspace/Suppr après un clic, Ctrl/Cmd+X, ou remplacement d'une sélection Ctrl/Cmd+A ou tracée à la souris |
| `navigation_jumps`        | Flèches, Début/Fin, Page préc./suiv., clics dans le document          |
| `cognitive_pauses`        | Reprises après 3 s à 5 min d'inactivité                                |
| `mad_ms`                  | Écart absolu médian des flight times                                   |
| `total_injected_chars`    | Caractères collés ou glissés (collages > 15 caractères)                |
| `real_volume`             | Caractères du document (export texte Google Docs, sans sauts de ligne) |
| `paste_events` *(nouveau)*      | Nombre de collages/glisser-déposer, quelle que soit leur taille  |
| `focus_losses` *(nouveau)*      | Nombre de sorties du document pendant la fenêtre                 |
| `median_flight_ms` *(nouveau)*  | Temps médian entre deux frappes (cadence)                        |

Une suppression **solde le déplacement qui la précède** : la première touche Suppr après un clic
est une révision massive, après une flèche une reformulation différée, et **les suivantes sont des
corrections immédiates** — on efface là où on se trouve. Sans cette remise à zéro (le
comportement hérité des agents de bureau), un seul clic suffisait à faire compter toute une rafale
de suppressions en reformulations, et `immediate_corrections` restait à zéro chez un étudiant qui
clique avant de corriger. Le complément Word, lui, travaille par différences de texte et n'a
jamais eu ce biais.

**Remplacer une sélection est une suppression.** Taper ou coller par-dessus une sélection efface
tout ce qu'elle couvre : c'était jusqu'ici invisible, le capteur ne regardant que Backspace,
Suppr, Ctrl+X et Ctrl+Z. Une sélection en cours est désormais suivie — Ctrl/Cmd+A ou un tracé à la
souris pour un bloc, Maj + touche de déplacement pour une portion ciblée — et la frappe ou le
collage qui la remplace est compté à cette échelle. Maj seule ne sélectionne rien (c'est aussi
ainsi qu'on tape les majuscules), un déplacement sans Maj ou un clic annule la sélection, et elle
n'est décomptée qu'une fois. Le cas « tout sélectionner puis coller la réponse » ne comptait
auparavant qu'une injection, jamais une révision.

Le complément Word n'est pas concerné : il travaille par différences de texte et voyait déjà le
remplacement. L'agent LibreOffice suit la même logique que l'extension, à ceci près que son
gestionnaire de clic ne donne pas de coordonnées — une sélection tracée à la souris n'y est donc
pas détectable. L'extension VS Code voit le remplacement dans la modification elle-même (elle
porte la longueur de ce qu'elle efface) et connaît l'origine du déplacement, donc les trois cases
de révision y sont distinguées comme dans le navigateur.

**`paste_events` n'est pas envoyée par l'extension VS Code.** Une insertion faite en un coup peut
y être un collage, un extrait de code ou une complétion acceptée — d'IntelliSense comme d'un
assistant — et l'éditeur ne dit pas laquelle. Les caractères comptent bien dans
`total_injected_chars`, c'est même là qu'une réponse générée se voit ; le *nombre* de collages,
lui, serait faux, et une mesure fausse vaut moins que pas de mesure. Les flight times ne
retiennent pour la même raison que les modifications de la taille d'une frappe : une complétion
acceptée d'un coup se lirait sinon comme un dactylographe impossiblement rapide et régulier.

**Une pause va de 3 s à 5 minutes.** Le plafond était à 60 s, ce qui faisait compter *rien du
tout* — ni pause, ni temps effectif — toute délibération de plus d'une minute, alors que s'arrêter
une à cinq minutes sur un paragraphe est justement la marque de quelqu'un qui compose. Au-delà de
cinq minutes, l'étudiant a quitté le document : ce n'est plus de la friction cognitive. Le plafond
du **temps effectif** reste à 60 s (`ACTIVE_GAP_MAX_S`) : c'est une autre règle, les deux ne
partageaient la même constante que par accident. Un long silence compte donc comme une pause sans
être crédité comme du temps de frappe.

La **répétition automatique ne compte pas** : garder Suppr enfoncée pour effacer un mot vaut une
seule suppression (c'est la définition des agents de bureau, reprise telle quelle).

Les trois dernières metrics sont déclarées dans `internal/db/file.go` du moteur. Face à un moteur
qui les refuse (`400 metric_type_unknown`), l'agent les retire et renvoie le reste ; il réessaie à
la prochaine connexion. Tout autre `400` (période invalide, corps mal formé) ne les désactive
pas — c'était le cas avant, et `focus_losses` ne repartait jamais.

## Suspendre la mesure

Les quatre agents ont un bouton qui **suspend la mesure** : la popup de l'extension, le volet du
complément Word, la fenêtre **Certimens** de LibreOffice et le panneau VS Code (ou la commande
*Certimens : suspendre ou reprendre la mesure*).

Le comportement est le même partout :

- **la mesure s'arrête, pas l'envoi.** La file continue de partir : ce qui a été mesuré avant la
  pause appartient déjà au moteur. Le retenir ne ferait que transformer la pause en un lot tardif,
  que le moteur signalerait (`late_ingestion`, `multi_window_batch`) ;
- **la fenêtre en cours est vidée** au moment de suspendre : rien de mesuré n'est perdu, rien ne
  s'accumule derrière un capteur suspendu ;
- **pendant la pause, rien n'est compté** : ni frappe, ni temps effectif, ni pause cognitive.
  Ce n'est pas « mesurer sans envoyer » ;
- **la suspension dure** : elle survit au redémarrage du navigateur, de Word, de LibreOffice ou de
  VS Code, et seule une reprise explicite la lève. L'état est affiché en permanence — badge `II`
  sur l'icône de l'extension, bandeau dans le volet, barre d'état de VS Code — parce que le seul
  état qu'un agent de mesure ne doit jamais produire, c'est « suspendu mais qui en a l'air actif ».

La suspension est **globale à l'agent**, pas par document : c'est l'étudiant qui suspend.

L'état s'affiche **une fois** : le bandeau permanent le porte, et le message transitoire ne
confirme que la reprise — elle, ne laisse rien à l'écran. Dans le panneau VS Code, la ligne d'état
ne parle pendant une pause que s'il reste des mesures d'avant à envoyer.

Côté moteur, rien n'est déclaré : le trou reste lisible dans le nombre de fenêtres et dans
l'`unmeasured_ratio` du fichier — la part du document qu'aucune mesure n'explique. Un devoir écrit
pour moitié pendant une pause le montre là.

### Mode debug

La page d'options a une case **Mode debug**. Activée, elle :

- journalise dans la console du document chaque suppression et la case dans laquelle elle tombe
  (correction immédiate, reformulation différée, révision massive), les collages, les sorties du
  document et chaque fenêtre envoyée ;
- garde les 30 dernières fenêtres de mesure dans la page d'options (heure, raison de l'envoi,
  compteurs non nuls), à comparer avec ce qu'affiche le moteur.

Des compteurs uniquement : ni texte ni touches n'y apparaissent, la promesse de l'extension reste
la même. L'état « mesures étendues refusées par le moteur » est affiché dans la section
*Synchronisation*.

## Installation (développement)

- **Chrome/Edge** : `chrome://extensions` → mode développeur → *Charger l'extension non
  empaquetée* → le dossier `extension/`.
- **Firefox** : `about:debugging` → *Charger un module temporaire* → `extension/manifest.json`.
- **Opera, Brave, Vivaldi, Arc** : comme Chrome (`opera://extensions`, `brave://extensions`…).
- **Safari** (macOS, Xcode) : `npm run build && npm run build:safari`, ouvrir le projet
  `dist/safari-xcode/Certimens/Certimens.xcodeproj`, lancer le schéma *Certimens (macOS)*, puis
  dans Safari : *Réglages › Développement › Autoriser les extensions non signées* et activer
  l'extension dans *Réglages › Extensions*. Le schéma *Certimens (iOS)* la lance sur iPhone/iPad.

Pour un moteur local, saisir `http://localhost:8080` comme adresse du moteur : l'extension
demande alors l'accès à cet hôte (`optional_host_permissions`).

Un clic sur l'icône ouvre une **popup** : l'étudiant s'y connecte (identifiants vérifiés par
`POST /api/auth/login` avant d'être enregistrés) puis, sur un document Google Docs, crée son
fichier Certimens (`POST /api/files`, nom modifiable, pré-rempli avec le titre du doc) et
l'ouvre dans le moteur. Elle propose aussi de le rendre sur un devoir auquel l'étudiant est
rattaché (`GET /api/assignments`, puis `PUT /api/files/:id` avec `assignment_id`) ; ce choix
n'apparaît que pour les comptes au rôle `student` (vérifié par `GET /api/auth/me`).

La popup envoie aussi le **document .docx** au fichier moteur (`PUT /api/files/:id` avec
`document` en base64, 18 Mo maximum) : dans Google Docs en un clic (export `format=docx` avec la
session de l'étudiant) ; dans Word Online, l'iframe d'édition n'a pas accès au fichier, l'étudiant
choisit donc une copie téléchargée (*Fichier › Enregistrer sous › Télécharger une copie*). Un
nouvel envoi remplace le document précédent.

Un document **renommé dans l'éditeur** (Google Docs ou Word Online, titre relevé toutes les 3 s)
est renommé côté moteur (`PUT /api/files/:id` avec `document_name`), y compris s'il a été renommé
hors-ligne : le renommage part au prochain envoi. Un nom choisi dans la popup est conservé tant que
le titre du document ne change pas. Quand l'étudiant est connecté et ouvre un
document encore inconnu de l'extension, la popup s'ouvre d'elle-même (une fois par document et par
session de navigateur, Chrome 127+) ; si le navigateur le refuse (Firefox), l'icône de l'onglet
affiche `NEW`. Sans création explicite, le fichier est créé au premier envoi de mesures.

La page d'options s'ouvre à l'installation : adresse du moteur (par défaut
`https://monespace.certimens.fr`), e-mail et mot de passe de l'étudiant.

> Ne pas l'utiliser en même temps que l'agent de bureau + Web Shield (`legacy/`) sur Google
> Docs : les frappes seraient comptées deux fois.

## Développement

```bash
npm ci
npm run lint          # ESLint
npm test              # tous les tests (capteurs JavaScript et extension LibreOffice)
npm run test:js       # tests des capteurs navigateur et Word, sans navigateur ni Word
npm run build         # dist/chrome.zip, dist/firefox.zip, dist/safari.zip
npm run lint:firefox  # validation addons.mozilla.org du paquet Firefox (après build)
npm run build:safari  # macOS : projet Xcode dans dist/safari-xcode/, compilé sans signature
npm run lint:word     # validation Microsoft du manifest Word (après build, réseau requis)
npm run word:serve    # complément Word sur https://localhost:3000 (après build)
npm run test:libreoffice  # tests de l'extension LibreOffice (Python 3)
npm run vscode:dev    # construit le paquet VS Code et ouvre une fenêtre dessus
```

### Versions

La version vient de git, il n'y a donc rien à monter à la main :

| Build                      | Version des paquets                                            |
| -------------------------- | -------------------------------------------------------------- |
| Release (tag `vX.Y.Z`)     | `X.Y.Z`                                                          |
| Branche, PR, build local   | dernier tag + commit, par exemple `1.4.2-a9085f3`               |

Chrome n'accepte qu'une version **numérique** : le repère lisible (`1.4.2-a9085f3`) va donc dans
`version_name`, que les navigateurs Chromium et Safari affichent et qu'addons.mozilla.org accepte.
Word impose quatre nombres (`X.Y.Z.0`) et ne peut pas porter le commit ; LibreOffice, lui, accepte
la chaîne complète. Le build écrit aussi ce repère dans `dist/VERSION`, que la CI affiche.

La `version` de `extension/manifest.json` ne sert plus que de valeur de repli, quand le dépôt n'a
encore aucun tag.

`extension/manifest.json` sert à tous les navigateurs. Le build n'en garde, pour chacun, que ce
qu'il comprend : Chrome et Safari n'ont que `background.service_worker` et pas de
`browser_specific_settings`, Firefox n'a que `background.scripts`. `chrome.zip` sert aussi à
Edge, Opera et aux autres navigateurs Chromium, qui installent l'extension depuis leur store ou
depuis le Chrome Web Store.

Safari n'accepte une extension qu'embarquée dans une app : `scripts/safari.sh` la convertit
(`xcrun safari-web-extension-converter`) en app macOS + iOS, identifiant
`fr.certimens.agent`.

### Charte graphique

Les plugins suivent la **même direction artistique que le moteur** (`docs/charte-graphique.md`
du dépôt du moteur, appliquée dans l'application par `ui/src/theme.ts`) : Plus Jakarta Sans avec
des titres en 800 sur un corps en 500, l'ardoise `#1E293B` comme couleur dominante et pour les
actions, l'or laiton `#C5A059` en accent unique — le mot-marque « Certi**mens** », jamais du
texte sur blanc (les liens prennent l'or sombre `#705E3A`) —, un fond `#F8FAFC` et des surfaces
plates posées sur un filet `#E5E5E5`.

| Où | Fichier |
| --- | --- |
| Popup, page d'options, volet Word | `extension/ui.css` (les variables CSS de `:root` ; rien en dur ailleurs) |
| Marque | `store/brand-mark.png` — l'écu doré du site, copie de `ui/public/logo.png` du moteur |
| Icônes et visuels de boutique | `scripts/brand-assets.mjs`, régénérés depuis la marque |

Les couleurs de verdict (vert, orange, rouge) portent du sens et non de la marque : le badge de
l'extension et les alertes les gardent telles quelles.

Le script redessine les icônes (16, 32, 48 et 128 px pour l'extension, 64 et 80 px pour Word)
et les visuels de `store/`. Il ne fait pas partie du build, qui n'a pas à en dépendre : il
demande `sharp` et, pour le texte des visuels, Plus Jakarta Sans installée sur la machine (le
dépôt ne livre que les `.woff2`, que fontconfig ne lit pas).

```
npx --yes --package sharp -- node scripts/brand-assets.mjs
```

## CI et publication

- **CI** (`.github/workflows/ci.yml`) : lint, build et validation Firefox sur chaque branche et
  PR ; les zips sont joints au run (artefact `extension`), comme le `.oxt` LibreOffice et le
  `.vsix` VS Code (artefacts `certimens-libreoffice` et `certimens-vscode`). Un job macOS
  convertit le paquet Safari, compile l'app sans signature et joint le projet Xcode (artefact
  `safari-xcode`).
- **Dépendances** (`.github/dependabot.yml`) : Dependabot suit chaque lundi les paquets npm de
  l'outillage et les actions des workflows (les mises à jour mineures et correctives arrivent
  groupées, les majeures séparément). Rien pour l'extension LibreOffice : son code Python n'a que
  la bibliothèque standard.
- **Pages** (`.github/workflows/pages.yml`) : publie le site du complément Word à la demande
  (`gh workflow run pages.yml --ref ma-branche`), sans release ni tag. Même cible que la
  release, un seul déploiement à la fois (groupe de concurrence `github-pages`).
- **Release** (`.github/workflows/release.yml`) : un tag `vX.Y.Z` relance la CI, qui construit
  **une seule fois** les paquets de tous les navigateurs. C'est **le tag qui donne la version** à
  tous les paquets : rien n'est à modifier à la main avant de le poser. Ensuite :
  1. une release GitHub `vX.Y.Z` est créée avec ces paquets et leurs empreintes :
     `certimens-agent-X.Y.Z-{chrome,firefox,safari,safari-xcode}.zip`, `SHA256SUMS.txt` ;
  2. le complément Word est publié sur GitHub Pages (le manifest Word est joint à la release) :
     les étudiants ont la nouvelle version à la prochaine ouverture de Word, sans repasser par
     AppSource tant que le manifest ne change pas ;
  3. l'extension LibreOffice (`certimens-agent-X.Y.Z-libreoffice.oxt`) est jointe à la release,
     à déposer à la main sur extensions.libreoffice.org ;
  4. l'extension VS Code (`certimens-agent-X.Y.Z-vscode.vsix`) est jointe à la release et publiée
     sur le Visual Studio Marketplace si `VSCE_PAT` est configuré. Le Marketplace n'accepte que
     des versions `X.Y.Z` : un build de branche, versionné `X.Y.Z-commit`, n'est donc jamais
     publiable — c'est voulu ;
  5. ces mêmes fichiers sont publiés sur le Chrome Web Store, addons.mozilla.org et, s'ils sont
     configurés, Edge Add-ons et Opera Add-ons (`publish-browser-extension`), un job par store.
     Un store en échec ne bloque ni les autres ni la release GitHub : relancer son job seul
     (*Re-run failed jobs*).
- **Safari** : publication à la main depuis Xcode (voir plus bas), à partir du
  `safari-xcode.zip` de la release pour garder la même version que les autres stores.

Publier une version :

```bash
git tag v1.5.0
git push origin v1.5.0
```

Les deux stores relisent chaque version avant de la mettre en ligne (de quelques heures à
quelques jours).

### Mise en place (une seule fois)

La **première** publication se fait à la main dans chaque store ; la CI ne sait que mettre à
jour une extension existante. Chaque fiche demande une adresse d'assistance : partout
`contact@certimens.fr`, avec `https://certimens.fr` comme site. Les paquets portent le nom et la
description dans les deux langues, mais **aucune boutique ne traduit la fiche à partir du
paquet** : chacune a un onglet par langue, à remplir à la main (textes dans `store/`).

**Chrome Web Store**

1. Créer un compte développeur (frais uniques de 5 $) sur le
   [tableau de bord](https://chrome.google.com/webstore/devconsole).
2. Téléverser `dist/chrome.zip`, remplir la fiche (description, capture
   `store/chrome-screenshot-1280x800.png`, confidentialité : justifier chaque permission et
   déclarer les données collectées, textes dans `store/chrome-web-store.md`), soumettre.
3. Relever l'**ID de l'extension** (32 lettres) et l'**ID d'éditeur** (*Compte* dans le tableau
   de bord).
4. Dans Google Cloud : activer la *Chrome Web Store API*, créer un compte de service et une clé
   JSON, puis ajouter l'e-mail du compte de service dans le tableau de bord du Chrome Web Store
   (*Compte* › accès à l'API).

**Firefox (addons.mozilla.org)**

1. Créer un compte sur le [Developer Hub](https://addons.mozilla.org/developers/).
2. Soumettre `dist/firefox.zip` (*Sur ce site*). L'ID `agent@certimens.fr` vient du manifest :
   il ne peut plus changer une fois publié.
3. Générer les clés d'API : *Tools › Manage API Keys* (JWT issuer et JWT secret).

**Edge Add-ons** (facultatif)

1. Créer un compte dans le [Partner Center](https://partner.microsoft.com/dashboard/microsoftedge)
   (gratuit), soumettre `dist/chrome.zip`.
2. Relever le **Product ID**, puis *Publish API* : activer l'API v1.1, relever le **Client ID**
   et créer une **API key**.

**Opera Add-ons** (facultatif)

Sans store dédié, Opera installe aussi les extensions du Chrome Web Store (*Install Chrome
Extensions*). Pour une fiche sur [addons.opera.com](https://addons.opera.com/developer/) :
soumettre `dist/chrome.zip` avec l'image promotionnelle `store/opera-300x188.png`, relever l'ID
du paquet. Opera n'a pas d'API : la CI utilise le
cookie `sessionid` du compte développeur, à renouveler quand il expire.

**Visual Studio Marketplace**

1. Créer une organisation sur [Azure DevOps](https://dev.azure.com) avec le compte Microsoft de
   Certimens, puis un **éditeur** (*publisher*) `certimens` sur le
   [portail Marketplace](https://marketplace.visualstudio.com/manage) — l'identifiant doit être
   celui du champ `publisher` de `vscode/package.json`, il ne change plus une fois publié.
2. Créer un **jeton d'accès personnel** (Azure DevOps › *User settings › Personal access tokens*)
   pour *All accessible organizations*, portée *Marketplace › Manage*, et l'enregistrer dans le
   secret `VSCE_PAT` du dépôt.
3. Première publication à la main : `npx vsce publish --packagePath dist/certimens-vscode.vsix`.
   Les suivantes partent de la release.

**Open VSX** (facultatif, pour VSCodium, Cursor et Gitpod) : dépôt distinct de Microsoft, sans
publication automatisée ici — déposer le `.vsix` de la release à la main sur
[open-vsx.org](https://open-vsx.org).

**Safari (App Store)**

1. Adhérer à l'[Apple Developer Program](https://developer.apple.com/programs/) (99 $/an).
2. Sur un Mac : `npm run build && npm run build:safari`, ouvrir le projet Xcode, choisir
   l'équipe dans *Signing & Capabilities* des quatre cibles (app et extension, macOS et iOS).
3. *Product › Archive* pour chaque plateforme, puis *Distribute App › App Store Connect*.
4. Dans [App Store Connect](https://appstoreconnect.apple.com), remplir la fiche
   (confidentialité comprise) et soumettre. À chaque version, recommencer à l'étape 2.

**Word (AppSource)**

1. Activer GitHub Pages sur le dépôt : *Settings › Pages › Source : GitHub Actions*. Sur un
   dépôt privé, Pages demande un plan GitHub payant (Team ou Enterprise).
2. Publier une première release (le site doit être en ligne pour la validation).
3. Créer un compte dans le [Partner Center](https://partner.microsoft.com/dashboard) (programme
   *Microsoft 365 et Copilot*, gratuit), nouvelle offre *Complément Office*, envoyer
   `certimens-agent-X.Y.Z-word-manifest.xml` de la release.
4. Remplir la fiche avec `store/appsource.md` et `store/appsource-logo-300x300.png`, et donner
   un compte de test aux validateurs de Microsoft.

Une fois publié, seul un changement du manifest (nom, icônes, autorisations, adresses) repasse
par la validation ; le code, lui, est pris sur GitHub Pages à chaque ouverture.

**GitHub** (dépôt › *Settings › Secrets and variables › Actions*)

| Nom                                   | Type     | Valeur                                           |
| ------------------------------------- | -------- | ------------------------------------------------ |
| `CHROME_EXTENSION_ID`                 | variable | ID de l'extension sur le Chrome Web Store        |
| `CHROME_PUBLISHER_ID`                 | variable | ID d'éditeur du Chrome Web Store                 |
| `CHROME_SERVICE_ACCOUNT_CLIENT_EMAIL` | secret   | `client_email` de la clé JSON du compte de service |
| `CHROME_SERVICE_ACCOUNT_PRIVATE_KEY`  | secret   | `private_key` de la même clé                     |
| `FIREFOX_JWT_ISSUER`                  | secret   | JWT issuer d'addons.mozilla.org                  |
| `FIREFOX_JWT_SECRET`                  | secret   | JWT secret d'addons.mozilla.org                  |
| `EDGE_PRODUCT_ID`                     | variable | Product ID Edge Add-ons (vide : Edge ignoré)     |
| `EDGE_CLIENT_ID`                      | variable | Client ID de la Publish API Edge                 |
| `EDGE_API_KEY`                        | secret   | API key de la Publish API Edge                   |
| `OPERA_PACKAGE_ID`                    | variable | ID du paquet Opera (vide : Opera ignoré)         |
| `OPERA_SESSION_ID`                    | secret   | Cookie `sessionid` d'addons.opera.com            |
