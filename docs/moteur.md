# Le contrat avec le moteur

Tout ce qu'un agent attend du moteur Certimens, et rien de plus : les appels qu'il fait, ce
qu'il présente, ce qu'il fait d'un refus. Le moteur lui-même — son code, son modèle de données,
le calcul du score, son déploiement — est développé à part et n'est pas public : rien n'en est
repris ni cité ici.

## Adresse et authentification

L'**adresse du moteur** vaut `https://monespace.certimens.fr` et l'étudiant n'a pas à la saisir :
elle est repliée dans les **paramètres avancés** de la fenêtre de connexion, qui ne s'ouvrent
d'eux-mêmes que si l'adresse enregistrée n'est pas celle-là — un établissement qui héberge son
propre moteur, ou un développeur sur `http://localhost:8080`. Un champ vidé vaut l'adresse par
défaut : il n'y a pas de connexion refusée faute d'un champ que la fenêtre n'affichait pas.

### Ce que cette adresse a le droit d'être

Elle décide où part un **jeton d'API valable des mois** : en `http:`, il traverse le réseau en
clair, et un jeton lu une fois est un jeton gardé. Les agents n'acceptent donc `http:` que là où
la requête ne peut pas sortir du bâtiment — ailleurs, `https:` est obligatoire :

| Accepté en `http:` | Exemples |
| --- | --- |
| un nom à une seule étiquette, que seul un résolveur interne répond — mais pas tout en chiffres | `moteur`, `certimens-srv:9000` |
| la boucle locale | `localhost`, `sub.localhost`, `127.0.0.0/8`, `::1` |
| le mDNS | `ecole.local` |
| les plages privées, et les ULA en IPv6 | `10/8`, `172.16/12`, `192.168/16`, `fc00::/7` |

Tout le reste en `http:` est refusé, avec la phrase `error.engineUrlInsecure` : la fenêtre la dit
au moment où l'étudiant valide, et le client la redit à chaque appel — ce qui couvre une adresse
enregistrée avant que la règle existe, et une file qui s'arrête plutôt que de pousser en clair.

Ce n'était pas le cas jusqu'ici : n'importe quel hôte en `http:` était accepté, et refuser le
`http:` tout court aurait cassé le déploiement qui le justifie — un établissement qui sert son
moteur sur son intranet, sans certificat ni nom public. La règle porte donc sur l'**hôte** et
non sur le schéma. Un nom tout en chiffres est écarté parce que `http://134744072/`, c'est
8.8.8.8 déguisé en nom d'hôte.

Les **quatre agents** portent le même motif, caractère pour caractère (`LOCAL_ENGINE_HOST` dans
chacun des quatre clients), et `make check` les compare : un agent élargi tout seul serait un
trou que rien ne dirait nulle part.

Cela ne concerne que le moteur. Les **sites que l'étudiant ajoute** pour être mesurés restent
libres d'être en `http:` : aucun jeton n'y va — ce qui s'y rend, c'est un content script qui lit
une page choisie par l'étudiant — et un Moodle d'intranet en clair est un endroit réel où des
étudiants rédigent.

**Aucun agent ne demande de mot de passe.** Il n'y en a plus à demander : un compte peut
désormais se connecter par un fournisseur externe — un service d'identité, celui de son
établissement, ou un lancement depuis son Moodle — et un tel compte n'a **pas de mot de passe du
tout**. Et un champ « mot de passe » dans une extension est exactement la forme qu'aurait un faux
agent : ce n'est pas un geste à enseigner.

La connexion se fait par un **flux d'appareil** (*device authorization grant*, RFC 8628), celui
des téléviseurs et des consoles :

```
agent                           étudiant                        moteur
  │ POST /api/auth/device ───────────────────────────────────────▶
  │ ◀── code court « CDFH-JKMN », device_code, adresse à ouvrir ──
  │ affiche le code
  │                 ouvre son espace, se connecte, confirme ─────▶
  │ POST /api/auth/device/token (toutes les `interval` s) ───────▶
  │ ◀── jeton d'API ──────────────────────────────────────────────
```

L'agent envoie son **nom** (`client`) à l'ouverture : il est affiché à l'étudiant au moment où il
confirme, pour que quelqu'un qui n'a rien lancé le reconnaisse. Le moteur ne lui accorde aucune
confiance.

