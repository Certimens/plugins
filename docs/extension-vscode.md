# Extension VS Code

Une extension pour **Visual Studio Code** dans `vscode/`, paquet `vscode/dist/certimens-vscode.vsix`
(VS Code 1.90+), pour les devoirs qui se rendent en code plutôt qu'en traitement de texte.

C'est le seul agent qui mesure **un projet entier, fichier par fichier** : chaque fichier écrit
devient un document Certimens distinct, avec ses propres fenêtres de mesure — ce qu'un enseignant
corrige, ce sont des fichiers, pas un projet en bloc.

## Les fichiers

- `sensor.js` : les fenêtres de mesure, une instance par document ouvert, sans aucune dépendance
  à l'API de VS Code — c'est ce qui rend les règles vérifiables sans éditeur
  (`tests/sensor.test.mjs`).
- `engine.js` : moteur et file hors-ligne (stockage global de l'extension), jeton d'API dans le
  **SecretStorage** de l'éditeur et non dans `settings.json`, qui se synchronise entre machines
  et se lit par-dessus l'épaule. Pas de CORS : les appels partent de Node, pas d'une page.
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
  `chars` et `pastes` dans la branche qui écrit le `paste`.
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
  coup : collage, extrait ou complétion acceptée, l'éditeur ne dit pas lequel), `self` (un bloc
  que le document contenait déjà ailleurs), `click` (déplacement d'origine souris), `move`
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

`Engine.windowOf` réécrit chaque fenêtre clé par clé, dans l'ordre du contrat : ce qui sort de
la file a été relu du stockage de l'éditeur, qui ne promet rien sur l'ordre des clés, et une clé
que le corps ne connaît pas n'est jamais transmise. `offline` est la seule chose que le client
ajoute à ce que le capteur a scellé, entre `why` et `active` ; `sent` est réécrit à chaque
tentative.

## Quels fichiers sont mesurés

**Rien n'est créé tant que l'étudiant n'a pas écrit** : ouvrir un projet de quatre cents fichiers
n'en crée aucun côté moteur. Le réglage `certimens.exclude` écarte en plus les dépendances, la
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
souvenir, et la liste était donc reparcourue à chaque évènement.

Un fichier est identifié par un condensé du chemin du dossier de travail et son chemin
**relatif** dans le projet ; ce qui part au moteur est `projet/chemin/du/fichier`, jamais le
chemin absolu, qui nomme le compte de l'étudiant. Un fichier renommé ou déplacé garde ses
mesures : le document Certimens est renommé (`PUT /api/documents/:id`), pas remplacé.

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

## Côté moteur

La famille de client `vscode` doit être connue de l'ingestion du moteur, sinon chaque envoi est
marqué `client_unknown` sur le document : voir [moteur.md](moteur.md).
