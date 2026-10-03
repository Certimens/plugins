# Complément Word

Un **complément Office** (*Office Add-in*) dans `word/`, qui mesure la rédaction dans **Word pour
Windows et Mac (Microsoft 365, Mac 2019+) et Word sur le web**, avec le même volet que la popup
de l'extension : appairage (un code court, **jamais de mot de passe** — voir
[moteur.md](moteur.md#adresse-et-authentification)), document Certimens du document, rendu sur un
devoir, envoi du .docx
(lu directement dans Word, sans téléchargement). Comme la popup, il retire le rendu et l'envoi
quand l'**échéance du devoir est passée** ([moteur.md](moteur.md)).

## Les fichiers

- `sensor.js` : un complément ne reçoit pas les frappes du document. Chaque modification locale
  (changement de sélection, paragraphe modifié, WordApi 1.6) déclenche une relecture du texte ;
  la différence avec la lecture précédente dit ce qui a été inséré ou effacé. Les modifications
  des co-auteurs sont ignorées. Mêmes définitions que l'extension, moins ce qu'Office ne laisse
  pas voir : ni rythme (`flight`, `dwell`), ni sorties du document (`exits`, `back_keys`,
  `back_chars`), ni silences courts (voir *Écarts assumés* dans [mesures.md](mesures.md)). Une « frappe » y est
  un caractère inséré ou effacé ; le détail est en tête du fichier. Office ne signalant ni
  l'enregistrement ni la sortie du document, ses fenêtres partent sur l'inactivité, sur les
  200 frappes et à la fermeture du volet.
- `agent.js` : l'équivalent de `background.js` (file hors-ligne dans `localStorage`, renvoyée
  chaque minute, par paquets quand elle a été remplie hors ligne). Chaque document garde son identifiant dans ses réglages, il suit donc le .docx —
  avec les deux contrôles décrits plus bas, qui sont ceux de l'extension LibreOffice, mot pour mot.
- `taskpane.html` / `taskpane.js` : le volet. Il reste chargé volet fermé (runtime partagé) ;
  une fois le fichier créé, Word rouvre le complément avec le document.
- `index.html` : la page d'accueil du site. Word ne la charge jamais (il va droit à
  `taskpane.html`), mais GitHub Pages ne sert aucun listing de dossier : sans elle, l'adresse du
  site répond 404 alors que tous les fichiers sont bien là. Le build y injecte la version.

## Ce que ce capteur envoie

Le corps d'une mesure est le même pour les quatre agents ([moteur.md](moteur.md) le décrit,
[mesures.md](mesures.md) en donne les définitions) : une fenêtre part avec son numéro dans une
**session**, ses deux horloges, le **déroulé** de ce qui s'y est passé (`runs`), les quelques
classements que seul le capteur sait faire (`counts`), le **texte lu** (`text`) et les cumuls de
la session (`sum`). Le moteur **déduit** du déroulé les frappes, les collages, les caractères
injectés, les restitutions et les pauses : aucun de ces nombres ne part. Ce que le complément en
fait tient à ce qu'il est — un capteur par différences :

- **La session est celle d'une instance du volet.** Elle s'ouvre à la première chose comptée et
  se ferme quand la mesure s'arrête : suspension, déconnexion, fermeture du volet. Reprendre en
  ouvre une autre, numérotée depuis zéro. Son nom est tiré au hasard (`SESSION_ID_BYTES`,
  128 bits), ne vient ni du compte ni du poste, et ne vit qu'en mémoire — la seule copie qui lui
  survit est celle que porte une fenêtre en file. La suspension étant partagée par tous les
  documents ouverts et leur mémoire ne l'étant pas, un capteur apprend celle qu'un autre volet a
  décidée **en la demandant**, à son événement suivant ou à sa relecture suivante (20 s au plus) :
  il scelle alors la fenêtre qu'il avait ouverte, avec le mot `end`.
- **Le numéro et les cumuls sont pris au scellement**, dans `flush()`, que la fenêtre parte ou
  non. Les cumuls (`sum` : `keys`, `chars`, `pastes`) sont **tirés du déroulé** par la même
  déduction que celle du moteur (`tally`) — c'est aussi elle qui dit si une fenêtre porte quelque
  chose et quand elle atteint les 200 frappes : le capteur ne tient aucun compte de frappes ou
  de collages à côté de ses suites, donc rien qui puisse les contredire. Un collage n'entre dans
  `chars` qu'au-delà de `INJECTION_MIN_CHARS` caractères. Deux volets ouverts sur le même
  document sont deux capteurs, donc deux sessions : aucun ne peut numéroter une fenêtre de
  l'autre, et le bail de vidage n'a rien à arbitrer là-dessus — l'instance qui vide la file
  envoie les fenêtres des autres telles qu'elles ont été scellées.
