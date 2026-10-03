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

Elle décide où part un **jeton d'API qui n'expire pas** : en `http:`, il traverse le réseau en
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

C'est ce **jeton d'API** qui est conservé, et c'est le même qu'auparavant : sans expiration,
parce qu'un agent travaille sans surveillance, et **révocable** — depuis l'espace Certimens, ou
par l'agent lui-même (`DELETE /api/auth/tokens/:id`) quand l'étudiant se déconnecte.

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
| `POST /api/documents/:id/metrics` | pousser un lot de fenêtres de mesure |
| `PUT /api/documents/:id` | renommer le document, le rattacher à un devoir, y déposer son contenu |
| `GET /api/assignments` | les devoirs auxquels l'étudiant est rattaché |

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

## File hors-ligne

Aucun agent ne perd une mesure parce que le réseau manque : les fenêtres partent en **file
d'attente**, renvoyée chaque minute. Le stockage diffère (`chrome.storage.local`,
`localStorage`, `certimens.json`, stockage global de l'extension VS Code), le comportement non.

Conséquence assumée, côté moteur : une fenêtre légitime peut précéder son propre document de
plusieurs heures — un travail commencé hors ligne. L'ingestion ne traite donc pas comme suspecte
une période antérieure à la création du document.

### Déclarer qu'une fenêtre a été écrite hors ligne

Une mesure peut porter **`offline: true`**. Le champ ne décrit pas la file, il décrit la
**fenêtre** : il dit que l'étudiant écrivait pendant que le moteur était hors d'atteinte.

La règle est la même dans les quatre agents, et elle est posée **à la mise en file**, pas au
départ : une fenêtre est `offline` si, au moment où elle a été close, la dernière tentative
d'envoi avait échoué. Une fenêtre écrite alors que le moteur répondait encore part sans rien
dire, même si elle attend ensuite des heures. Aucun agent ne se fie à `navigator.onLine` : un
portail captif répond à la couche liaison et jamais au moteur, et deux des quatre agents n'ont
de toute façon pas cette API.

Ce que le champ produit côté moteur est un **taux de rédaction hors ligne**, affiché ; il
n'entre pas dans le score. Déclarer `offline` ne retire aucun signal d'ingestion : un
rattrapage reste un rattrapage.

### Déclarer pourquoi la fenêtre s'est fermée

