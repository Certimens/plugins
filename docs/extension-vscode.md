# Extension VS Code

Une extension pour **Visual Studio Code** dans `vscode/`, paquet `vscode/dist/certimens-vscode.vsix`
(VS Code 1.90+ ; le collage n'y est distingué d'une suggestion acceptée qu'à partir de 1.97), pour
les devoirs qui se rendent en code plutôt qu'en traitement de texte.

C'est le seul agent qui mesure **un projet entier, fichier par fichier** : chaque fichier écrit
devient un document Certimens distinct, avec ses propres fenêtres de mesure — ce qu'un enseignant
corrige, ce sont des fichiers, pas un projet en bloc.

## Les fichiers

- `sensor.js` : les fenêtres de mesure, une instance par document ouvert, sans aucune dépendance
  à l'API de VS Code — c'est ce qui rend les règles vérifiables sans éditeur
  (`tests/sensor.test.mjs`).
- `engine.js` : moteur et file hors-ligne (stockage **de l'espace de travail** — voir
  [*Deux stockages*](#deux-stockages)), jeton d'API dans le
  **SecretStorage** de l'éditeur et non dans `settings.json`, qui se synchronise entre machines
  et se lit par-dessus l'épaule. Pas de CORS : les appels partent de Node, pas d'une page.
- `queue-file.js` : la file hors-ligne dans un fichier du dossier de stockage de l'espace de
  travail, en ajout seul ([*Deux stockages*](#deux-stockages)). `engine.js` n'en sait rien : il
  reçoit de l'hôte un objet qui charge, ajoute, avance et réécrit, et en garde le miroir en
  mémoire.
- `extension.js` : l'hôte. Il traduit les événements de l'éditeur en mesures, tient un capteur
  par document, la barre d'état et les commandes.
- `panel.js` : le panneau latéral (webview), le même écran que la popup de l'extension et que le
  volet Word ; il réutilise `ui.css`, ne détient aucun état et ne voit jamais le jeton.
- `i18n.js` : les deux dictionnaires d'interface, plus ceux qui n'ont de sens que dans un éditeur
  — `bar.*` pour la barre d'état, `notify.*` pour les notifications ([langues.md](langues.md)).
- `README.md` : la fiche du Marketplace, écrite pour l'étudiant. Le build la copie dans le
  paquet ; la documentation de référence, elle, reste ici.

## Ce que voit l'éditeur

VS Code ne livre pas les frappes : il signale **ce qui change** dans le document
(`onDidChangeTextDocument`, un événement par modification, avec le texte inséré et la longueur
de ce qu'il remplace) et **d'où vient le curseur** (`onDidChangeTextEditorSelection`, avec
l'origine du déplacement — clavier, souris ou commande — et la position où il est allé, jamais
la touche : c'est à la distance que le capteur distingue une flèche d'un saut).

C'est plus que ce que donne Office — l'origine d'un déplacement étant connue, la règle « une
suppression solde le déplacement qui la précède » y tient — et moins qu'un navigateur, aucune
touche n'étant jamais vue. Un déplacement qui suit une frappe de moins de 50 ms
(`SELECTION_ECHO_MS`) est l'écho du curseur, pas une navigation.

### Ce qui a apporté un bloc

L'événement de modification donne le texte qu'un geste a inséré, jamais le geste : un collage,
une complétion d'IntelliSense acceptée, la suggestion d'un assistant, un extrait de code, une
action de code arrivent tous de la même façon. Jusqu'ici, tout bloc de plus
d'`INJECTION_MIN_CHARS` caractères partait donc en `paste` — une accusation d'import pour
quiconque code avec une complétion.

Ce que l'éditeur donne, depuis **VS Code 1.97**, c'est un regard sur chaque collage et chaque
glisser-déposer **avant** qu'il soit appliqué : `vscode.languages.registerDocumentPasteEditProvider`
(API finale en 1.97) et `registerDocumentDropEditProvider` avec ses métadonnées (finales dans la
même version ; la fonction elle-même existe depuis longtemps). L'hôte (`watchPastes`, dans
`extension.js`) enregistre les deux pour les schémas mesurés (`file`, `vscode-remote`), types
`text/plain` et `text/uri-list` (plus `files` pour un dépôt), genre d'édition déclaré
`DocumentDropOrPasteEditKind.Text`. Les deux fournisseurs **ne rendent aucune édition** : l'éditeur
applique alors son propre collage, celui qu'il aurait fait sans nous — il fait déjà passer chaque
collage par ses fournisseurs intégrés, et n'en revient à son collage de base que lorsque seule
son édition de texte a répondu —, sans widget « coller comme… » et sans choix proposé à
l'étudiant. Ils notent une seule chose : un collage ou un dépôt arrive dans ce document. **Ce qui
est collé n'est jamais lu** : ni les plages, ni le `DataTransfer` ; le capteur voit le texte
inséré de l'événement de modification, comme avant, et rien d'autre. Le coût est un aller-retour
vers l'hôte d'extensions par collage, en parallèle des fournisseurs de l'éditeur ; l'éditeur
n'affiche son indicateur d'attente qu'au-delà de 500 ms, qu'un fournisseur qui répond sans rien
calculer n'atteint pas — sauf un hôte d'extensions occupé par une autre extension, qui retarde
alors le collage ; c'est déjà le cas dans un fichier TypeScript ou Markdown, dont les
fournisseurs de collage livrés avec l'éditeur vivent dans ce même hôte.

La règle, appliquée par `Agent.pastedInto` et transmise au capteur avec la modification
(`sensor.change(changes, raison, heure, { pasted })`, le capteur restant libre de toute API) :

- **La modification qui suit une note est le collage**, quelle que soit sa taille, et elle
  dépense la note — c'est le collage annoncé, ou une frappe qui l'a annulé (l'éditeur abandonne
  un collage dont le document change pendant que ses fournisseurs répondent). `pasted: true` :
  le bloc part en `paste`, exactement comme avant.
- **Une note expire** au bout de `PASTE_NOTICE_MS` (10 s) si rien ne l'a dépensée : l'éditeur
  attend tous ses fournisseurs avant d'appliquer — l'un d'eux peut interroger un serveur de
  langage — et propose le collage de base sur un clic après une demi-seconde. Un « Coller
  comme… » attend le choix de l'étudiant dans une liste : sa note dure `PASTE_AS_NOTICE_MS`
  (2 min). Une note périmée ne peut que faire lire une suggestion comme un collage, la lecture
  d'avant.
- **Un bloc sans note, là où l'éditeur l'aurait donnée**, est une suggestion (`pasted: false`) :
  une suite `["suggest", n]`.
- **Là où l'éditeur ne peut pas la donner, rien n'est dit** (`pasted` indéfini) et tout bloc
  reste un `paste` : ne pas savoir n'est pas une suggestion. C'est le cas d'un VS Code antérieur
  à 1.97 (de 1.90 à 1.96, la fonction est déjà sur `vscode.languages`, mais comme **proposition**,
  qui lève une exception pour toute extension qui n'y est pas autorisée : sa présence ne prouve
  rien, et l'hôte lit la version, `pasteProvidersIn`) ; d'un éditeur **dans un navigateur**
  (un codespace ou un code-server ouvert dans un onglet), où la commande Coller du menu ou de la palette écrit le
  presse-papiers sans consulter aucun fournisseur — rien n'y est enregistré ; du réglage
  `editor.pasteAs.enabled` désactivé, qui fait sauter tous les fournisseurs de collage ; et d'un
  mode **Vim ou Neovim** installé (`PASTES_ON_ITS_OWN`), dont le `p` écrit le presse-papiers par
  ses propres éditions. Ces deux derniers ne sont lus que pour une modification assez longue pour
  être un bloc : une frappe ordinaire ne demande rien de plus à l'éditeur.

Dans le capteur, une suite `suggest` est **une par bloc**, jamais fondue dans sa voisine (comme
`paste` et `self`). Elle ne compte ni dans `sum.pastes` ni dans `sum.chars`, ni dans
`counts.back_chars` si tôt qu'elle suive un retour ; ce n'est pas une frappe : rien dans
`sum.keys`, aucun flight time, aucun silence clos ni remis à zéro, rien vers `FLUSH_KEYSTROKES`.
Elle est une activité : une fenêtre qui ne porte qu'elle est scellée et envoyée (`hasActivity`),
et le plafond de `TIMELINE_MAX_RUNS` la traite comme toute suite. Comme toute insertion, elle
solde le trajet et la rafale de suppression. Un texte que le document contenait déjà reste un
`self`, quel que soit le geste qui l'y remet ; une annulation reste une frappe et une correction.
Et **ce qu'une suggestion remplace n'est pas une suppression** : une complétion reprend le préfixe
tapé pour écrire le mot entier, une action de code réécrit une expression. Compté par `erase`,
trois lettres complétées faisaient trois corrections, une réécriture une révision massive, pour
un geste que l'étudiant n'a pas fait ; rien n'est compté, la sélection et le trajet sont soldés,
et ce qui a réellement quitté le texte est dans la portée (`text`).

Ce que la règle ne sait pas, et qui part donc en `suggest` alors qu'un geste de l'étudiant l'a
apporté d'ailleurs : une extension de presse-papiers non répertoriée qui écrit par ses propres
éditions ; un « Coller comme… » lancé par un raccourci qui demande d'avance un genre précis
(`editor.action.pasteAs` avec `kind`), qui ne consulte que les fournisseurs de ce genre ; et le
changement de forme après coup dans le widget de collage, que l'éditeur applique sans
reconsulter les fournisseurs. Et ce qui part en `suggest` sans être une suggestion au sens
courant, mais reste l'éditeur agissant sur commande : le formatage, un remplacement dans tout le
fichier, une ligne déplacée (Alt+flèche) ou un bloc glissé **dans le même éditeur**.

**Les insertions courtes ne changent pas.** De 2 à `INJECTION_MIN_CHARS` caractères en une
modification non annoncée — une paire de parenthèses fermée d'elle-même, une complétion courte,
le texte validé d'une composition (IME) — restent autant de frappes `type`. L'API ne distingue
pas une complétion courte d'une composition qui se valide, et cette dernière doit rester de la
frappe ; une composition en cours remplace d'ailleurs son propre texte à chaque touche, comme une
complétion remplace son préfixe. Un collage court **annoncé**, lui, serait lisible pour ce qu'il
est (une suite `paste` par geste, quelle que soit sa taille, comme dans l'extension navigateur) :
ce n'est pas fait ici, la règle commune des capteurs par différences restant le seuil.

## Ce que porte une fenêtre

Une fenêtre part dans le corps de mesure du moteur ([moteur.md](moteur.md)) — il n'y en a
qu'un. Elle porte ce que le capteur a **observé**, et rien de ce qui s'en déduit : le nombre de
frappes, de collages, de caractères injectés, d'hésitations et de pauses est tiré du déroulé
par le moteur, et le capteur ne tient donc aucun seuil d'hésitation ni de pause. Ce que cet
agent envoie, et comment il le construit :

- **La session, c'est un fichier mesuré d'une traite** — pas la fenêtre de l'éditeur, puisque
  chaque fichier a son capteur et son document. Elle commence à la première activité du capteur
  et finit quand la mesure s'arrête pour lui : fichier fermé, mesure suspendue, déconnexion,
  arrêt de l'éditeur (les déclencheurs que `WIRE_FLUSH_REASONS` traduit par `end`). La suivante
  reçoit un nouvel identifiant, `SESSION_ID_BYTES` (16) octets tirés par `crypto.randomBytes`
  et dérivés de rien — ni du compte, ni du poste, ni du chemin. Le capteur ne l'écrit nulle
  part ; il n'est sur le disque que dans une fenêtre restée en file.
- **`seq` et `sum` sont tenus par le capteur, au scellement**, dans `flush` : une fenêtre est
  numérotée et ajoutée aux cumuls (`keys`, `chars`, `pastes`) qu'elle parte ou non. Les cumuls
  sont comptés là où les suites dont ils sortent sont écrites : `keys` dans `countKeystrokes`,
  `chars` et `pastes` dans la branche qui écrit le `paste`. Une suite `suggest` n'entre dans
  aucun des trois.
- **`at`, `mono`, `ms`** : `at` est l'horloge du poste à la première activité ; `mono` le même
  instant sur `performance.now()`, compté depuis le début de la session ; `ms` va de la
  première à la dernière activité sur cette horloge-là, `1000` au moins.
- **Toute durée est mesurée sur l'horloge monotone** : `ms`, `active`, la durée des suites et
  des silences, les écarts de `flight`, et les délais que comparent les règles
  (`SELECTION_ECHO_MS`, `RETURN_WINDOW_MS`). L'hôte donne à chaque événement l'heure du poste,
  que `Sensor.tick` ne retient que pour dater la fenêtre (`at`) ; une heure remontée ou avancée
  en cours de séance déplace `at` et rien d'autre.
- **`why`** : le mot que `WIRE_FLUSH_REASONS` donne au déclencheur. Une fenêtre le dit
  toujours ; un déclencheur absent de la table est scellé `idle`.
- **`runs`** : le capteur travaille sur les **modifications** du document, et chacune nourrit
  une suite de son genre — deux modifications voisines du même genre prolongent la même suite,
  sauf un bloc, qui a toujours la sienne. Les genres de cet agent : `type` (insertion de la
  taille d'une frappe, jusqu'à `INJECTION_MIN_CHARS`), `erase` (suppression), `other` (une
  frappe qui n'est ni l'un ni l'autre : une annulation, un rétablissement, un bloc du document
  reposé) — ces trois-là sont des frappes, `[genre, n, ms]` ; `paste` (un bloc arrivé d'un
  coup que l'éditeur a annoncé comme un collage ou un glisser-déposer — ou tout bloc, là où il
  ne sait pas l'annoncer), `suggest` (un bloc arrivé d'un coup sans cette annonce, là où
  l'éditeur l'aurait faite : complétion, suggestion d'un assistant, extrait, action de code —
  voir [*Ce qui a apporté un bloc*](#ce-qui-a-apporté-un-bloc)), `self` (un bloc que le
  document contenait déjà ailleurs, quel que soit le geste), `click` (déplacement d'origine souris), `move`
  (déplacement d'origine clavier — pas `nav`, qui compte des frappes), `undo` — ceux-là sont
  `[genre, n]`, sans durée. Une suite `type` ne se coupe que sur un geste d'un autre genre ou
  sur un silence, jamais sur un caractère. Un déplacement d'origine commande compte dans
  `counts.jumps` et n'écrit aucune suite.
- **`["gap", ms]`** : tout silence d'au moins `GAP_MIN_MS` (1 000 ms) entre deux frappes
  comptées, à sa durée réelle, écrit par `countKeystrokes` juste avant la frappe qui le clôt —
  un clic ou un bloc n'en clôt aucun. Celui qui a précédé la première frappe de la fenêtre en
  est la première suite. Un silence ne traverse pas une session : l'horloge repart quand une
  session s'ouvre, et sa première fenêtre n'a pas de silence de tête.
- **`TIMELINE_MAX_RUNS` (512)** est tenu comme le plafond de frappes : la fenêtre pleine est
  scellée (`volume`) et le geste ouvre la suivante — y compris une fenêtre qui ne porte que des
  déplacements, qui sans cela aurait attendu la suivante. Aucune suite n'est jamais retirée
  pour faire de la place, et un silence n'est jamais scellé sans la frappe qui le clôt.
- **`counts`** : ce que seul le capteur sait classer — `corrections`, `reformulations`,
  `revisions`, `jumps`, `exits`, `back_keys`, `back_chars` ([mesures.md](mesures.md)).
- **`flight`** : `med`, `mad` et l'histogramme `bins` (`FLIGHT_BINS_MS`, zéros de queue
  retirés) du même échantillon, envoyés dès qu'il y a deux écarts. Pas de `dwell` : aucune
  touche n'est vue, donc aucun relâchement.
- **`text`** : `len`, la taille du texte (caractères, sauts de ligne exclus), seule à la
  première lecture d'une session ; puis, à chaque lecture qui en suit une autre, la portée de
  la modification entre les deux, en longueurs dans la même unité — `since`, `at`, `cut`,
  `add`. `kept` y dit ce qui, dans `add`, était déjà dans `cut` : la sous-suite commune de
  **mots** la plus lourde, chaque mot pesant ses caractères et l'espacement qui le suit des
  deux côtés (`keptBetween`). Les mots sont comparés par un numéro le temps de l'appel, jamais
  gardés. Omis au-delà de `TEXT_KEPT_MAX_WORDS` (2 000) mots d'un côté ou de l'autre.

**Confidentialité : une lecture du texte est gardée en mémoire.** Pour mesurer la portée d'une
modification il faut deux lectures : celle faite au scellement d'une fenêtre — la **même**
lecture que celle de la taille, `getText()` n'est pas appelé une fois de plus — est conservée
telle quelle,
jusqu'à ce que la fenêtre suivante la remplace. Elle n'existe qu'en mémoire vive, dans l'hôte
d'extensions, une par fichier mesuré ; elle ne sert qu'à cette comparaison ; elle n'est ni
écrite, ni mise en file, ni envoyée — ce qui part, ce sont des longueurs — et elle est
relâchée à la fin de la session (fichier fermé, mesure suspendue, déconnexion). La lecture
faite quand un bloc arrive d'un coup, elle, est toujours cherchée puis relâchée dans l'appel.

Ce que cela coûte, mesuré sous Node sur un fichier de 216 000 caractères (40 000 mots), par
fenêtre scellée — donc jamais par frappe, la lecture n'ayant lieu qu'au scellement :

| Cas | par fenêtre |
| --- | --- |
| décompte de la taille seule | 0,27 ms |
| frappe en fin de fichier, ou au milieu (`cut` à 0 : rien à comparer) | 0,36 à 0,43 ms |
| deux retouches aux deux bouts du fichier (40 000 mots : `kept` omis) | 1,2 ms |
| deux retouches à 500 mots d'écart | 1,6 ms |
| deux retouches à 1 990 mots d'écart — le pire cas calculé | 18 ms |

Les deux lectures sont comparées par blocs de `SCAN_BLOCK` unités, que le moteur JavaScript
compare nativement, puis unité par unité dans le bloc où elles se séparent ; seul le plus court
des deux bouts communs est compté. Le coût de `kept` suit le **produit** des deux nombres de
mots, d'où la borne : le pire cas suppose une fenêtre qui touche deux endroits distants de près
de 2 000 mots, et il est payé au scellement, pas dans une frappe. Sur le poste d'un étudiant
(facteur 3 à 5) c'est le seul chiffre de ce tableau qui se verrait ; abaisser `TEXT_KEPT_MAX_WORDS`
est le levier, le contrat permettant d'omettre `kept`.

### Hors ligne, et devant un refus

Une fenêtre mesurée pendant que le moteur répond part **seule**. Une file rattrapée après une
coupure part par paquets : les fenêtres voisines dans la file, marquées `offline`, d'une même
session, dans l'ordre de leur `seq`, `BATCH_MAX_WINDOWS` (64) au plus par requête. Le curseur
`queueSent` avance du paquet entier. Un paquet refusé (`400`, ou `409` pour un `seq` déjà
enregistré avec un autre début ou une autre durée) est repris fenêtre par fenêtre, pour qu'une
fenêtre refusée ne coûte pas les soixante-trois autres ; refusée seule, elle est abandonnée,
sans quoi elle bloquerait la file.

**Aucun refus ne fait changer de corps.** Il n'y en a qu'un : l'agent ne se replie sur rien, ne
retire aucune mesure pour un moteur plus ancien, et ne retient rien d'un refus. La seule
réponse qui fait renvoyer une fenêtre est un `404` — le document a été supprimé côté moteur :
il est recréé, une fois. Une entrée de la file qui n'est pas une fenêtre de ce corps (laissée
par une version de l'extension qui en mettait une autre forme en file) est retirée de la file
sans être envoyée (`sendable`, dans `engine.js`).

**`offline` dit un moteur hors d'atteinte, pas un moteur qui a refusé.** L'état d'envoi porte
`reached` dès que le moteur a répondu quelque chose, fût-ce une erreur : une fenêtre scellée
derrière un `5xx` ou un `429` attend sans être marquée, et repart seule. Un renommage que le
moteur refuse (`4xx` hors `401`, `408`, `429`) est tenu pour fait : il ne repart pas à chaque
minute et ne fait pas virer l'état au rouge. Après un `401`, les fenêtres suivantes sont mises
en file sans nouvel essai — la boucle redemande une fois par minute, et se reconnecter remet
l'état à zéro. Aucun appel n'attend plus de 30 s (5 min pour le dépôt d'un fichier).

### Deux stockages

| Où | Ce qui s'y trouve | Pourquoi |
| --- | --- | --- |
| `globalState` (partagé par toutes les fenêtres) | `config`, `signedIn`, `paused`, `accountEpoch`, les compteurs de télémétrie | ce qui appartient à l'installation ou au compte |
| `workspaceState` (un par espace de travail) | `engineIds`, `names`, `syncedNames`, `status`, `epoch` | ce qu'**une seule fenêtre** écrit |
| `storageUri` (un dossier par espace de travail) | la file : `queue.jsonl` et son curseur `queue.sent` | ce qui grossit pendant une coupure, et ne doit pas tout réécrire à chaque fenêtre |

L'éditeur garde le `globalState` d'une extension comme **une seule valeur**, que chaque fenêtre
réécrit en entier : la file y était, et la fenêtre qui finissait de la vider effaçait les
mesures qu'une autre venait d'y ajouter. Un espace de travail n'est ouvert que dans une fenêtre
à la fois, donc son stockage n'a qu'un rédacteur.

Ce que les fenêtres partagent reste le compte. Se déconnecter (ou se connecter sous un autre
compte, ou le même sur un autre moteur) relève `accountEpoch` ; chaque espace de travail retient
l'époque sous laquelle son état a été écrit (`epoch`), et un espace en retard se lit **vide**,
puis est vidé pour de bon au premier passage sous le verrou (`Engine.reconcile`). Une file
restée dans une autre fenêtre ne part donc jamais sous le jeton du compte suivant.

La file n'est pas dans le `workspaceState` : un `Memento` sérialise tout son contenu à chaque
écriture, et une file de plusieurs milliers de fenêtres, après une longue coupure, s'y
réécrivait plusieurs fois à chaque fenêtre scellée. Elle est dans le dossier que l'éditeur
réserve à l'extension pour cet espace de travail (`context.storageUri`), en deux fichiers
(`queue-file.js`) :

- `queue.jsonl` : une fenêtre par ligne, en JSON, chaque ligne terminée par un saut de ligne.
  Mettre une fenêtre en file **ajoute une ligne**, quelle que soit la longueur de la file ;
- `queue.sent` : le nombre de lignes de tête déjà parties, en décimal. C'est la seule écriture
  entre deux envois, et elle fait quelques octets.

Le fichier n'est réécrit que dans trois cas : tout est parti (il est vidé), la file est pleine
et ses plus anciennes fenêtres sont abandonnées (`MAX_QUEUE`, chacune comptée
`queue.dropped`), ou un fichier renommé renomme les fenêtres qui l'attendaient (`moveFile`).
Une réécriture passe par un fichier voisin, puis **remet le curseur à zéro, puis remplace le
fichier** : arrêtée entre deux écritures, la file relue peut renvoyer des fenêtres déjà
parties — le moteur y reconnaît le renvoi qu'elles sont — et n'en saute jamais une. L'ordre
inverse relirait le nouveau fichier depuis l'ancien curseur. Une dernière ligne coupée par un
arrêt au milieu d'un ajout est une fenêtre jamais acquittée : elle est retirée au chargement,
avant que la suivante s'y colle. Un curseur tronqué par le même arrêt est un préfixe du nombre
écrit, donc plus petit : il renvoie, il ne saute pas. `tests/queue-file.test.mjs` arrête un
scénario à chacune de ses écritures et vérifie les deux propriétés.

La fenêtre de l'éditeur est la seule à écrire ce dossier : pas de verrou entre processus. Se
déconnecter, ici ou dans une autre fenêtre (l'époque ci-dessus), vide le fichier comme le
reste. Sans dossier de stockage — aucun dossier ouvert, ou un stockage qui n'est pas un chemin
local — la file reste dans le `workspaceState`, sous `queue` et `queueSent`, comme avant ; sans
dossier ouvert, rien n'est mesuré de toute façon. Une file qu'une version précédente y avait
laissée passe dans le fichier au premier chargement : le fichier est écrit **avant** que les
deux clés soient effacées, pour la même raison.

`Engine.windowOf` réécrit chaque fenêtre clé par clé, dans l'ordre du contrat : ce qui sort de
la file a été relu du stockage de l'éditeur, qui ne promet rien sur l'ordre des clés, et une clé
que le corps ne connaît pas n'est jamais transmise. `offline` est la seule chose que le client
ajoute à ce que le capteur a scellé, entre `why` et `active` ; `sent` est réécrit à chaque
tentative.

## Quels fichiers sont mesurés

**Rien n'est créé tant que l'étudiant n'a pas écrit** : ouvrir un projet de quatre cents fichiers
n'en crée aucun côté moteur. Et seul le fichier **au premier plan** est écrit par lui :
l'évènement de modification se lève pour tout document de l'espace de travail, quel que soit
l'auteur du changement — un symbole renommé dans vingt fichiers, un journal rechargé depuis le
disque. Ces changements-là ne sont pas comptés et ne créent rien.

Un fichier d'une fenêtre distante (WSL, conteneur, SSH — schéma `vscode-remote`) est mesuré
comme un fichier local : l'extension tourne côté interface dans les deux cas, et l'éditeur lui
remet les documents des deux. Le réglage `certimens.exclude` écarte en plus les dépendances, la
sortie de compilation et les fichiers générés.

Les motifs sont comparés **segment par segment**, jamais par une expression régulière construite
à la volée. Les deux raisons tiennent dans la même fonction. Compiler le motif par
remplacements successifs laissait chaque passe réécrire les métacaractères que la précédente
venait d'émettre : aucun des douze motifs livrés par défaut ne correspondait à quoi que ce soit,
et le seul levier dont dispose l'étudiant pour tenir un chemin hors du moteur ne faisait rien —
sans rien dire. Et l'expression produite revenait en arrière sans borne, de sorte qu'un motif
fourni par le `.vscode/settings.json` d'un dépôt cloné figeait **le fil de l'hôte d'extensions**,
partagé par toutes les extensions, pendant des minutes sur une seule frappe. Comparer
directement coûte un temps proportionnel au motif et au chemin, quel que soit le contenu du
motif.

Deux conséquences à connaître : le réglage est déclaré **configuration restreinte**, donc un
espace de travail non fiable ne peut pas le poser ; et la décision d'exclusion est mise en cache
par chemin, rejetée au changement du réglage — un fichier exclu n'a pas de capteur pour s'en
souvenir, et la liste était donc reparcourue à chaque évènement. Un fichier **déjà mesuré**
que le nouveau réglage exclut cesse de l'être aussitôt : sa fenêtre est scellée et son capteur
retiré, sans attendre qu'il soit fermé.

Un fichier est identifié par un condensé du chemin du dossier de travail et son chemin
**relatif** dans le projet ; ce qui part au moteur est `projet/chemin/du/fichier`, jamais le
chemin absolu, qui nomme le compte de l'étudiant. Un fichier renommé ou déplacé garde ses
mesures : le document Certimens est renommé (`PUT /api/documents/:id`), pas remplacé. Tout ce
qui était connu sous l'ancien chemin suit le fichier (`Engine.moveFile`) — le document moteur,
le nom à lui envoyer et les fenêtres encore en file — sans quoi le fichier rouvert sous son
nouveau chemin n'avait pas de document et en créait un second. Un **dossier** renommé arrive en
une seule entrée et emporte chaque fichier qu'il contient.

Un document ne se reprend pas d'un éditeur à l'autre ici, et il n'y a rien à y faire : le
complément Word et l'extension LibreOffice écrivent dans le fichier le document Certimens qu'il
alimente ([moteur.md](moteur.md)), là où un fichier de projet est du texte et n'a aucun endroit
où porter quoi que ce soit. Ce qui le remplace est déjà là : le chemin relatif dans le projet
identifie le fichier d'une ouverture à l'autre.

## Se connecter

Le panneau ne demande **aucun mot de passe** : son bouton **Se connecter** obtient un code court
auprès du moteur, l'étudiant le saisit dans son espace Certimens, et l'extension reçoit un jeton
d'API — le flux est décrit dans [moteur.md](moteur.md#adresse-et-authentification). L'adresse du
moteur est repliée dans ses **paramètres avancés**, qui ne s'ouvrent d'eux-mêmes que pour une
adresse autre que celle par défaut.

L'attente vit **côté extension**, pas dans la webview : VS Code démonte une vue dès qu'une autre
passe devant, et c'est précisément le moment où l'étudiant est parti confirmer le code. La
commande *Certimens : se connecter* (palette) fait la même chose sans ouvrir le panneau : elle
affiche le code dans une notification avec le bouton qui ouvre l'espace, et reprend l'adresse
déjà enregistrée — une adresse à changer passe par le panneau.

## Rendre un fichier

La commande *Certimens : rendre ce fichier* (palette de commandes, ou le bouton du panneau)
envoie le fichier ouvert (`PUT /api/documents/:id`, base64, 18 Mo au plus) puis propose les devoirs
auxquels l'étudiant est rattaché. C'est **la seule** action qui fait sortir du texte du poste ;
la mesure, elle, n'envoie que des nombres et des catégories.

L'état du document est relu **avant** l'envoi, et non après : une copie dont l'échéance est
passée (`assignment_deadline`) arrête la commande là, plutôt que de lire le fichier et de
l'envoyer pour un refus. La *quick pick* n'ayant pas de ligne désactivée, un devoir échu y est
listé, le dit dans son libellé, et est refusé à la sortie ([moteur.md](moteur.md)).

## Installer

```bash
code --install-extension vscode/dist/certimens-vscode.vsix
```

Ou *Extensions › … › Installer à partir d'un VSIX*. En développement, `make -C vscode dev`
ouvre une fenêtre VS Code sur le dossier `vscode/` lui-même, sans rien construire : `media/`
(la feuille de style, les polices et l'icône partagées avec l'extension navigateur) y est fait
de **liens symboliques** vers `browser/`, que l'hôte d'extension suit comme des fichiers.

## « Certimens a été mis à jour »

Après une mise à jour, le panneau dit une fois quelle version tourne, avec un lien vers les
notes de release. La règle est la même dans les quatre agents et elle est écrite une
fois : [extension-navigateur.md](extension-navigateur.md#certimens-a-été-mis-à-jour).

La version vient de `context.extension.packageJSON`, et elle est lue au moment où la vue est
résolue : l'éditeur détruit et reconstruit une webview dès qu'une autre vue passe devant,
et la ligne se dirait à chaque retour si elle n'était pas consommée là. Une extension
chargée depuis un dossier (`make dev`) n'a pas de descripteur : rien n'est annoncé.

## Signaler un problème

Le lien, le bloc et ce qui n'y est jamais sont écrits une fois pour les quatre agents :
[moteur.md](moteur.md#signaler-un-problème). Ce qui est propre à celui-ci :

- trois portes, un seul chemin : la commande *Certimens : signaler un problème*
  (`certimens.reportProblem`, palette), le lien discret au pied du panneau — affiché connecté
  ou non, puisqu'un appairage qui échoue est le moment où l'on a besoin d'écrire —, et le bouton
  **Signaler un problème** de chaque notification d'erreur de l'extension (`notify.failure`,
  `panel.js` : les commandes, le panneau, l'appairage). Le panneau et le bouton exécutent la
  commande ; la webview **ne construit pas le lien et ne reçoit pas le bloc**, elle poste
  `reportProblem` et rien d'autre ;
- le lien est bâti par `Engine.reportUrl` (`REPORT_FRAGMENT`, `REPORT_KEYS`, comparés par
  `make check`). Le client ne connaît pas l'éditeur : c'est l'hôte qui lui passe `host`
  (`VS Code <vscode.version>`, suivi de `vscode.env.appName` quand ce n'est pas VS Code —
  VSCodium, Cursor…), `os` (`process.platform process.arch`, suivi de
  `remote <vscode.env.remoteName>` dans une fenêtre distante : son genre, `wsl`, `ssh-remote`,
  jamais la machine) et `paused`. `signed_in` est le drapeau `signedIn`, `queued` le
  `pending()` de la file, `counters` les compteurs de télémétrie pas encore envoyés, dans
  l'ordre du vocabulaire ; `status` est le mot d'état seul (`offline (reached)`,
  `offline (unreachable)`, `synced`…), **jamais son message**, qui peut citer le moteur ou un
  nom de fichier ;
- chaque valeur est ramenée à une ligne (caractères de contrôle remplacés) et bornée à
  120 caractères : onze lignes tiennent toujours sous les 1 500 du contrat, et la coupe du bloc,
  qui ne tombe qu'entre deux lignes, n'a jamais à en retirer une ;
- l'adresse est remise à `vscode.env.openExternal` **telle quelle, en chaîne** : un
  `vscode.Uri` la réécrit en encodant le `?`, le `=` et le `&` du fragment, que le formulaire
  ne lirait plus. Le cas de `make test-host` le vérifie (l'éditeur laisse `vscode.env`
  modifiable pendant une suite de tests, et seulement là).

Exemple de bloc, déconnecté du réseau dans une fenêtre WSL de VSCodium :

```
agent: vscode/1.4.2
host: VS Code 1.97.0 VSCodium
os: linux x64 remote wsl
language: fr
engine: https://monespace.certimens.fr
signed_in: yes
paused: no
status: offline (unreachable)
queued: 12
counters: network.failure=5
at: 2026-11-25T14:32:07Z
```

## Ce que l'agent dit de lui-même

Les compteurs d'installation, de démarrage, d'erreurs et d'échecs réseau, leur vocabulaire et
leur envoi sont décrits une fois pour les quatre agents :
[moteur.md](moteur.md#ce-que-lagent-dit-de-lui-même). Ce qui est propre à celui-ci :

- les compteurs vivent dans le `globalState` (clé `telemetry`, la dernière version vue dans
  `telemetryVersion`), à côté de la file, et **une déconnexion ne les efface pas** : ils sont à
  l'installation, pas au compte ;
- les échecs sont comptés là où passent tous les appels du travail de l'agent,
  `Engine.request` ; l'envoi des compteurs (`Engine.reportTelemetry`) n'y passe pas, et n'est
  donc jamais compté lui-même. Les réponses « continuez d'attendre » de l'appairage
  (`device_authorization_pending`, `device_slow_down`, `429`) ne sont pas des refus : elles
  arrivent toutes les cinq secondes pendant que l'étudiant confirme son code ;
- `error.runtime` ne compte que **les exceptions de l'extension**. L'hôte d'extension est
  partagé avec toutes les autres extensions installées : aucun gestionnaire `uncaughtException`
  ou `unhandledRejection` n'est posé, il compterait — et avalerait — les leurs. Ce sont les
  points d'entrée qui sont gardés : les écouteurs d'événements et les minuteries par
  `Engine.guard` (qui relance l'exception, pour que l'éditeur la journalise comme avant), les
  commandes et le panneau dans leur `catch`. Un `HttpError` n'y est pas compté : c'est une
  réponse du moteur, déjà comptée à l'appel, ou un refus que l'agent formule lui-même ;
- chaque exception comptée en `error.runtime` garde aussi **où** elle a été levée
  (`faultOf`, clé `telemetryFaults`, dix erreurs distinctes au plus) : son type et les frames de
  la pile qui sont des fichiers de l'extension, `fonction@engine.js:ligne:colonne`. Seules les
  lignes `at` de la pile de Node sont lues — jamais le message — et une frame ne garde que le nom
  du fichier, jamais son répertoire : l'extension est installée dans le dossier personnel de
  l'étudiant, dont le chemin nomme son compte. Une frame hors du dossier `src` de l'extension
  (l'éditeur, une autre extension, Node) est ignorée ;
- `installed` et `updated` comparent la version de `context.extension.packageJSON` à
  `telemetryVersion`. Une installation antérieure à ces compteurs n'a pas cette clé : la
  dernière version vue est alors le `seenVersion` du panneau, et à défaut une `config` ou une
  session (`signedIn`) suffit à compter `updated` plutôt qu'`installed` ;
- les 403/404 d'un document qu'on tente de **reprendre** ne concernent pas cet agent : il ne lit
  aucun identifiant de document dans un fichier, il ne connaît que ceux qu'il a créés (sa table
  `engineIds`). Un 404 sur l'un d'eux — document supprimé côté moteur — reste compté
  `error.rejected`, comme tout refus ;
- l'envoi part sur la boucle de la file (`Engine.tick`, chaque minute), après le vidage, et la
  date du dernier envoi tenté (`telemetryAt`) est persistée : recharger la fenêtre ne le
  rapproche pas.

## Côté moteur

La famille de client `vscode` doit être connue de l'ingestion du moteur, sinon chaque envoi est
marqué `client_unknown` sur le document : voir [moteur.md](moteur.md).