- **Les deux horloges, et les durées sur une seule.** `at` est l'heure du poste à la première
  activité de la fenêtre, `mono` le même instant sur `performance.now()` compté depuis le début
  de la session. `ms` (la durée, au moins `1000`), `active` (le temps de frappe effectif) et les
  silences sont tous lus sur l'horloge monotone : une durée ne bouge pas avec l'heure du poste.
- **Le déroulé a une suite par différence** : `["type", n, 0]` pour ce qui est inséré à la
  taille d'une frappe, `["erase", n, 0]` pour ce qui est retiré, `["paste", n]` pour un collage,
  `["self", n]` pour une restitution — suivie d'un `["other", 1, 0]` quand elle ne remplace
  rien, la frappe pour laquelle elle compte. Dans une même différence, ce qui est retiré précède
  ce qui est posé. Deux suites `type`, `erase`, `other` ou `move` qui se suivent n'en font
  qu'une, et une suite `type` **ne se coupe jamais sur ce qui a été tapé** : une espace, un
  retour à la ligne et une lettre sont du même genre. Un collage et une restitution ne
  fusionnent jamais : une suite, un geste — c'est ce qui laisse lire le plus gros collage.
- **Aucune durée de suite** (`ms` à `0`) : les instants que tient le capteur sont ceux des
  événements de Word, pas des touches. Pour la même raison, **ni `flight` ni `dwell`**.
- **Un `["gap", ms]` par silence de plus de 3 s** (`SILENCE_RESOLUTION_MS`) entre deux
  différences tapées, à sa durée réelle, sans plafond : de la dernière différence tapée au
  premier événement de la suivante. Le capteur ne le classe pas et ne compte aucune pause — le
  silence est le fait, le moteur y lit une pause ou un départ. En dessous de ce seuil, ce qui
  serait mesuré est l'espacement des événements de Word : ces silences ne sont pas émis, et
  chaque requête le déclare par `"unseen": ["hesitations"]` — sans quoi le moteur lirait leur
  absence comme une rédaction sans une seule recherche de mot. Le silence qui précède la
  première différence tapée de la fenêtre va en tête, même si un collage a été lu avant lui.
  **Un silence ne traverse jamais une session** : l'horloge du silence repart à l'ouverture de
  chacune, et sa première fenêtre ne porte donc aucun `gap` de tête — le temps écoulé depuis la
  dernière frappe de la session précédente couvre une suspension, pas une réflexion.
- **Un `["move", n]` par déplacement vu** : le curseur ou la sélection a bougé sans que le texte
  change, un par événement de Word. Ce n'est pas une frappe ici — `counts.jumps` le compte, la
  somme des frappes non — donc ce n'est pas un `nav`. Des déplacements seuls ne scellent rien :
  leur suite et leur compte passent à la fenêtre suivante, **pas leur temps**, faute de quoi
  celle-ci annoncerait plus de temps effectif qu'elle n'a duré, ce que le moteur refuse.
- **Ni `nav`, ni `click`, ni `copy`, ni `undo`, ni `fix`** : Office ne livre ni la touche d'un
  déplacement, ni le clic, ni le presse-papiers, ni l'annulation, ni le choix dans le correcteur.
- **`counts` ne porte que quatre clés** : `corrections`, `reformulations`, `revisions`, `jumps`.
  `exits`, `back_keys` et `back_chars` sont **absentes**, pas à zéro : Office ne dit pas qu'on a
  quitté le document, il n'y a donc aucun retour d'où dater quoi que ce soit.
- **Le déroulé est obligatoire et n'est jamais amputé.** Son plafond, `TIMELINE_MAX_RUNS`, se
  tient comme celui des 200 frappes : la fenêtre est scellée (`volume`) avant de l'atteindre.
  Rien n'est retiré d'un déroulé : c'est de lui que le moteur tire tout ce qu'il compte.
- **`text` donne la taille, puis la portée.** `len` est la taille du texte lu, en points de
  code, sans les caractères de structure de Word. La première fenêtre d'une session n'a rien à
  quoi se comparer : elle envoie `{"len": n}` seul. Les suivantes ajoutent la portée — `since`,
  `at`, `cut`, `add`, et `kept` quand il est calculé — y compris quand le texte n'a pas changé
  (`cut` et `add` à `0`).
- **La portée compare le texte de la fenêtre à celui de la fenêtre précédente**, pas à la
  lecture précédente : entre deux fenêtres le texte est relu plusieurs fois. La session garde
  donc **un texte de plus** tant qu'une fenêtre est ouverte — celui que la dernière fenêtre a
  annoncé. C'est la règle de la lecture précédente, étendue d'un cran : en mémoire vive
  seulement, jamais envoyé, remplacé à chaque scellement, lâché à la fermeture de la session ;
  et ce n'est pas une copie, c'est la chaîne même qu'était la lecture précédente à ce moment-là.
  **Le texte annoncé est celui de la lecture qui a scellé la fenêtre** : la lecture devient la
  référence *avant* d'être analysée, si bien qu'une fenêtre scellée par les 200 frappes en
  pleine analyse annonce le texte que sa dernière différence a produit. L'inverse laisserait ce
  qui vient d'être tapé ou collé apparaître dans la portée de la fenêtre suivante, le geste qui
  l'explique étant resté dans celle-ci.
