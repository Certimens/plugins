# Le contrat avec le moteur

Tout ce qu'un agent attend du moteur Certimens, et rien de plus : les appels qu'il fait, ce
qu'il présente, ce qu'il fait d'un refus. Le moteur lui-même — son code, son modèle de données,
le calcul du score, son déploiement — est développé à part et n'est pas public : rien n'en est
repris ni cité ici.

## Adresse et authentification

L'**adresse du moteur** vaut `https://monespace.certimens.fr` et l'étudiant n'a pas à la saisir :
elle est repliée dans les **paramètres avancés** du formulaire de connexion, qui ne s'ouvrent
d'eux-mêmes que si l'adresse enregistrée n'est pas celle-là — un établissement qui héberge son
propre moteur, ou un développeur sur `http://localhost:8080`. Un champ vidé vaut l'adresse par
défaut : il n'y a pas de connexion refusée faute d'un champ que le formulaire n'affichait pas.
La connexion se fait en trois temps :
`POST /api/auth/login` vérifie les identifiants et ouvre une session, `POST /api/auth/tokens`
crée avec elle un **jeton d'API** sans expiration — libellé d'après l'agent et la date, pour se
reconnaître dans la liste —, puis `POST /api/auth/logout` referme la session, devenue inutile.

C'est ce jeton qui est conservé, à la place du mot de passe, qui n'est jamais stocké. Il est
sans expiration parce qu'un agent travaille sans surveillance, et **révocable** : depuis l'espace
Certimens, ou par l'agent lui-même, qui supprime le sien (`DELETE /api/auth/tokens/:id`) quand
l'étudiant se déconnecte. Un mot de passe recopié dans quatre agents, lui, ne se révoque pas.

| Agent | Où le jeton est gardé |
| --- | --- |
| Extension navigateur | `chrome.storage.local` |
| Complément Word | `localStorage` du volet (partagé entre documents) |
| Extension LibreOffice | `certimens.json` du profil, lisible par l'utilisateur seul |
| Extension VS Code | le **SecretStorage** de l'éditeur, jamais `settings.json` |

## Endpoints utilisés

| Appel | Usage |
| --- | --- |
| `POST /api/auth/login` | vérifier les identifiants et ouvrir une session |
| `POST /api/auth/tokens` | créer le jeton d'API conservé par l'agent |
| `POST /api/auth/logout` | refermer la session de connexion |
| `DELETE /api/auth/tokens/:id` | révoquer son propre jeton, à la déconnexion |
| `GET /api/auth/me` | rôle, langue et nom affiché du compte (le choix d'un devoir n'est proposé qu'au rôle `student`) |
| `POST /api/documents` | créer le document Certimens qui recevra les mesures |
| `GET /api/documents/:id` | relire son état (nom, devoir, score) pour l'afficher |
| `POST /api/documents/:id/metrics` | pousser un lot de fenêtres de mesure |
| `PUT /api/documents/:id` | renommer le document, le rattacher à un devoir, y déposer son contenu |
| `GET /api/assignments` | les devoirs auxquels l'étudiant est rattaché |

Le corps et les codes de retour de chaque appel sont documentés côté moteur ; ce que les agents
en utilisent tient dans les pages de ce dossier.

La connexion et `GET /api/auth/me` renvoient un **`display_name`** que le moteur calcule, et qui
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

### L'ordre des clés d'une mesure n'est pas libre

Le moteur reconnaît le sérialiseur d'un agent à **l'ordre** des clés qu'il écrit, et il n'en
connaît que deux :

```json
{"type":"…","value":0,"period":{"start":"…","end":"…"}}
{"type":"…","value":0,"period":{"start":"…","end":"…"},"offline":true}
```

`offline` s'ajoute **en dernier**, et **seulement quand il est vrai**. Une clé insérée ailleurs,
un corps indenté, ou `offline` envoyé systématiquement : chacun de ces trois écarts fait lever
un signal silencieux sur **tous** nos envois, que l'évaluateur voit et que rien ne renvoie à
l'agent. `libreoffice/tests/test_engine.py` tient cet ordre pour les quatre, sur un vrai corps
HTTP — c'est le seul agent qui a un moteur factice sous la main.

**Ajouter un champ à une mesure, c'est donc deux chantiers** : le moteur doit d'abord déclarer
la nouvelle forme, les agents l'envoient ensuite.

## Metrics refusées

`paste_events`, `focus_losses` et `median_flight_ms` sont plus récentes que certains moteurs
déployés. Face à un **`400` portant le code `metric_type_unknown`** — et seulement celui-là —
l'agent retire ces trois metrics et renvoie le reste, puis réessaie à la prochaine connexion.

Tout autre `400` (période invalide, corps mal formé) ne doit **pas** désactiver les metrics
étendues : c'était le bug qui empêchait `focus_losses` de repartir.

La liste des types acceptés est tenue par le moteur, lui seul. **Ajouter une metric, c'est donc
deux chantiers : le moteur d'abord, les agents ensuite**, avec la dégradation ci-dessus.

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