Une mesure porte **`reason`** : le mot qui dit lequel des déclencheurs de l'agent a scellé la
fenêtre. Le vocabulaire est celui du moteur, six mots, et la table qui dit lequel chaque
déclencheur produit vit dans le capteur de chaque agent
([mesures.md](mesures.md), *Pourquoi la fenêtre s'est fermée*).

Il est envoyé **à chaque mesure**, et laissé de côté — jamais envoyé vide — pour une fenêtre
mise en file par un agent qui ne savait pas encore le dire : une clé absente, c'est un agent
qui ne dit rien, une clé vide, c'est un mot que le vocabulaire du moteur ne contient pas.

Contrairement à `offline`, cette déclaration **peut rapporter quelque chose** : le moteur
retire de son calcul du rythme les silences qui suivent un départ. Il la recoupe donc avec les
compteurs de la fenêtre là où ils peuvent la corroborer — ce qu'il vérifie et ce qu'il en fait
se documentent de son côté. Ce que les agents en doivent est simple : ne jamais déclarer un
départ qu'ils n'ont pas compté.

### L'ordre des clés d'une mesure n'est pas libre

Le moteur reconnaît le sérialiseur d'un agent à **l'ordre** des clés qu'il écrit, et il n'en
connaît que quatre :

```json
{"type":"…","value":0,"period":{"start":"…","end":"…"},"reason":"idle"}
{"type":"…","value":0,"period":{"start":"…","end":"…"},"offline":true,"reason":"away"}
{"type":"…","value":0,"period":{"start":"…","end":"…"}}
{"type":"…","value":0,"period":{"start":"…","end":"…"},"offline":true}
```

`offline` s'ajoute **seulement quand il est vrai**, et `reason` **en dernier**, après lui. Les
deux dernières formes sont celles d'un agent qui ne sait pas encore dire pourquoi il a vidé sa
fenêtre, y compris une fenêtre restée en file pendant la mise à jour qui le lui a appris. Une
clé insérée ailleurs, un corps indenté, ou `offline` envoyé systématiquement : chacun de ces
écarts sort de la forme que le moteur accepte, et ce qu'il en fait est son affaire — ce
dépôt-ci n'en documente que le contrat. Chaque agent tient cet ordre dans sa propre suite, sur son propre sérialiseur :
`libreoffice/tests/test_engine.py` sur un vrai corps HTTP, `browser/tests/background.test.mjs`,
`vscode/tests/engine.test.mjs` et `word/tests/agent.test.mjs` sur le corps que leur `fetch`
reçoit. Un seul test ne pouvait rien en dire des trois autres — il n'exécute qu'un sérialiseur.

**`period` demande la même attention, et pour une raison qui ne se voit pas.** La mesure est
construite à chaque envoi, donc dans l'ordre du code ; la période, elle, vient de la **file
d'attente**, et une file se relit depuis le stockage de l'hôte — `chrome.storage.local`, le
stockage global de VS Code, le profil sur disque. Ce qui en revient n'est pas l'objet qu'on y a
rangé : c'est un objet que l'hôte reconstruit, et **rien ne promet qu'il en garde l'ordre des
clés**. Relue alphabétiquement, `{start, end}` revient `{end, start}`.

Les quatre agents **reconstruisent donc la période clé par clé** au moment de l'envoi, au lieu
de transmettre celle qui sort de la file, et leurs doubles de stockage rendent leurs clés dans
le désordre pour qu'un code qui s'y fierait échoue chez nous et pas chez l'étudiant.

**Ajouter un champ à une mesure, c'est donc deux chantiers** : le moteur doit d'abord déclarer
la nouvelle forme, les agents l'envoient ensuite.

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

## Metrics refusées

Certaines metrics sont plus récentes que des moteurs déployés, et elles le sont en **trois
générations** :

| Génération | Metrics |
| --- | --- |
| 1 | `paste_events`, `focus_losses`, `flight_median_ms` |
| 2 | `self_paste_events`, `injected_chars_max`, `injected_chars_after_return` |
| 3 | `self_paste_chars_total`, `lexical_hesitations`, `keystrokes_after_return` |

Ce tableau est tenu d'accord avec les quatre agents par `make check` : une metric ajoutée aux
capteurs sans génération y est refusée, parce que rien d'autre ne la verrait — l'agent
l'enverrait à tous les moteurs, et le premier qui ne connaît pas le type refuserait la fenêtre
entière, y compris les mesures qu'il sait parfaitement lire.

Face à un **`400` portant le code `metric_type_unknown`** — et seulement celui-là — l'agent
retire **la génération la plus récente encore envoyée** et renvoie la fenêtre ; si le refus
persiste, il retire la suivante. Un moteur qui connaît les deux premières générations mais pas
la troisième ne perd donc que la troisième.

Lâcher tout d'un coup au premier refus, comme le faisaient les agents quand il n'y avait qu'une
génération, retirerait à ce moteur-là des mesures qu'il sait lire — et personne ne le verrait,
puisqu'une mesure jamais envoyée est indiscernable, côté moteur, d'une mesure que le capteur ne
sait pas prendre. L'état retenu est donc un **nombre de générations retirées**, pas un booléen ;
une installation mise à jour depuis une version qui portait le booléen le lit comme « tout ce
qui existait alors », c'est-à-dire la première génération.

Puis l'agent réessaie au prochain appairage.

Cette seconde chance est l'**appairage** : chaque agent remet le compteur à zéro au moment où il
adopte le jeton qu'on vient de lui remettre (`adoptToken`, `adopt_token`). Sans elle le refus est
définitif — un seul envoi vers un moteur trop ancien, et
l'agent n'envoie plus jamais ces mesures, même une fois le moteur à jour et même après
un changement de compte. Le complément Word était dans ce cas ; les **quatre** suites tiennent
désormais la règle (`browser/tests/background.test.mjs`, `word/tests/agent.test.mjs`,
`vscode/tests/engine.test.mjs`, `libreoffice/tests/test_engine.py`).

Tout autre `400` (période invalide, corps mal formé) ne doit **pas** désactiver les metrics
étendues : c'était le bug qui empêchait `focus_losses` de repartir.

La liste des types acceptés est tenue par le moteur, lui seul. **Ajouter une metric, c'est donc
deux chantiers : le moteur d'abord, les agents ensuite**, avec la dégradation ci-dessus. Une
metric nouvelle s'ajoute à une **génération nouvelle**, jamais à une existante : l'ajouter à la
première ferait perdre celle-ci entière à un moteur qui ne connaîtrait que la metric manquante.

**Renommer une metric est le même chantier, dans le même ordre**, et il est plus coûteux
qu'il n'en a l'air : le nouveau nom est un type que le moteur ne connaît pas, et un agent qui
l'envoie à un moteur qui ne l'a pas encore se voit refuser toute sa génération. Le moteur doit
donc accepter les deux noms d'abord, les agents basculent ensuite, et l'ancien ne disparaît
là-bas qu'une fois les quatre agents publiés et installés. La forme que doit avoir un nom est
dans [mesures.md](mesures.md) (*Comment un nom de metric se forme*) : la suivre à l'ajout coûte
une minute, la rattraper après coup coûte ce paragraphe.

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

## Comment un agent s'annonce

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