C'est ce **jeton d'API** qui est conservé. Deux choses ont changé côté moteur (audit run 3 du
moteur, parce que le flux remet le jeton à quiconque a fait approuver le code — un lien
d'appairage transféré suffisait) :

- il **expire au bout de 180 jours**. Il n'expirait pas. L'agent reçoit alors 401 et le dit
  (`error.credentials` : « reconnectez-vous ») ; rien d'autre à faire de son côté ;
- c'est un **justificatif d'agent** : le moteur ne l'accepte que sur les routes qu'un agent
  appelle — `GET /api/auth/me`, `GET` et `DELETE /api/auth/tokens[/:id]`, `POST /api/documents`,
  `GET`/`PUT /api/documents/:id`, `POST /api/documents/:id/metrics`, `GET /api/assignments`,
  `POST /api/plugins/telemetry` — et répond **403 `agent_scope_forbidden`** partout ailleurs. Un
  agent qui a besoin d'une route nouvelle la fait ouvrir côté moteur (`httpx.Auth.AllowAgent`)
  avant de l'appeler.

Il reste **révocable** — depuis l'espace Certimens, ou par l'agent lui-même
(`DELETE /api/auth/tokens/:id`) quand l'étudiant se déconnecte.

Les refus sont **distincts**, et un agent doit les distinguer. Trois conduites, quatre codes :
`device_authorization_pending` (personne n'a encore confirmé : continuer d'interroger),
`device_slow_down` (trop souvent : continuer, mais plus lentement), `device_code_expired` et
`device_denied` (fini : reproposer un code, ou dire que la demande a été refusée). Un agent qui
les confondrait abandonnerait une demande vivante ou interrogerait une demande morte jusqu'à
l'expiration.

Un **`429`** se range avec `device_slow_down` : il vient du limiteur de débit posé devant ces
routes, qui compte par adresse IP — tout un établissement derrière la même sortie le rencontre
alors que chaque appairage, pris seul, reste dans les clous. L'échange est vivant de l'autre
côté : les agents ajoutent cinq secondes à leur intervalle (RFC 8628) au lieu de lâcher un code
que son propriétaire s'apprête à confirmer. **Ce que vaut ce plafond est décidé côté moteur** :
le desserrer pour la route d'interrogation est un changement à demander là-bas.

Les deux refus que l'étudiant peut lire — un code expiré, un code refusé — sont **réécrits** par
chaque agent dans sa langue : le moteur ne répond qu'en anglais, et c'est le seul moment où
l'étudiant attend devant un écran ([langues.md](langues.md)).

| Agent | Où le jeton est gardé | Qui interroge pendant l'attente |
| --- | --- | --- |
| Extension navigateur | `chrome.storage.local` | le *service worker* — la popup se ferme dès que l'étudiant change d'onglet pour confirmer |
| Complément Word | `localStorage` du volet (partagé entre documents) | le volet, qui reste ouvert pendant la confirmation |
| Extension LibreOffice | `certimens.json` du profil, lisible par l'utilisateur seul | la fenêtre, hors du fil d'interface |
| Extension VS Code | le **SecretStorage** de l'éditeur, jamais `settings.json` | le panneau, ou la commande de la palette |

## Endpoints utilisés

| Appel | Usage |
| --- | --- |
| `POST /api/auth/device` | ouvrir un appairage : renvoie le code court à afficher et le `device_code` à conserver |
| `POST /api/auth/device/token` | demander si l'appairage a été confirmé ; renvoie le jeton d'API une fois fait |
| `GET /api/auth/tokens` | retrouver l'identifiant du jeton qui vient d'être remis, pour pouvoir le révoquer |
| `DELETE /api/auth/tokens/:id` | révoquer son propre jeton, à la déconnexion |
| `GET /api/auth/me` | rôle, langue et nom affiché du compte (le choix d'un devoir n'est proposé qu'au rôle `student`), et `writing_sites` : ce que son établissement propose de mesurer |
| `POST /api/documents` | créer le document Certimens qui recevra les mesures |
| `GET /api/documents/:id` | relire son état (nom, devoir, score) pour l'afficher |
| `POST /api/documents/:id/metrics` | pousser une fenêtre de mesure, ou un lot quand une file se vide — dans [le corps de mesure](#le-corps-de-mesure), le seul qu'il y ait |
| `PUT /api/documents/:id` | renommer le document, le rattacher à un devoir, y déposer son contenu |
| `GET /api/assignments` | les devoirs auxquels l'étudiant est rattaché |
| `POST /api/plugins/telemetry` | ce que l'agent compte **sur lui-même** — installations, démarrages, erreurs, échecs réseau — et **où son code a échoué**, voir [Ce que l'agent dit de lui-même](#ce-que-lagent-dit-de-lui-même) |

Le corps et les codes de retour de chaque appel sont documentés côté moteur ; ce que les agents
en utilisent tient dans les pages de ce dossier.

L'appairage rend le **jeton**, pas son identifiant : l'agent le retrouve en listant ses jetons
juste après, où le sien est **le plus récent**. L'ordre de cette liste est donc un point de
contrat ; si l'appairage venait un jour à rendre l'identifiant avec le jeton, cet appel de plus
disparaîtrait, et avec lui le cas tordu de deux agents appairés dans la même seconde.

`GET /api/auth/me` renvoie un **`display_name`** que le moteur calcule, et qui
retombe sur l'e-mail quand le compte ne porte ni prénom ni nom. Les agents l'affichent à la
place de l'e-mail dans leur ligne « Connecté : », en gardant l'e-mail en dessous quand il
apporte quelque chose de plus. Un moteur trop ancien pour l'envoyer ne casse rien : le champ est
absent, et la ligne retombe sur l'e-mail d'elle-même.

Le moteur sait aussi servir la **photo** d'un compte, mais **aucun agent ne l'affiche**, et
c'est un choix. Elle n'est pas un champ du JSON : c'est une ressource binaire qui exige
l'en-tête d'authentification, donc impossible à poser dans un `<img src>` — il faudrait la
récupérer puis la convertir, quatre fois, dont un passage par l'hôte pour la webview VS Code et
un fichier temporaire pour les fenêtres UNO. Beaucoup de machinerie pour un ornement dans une
fenêtre où l'étudiant sait déjà qui il est.

Le dépôt de contenu passe par `PUT /api/documents/:id` avec le document en base64, **18 Mo** au plus
(le moteur plafonne la requête à 25 Mio). Un nouvel envoi remplace le document précédent.

**Aucun appel n'attend indéfiniment** : 30 s, 5 min pour un dépôt. `fetch` n'a pas de limite à
lui, un portail captif tient une connexion des minutes, et le verrou de la file est tenu pendant
l'appel.

### Un nom déjà pris

Le moteur ne tient qu'**un document vivant par nom et par compte** : `POST /api/documents` sur
un nom que le compte porte déjà répond `409 document_name_taken`, et un nom de plus de 255
caractères `400`. Or un agent crée le plus souvent un document **sans que personne regarde** —
à la première fenêtre scellée — et sous un nom qu'il n'a pas choisi : le titre du Google Doc,
le nom du fichier, le chemin dans le projet. Ce nom est pris dès que l'étudiant s'est
déconnecté puis reconnecté (l'agent a oublié ses documents), travaille sur un second poste, ou
a deux fichiers appelés « Mémoire ».

| Qui a choisi le nom | Ce que fait l'agent d'un `document_name_taken` |
| --- | --- |
| personne — création depuis une fenêtre scellée, ou commande « rendre » de VS Code | reprend sous un **nom libre** : le nom, puis l'instant de la création, `Mémoire (2026-11-25 14.32.07)` |
| l'étudiant — le champ de la popup, du volet, de la fenêtre | le lui **dit** (`error.nameTaken`) et ne crée rien : renommer derrière quelqu'un, c'est deux documents aux noms que personne n'a choisis |

Le nom est coupé à 255 caractères (`DOCUMENT_NAME_MAX`) avant de partir. Et **un refus de
créer n'est jamais lu comme un refus de la fenêtre** qui attendait le document : la fenêtre
reste en file. Les quatre agents lisaient ce `409` comme celui d'une mesure, et jetaient une à
une toutes les fenêtres du document, sans un mot. `make check` tient la règle chez les quatre.

## Reprendre un document que le fichier nomme

Deux agents — le complément Word et l'extension LibreOffice — écrivent l'identifiant du document
Certimens **dans le fichier**, en propriété personnalisée : le même `.docx` ouvert dans Writer, ou
sur une autre machine, poursuit son dossier au lieu d'en ouvrir un second
([complement-word.md](complement-word.md), [extension-libreoffice.md](extension-libreoffice.md)).

**Rien de neuf n'est demandé au moteur** : la reprise tient dans `GET /api/documents/:id`, et
c'est son refus qui fait l'autorisation. Un identifiant lu dans un fichier n'est rien d'autre
qu'une prétention ; le moteur répond `403` ou `404` dès qu'il ne s'agit pas d'un document de ce
compte, et les agents lisent ces deux codes-là comme « ce fichier n'a rien à reprendre », en
silence — c'est le cas ordinaire d'un fichier qu'un camarade a envoyé, pas une erreur à montrer.

La question est posée à l'ouverture du fichier, et **reposée avant toute création** : un
fichier ouvert avant l'appairage, ou hors ligne, n'a pas pu la poser, et sa première fenêtre
ouvrait un second dossier — dont l'identifiant écrasait ensuite celui que le fichier portait.
Une reprise qui n'a pas reçu de réponse n'a rien décidé : aucun document n'est créé à sa place,
la fenêtre attend.

Deux conséquences qui ne se devinent pas d'ici :

- les agents vérifient la **forme** de l'identifiant avant de le mettre dans un chemin
  (`^[A-Za-z0-9_-]{1,64}$`) : il vient d'un fichier, et une barre oblique dedans appellerait une
  autre route avec le jeton de l'étudiant ;
- seul le rôle **`student`** reprend, ce que `GET /api/auth/me` donne déjà. Un enseignant est
  autorisé à lire la copie qu'on lui a rendue — le moteur répondrait `200` — et ses frappes
  iraient grossir le dossier de son étudiant.

Côté moteur, cela ne change donc qu'une chose, et elle est déjà vraie : **l'appartenance d'un
document est la seule garde**. Tout ce que ce dépôt-ci peut faire de plus, il le fait avant
l'appel.

## File hors-ligne

Aucun agent ne perd une mesure parce que le réseau manque : les fenêtres partent en **file
d'attente**, renvoyée chaque minute. Le stockage diffère (`chrome.storage.local`,
`localStorage`, `certimens.json`, stockage global de l'extension VS Code), le comportement non.

Trois règles tiennent la file propre, chez les quatre :

- **un renommage que le moteur refuse est tenu pour fait** (`4xx` hors `401`, `408`, `429` :
  nom déjà pris, échéance passée, document supprimé) — il ne repart pas à chaque minute et ne
  fait pas virer l'état d'envoi au rouge ;
- **un jeton refusé (`401`) n'est pas réessayé à chaque fenêtre** : les fenêtres attendent, la
  boucle redemande une fois par minute, et se reconnecter remet l'état à zéro ;
- **rien n'entre en file quand personne n'est connecté**, et la déconnexion scelle, envoie puis
  efface sous le verrou de la file — ce qu'un compte a mesuré ne part jamais sous le suivant.

Conséquence assumée, côté moteur : une fenêtre légitime peut précéder son propre document de
plusieurs heures — un travail commencé hors ligne. L'ingestion ne traite donc pas comme suspecte
une fenêtre datée d'avant la création du document.

### Déclarer qu'une fenêtre a été écrite hors ligne

Une fenêtre peut porter **`offline: true`**. Le champ ne décrit pas la file, il décrit la
**fenêtre** : il dit que l'étudiant écrivait pendant que le moteur était hors d'atteinte.

La règle est la même dans les quatre agents, et elle est posée **à la mise en file**, pas au
départ : une fenêtre est `offline` si, au moment où elle a été close, la dernière tentative
d'envoi était **restée sans réponse**. Un moteur qui a répondu une erreur — un `5xx`, un `429`,
un refus — a été joint (`reached` dans l'état d'envoi) : ce qui s'empile derrière n'est pas
marqué, et repart fenêtre par fenêtre. Une fenêtre écrite alors que le moteur répondait encore part sans rien
dire, même si elle attend ensuite des heures. Aucun agent ne se fie à `navigator.onLine` : un
portail captif répond à la couche liaison et jamais au moteur, et deux des quatre agents n'ont
de toute façon pas cette API.

Ce que le champ produit côté moteur est un **taux de rédaction hors ligne**, affiché ; il
n'entre pas dans le score. Déclarer `offline` ne retire aucun signal d'ingestion : un
rattrapage reste un rattrapage.

### Déclarer pourquoi la fenêtre s'est fermée

Une fenêtre porte **`why`** : le mot qui dit lequel des déclencheurs de l'agent l'a scellée. Le
vocabulaire est celui du moteur, six mots, et la table qui dit lequel chaque déclencheur produit
vit dans le capteur de chaque agent
([mesures.md](mesures.md#pourquoi-la-fenêtre-sest-fermée)). Le champ est **obligatoire** : une
fenêtre sans mot, ou avec un mot hors du vocabulaire, est refusée.

Contrairement à `offline`, cette déclaration **peut rapporter quelque chose** : le moteur
retire de son calcul du rythme les silences qui suivent un départ. Il la recoupe donc avec ce
que la fenêtre porte là où cela peut la corroborer — ce qu'il vérifie et ce qu'il en fait
se documentent de son côté. Ce que les agents en doivent est simple : ne jamais déclarer un
départ qu'ils n'ont pas compté.

### Une fenêtre en direct part seule, une file part par lots

Une fenêtre qui vient d'être scellée part **seule** dans sa requête. Une file qui se vide après
une coupure part **par lots** : jusqu'à `BATCH_MAX_WINDOWS` (64) fenêtres **voisines dans la
file**, de la même session et du même document, par `seq` croissant, **chacune portant
`offline: true`**. Un lot n'est légitime qu'à cette condition : une fenêtre qui a attendu pour
une autre raison — le moteur a répondu une erreur — repart seule, faute de quoi le moteur lève
`multi_window_batch`. Les fenêtres d'une autre session partent dans une autre requête. Le
curseur qui empêche une fenêtre de partir deux fois avance alors d'un lot à la fois.

Un lot que le moteur refuse est renvoyé **fenêtre par fenêtre** : un refus désigne une fenêtre,
et la seule à abandonner est celle-là.

### Ce qui sort de la file est reconstruit clé par clé

L'ordre des clés du corps n'est pas libre ([*Le corps de mesure*](#le-corps-de-mesure)), et une
file se relit depuis le stockage de l'hôte — `chrome.storage.local`, le stockage global de
VS Code, le profil sur disque. Ce qui en revient n'est pas l'objet qu'on y a rangé : c'est un
objet que l'hôte reconstruit, et **rien ne promet qu'il en garde l'ordre des clés**.

Les quatre agents **reconstruisent donc la fenêtre clé par clé** au moment de l'envoi, au lieu
de transmettre celle qui sort de la file, et leurs doubles de stockage rendent leurs clés dans
le désordre pour qu'un code qui s'y fierait échoue chez nous et pas chez l'étudiant. Une fenêtre
mesurée à l'instant et une fenêtre sortie de la file partent ainsi dans les mêmes octets, à
`sent` et `offline` près. Chaque agent tient cet ordre dans sa propre suite, sur son propre
sérialiseur : `libreoffice/tests/test_engine.py` sur un vrai corps HTTP,
`browser/tests/background.test.mjs`, `vscode/tests/engine.test.mjs` et
`word/tests/agent.test.mjs` sur le corps que leur `fetch` reçoit.

**Une entrée de file qui n'a pas la forme du corps est abandonnée**, pas convertie : il n'y a
qu'un corps, et une fenêtre restée en file sous une forme qu'un agent ne produit plus n'a ni
les champs qu'il faudrait pour la réécrire, ni un moteur pour la lire.

## Le corps de mesure

Ce que les agents envoient à `POST /api/documents/:id/metrics`. Cette section est l'énoncé du
contrat tel que les quatre agents le tiennent ; ce que chaque bloc *mesure*, et comment un
capteur le remplit, est dans [mesures.md](mesures.md).

**Il n'y a qu'un corps, et il n'a pas de numéro.** Quand le protocole change, le moteur et les
capteurs changent ensemble, et l'ancien corps cesse d'exister. Aucun agent ne négocie, ne se
replie ni ne retire une mesure pour un moteur plus ancien ; un corps que le moteur ne reconnaît
pas est refusé, et c'est tout.

### Les trois règles du corps

1. **Un fait n'est dit qu'une fois.** Le corps porte ce que le capteur a *observé* — le déroulé
   ordonné des gestes, la distribution du rythme, la portée du texte — et le moteur en
   **déduit** tout ce qui s'en déduit : le nombre de frappes, de collages, de caractères
   injectés, de pauses, d'hésitations. Aucun de ces nombres ne voyage. Une règle de comptage vit
   donc à un seul endroit et change sans redéployer les capteurs ; et un compteur ne peut plus
   contredire le déroulé dont il sort.
2. **Ce qui voyage en plus du déroulé est ce que seul le capteur sait.** Classer une suppression
   en correction ou en reformulation demande de savoir quelle touche, quelle sélection, quel
   clic l'a précédée — ce qui ne quitte jamais le poste. Ces quelques nombres-là voyagent, dans
   `counts`.
3. **Une mesure que le capteur ne sait pas prendre est absente, jamais à zéro.** Une clé absente
   de `counts`, un bloc `flight`, `dwell` ou `text` absent : le moteur n'en tire aucune mesure,
   et l'absence n'entre dans aucune moyenne.

Un agent tourne sur le poste de celui qu'il mesure : rien de ce qu'il envoie n'est une preuve en
soi. Ce qui rend un envoi coûteux à forger, ce sont les faits tenus par **deux observations
indépendantes** : la numérotation et les cumuls de session (une fenêtre retenue manque), les
deux horloges (une heure remontée se voit), le texte lu contre les gestes comptés (du texte
arrivé sans geste se voit), les appuis contre les frappes. Répéter un nombre que le capteur
aurait lui-même tiré du déroulé n'ajoute rien à cela — c'est pourquoi ces nombres ne sont pas
dans le corps.

### Ce qui ne part pas

**Aucun caractère, aucune touche, aucun texte, aucune empreinte de texte.** Le corps est fait de
nombres et de catégories ; les trois choix qui les empêchent de redevenir du texte, et ce que
les capteurs gardent en mémoire pour les calculer, sont dans
[mesures.md](mesures.md#confidentialité). Une empreinte du contenu (hachage, MinHash) lierait
plus fortement la mesure au document rendu : elle est **délibérément absente**, parce qu'elle
ferait transiter un dérivé du texte par la mesure. C'est une décision de contrat, pas un oubli.

### Le corps

```json
{
  "session": "p3Vq0hJmR2aXw9LkT1yZ5g",
  "sent": 1794478507412,
  "windows": [
    {
      "seq": 12,
      "at": 1794478471120,
      "mono": 1843120,
      "ms": 34180,
      "why": "idle",
      "active": 27800,
      "runs": [
        ["gap", 5200], ["type", 20, 4100], ["nav", 3, 600], ["type", 96, 21400],
        ["erase", 7, 900], ["gap", 1400], ["type", 5, 800], ["paste", 240]
      ],
      "counts": { "corrections": 4, "reformulations": 1, "revisions": 0, "jumps": 3, "exits": 0, "back_keys": 0, "back_chars": 0 },
      "flight": { "med": 92, "mad": 38.5, "bins": [0, 2, 9, 21, 30, 24, 15, 9, 6, 4, 2, 1] },
      "dwell": { "bins": [0, 1, 8, 31, 40, 22, 9, 4, 1], "rollover": 17 },
      "text": { "len": 1540, "since": 11, "at": 1180, "cut": 0, "add": 360, "kept": 0 },
      "sum": { "keys": 5400, "chars": 240, "pastes": 1 }
    }
  ]
}
```

L'exemple est indenté pour être lu ; **le corps envoyé ne l'est jamais**. L'ordre des clés est
celui de l'exemple à tous les niveaux (dans `counts`, l'ordre est libre). `offline` s'insère
entre `why` et `active`, `unseen` entre `sent` et `windows`. Un bloc ou une clé facultatifs
absents sont **omis**, jamais envoyés vides ou à `null`. **Une clé inconnue est un refus**, à
tous les niveaux : le vocabulaire est fermé, et c'est ce qui dit à un capteur en retard qu'il
l'est.

Tous les instants et toutes les durées sont des **entiers de millisecondes**. **Toute durée
est mesurée sur l'horloge monotone** — `ms`, `active`, la durée d'une suite et d'un silence, les
écarts de `flight`, les appuis de `dwell` ; l'horloge murale ne donne que `at` et `sent`.

### L'enveloppe

| Champ | Obligatoire | Règle |
| --- | --- | --- |
| `session` | oui | 16 à 64 caractères `[A-Za-z0-9_-]`, tirés au hasard (≥ 96 bits) quand l'agent **commence à mesurer ce document** : ouverture de la page, du volet, du fichier, reprise après une suspension ou un rappairage — au plus tard au premier événement compté, qui est alors le zéro de `mono`. Jamais persistée au-delà de la vie du capteur, jamais dérivée du compte ni de la machine |
| `sent` | oui | l'horloge du poste à l'instant de l'envoi, en millisecondes depuis l'époque Unix. **Réécrite à chaque tentative** : elle n'est pas gardée dans la file. Le moteur la lit et la valide, et ne la conserve pas |
| `unseen` | non | ce que ce capteur ne sait pas observer et que le moteur déduirait sinon du déroulé. Un seul mot aujourd'hui : `hesitations` (voir [*Le silence*](#le-silence)). Omis par un capteur qui voit tout |
| `windows` | oui | 1 à 64 fenêtres de **cette** session, par `seq` croissant ; plusieurs seulement si toutes portent `offline: true` ([*Une fenêtre en direct part seule*](#une-fenêtre-en-direct-part-seule-une-file-part-par-lots)) |

### La fenêtre

| Champ | Obligatoire | Règle |
| --- | --- | --- |
| `seq` | oui | entier ≥ 0. `0` pour la première fenêtre **scellée** de la session, puis +1 à chaque fenêtre scellée — y compris celles qui ne partiront jamais. C'est le capteur qui numérote, au scellement, pas l'envoi. Une fenêtre n'est scellée que si elle porte une activité : une fenêtre vide ne consomme pas de numéro, et tout numéro qui manque au moteur est donc une fenêtre qui portait quelque chose |
| `at` | oui | l'horloge du poste à la **première activité** de la fenêtre, en millisecondes depuis l'époque Unix |
| `mono` | oui | le même instant, lu sur une **horloge monotone** dont le zéro est le début de la session (`performance.now()`, `time.monotonic()`) |
| `ms` | oui | de la première à la dernière activité, mesuré sur l'horloge monotone. Au moins `1000` : une fenêtre d'un seul instant s'envoie à 1000. La fin de la fenêtre est `at + ms` ; le temps mort n'y entre jamais |
| `why` | oui | pourquoi la fenêtre a été scellée : `idle`, `volume`, `save`, `focus`, `away`, `end` |
| `offline` | non | `true` si la fenêtre a attendu en file faute de réseau ; absent sinon |
| `active` | oui | le temps de frappe effectif de la fenêtre |
| `runs` | oui | le déroulé, voir ci-dessous. Jamais vide : une fenêtre scellée porte une activité |
| `counts` | oui | ce que seul le capteur sait classer, voir ci-dessous |
| `flight` | selon le capteur | les écarts entre frappes, voir ci-dessous |
| `dwell` | selon le capteur | les durées d'appui, voir ci-dessous |
| `text` | selon le capteur | le texte lu, voir ci-dessous |
| `sum` | oui | les cumuls de la session **jusqu'à cette fenêtre comprise** |

### `runs` — le déroulé

Les gestes dans l'ordre où ils ont eu lieu. Une suite a l'une de trois formes, selon son
genre — aucun champ n'y vaut toujours la même chose :

| Forme | Genres | Lecture |
| --- | --- | --- |
| `[genre, n, ms]` | `type`, `erase`, `nav`, `other` | `n` **frappes** en `ms`, de la première à la dernière |
| `[genre, n]` | `move`, `click`, `paste`, `self`, `suggest`, `copy`, `undo`, `fix` | un geste sans durée ; `n` est une quantité |
| `["gap", ms]` | `gap` | un silence de `ms` |

Ce qu'est chaque genre, et ce que `n` y compte, est dans
[mesures.md](mesures.md#le-déroulé). Deux suites consécutives n'ont jamais le même genre, sauf
`gap`, `paste`, `self` et `suggest`. Au plus **512** suites par fenêtre : une fenêtre qui les atteindrait
est scellée avant, avec `volume` — `runs` n'est jamais abandonné ni tronqué. Une durée de suite
ne recouvre jamais un `gap` : elle s'arrête où le silence commence. Les capteurs qui travaillent
par différences de texte (Word, VS Code) émettent une suite par différence — `type` pour ce qui
est inséré à la taille d'une frappe, `erase` pour ce qui est retiré, `paste` pour un bloc — avec
`ms` à `0` quand ils n'ont pas la durée.

#### Le silence

Le capteur émet un `gap` pour **tout silence d'au moins 1 000 ms entre deux frappes comptées**,
à sa durée réelle, non plafonnée — et nulle part ailleurs. Il ne le classe pas : c'est le moteur
qui lit une hésitation ou une pause dans sa durée. Quatre précisions :

- le silence qui a précédé la première frappe de la fenêtre est **toujours la première suite**
  de cette fenêtre, même si un clic ou un collage l'a ouverte avant ;
- un silence **ne traverse jamais une session** : il se mesure depuis la dernière frappe de la
  session en cours, et la première fenêtre d'une session ne porte donc aucun `gap` de tête ;
- un silence d'au plus 3 000 ms (inclus) qu'achève une touche prise par une composition (palette
  d'accents, IME) n'est pas émis : la touche ne dit rien d'une recherche de mot ;
- un capteur qui ne résout pas les silences courts (Word) n'émet que ceux de **plus de
  3 000 ms** et le déclare par `unseen: ["hesitations"]`.

### Ce que le moteur déduit du déroulé

| Mesure | Déduction |
| --- | --- |
| `keystrokes_total` | Σ `n` des suites `type`, `erase`, `nav`, `other` |
| `paste_events` | nombre de suites `paste` |
| `injected_chars_total` | Σ `n` des suites `paste` de plus de 15 caractères |
| `injected_chars_max` | le plus grand `n` d'une suite `paste`, quand il dépasse 15 ; sinon `0` |
| `self_paste_events` | nombre de suites `self` |
| `self_paste_chars_total` | Σ `n` des suites `self` |
| `suggest_events` | nombre de suites `suggest` |
| `suggest_chars_total` | Σ `n` des suites `suggest` |
| `lexical_hesitations` | nombre de `gap` de 1 000 à 3 000 ms inclus. **Aucune mesure** si l'enveloppe porte `unseen: ["hesitations"]` |
| `cognitive_pauses` | nombre de `gap` de plus de 3 000 ms, jusqu'à 300 000 ms inclus. Au-delà, le silence est un départ, pas une pause |

Ces dix mesures existent pour chaque fenêtre reçue, zéro compris (à l'exception dite pour les
hésitations). Leurs noms sont ceux de l'API du moteur ; **aucun ne figure dans le corps**, et
les seuils ci-dessus sont les siens : les capteurs ne les connaissent pas. La seule de ces
règles qu'un capteur tient aussi est celle des 15 caractères (`INJECTION_MIN_CHARS`), parce
qu'il en a besoin pour `sum.chars`.

### `counts` — ce que seul le capteur sait classer

Des entiers ≥ 0. Une clé que le capteur ne sait pas mesurer est **absente**.

| Clé | Mesure côté moteur | Ce que c'est |
| --- | --- | --- |
| `corrections` | `immediate_corrections` | réparer sur place ce qu'on vient de taper ; une annulation |
| `reformulations` | `deferred_reformulations` | revenir sur ce qui est écrit |
| `revisions` | `macro_revisions` | les gestes de bloc |
| `jumps` | `navigation_jumps` | déplacements dans le document, clavier et souris |
| `exits` | `focus_losses` | sorties du document pendant la fenêtre |
| `back_keys` | `keystrokes_after_return` | frappes dans les 15 s suivant un retour au document |
| `back_chars` | `injected_chars_after_return` | caractères injectés dans les 15 s suivant un retour |

Les définitions exactes sont dans
[mesures.md](mesures.md#ce-que-seul-le-capteur-sait-classer) : elles dépendent de touches et de
sélections que le corps ne porte pas.

### `flight` et `dwell` — le rythme

| Champ | Règle |
| --- | --- |
| `flight.med` | médiane des écarts entre deux frappes consécutives de moins de 800 ms, arrondie à deux décimales |
| `flight.mad` | écart absolu médian des mêmes écarts, même arrondi |
| `flight.bins` | le nombre de ces écarts par tranche. Bornes inférieures, en ms : `0, 20, 40, 60, 80, 100, 130, 160, 200, 250, 320, 400, 500, 650` — la dernière tranche va jusqu'à 800 exclu. 14 tranches au plus |
| `dwell.bins` | le nombre de durées d'appui (touche enfoncée → relâchée) par tranche, pour les seules touches `type`. Bornes inférieures : `0, 20, 40, 60, 80, 100, 120, 150, 200, 300` — la dernière tranche est ouverte. 10 tranches au plus |
| `dwell.rollover` | le nombre de frappes `type` enfoncées **alors qu'une autre touche `type` n'était pas encore relâchée** |

**Les zéros de queue d'un histogramme ne s'envoient pas** : `[0, 2, 9]` vaut `[0, 2, 9, 0, …]`,
et un histogramme entièrement nul s'envoie `[]`.

`flight` est omis sans au moins deux écarts, et par un capteur qui ne voit pas les frappes.
`dwell` demande de voir le relâchement des touches : un capteur qui ne le voit pas l'omet ;
celui qui le voit l'envoie toujours, zéros compris.

### `text` — le texte lu

| Champ | Ce que c'est |
| --- | --- |
| `len` | la taille du texte en caractères |
| `since` | le `seq` de la fenêtre qui portait la lecture précédente |
| `at` | la longueur du préfixe commun aux deux lectures : où la modification commence |
| `cut` | ce qui a disparu entre le préfixe et le suffixe communs |
| `add` | ce qui est apparu à la place |
| `kept` | facultatif : parmi `add`, les caractères qui **étaient déjà** dans `cut`, dans le même ordre (plus longue sous-suite commune, comptée par mots) |

Le bloc a deux formes. **`{"len": n}` seul** quand la taille est connue sans lecture neuve à
comparer : relevé en cache, ou première lecture de la session. **Avec la portée** (`since`,
`at`, `cut`, `add`, et `kept` s'il est calculé) à chaque nouvelle lecture qui en suit une autre
dans la session — y compris identique : `cut` et `add` à `0`. Le bloc est **omis** quand le
texte n'a pas pu être lu, et par les capteurs qui ne le lisent pas (Overleaf).

La portée compare deux lectures par leur plus long préfixe commun et leur plus long suffixe
commun (en caractères, sans chevauchement). **C'est une enveloppe, pas une modification** :
entre deux lectures, l'étudiant peut avoir touché deux endroits éloignés, la portée va alors du
premier au dernier, et tout le texte intact entre les deux figure à la fois dans `cut` et dans
`add`. Ce que la portée affirme sans ambiguïté est donc la **croissance** (`add − cut`) et la
**position** ; `kept` lève le reste : le texte neuf est `add − kept`. Un capteur qui ne le
calcule pas l'omet, et le moteur ne compte alors comme texte neuf que la croissance, et comme
texte retiré tout `cut`. Le calcul
est borné : au-delà de 2 000 mots de part ou d'autre (`TEXT_KEPT_MAX_WORDS`), `kept` est omis
plutôt que calculé — et un capteur peut plafonner plus bas, le calcul tournant sur le fil de
l'étudiant.

Ce bloc rend lisibles deux choses qu'une taille ne dit pas : **du texte arrivé sans geste** (du
texte neuf au-delà de ce que les frappes, les collages et les restitutions des fenêtres depuis
`since` expliquent — même quand `cut` compense et que la taille ne bouge pas), et **où**
l'étudiant écrit (`at + cut` égal à la taille précédente : à la fin ; sinon dans le texte déjà
écrit). La seconde est ce sur quoi le moteur note le **remaniement** : le texte retiré du
déjà-écrit ou inséré dedans, en caractères, rapporté au texte produit — les compteurs
`counts.reformulations` et `counts.revisions` n'y servent plus que de repli, pour une rédaction
dont aucune fenêtre n'a porté de portée ([mesures.md](mesures.md#le-texte-lu)).

### `sum` — les cumuls

| Champ | Ce que c'est |
| --- | --- |
| `keys` | Σ des frappes des fenêtres `0…seq` de la session : les `n` des suites `type`, `erase`, `nav`, `other` |
| `chars` | Σ des caractères injectés : les `n` des suites `paste` de plus de 15 caractères |
| `pastes` | Σ des collages : le nombre de suites `paste` |

**`chars` et `pastes` ne comptent pas les suggestions**, pas plus que `keys` : une suite `suggest`
n'est ni un caractère injecté, ni un collage, ni une frappe, et une fenêtre qui n'apporte qu'une
suggestion laisse les trois cumuls où ils étaient. Pour la même raison `counts.back_chars` ne
compte que les caractères des suites `paste` : il ne peut pas dépasser ce que le moteur déduit
en caractères injectés.

Les trois sont obligatoires. Tenus par le capteur au scellement, dans la même opération que
`seq`, avec les mêmes déductions que le moteur. C'est ce qui fait qu'une fenêtre retenue se
voit : la suivante arrive avec un numéro qui saute **et** des cumuls que la somme des fenêtres
reçues n'atteint pas — l'écart est exactement ce que la fenêtre manquante portait.

### Ce que le moteur refuse

| Réponse | Ce qu'elle dit | Ce que fait l'agent |
| --- | --- | --- |
| `201` | reçu — y compris quand il lève un signal d'intégrité, qui ne se voit pas dans la réponse | la fenêtre quitte la file |
| `400` | ce n'est pas un corps du protocole, ou la fenêtre est hors bornes | abandonne la fenêtre |
| `409` | ce `seq` est déjà enregistré pour cette session avec un **autre** `at` ou un autre `ms`. Le même `seq` avec les mêmes est un renvoi : accepté sans rien réécrire | abandonne la fenêtre |

Lève un `400` : une clé inconnue ou écrite deux fois ; un champ obligatoire absent ; `session`
mal formée ; `windows` vide ou de plus de 64 ; `seq` négatif, répété dans le lot ou non
croissant ; un genre de suite inconnu, une suite qui n'a pas la forme de son genre, `runs` vide
ou de plus de 512 suites ; un histogramme trop long ; un mot inconnu dans `why` ou `unseen` ;
une portée incomplète (une partie seulement de `since`, `at`, `cut`, `add`) ou dont le `since`
n'est pas antérieur au `seq` ; `ms` sous 1000 ; une valeur négative, non entière là où un entier
est attendu, non finie, ou au-delà de 2⁴⁰ — 2⁴⁸ pour les deux instants `at` et `sent` (une borne de calcul, pas de vraisemblance : un
silence s'envoie à sa durée réelle) ; et les bornes de plausibilité que le moteur tient sur les
mesures.

**Un agent n'insiste ni sur un `400` ni sur un `409`** : il abandonne la fenêtre, parce
qu'insister bloquerait la file. **Aucun refus ne le fait changer de corps** : il n'y en a pas
d'autre.

### Ce que le moteur signale

**Relations vérifiées** — une fenêtre qui en casse une est acceptée et lève
`values_impossible`, dont le détail nomme laquelle :

- Σ `ms` de toutes les suites, sauf le `gap` de tête, ≤ `ms` de la fenêtre + 1 000 ;
- Σ `dwell.bins` ≤ Σ `n` des suites `type` **+ 2**, et `dwell.rollover` ≤ Σ `dwell.bins` **+ 2**.
  La marge est celle des touches encore enfoncées au scellement : une frappe est comptée quand
  la touche descend et son appui quand elle remonte, donc une fenêtre fermée entre les deux
  laisse l'appui à la suivante ;
- `flight.med` tombe entre la borne basse de la tranche qui contient l'écart médian inférieur
  et la borne haute de celle qui contient l'écart médian supérieur ;
- `text.len` = `len` de la fenêtre `since` − `cut` + `add` ; `at + cut` ≤ ce `len` précédent ;
  `kept` ≤ min(`cut`, `add`) ; `at + add` ≤ `len` ;
- chaque cumul de `sum` est **au moins** égal à ce que la fenêtre porte, et lui est **égal**
  quand `seq` vaut 0 ;
- la fenêtre `seq` 0 ne porte pas de `gap` de tête : un silence ne traverse pas une session.

**Signalé, jamais refusé** — comme tout signal d'intégrité, répondu exactement comme un envoi
propre :

| Signal | Ce qui le lève |
| --- | --- |
| `values_impossible` | une des relations ci-dessus est cassée |
| `window_missing` | une session a des numéros manquants, ou des cumuls que ses fenêtres n'atteignent pas |
| `clock_rewound` | dans une session, l'écart entre `at` et `mono` a **reculé** de plus de 5 s d'une fenêtre à la suivante : l'heure du poste a été remontée. Une avance n'est pas signalée — un poste qui dort arrête l'horloge monotone |
| `insertion_unexplained` | une portée dont le texte neuf (`add − kept`, ou `add − cut` sans `kept`) dépasse d'au moins 500 caractères ce que les fenêtres depuis `since` expliquent. Sur un document partagé, le texte d'un co-auteur le lève aussi : c'est un constat, pas une accusation |
| `rhythm_synthetic` | sur le document, une distribution du rythme qu'une main ne produit pas |
| `evidence_withheld` | un agent déclaré (`X-Certimens-Agent`) dont le genre sait produire un bloc, et qui ne l'envoie pas |
| `flush_odd` | un `why` que la fenêtre contredit : `away` avec `counts.exits` à 0, ou `volume` sous `FLUSH_KEYSTROKES` frappes dans une fenêtre loin de `TIMELINE_MAX_RUNS` suites. La déclaration n'est alors pas crue |
| `text_append_only` | un long document dont les portées n'ont jamais écrit ailleurs qu'à la fin du texte |
| `text_lost_between_sessions` | `text.len` à l'ouverture d'une session inférieur d'au moins 500 caractères à celui de la fermeture de la précédente |

Ce que le moteur fait de ces signaux se documente de son côté. Ce que les agents en doivent
tient en une phrase : **envoyer chaque bloc qu'ils savent remplir, et ne jamais envoyer un bloc
qui contredit le déroulé.**

### Ce que chaque capteur envoie

| Bloc | Navigateur | LibreOffice | VS Code | Word |
| --- | --- | --- | --- | --- |
| `runs`, `counts`, `sum` | oui | oui | oui (par modification) | oui (par différence, `ms` à 0) |
| `unseen` | — | — | — | `hesitations` |
| suites `suggest` | — | — | quand l'éditeur expose son API de collage | — |
| `counts.exits`, `counts.back_keys`, `counts.back_chars` | oui | oui | oui | non |
| `flight` | oui | oui | oui | non |
| `dwell` | oui | oui | non | non |
| `text` | Google Docs (à chaque export), Word Online, site ajouté ; non sur Overleaf | oui | oui | oui |

`suggest` n'est pas un bloc et n'entre pas dans ce que `evidence_withheld` exige : une séance
où aucune complétion n'a été acceptée n'en porte pas, et c'est une séance ordinaire.

Ce qu'un agent n'envoie pas, et pourquoi, est dans [mesures.md](mesures.md#écarts-assumés).
Cette table est ce que `evidence_withheld` lit : le moteur la tient de son côté, par **genre**
d'agent (celui de `X-Certimens-Agent`). **Un capteur qui gagne un bloc le déclare donc côté
moteur dans le même changement.** La portée `text` n'est pas exigée de l'extension navigateur :
un envoi ne dit pas sur quel site il a mesuré, et l'exiger signalerait chaque étudiant sur
Overleaf.

## Les sites que l'établissement propose

`GET /api/auth/me` porte un champ **`writing_sites`** : les origines où l'établissement de
l'étudiant dit que ses étudiants rédigent (`["https://moodle.univ.fr"]`). **Seule l'extension
navigateur s'en sert** — les trois autres agents n'ont pas de notion de « site ».

Elle voyage là et non sur une route à elle, parce qu'un agent connaît un compte et jamais une
école. Conséquence directe : **elle ne coûte aucun appel**. Chaque `me` que l'agent fait déjà —
celui qui termine un appairage, celui qui précède la liste des devoirs, celui du bouton
« tester » — la rafraîchit au passage, et la relecture quotidienne n'existe que pour les jours où
l'agent ne demande rien d'autre. Le champ ne nomme pas l'établissement : l'agent écrit donc
« votre établissement », sans le nommer.

Elle **propose**, elle n'accorde rien, et c'est ce qui décide du reste. L'API d'autorisation d'un
navigateur n'obéit qu'à un geste de l'utilisateur, qu'aucun serveur et aucun *service worker*
n'aura jamais : l'étudiant confirme donc chaque origine dans la fenêtre de son propre navigateur,
depuis la page d'options, peut les refuser toutes, et garde l'ajout manuel. Ce que la liste
supprime, c'est la saisie de l'adresse — là où un étudiant se trompe —, et rien d'autre.

Ce que l'agent en fait, et qui ne se devine pas depuis le moteur :

- il ne retient que ce qu'il peut **réellement** demander à un navigateur : `https` et une
  origine exacte. Une entrée à joker, en `http` ou d'un autre schéma est écartée en silence — la
  liste vient d'un serveur, et l'étudiant ne lirait pas ça dans sa fenêtre d'autorisation ;
- il la relit **une fois par jour** au minimum, et à chaque ouverture de la page d'options ; un
  compte qui arrive écrase la liste du précédent, fût-elle vide — c'est ce qui empêche l'école où
  l'on était connecté il y a une minute de transparaître ;
- un `me` qui **répond sans le champ** est un moteur trop ancien pour le porter, et cela se lit
  comme « cette école ne propose rien » : c'est une réponse, elle est enregistrée comme telle ;
- un `me` qui **ne répond pas** ne dit rien à l'étudiant et ne touche pas à ce qui a été lu la
  veille — les adresses d'un établissement ne doivent pas disparaître de la page parce que le
  réseau a disparu.

Qui a le droit d'écrire cette liste, ce qu'une adresse devient en la rangeant et ce qui est
refusé se décident **côté moteur** ; ce dépôt-ci n'en documente que ce qu'un agent en présente.

## Ajouter ou changer une mesure

Le vocabulaire du corps est **fermé** : une clé, un genre de suite ou un mot que le moteur ne
connaît pas fait refuser la fenêtre entière. Il n'y a ni négociation ni repli — un agent
n'apprend pas d'un refus ce qu'il devrait retirer, et il ne retire rien.

**Ajouter une mesure, c'est donc un seul changement en deux endroits, le moteur d'abord** : le
champ se définit dans le contrat et le moteur apprend à le lire, puis les quatre capteurs
l'envoient, ensemble. Renommer une clé, déplacer un seuil que les capteurs tiennent, ajouter un
genre de suite ou un mot à `why` suivent le même ordre. Ce qui se **déduit** du déroulé — un
nouveau décompte, un seuil de silence — ne demande rien aux agents : c'est une règle du moteur,
et elle change sans les redéployer.

Tant que le produit n'est pas en production, l'ancien corps cesse simplement d'exister : une
fenêtre restée en file sous une forme antérieure est abandonnée
([*File hors-ligne*](#ce-qui-sort-de-la-file-est-reconstruit-clé-par-clé)).

## Échéance passée

L'**échéance** d'un devoir est la porte : passée, le moteur refuse le rendu, et refuse de
toucher à une copie déjà rendue — son nom, son devoir et son contenu. C'est un `403` portant le
code **`deadline_passed`**. Il n'y a donc pas de rendu en retard : il y a une échéance que
**l'enseignant repousse**, et ce geste rouvre tout d'un coup. C'est la seule date à l'écran et
le seul levier, et c'est ce que l'agent doit dire à l'étudiant — « demandez à l'enseignant de la
repousser » est la suite utile, pas une politesse.

Ce qui reste permis est tout le reste, et la **mesure en fait partie** : les fenêtres continuent
d'être acceptées après l'échéance, et l'agent n'a donc rien à suspendre.

L'échéance étant une date, un agent la lit lui-même plutôt que de demander un état :

- `GET /api/assignments` porte le **`deadline`** de chaque devoir. Un devoir échu reste donc
  listé et **dit qu'il l'est** (`assignment.overdue`), mais ne peut plus être choisi : le faire
  disparaître de la liste se lirait comme un devoir manquant, pas comme une porte fermée. Là où
  le composant le permet — une `<option>` HTML — la ligne est grisée ; ailleurs — la liste UNO
  de LibreOffice, la *quick pick* de VS Code — l'agent refuse à la sortie, avec la même phrase.
- `GET /api/documents/:id` porte **`assignment_deadline`**, l'échéance du devoir auquel la copie
  répond. C'est ce qui permet de **cesser de proposer** le rendu, le changement de devoir et le
  dépôt du contenu sur une copie gelée, au lieu d'offrir un bouton dont le refus n'apprend rien.
  La ligne `doc.deadlinePassed` dit pourquoi, dit que la mesure continue, et dit que tout rouvre
  si l'échéance est repoussée.

L'échéance peut passer pendant qu'une fenêtre est ouverte, et un devoir peut rouvrir entre deux
ouvertures : rien n'est mis en cache, tout se recalcule à l'affichage. Le refus du moteur reste
le dernier mot, reformulé par l'agent (voir *Un refus est un texte d'interface* dans
[langues.md](langues.md)) et jamais recopié.

Reste un refus que l'étudiant ne provoque pas : les agents propagent au moteur le **titre** d'un
document renommé dans l'éditeur, et ce renommage-là est refusé aussi. Il est donc tenu pour
synchronisé malgré le refus — sans quoi il repartirait à chaque minute et ferait virer l'état
d'envoi au rouge, pour quelque chose sur quoi personne n'a la main. Conséquence assumée : un
renommage fait pendant que la porte était fermée ne repart pas tout seul quand elle rouvre ;
un renommage fait après, si.

## Ce que l'agent dit de lui-même

Le moteur ne voit un agent qu'à travers les fenêtres qu'il pousse. Tout ce qui arrive sur le poste
sans rien pousser lui échappe : une installation, une mise à jour, une exception dans le code de
l'agent, un envoi qui n'a jamais atteint le moteur. Pour que l'équipe qui maintient les agents
voie une régression avant qu'un étudiant la signale, **chaque agent compte ces évènements et
envoie les compteurs**.

### Ce qui part : des compteurs, et l'endroit des erreurs

```
POST /api/plugins/telemetry
Authorization: Bearer <jeton>
X-Certimens-Agent: <type>/<version>
Content-Type: application/json

{"events":{"started":3,"error.runtime":1},
 "faults":[{"type":"TypeError","frames":["flushTelemetry@background.js:323:15","background.js:387:5"],"count":1}]}
```

`events` est **un objet de compteurs et rien d'autre** : pas de message d'erreur, pas d'URL, pas
de nom de document. Un texte d'exception, dans un outil de rédaction, peut citer ce que
l'étudiant écrit — et aucun texte de l'étudiant ne quitte le poste. Ce qui est compté est un
**mot du vocabulaire ci-dessous**, jamais une chaîne formée à l'exécution.

`faults`, facultatif, dit **où** le code de l'agent a échoué, pour qu'une version qui se met à
casser montre l'endroit et pas seulement le nombre. Une erreur y est :

- son **type** — le nom de l'exception (`TypeError`, `KeyError`…), ou `Other` s'il n'a pas la
  forme d'un nom ;
- ses **frames**, de la plus interne à la plus externe, au plus `TELEMETRY_MAX_FRAMES` (12) :
  **seulement celles des fichiers de l'agent**, chacune `fonction@fichier.js:ligne:colonne`
  (`fonction@fichier.py:ligne` pour LibreOffice), le nom de fonction omis quand il n'en a pas la
  forme. **Un nom de fichier nu** : jamais le répertoire, qui sur le poste nomme le compte de
  l'étudiant, ni l'adresse de l'extension, qui sur certains navigateurs est tirée pour cette
  installation. Une frame d'un autre code — la page, l'hôte, une bibliothèque — est sautée ;
- son **nombre** d'occurrences depuis le dernier envoi.

**Jamais le message.** Les agents ne sont pas minifiés : un fichier, une ligne et un nom de
fonction sont une position dans le **code publié** de la version déclarée, et rien d'autre. Le
moteur refuse toute frame d'une autre forme.

| Évènement | Quand l'agent l'ajoute |
| --- | --- |
| `installed` | au premier démarrage après une installation : aucune version n'est encore enregistrée dans le stockage de l'agent. Une installation **antérieure à la télémétrie** — elle a déjà une version vue (celle de la ligne « Certimens a été mis à jour »), une configuration ou un jeton — compte `updated`, pas `installed` |
| `updated` | au premier démarrage d'une version différente de celle enregistrée |
| `started` | à chaque démarrage de l'agent : activation de l'extension, ouverture du volet, chargement dans LibreOffice |
| `error.runtime` | une exception que le code de l'agent n'a pas rattrapée — **la sienne seulement**, jamais celle de la page ou de l'hôte |
| `error.engine` | une réponse du moteur en 5xx |
| `error.rejected` | un refus du moteur en 4xx, sauf 401 |
| `error.auth` | un 401 : le jeton n'est plus accepté |
| `network.failure` | un appel resté sans réponse : hors ligne, DNS, TLS, délai dépassé |
| `queue.dropped` | une fenêtre que la file hors ligne a dû abandonner, pleine |

Une **mise à jour échouée** n'est pas dans la liste, et ce n'est pas un oubli : la boutique qui
échoue laisse tourner l'ancienne version, qui ne sait rien de l'échec. Le moteur la lit de son
côté, comme des étudiants restés sur une ancienne version.

Les appels comptés en `error.*` et `network.failure` sont **ceux du travail de l'agent** —
appairage, documents, mesures, devoirs — et seulement **les réponses que l'agent ne traite pas
comme ordinaires** : l'attente de l'appairage (`device_authorization_pending`,
`device_slow_down`, un 429 sur le sondage) et le 403/404 d'un document qu'on tente de reprendre
ne sont pas des refus, ils arrivent toutes les cinq secondes ou à chaque ouverture. Une erreur que
l'agent fabrique lui-même sans appeler le moteur (pas de jeton, adresse refusée) n'est comptée
nulle part. L'envoi des compteurs lui-même ne se compte pas : un
moteur injoignable ferait sinon grossir le compteur qui dit qu'il est injoignable.

### Quand et comment

- **Les compteurs vivent dans le stockage de l'agent**, à côté de la file hors ligne, et
  survivent à un redémarrage. Chacun plafonne à `TELEMETRY_MAX_COUNT` (10 000) : au-delà, le
  moteur l'écrêterait de toute façon.
- **Les erreurs aussi**, à côté des compteurs (`telemetryFaults`, ou `telemetry.faults` dans
  le fichier d'état de LibreOffice) : une entrée par erreur distincte (même type,
  mêmes frames) avec son nombre, au plus `TELEMETRY_MAX_FAULTS` (10). Au-delà, l'erreur compte
  toujours `error.runtime` mais n'est plus localisée : les dix premières d'une version cassée
  disent où elle casse. Elles partent avec les compteurs et sont oubliées avec eux, selon les
  mêmes codes de retour.
- **Ils partent au plus toutes les `TELEMETRY_FLUSH_MS` (15 minutes)**, sur la boucle qui
  vide déjà la file chaque minute, et seulement s'il y a quelque chose à envoyer.
- **L'extension navigateur lit `installed` et `updated` dans `runtime.onInstalled`** (raison
  `install`, ou `update` avec une autre `previousVersion`) plutôt que dans une version
  enregistrée : le navigateur le sait mieux qu'elle, et une installation antérieure aux compteurs
  y arrive d'elle-même en `update`.
- **Firefox demande l'accord de l'étudiant.** Sa plateforme range ces compteurs dans la catégorie
  de données `technicalAndInteraction`, qu'une extension ne peut déclarer qu'en **facultatif** :
  le manifeste la déclare ainsi, et l'extension n'envoie rien tant que l'accord n'est pas donné
  (les compteurs s'accumulent sur le poste). Les autres agents n'ont pas cette étape.
- **Seulement appairé.** L'envoi demande le jeton : un agent pas encore connecté garde ses
  compteurs (`installed` arrive presque toujours avant l'appairage) et les envoie après.
- **Remis à zéro sur un 204**, et seulement sur un 204 — sauf ce qui a été compté pendant
  l'envoi, qui reste pour le suivant. Un échec réseau ou un 5xx les garde pour la fois
  suivante ; un 400 ou un 413 les abandonne (le corps est faux, le renvoyer ne le corrigera pas) ;
  un 401 aussi, puisque le jeton est perdu.
- **Le moteur ignore un nom qu'il ne connaît pas** et compte le reste : un agent plus récent que
  le moteur ne perd pas tout son rapport pour un mot.

### Ce que le moteur en fait

Il additionne, **par agent, version et évènement**, sans garder ni le compte ni l'établissement
qui a envoyé : le jeton prouve qu'un agent appairé parle, il n'est pas conservé avec les
compteurs. Chaque erreur devient une ligne de son journal, elle aussi sans compte, avec une
**empreinte** calculée sur l'agent, le type et la suite des `fonction@fichier` sans les lignes :
une même empreinte d'une version à l'autre est le même bug, même quand le code au-dessus a bougé. Ce qui en est affiché se documente de son côté. Un compteur est une **déclaration**,
comme le reste de ce que l'agent présente : il ne décide de rien et ne rapporte rien à
personne.

## Signaler un problème

Chaque agent porte un lien **« Signaler un problème »**. Il n'envoie rien lui-même : il ouvre,
dans le navigateur, **le formulaire d'aide de l'espace Certimens** — celui du pied de page de
toutes ses pages, `POST /api/contact` en `kind: problem` — déjà prérempli. C'est le même
formulaire, la même route, la même boîte support et les mêmes quotas : rien à maintenir en
quatre exemplaires. La route exige une **preuve de travail** que le formulaire résout dans le
navigateur ; un agent qui posterait lui-même devrait la résoudre en JavaScript, en Python et dans
un volet Office. Et un lien marche **sans être connecté** — or l'appairage qui échoue est
précisément le moment où l'on a besoin d'écrire.

### Le lien

```
<adresse du moteur>/#report?kind=problem&details=<bloc encodé>
```

- l'adresse est celle de la configuration, ou l'adresse par défaut si celle-là est refusée
  (`engineUrlAllowed`) : un lien ne s'ouvre pas en clair vers un hôte public ;
- tout est dans le **fragment** (`#…`), qu'un navigateur n'envoie jamais au serveur : le bloc ne
  passe ni dans les journaux du moteur ni dans ceux d'un proxy ;
- `kind` vaut `problem` ; `details` est le bloc ci-dessous, encodé (`encodeURIComponent`,
  `urllib.parse.quote`), **1 500 caractères au plus** avant encodage — le message entier est borné
  à 5 000 par le moteur, et le reste est à l'étudiant.

L'interface ouvre alors le formulaire en mode « problème », le message vide pour l'étudiant, et
montre le bloc **en clair, à part, avec une case pour le retirer** ; il est ajouté sous le message
à l'envoi, et seulement si la case est cochée. Le fragment est effacé dès qu'il est lu : recharger
la page ne rouvre pas le formulaire.

### Le bloc

Des lignes `clé: valeur`, dans cet ordre, aux clés **fixes et en anglais** — le support les lit
quel que soit l'agent, et `make check` compare les quatre listes (`REPORT_KEYS`) :

| Clé | Ce qu'elle porte | Exemple |
| --- | --- | --- |
| `agent` | type et version déclarés (`X-Certimens-Agent`) | `vscode/1.4.2` |
| `host` | l'hôte et sa version | `VS Code 1.97.0`, `Chrome 141`, `LibreOffice 7.4.7.2`, `Word Win32 16.0` |
| `os` | le système, tel que l'hôte le nomme | `linux x64`, `Windows` |
| `language` | la langue de l'interface | `fr` |
| `engine` | l'origine du moteur **tel qu'il est configuré**, même refusé — c'est ce que l'étudiant a saisi ; seul le lien retombe sur l'adresse par défaut. `unknown` hors `http(s)` | `https://monespace.certimens.fr` |
| `signed_in` | appairé ou non | `yes` / `no` |
| `paused` | mesure suspendue | `yes` / `no` |
| `status` | l'état d'envoi, et s'il a joint le moteur | `offline (reached)`, `synced` |
| `queued` | fenêtres en attente | `12` |
| `counters` | les compteurs de télémétrie pas encore envoyés, mots du vocabulaire fermé | `error.runtime=2 network.failure=5` |
| `at` | l'instant, horloge du poste | `2026-11-25T14:32:07Z` |

Une valeur inconnue s'écrit `unknown` ; une ligne n'est jamais omise, pour que deux rapports se
lisent ligne à ligne. Une valeur ne s'étend jamais sur deux lignes (retours et caractères de
contrôle deviennent des espaces) : sans quoi une valeur pourrait fabriquer une ligne.

| Agent | Où le lien est | Ce qui l'ouvre |
| --- | --- | --- |
| Extension navigateur | popup et page d'options | le *service worker* (`CERTIMENS_REPORT`, accepté de ses seules pages), `chrome.tabs.create` |
| Complément Word | pied du volet | `Office.context.ui.openBrowserWindow` là où il existe (pas sur le web), sinon `window.open` |
| Extension LibreOffice | pied des deux fenêtres, sous la ligne des erreurs | `SystemShellExecute`, `URIS_ONLY` ; dans la fenêtre de connexion, vers l'adresse saisie |
| Extension VS Code | commande de la palette, pied du panneau, et un bouton sur chaque notification d'erreur | `env.openExternal`, **avec une chaîne** : un `vscode.Uri` réécrit le fragment encodé |

Le constructeur est partagé par l'extension et le complément Word (`report.js`, par lien
symbolique), écrit à part dans VS Code et LibreOffice, et `make check` compare les quatre au
tableau ci-dessus.

**Ce qui n'y est jamais** : le jeton ni le `device_code`, l'e-mail (le formulaire a son champ, et
l'interface le remplit d'elle-même pour qui est connecté), le nom, l'identifiant ou l'adresse
d'un document ou d'un site, et le moindre caractère écrit par l'étudiant. Le bloc est fait
**des mêmes choses que la télémétrie** — des états, des nombres et des mots d'un vocabulaire
fermé — et l'étudiant le voit en entier avant de l'envoyer.



Les agents sont livrés en clair : tout ce qu'on leur demande d'envoyer, un attaquant peut le
recopier. Ce qu'ils présentent au moteur ne sert donc pas à prouver leur identité, mais à rendre
une contrefaçon **visible** : le moteur en tire une famille de client, et signale sur le document
un envoi qui ne ressemble à aucun agent connu.

| Agent | Ce que le moteur reconnaît |
| --- | --- |
| Extension navigateur | la signature de transport d'un navigateur |
| Complément Word | celle de la webview du volet Office |
| Extension LibreOffice | `urllib` de la bibliothèque standard Python |
| Extension VS Code | son `User-Agent` : `Certimens-VSCode/X.Y.Z (VS Code … ; Node …)` |

### L'agent se nomme, et dit sa version

Une signature de transport est **solide et grossière** : elle dit « une extension de navigateur »,
jamais laquelle ni quelle version. Chaque appel porte donc en plus un en-tête que l'agent pose
lui-même :

```
X-Certimens-Agent: <type>/<version>
```

| Agent | Type déclaré |
| --- | --- |
| Extension navigateur | `browser` |
| Complément Word | `word` |
| Extension LibreOffice | `libreoffice` |
| Extension VS Code | `vscode` |

La version est le libellé de build de l'agent (`1.4.2`, ou `1.4.2-9f8e7d6` entre deux tags),
limité à **32 caractères** pris parmi lettres, chiffres, `.`, `-`, `_` et `+`. Elle est
**facultative** : un agent construit depuis un dépôt ne connaît pas toujours son build et envoie
alors son type seul, ce que le moteur accepte — refuser toute la déclaration pour la part que
l'agent ignore jetterait la part qui est vraie. Chaque agent nettoie sa propre valeur avant de
l'envoyer plutôt que de s'y fier : une version hors de ce jeu de caractères rend la déclaration
entière illisible.

Le type, lui, n'est pas facultatif et appartient au vocabulaire du moteur : un mot hors liste
n'est pas un agent plus récent. Les quatre agents déclarent l'en-tête et leur type à côté de leur
client, et **`make check` les compare** — un agent qui épellerait l'en-tête autrement serait
compté comme ne déclarant rien, sur chaque fenêtre de chaque étudiant qui l'utilise, et rien ne
le dirait nulle part.

**Ce que ça ne prouve pas.** Les agents sont publics : cet en-tête se recopie. Il ne sert donc pas
à prouver une identité, il sert à **rendre visible** une contrefaçon, exactement comme le reste de
cette section — le moteur recoupe la déclaration avec la signature de transport, et une requête
qui annonce l'agent LibreOffice depuis ce qui est manifestement un navigateur se contredit
elle-même. Une requête qui ne déclare rien est signalée aussi, puisque tout agent réel parle. Ce
que le moteur en fait est son affaire ; ce que les agents doivent est de toujours se nommer.

C'est la raison pour laquelle **ne pas envoyer cet en-tête n'est pas une option** : ce ne serait
pas « un signal de moins », ce serait un signal levé sur chaque fenêtre honnête, donc un signal
qui ne dit plus rien.

Une conséquence qui ne se voit pas depuis le code : l'en-tête est personnalisé, donc une requête
*cross-origin* **préflighte** dessus. Seul le complément Word est dans ce cas, et le moteur doit
l'autoriser dans sa liste CORS — c'est un changement à demander là-bas **avant** de publier une
version du complément qui l'envoie.

Côté lecteur, ce que le moteur en fait, et qui ne se devine pas d'ici : il range la déclaration à
côté de chaque fenêtre et montre au correcteur avec quels outils la copie a été écrite. Deux
agents sur une même copie est ordinaire — commencer dans Word et finir dans un navigateur — et
c'est présenté comme tel, pas comme une anomalie.

L'extension VS Code est une exception assumée : elle tourne sur le `fetch` de Node, qui
n'ajoute de lui-même aucun en-tête qui le trahisse — d'où le `User-Agent` explicite. La famille
`vscode` doit être connue de l'ingestion du moteur, sinon chaque envoi est marqué
`client_unknown` sur le document.

Tous les agents posent exactement `application/json`, corps non indenté, clés dans l'ordre de
leur sérialiseur : c'est ce que le moteur attend.

## CORS

Trois agents sur quatre n'ont pas de CORS : LibreOffice appelle depuis Python, VS Code depuis
Node, l'extension navigateur depuis son service worker.

Seul le **complément Word** est une page web, servie par GitHub Pages : le moteur autorise cette
origine sur `/api`, avec `https://localhost:3000` pour le développement. La liste des origines
autorisées est tenue côté moteur — changer l'hébergement du complément, c'est donc **aussi** un
changement là-bas, à demander avant de publier.

## Langue

La règle de choix de la langue est celle du moteur, réimplémentée dans chaque agent — un agent
doit choisir sa langue avant d'avoir jamais joint le moteur. Voir [langues.md](langues.md).