- **`kept` dit ce que l'enveloppe a gardé.** Deux endroits éloignés modifiés dans la même
  fenêtre font une seule portée, du premier au dernier, où tout le texte intact figure dans
  `cut` comme dans `add`. `kept` est la plus longue sous-suite commune des deux milieux, **par
  mots** (chaque mot avec les blancs qui le suivent), comptée en caractères : le texte neuf est
  `add − kept`. Les mots sont réduits à des numéros le temps du calcul et ne sortent pas de
  la fonction. Au-delà de `TEXT_KEPT_MAX_WORDS` (2 000) mots d'un côté ou de l'autre, le champ
  est **omis** — ce qui n'est pas zéro. Un mot touché par une modification ne compte pas comme
  gardé : `kept` est une borne basse.
- **Toute relecture y entre, celles de référence comprises** : le texte d'un co-auteur est du
  texte arrivé sans geste de l'étudiant, et il est annoncé comme tel — dans la portée, dans
  aucune suite. Les relectures faites **pendant une suspension** n'y entrent pas : il n'y a
  alors pas de session, et la première fenêtre de la suivante n'a rien à quoi se comparer.

Côté envoi (`agent.js`) : **il n'y a qu'un corps**, reconstruit clé par clé à partir de la
fenêtre en file — l'ordre des clés est celui que le moteur attend, et `localStorage` ne promet
pas de le rendre. Une fenêtre mesurée moteur joignable part seule ; une file remplie hors ligne
part par paquets d'au plus `BATCH_MAX_WINDOWS` fenêtres **de la même session et du même
document**, toutes marquées `offline`, dans l'ordre de leurs numéros. Deux volets remplissent
la même file à tour de rôle : leurs fenêtres partent alors par petits paquets, jamais mélangées.
Un paquet refusé (`400`, ou `409` pour un numéro déjà tenu avec un autre instant ou une autre
durée) repart fenêtre par fenêtre, et seule celle que le moteur refuse est perdue. **Aucun refus
ne fait envoyer autre chose** : le complément ne négocie pas, ne se replie pas et ne retire
aucune mesure ; seul un `404` (document supprimé côté moteur) est suivi d'un second essai, vers
un document recréé. `sent` est l'heure du poste à chaque tentative. Une entrée de la file qui
n'est pas une fenêtre de cette forme — laissée par un build antérieur — n'a pas de corps
possible : elle est **écartée** à la lecture de la file, et disparaît du stockage à l'écriture
suivante.

Le build reprend de `browser/` la feuille de style `ui.css`, le code partagé des deux volets
`ui.js`, le dictionnaire `i18n.js` ([langues.md](langues.md)), le bloc de *Signaler un
problème* `report.js` (partagé, lui, avec le *service worker*), les polices et les icônes : le
volet Word et la popup sont le même écran, ils n'ont pas deux jeux de textes.

`ui.js` ne contient **que** ce que les deux écrans ont en commun — l'en-tête, les messages, le
sélecteur de devoirs — et **rien qui touche à `chrome.*`** : ce que seule l'extension peut faire
vit dans son `pages.js`, que le volet ne charge pas. Ce volet-ci n'a aucun navigateur à qui
demander une permission, et sa langue vient de Word. Dans l'autre sens, `agent.js` déclare
`DEFAULT_ENGINE_URL` comme chaque agent le déclare chez lui, et `make check` compare les quatre
([developpement.md](developpement.md)).

## Hébergement

Le complément est une page web servie par **GitHub Pages**
(`https://certimens.github.io/plugins/word/`, variable `WORD_BASE_URL` du build). Le moteur
autorise cette origine en CORS sur `/api` — voir [moteur.md](moteur.md).

### Ce qui est installé, et ce qui est servi

C'est la particularité de cet agent, et elle va dans les deux sens :

- **Le manifest est installé chez l'étudiant.** Il fige cinq adresses — `taskpane.html` et les
  quatre icônes — et plus rien de ce qu'on y change n'atteint quelqu'un de déjà installé. Un
  nouveau manifest veut dire revue AppSource, ou déploiement par l'admin du tenant.
- **Le code, lui, est relu à chaque ouverture du volet.** Un déploiement part donc chez tout le
  monde immédiatement, sans revue — c'est l'intérêt du montage, et c'est aussi le risque : un
  mauvais déploiement casse tous les étudiants d'un coup, et le seul recours est d'en refaire
  un.

**Ne jamais déplacer `taskpane.html` ni `icons/`** : ce sont les seules adresses que le
manifest connaît, et un étudiant installé ne les reverra jamais changer.

### Le volet se rattrape tout seul

Toutes les adresses sont stables, et le cache est traité **à l'exécution** plutôt que dans les
URL. Le site publie un `version.txt`, et un script **inline** en tête du volet le compare à la
version gravée dans la page à la construction.

Le problème qu'il règle : le volet charge sept fichiers, chacun avec sa propre durée de vie de
dix minutes sur Pages — et Word garde un cache à lui, plus tenace encore. Après un déploiement,
ils peuvent être repris à des moments différents, et un `taskpane.js` neuf tourne alors sur
l'`ui.js` précédent. Le symptôme typique : une fonction qui n'existe pas, et un volet
inutilisable jusqu'à ce que l'autre cache expire.

Deux déclencheurs, une seule action :

| Déclencheur | Ce qu'il attrape |
| --- | --- |
| `version.txt` diffère de la version de la page | la page elle-même est périmée |
| une erreur est levée pendant le chargement | les fichiers sont dépareillés |

L'action reprend les sept fichiers par-dessus les caches (`fetch(…, { cache: 'reload' })`, qui
réécrit la copie fraîche dans le cache HTTP) puis recharge.

**Le garde-fou compte plus que la fonction.** Une boucle de rechargement toucherait tous les
étudiants d'un coup et serait bien pire que le bug qu'elle poursuit : le rattrapage ne s'exécute
donc **qu'une fois par session** (`sessionStorage`), ne réessaie jamais, et ne fait rien du tout
si `sessionStorage` est indisponible. L'erreur n'est écoutée que pendant les quinze premières
secondes — passé le démarrage, on ne touche plus à rien.

Il contrôle au chargement et **ne scrute jamais** : le volet peut rester ouvert des heures, et
recharger pendant que l'étudiant écrit coûterait la fenêtre de mesure en cours.

Le script est inline à dessein : c'est le seul code qui arrive avec la page, donc le seul qui
tourne encore quand les fichiers chargés en dessous sont cassés. GitHub Pages ne permet pas à un
dépôt de régler `Cache-Control` — tout est servi en `max-age=600` — et ce rattrapage est ce qui
remplace l'en-tête qu'on ne peut pas poser.

> Sur Word pour le web, ne pas l'utiliser en même temps que l'extension navigateur : la
> rédaction serait comptée deux fois (le volet le rappelle).

## « Certimens a été mis à jour »

Après une mise à jour, le volet dit une fois quelle version tourne, avec un lien vers les
notes de release. La règle est la même dans les quatre agents et elle est écrite une
fois : [extension-navigateur.md](extension-navigateur.md#certimens-a-été-mis-à-jour).

Le volet ne lit pas sa version d'un manifest : elle est gravée dans la page par le build
(`<body data-build>`), la même valeur que celle que compare la reprise de cache. Un volet
servi sans elle ne dit rien plutôt que d'annoncer une version qu'il ignore.

## Ce que le complément dit de lui-même

Le contrat — vocabulaire, plafonds, cadence, remise à zéro — est dans
[moteur.md](moteur.md#ce-que-lagent-dit-de-lui-même) ; ce qui suit est ce que le complément en
fait, et qui ne s'y lit pas. Tout vit dans `agent.js`, section `SELF-TELEMETRY`.

- **Où c'est compté.** Les compteurs sont dans le `localStorage` du volet (`telemetry`,
  `telemetryAt`, `telemetryVersion`), partagé par tous les documents ouverts. Ils ne sont pas de
  l'état de compte : la déconnexion les garde. Les appels au moteur passent par `request()` (pas
  de réponse → `network.failure`) puis `readResponse()` (5xx, 4xx, 401). Les réponses que le
  complément lit comme ordinaires ne sont pas comptées : l'attente d'un appairage
  (`device_authorization_pending`, `device_slow_down`, un `429` sur l'interrogation), et un
  `403`/`404` sur un document repris ou consulté (`resumeEngineDocument`, `docInfo`) — « pas à ce
  compte » ou « supprimé », la réponse attendue. Un refus que le complément construit lui-même sans
  appeler le moteur (adresse refusée, pas de jeton) ne se compte nulle part. `queue.dropped` se compte à la mise en file, quand `MAX_QUEUE`
  pousse dehors les plus anciennes.
- **Plusieurs instances, un seul stockage.** Compter est une lecture et une écriture
  synchrones : deux instances ne perdent un incrément qu'en comptant au même instant depuis deux
  processus, un compteur faux d'une unité, qui ne vaut pas un bail. L'envoi, lui, ne doit pas
  partir deux fois : il est réservé (`telemetryAt`) avant de partir, et les autres instances le
  voient.
- **`started` à chaque ouverture du volet** — chaque document a son instance, et chacune est un
  démarrage. **`installed` ou `updated` contre le build enregistré** (`telemetryVersion`), Word
  n'annonçant ni l'un ni l'autre : le complément est une page, et son build est celui que la page
  a reçu. Un stockage sans build enregistré est une installation, **sauf si le complément y a
  déjà laissé une trace** (`seenVersion`, `config`, `queue`, `engineIds`) : le jour où ceci est
  livré, tous les étudiants déjà équipés n'ont aucun build enregistré et doivent compter comme
  mis à jour. D'où l'ordre dans `taskpane.js` : `noteLaunch()` avant `updatedVersion()`, qui
  écrit `seenVersion` dès la première ouverture. Un volet construit depuis un dépôt (gabarit non
  remplacé) enregistre un build vide.
- **`error.runtime` ne compte que notre code.** Le volet est notre page, mais Office.js y tourne
  aussi, chargé depuis le CDN de Microsoft, et ses erreurs sont celles de l'hôte.
  `watchErrors()`, posé avant tout le reste de `taskpane.js`, compte une `error` dont le script
  est servi par **l'origine du volet** (le script *inline* de reprise de cache compris), et une
  promesse rejetée sans gestionnaire dont la pile **passe par l'un de nos scripts**. Une erreur
  d'Office.js nomme l'origine de Microsoft ; celle d'un script d'une autre origine arrive sans
  aucun détail (« Script error. ») ; un rejet qui n'est pas une erreur n'a pas de pile : aucune
  n'est comptée. On compte donc un peu moins que tout plutôt qu'un peu de ce qui n'est pas à nous.
- **Et où notre code a cassé.** Une erreur comptée est aussi gardée comme *erreur localisée*
  (`countRuntimeError`, clé `telemetryFaults` du `localStorage`) : son type et les lignes de sa
  pile qui sont **nos fichiers**, de la plus interne à la plus externe, en
  `fonction@fichier.js:ligne:colonne` (`faultOf`). Un fichier n'est retenu que s'il est servi
  **directement dans le dossier du volet** (`new URL('.', location.href)`), et n'en garde que le
  nom nu : ni l'adresse, ni les lignes d'Office.js, ni celles d'un script *inline* de
  `taskpane.html`. Dans la pile de V8 (Word sous Windows, Word en ligne dans Edge ou Chrome),
  seules les lignes `at` sont lues — celles d'avant sont le message, qui ne part **jamais** ;
  Word pour Mac (Safari) écrit `fonction@url:ligne:colonne`, lu tel quel. Dix erreurs distinctes
  au plus, chacune avec son compte ; une onzième est comptée sans être localisée. Elles partent
  avec les compteurs et s'effacent avec eux.
- **Les compteurs partent sur la boucle d'une minute** de `startAgent()`, bornés à
  `TELEMETRY_FLUSH_MS`. L'appel est *cross-origin* comme les autres, avec le même en-tête
  `X-Certimens-Agent` : la route doit être couverte par la configuration CORS du moteur sur
  `/api`.

## Signaler un problème

Le bas du volet porte un lien discret **« Signaler un problème »**. Il ouvre le formulaire d'aide
de l'espace Certimens en mode « problème », prérempli d'un bloc qui décrit le complément ; le
contrat est dans [moteur.md](moteur.md#signaler-un-problème), et la façon dont le bloc est fait
— `report.js`, partagé avec le *service worker* de l'extension par un lien symbolique — dans
[extension-navigateur.md](extension-navigateur.md#signaler-un-problème).

- **Les valeurs viennent d'`agent.js`** (`reportValues()`), qui tient déjà la configuration,
  l'état, la file et les compteurs. **`host`** est ce qu'Office dit de lui-même
  (`Office.context.diagnostics` : hôte, plateforme, build — `Word PC 16.0.18129.20158`) ;
  **`os`** se déduit de la seule plateforme qui le désigne (`PC` → `Windows`, `Mac` → `macOS`,
  `iOS`, `Android`) et reste `unknown` sur Word pour le web, où Office ne dit pas quel système
  est derrière le navigateur. Ni le nom ni l'adresse du document n'y entrent.
- **Le lien s'ouvre dans le navigateur de l'étudiant**, pas dans le volet. Sur Word pour Windows
  et Mac, un `window.open` reste dans la *webview* d'Office — une fenêtre sans barre d'adresse,
  sans gestionnaire de mots de passe, sans la session de son espace Certimens.
  `Office.context.ui.openBrowserWindow` (ensemble `OpenBrowserWindowApi 1.1`) confie l'adresse au
  navigateur du système ; la table des ensembles de Microsoft le donne pour Word sur Windows
  (version 1810 et suivantes, Office 2021 en licence en volume), Mac et iPad, et **pas pour Word
  sur le web**. Le volet teste donc l'ensemble (`isSetSupported`) et retombe sur
  `window.open(url, '_blank', 'noopener')`, qui sur le web est déjà un onglet du navigateur où
  l'étudiant se trouve.

## La page d'accueil de `/plugins/word/`

C'est la **page de documentation** du complément qui est servie là, pas `src/index.html` : le
site de doc a une page à l'adresse de chaque agent, et l'assemblage la pose par-dessus les
fichiers du complément ([publication.md](publication.md#le-site-github-pages)). Seul `index.html`
est concerné — `taskpane.html`, `manifest.xml` et les icônes, c'est-à-dire tout ce qu'un manifest
installé pointe, sont intacts.

`src/index.html` reste livré et reste utile : c'est ce que `make serve` affiche à la racine du
site local, où aucune doc n'est servie.

## Tester en local

```bash
make -C word build && make -C word serve   # HTTPS sur localhost:3000, certificat de dev au 1er lancement
```

Puis charger `word/dist/word-localhost.xml` :

- Word sur le web : *Accueil › Compléments › Plus de compléments › Mes compléments › Charger mon
  complément* ;
- Windows / Mac : `npx office-addin-debugging start word/dist/word-localhost.xml desktop`.

Le bouton **Certimens** apparaît dans l'onglet *Accueil*. Pour un moteur local, ouvrir les
**paramètres avancés** de la fenêtre de connexion et y saisir `http://localhost:8080`.

## Publier le site sans faire de release

Le complément est une page web : il suffit de republier GitHub Pages. Le workflow
`.github/workflows/pages.yml` le fait à la demande, depuis n'importe quelle branche — mais
**il faut le demander**, avec `word=branch` :

```bash
gh workflow run pages.yml --ref ma-branche -f word=branch   # ou Actions › Site (GitHub Pages) › Run workflow
```

Sans ce drapeau, le run publie la documentation et le flux LibreOffice et **laisse le complément
tel qu'il est publié**, reconstruit à son dernier tag. C'est ce qui permet de republier le site
pour une autre raison — une page de doc corrigée — sans mettre devant tous les étudiants un code
Word que personne n'a tagué ([publication.md](publication.md#le-site-github-pages)).

Avec le drapeau, il construit la branche, valide le manifest et déploie `word/dist/word/` sur
`https://certimens.github.io/plugins/word/` — les mêmes adresses que la release, donc **rien à
recharger côté Word** : fermer et rouvrir le volet suffit. Deux réserves :

- le workflow n'apparaît dans *Actions* (et n'est lançable) qu'une fois `pages.yml` présent sur
  la branche par défaut ; ensuite `--ref` choisit la branche à publier. Si GitHub répond *branch
  is not allowed to deploy to github-pages*, c'est la règle de l'environnement : *Settings ›
  Environments › github-pages › Deployment branches* limite le déploiement à la branche par
  défaut, à élargir (ou publier depuis `main`) ;
- c'est le site de **production** qui est remplacé : les étudiants déjà équipés reçoivent ce
  build. La prochaine release le réécrasera avec celui du tag. Pour un essai qui n'engage
  personne, `make -C word serve` et `word/dist/word-localhost.xml` restent la bonne piste.

## Vérifier ce qui est en ligne

L'adresse du site sert `index.html`, et chaque fichier se teste directement, sans Word :

```bash
for f in manifest.xml taskpane.html taskpane.js agent.js sensor.js ui.css ui.js i18n.js; do
  curl -s -o /dev/null -w "%{http_code} $f\n" "https://certimens.github.io/plugins/word/$f"
done
curl -s https://certimens.github.io/plugins/word/src/manifest.xml | grep -E '<Version>|SourceLocation'
```

Huit `200` et la version attendue dans le manifest : le site est bon. Un `404` **sur tous** les
fichiers veut dire que Pages n'est pas activé (*Settings › Pages › Source : GitHub Actions*) ou
qu'aucun déploiement n'a eu lieu ; un `404` sur un seul fichier vient du build.

Si le volet montre encore l'ancien code, **rouvrir le volet suffit en principe** : au
chargement, il compare sa version à `version.txt` et se rattrape tout seul (voir
[Le volet se rattrape tout seul](#le-volet-se-rattrape-tout-seul)). Il ne le fait qu'une fois
par session, donc si l'ancien code persiste après réouverture, c'est que le rattrapage a déjà
joué sans succès : vider alors le cache de Word à la main (*Insérer › Compléments › Mes
compléments* pour recharger, ou `%LOCALAPPDATA%\Microsoft\Office\16.0\Wef` sous Windows,
`~/Library/Containers/com.microsoft.Word/Data/Library/Caches` sous macOS).

## L'identifiant du document

L'identifiant voyage **dans le fichier**, donc ce qu'il contient a été écrit par qui a produit ou
détenu ce fichier — personne la plupart du temps, un tiers parfois. Deux contrôles le séparent du
document Certimens qu'il désigne :

- **la forme** : une valeur que l'agent n'aurait pas pu frapper lui-même n'est pas adoptée, elle
  est remplacée. Cela écarte aussi bien une chaîne fabriquée qu'une propriété vide, fausse ou
  d'un autre type, qui donnait une identité inutilisable et jamais réparable — toutes les
  fenêtres de ce document étaient alors jetées en silence, pour la vie du fichier ;
- **le lien** : une entrée créée pour un fichier n'accueille pas un autre fichier. Une simple
  copie du document de l'étudiant porte la même identité, sans attaquant nulle part : un double
  gardé à côté de l'original, une version enregistrée sous un autre nom, un brouillon qu'un
  correcteur a renvoyé. Sans ce contrôle, les frappes du second fichier étaient fusionnées dans
  le dossier du premier, le dossier était renommé d'après le dernier fichier touché, et le dépôt
  y remplaçait le contenu par le mauvais fichier. Le second fichier reçoit une identité neuve, et
  l'étudiant retrouve l'invite de liaison que ce chemin sautait.

Le moteur ne peut pas voir la collision — la création ne porte qu'un nom, l'identité locale ne
traverse jamais le réseau — donc le refus vit dans l'agent, **avant** l'adoption. L'emplacement
du fichier est enregistré à côté du document Certimens.

### Renommé, déplacé, ou copié ?

Un fichier renommé ou déplacé présente lui aussi son identité depuis un emplacement auquel elle
n'est pas liée — `mémoire.docx` devenu `mémoire_v2.docx`, ou passé d'un dossier SharePoint à un
autre. Rien ne le distingue d'une copie, et c'est une limite de Word : un complément ne peut pas
demander si l'ancien emplacement existe encore. L'extension LibreOffice pose la question au
système de fichiers ; le complément, lui, **la pose à l'étudiant**, une fois.

La question ne se pose que dans ce cas-là : un fichier dont l'identité est déjà liée, sur ce
poste et pour ce compte, à un **autre** emplacement. Le volet se montre de lui-même — un document
lié rouvre le complément sans son volet, et c'est le seul moment où l'étudiant est nécessaire —
et demande s'il s'agit du même fichier, renommé ou déplacé, ou d'une copie.

- **Le même fichier** : le lien suit le fichier vers son nouvel emplacement, l'identité d'origine
  est gardée (aucune nouvelle n'est frappée, celle d'origine est réécrite dans le fichier), la
  reprise redevient possible, et les mesures continuent dans le dossier existant. Son nom suit
  par la synchronisation ordinaire des titres : le dossier « mémoire » devient « mémoire_v2 ».
- **Une copie**, et aussi **pas de réponse** (document fermé sans répondre, compte déconnecté) :
  exactement ce qui précède — une identité neuve, un dossier à elle, l'invite de liaison.

La réponse est retenue **par identité et par emplacement** : le même fichier n'est pas
redemandé à chaque ouverture, même resté sans enregistrement et portant encore l'identité
d'origine.

**La mesure n'attend pas la réponse, l'envoi si.** En attendant, le fichier est mesuré comme la
copie qu'il est peut-être : sous une identité provisoire, dont les fenêtres entrent dans la file
comme les autres mais sont **retenues** — aucune ne part, aucun dossier n'est créé pour elle.
Une fenêtre envoyée avant la réponse aurait dû aller quelque part : dans un dossier neuf, que
« le même fichier » aurait alors scindé, ou dans celui d'origine, que « une copie » aurait
pollué. À la réponse :

- « le même fichier » **ramène** les fenêtres retenues sous l'identité d'origine, dans la file
  même, et le volet comme le capteur passent à cette identité dans le même pas, sous le verrou
  de la file : une fenêtre est scellée avant (et ramenée) ou après (sous la bonne identité),
  jamais entre les deux. La session du capteur continue — toutes ses fenêtres finissent sous la
  même identité, elle reste un seul tronçon de mesure d'un seul document ;
- « une copie » les **libère**, et la première ouvre le dossier de la copie.

La file est commune à tous les documents ouverts : les fenêtres retenues passent derrière les
autres plutôt que de les bloquer. La retenue est renouvelée par le volet qui pose la question à
chaque vidage, et s'éteint au bout de dix minutes sans lui — un volet disparu sans un mot ne
retient rien pour toujours : ses fenêtres partent comme celles d'une copie. Une déconnexion
envoie tout, retenu compris, pour la même raison.

**Ce qu'on rattache, on le voit.** L'identité voyage dans le fichier, et un fichier préparé par
un tiers peut porter celle de l'étudiant. Trois choses empêchent qu'une réponse « le même
fichier » fusionne deux travaux plus facilement qu'avant :

- la question **nomme** le dossier qu'elle rejoindrait, sous le nom que le moteur lui donne
  (`GET /api/documents/:id`), et le fichier sous lequel l'identité a été vue la dernière fois.
  Moteur injoignable, elle est posée sans le nom du dossier ; mais « le même fichier » ne
  s'accepte qu'une fois le moteur interrogé ;
- le **moteur** reste l'autorisation : `403` ou `404` sur ce dossier, et il n'y a rien à
  rejoindre — la question n'est pas posée, ou la réponse est refusée et le fichier garde son
  propre dossier ;
- la question ne porte que sur une identité **déjà liée sur ce poste, pour ce compte** : la
  réponse ne peut atteindre qu'un dossier de l'étudiant, et jamais plus facilement qu'un fichier
  resté à sa place ne le fait déjà.

## Reprendre un document d'un éditeur à l'autre

Un mémoire commencé dans Word et poursuivi dans Writer est **un seul travail**, et doit rester un
seul dossier côté moteur. Ce qui le permet tient dans deux propriétés personnalisées, écrites
dans le fichier lui-même — `.odt` comme `.docx` — et lues sous le même nom par les deux agents :

| Propriété | Ce qu'elle porte |
| --- | --- |
| `CertimensDocumentId` | l'identité locale du document, qui ne traverse jamais le réseau |
| `CertimensEngineDocument` | le document Certimens que ce fichier alimente |

La seconde est écrite une fois le document Certimens créé, jamais avant : un identifiant inscrit
pour un document qui n'existe pas enverrait l'éditeur suivant chercher le vide. À l'ouverture
d'un fichier qui la porte, l'agent **reprend** ce document au lieu d'en ouvrir un second — en
silence, sans rien demander à l'étudiant, parce que c'est le comportement qu'il attend et que la
question se poserait à chaque ouverture.

C'est la seule valeur que ces agents lisent **dans un fichier**, donc la seule dont personne
n'a vérifié la forme avant eux. Quatre refus la séparent du document qu'elle désigne :

- **la forme**, vérifiée à l'entrée et non à l'usage (`^[A-Za-z0-9_-]{1,64}$`, le même motif dans
  les trois agents qui en lisent un, comparé par `make check`) : une barre oblique ou un `..`
  dedans n'est plus un identifiant, c'est une autre route, appelée avec un jeton qui n'expire
  pas ;
- **le propriétaire** : le moteur répond `404` ou `403` pour un document qui n'est pas à ce
  compte, et c'est là toute l'autorisation — seul le propriétaire d'un document y écrit. Le
  fichier qu'un camarade envoie est donc un fichier comme un autre, qui reçoit son propre
  dossier ;
- **le rôle** : seul un `student` reprend. Un enseignant a le droit de lire la copie qu'on lui a
  rendue, donc le moteur répondrait `200` — et ses propres frappes iraient grossir le dossier de
  son étudiant ;
- **le double** : c'est le refus qui vit ici et nulle part ailleurs. Si l'identité du fichier est
  déjà liée à un autre fichier sur ce poste, celui-ci est une copie — le moteur ne peut pas les
  distinguer, les deux sont de cet étudiant — et rien de ce qu'elle nomme n'est repris, tant que
  l'étudiant n'a pas répondu qu'il s'agit du même fichier, déplacé (voir
  [Renommé, déplacé, ou copié ?](#renommé-déplacé-ou-copié-)).

Un fichier ouvert sur une autre machine, lui, est indiscernable d'une reprise légitime : c'est
exactement le signal qu'on a choisi de croire.

La reprise est un appel réseau, donc elle ne retarde rien : la mesure démarre tout de suite, les
fenêtres s'empilent dans la file sous l'identité locale, et le document Certimens n'est résolu
qu'à l'envoi. Une fenêtre mesurée pendant que la reprise est en vol rejoint le document repris
plutôt que d'en ouvrir un second à côté.

Deux choses propres au complément :

- l'identité **a changé de contenant**. Elle vivait dans les réglages Office du document, qui
  voyagent bien dans le `.docx` mais dans une partie que personne d'autre ne lit : Writer ne
  voyait rien. Elle est désormais une propriété personnalisée, c'est-à-dire exactement ce que
  LibreOffice écrit de son côté. **Les liens existants ne sont pas repris** : un document déjà
  suivi dans Word reçoit une identité neuve, et son dossier précédent reste tel quel ;
- les propriétés personnalisées sont **WordApi 1.3**. Aucun hôte capable d'exécuter ce
  complément n'est en dessous — le *runtime* partagé exclut déjà les autres — mais la détection
  est faite plutôt que supposée : à défaut, l'identité retombe sur les réglages Office, la mesure
  continue, et ce document-là ne voyage pas.
