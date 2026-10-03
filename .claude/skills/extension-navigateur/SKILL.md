---
name: extension-navigateur
description: Extension navigateur MV3 de Certimens (browser/, un seul manifest pour Chrome, Firefox, Safari, Edge et Opera) — service worker, content scripts, permissions, empaquetage par navigateur et contraintes des boutiques. À charger avant toute modification dans browser/, y compris son build.mjs ou sa configuration de lint, et avant de toucher au manifest ou aux permissions.
---

# Extension navigateur (MV3)

`browser/` mesure la rédaction dans Google Docs, Word Online et Overleaf. `content.js` est le capteur
(voir la skill `mesures-redaction`), `background.js` le service worker qui pousse vers le moteur,
`popup.js` / `options.js` les pages, `constants.js` / `i18n.js` / `ui.js` / `ui.css` / `pages.js`
le socle partagé, chacun par un jeu de portées différent (voir plus bas).

## Un seul manifest, trois paquets

`browser/src/manifest.json` sert tous les navigateurs **et le chargement non empaqueté**.
`browser/build.mjs` n'en garde, pour chaque cible, que ce qu'elle comprend :

- **Chrome et Safari** : `background.service_worker` seul, pas de `browser_specific_settings` ;
- **Firefox** : `background.scripts` seul ;
- `chrome.zip` sert aussi Edge, Opera, Brave, Vivaldi et Arc.

Une clé ajoutée au manifest doit donc être pensée pour les trois cibles, ou retirée dans
`TARGETS` du build. Ne jamais maintenir de manifest par navigateur.

## Versions : rien à monter à la main

La version vient de git, et de **ses** tags à lui : release (tag `browser-vX.Y.Z`) → `X.Y.Z` ;
sinon dernier tag `browser-v*` + commit (`1.4.2-a9085f3`). Les trois autres agents ont leur
propre ligne de versions, et le build refuse un tag qui ne commence pas par `browser-v`.
Chrome n'accepte qu'une version numérique : le repère lisible va dans `version_name`. La
`version` de `manifest.json` n'est plus qu'un repli pour un dépôt sans tag — **ne pas
l'incrémenter dans un commit de fonctionnalité**.

## Contraintes des boutiques

- `description` ≤ **132 caractères** : au-delà le Chrome Web Store et Opera refusent le paquet,
  et le build échoue avant eux (contrôle en tête de `browser/build.mjs`).
- Firefox exige `browser_specific_settings.gecko` : `id` stable, `strict_min_version`, et
  `data_collection_permissions` à jour de ce que l'extension collecte réellement.
  `make -C browser lint-amo` (après build) traite les avertissements AMO comme des erreurs.
- **Aucun code distant** : tout est empaqueté, pas de `<script src>` externe, pas d'`eval`. Les
  polices sont livrées dans `browser/src/fonts/`.
- Permissions au plus juste : `storage`, `alarms`, `scripting` et `activeTab`, plus les hôtes
  des éditeurs et du moteur. Un moteur personnalisé (`http://localhost:8080`) **et les sites que l'étudiant
  ajoute** (son Moodle, son Canvas) passent par `optional_host_permissions`, demandés à
  l'exécution, une adresse à la fois — ne jamais élargir `host_permissions` pour s'en dispenser,
  c'est précisément ce que les boutiques regardent.

## Scripts classiques, pas de modules

`sourceType: 'script'` : il n'y a ni `import` ni bundler, les fichiers se partagent des globales
dans l'ordre où la page les charge. **Quatre portées, et le fichier partagé se choisit d'après
elles** — c'est la question à se poser avant d'écrire une ligne commune :

| Fichier | Chargé par | Ce qu'il peut faire |
| --- | --- | --- |
| `constants.js` | le worker **et** les pages | des valeurs, rien d'autre : les deux portées ne partagent presque aucune API |
| `i18n.js` | le worker, les pages, le volet Word | le dictionnaire |
| `ui.js` | les pages **et** le volet Word (lien symbolique) | du DOM, aucun `chrome.*` |
| `pages.js` | la popup et les options seules | tout, `chrome.*` compris |

Une fonction partagée nouvelle est **déclarée dans le bon fichier et ajoutée aux globals de
`browser/eslint.config.mjs`** — et, si le volet Word s'en sert, à ceux de
`word/eslint.config.mjs` — sinon le lint casse. Mettre dans `ui.js` quelque chose qui atteint
`chrome.*` livre du code mort dans le volet Word : c'est d'où viennent `startLanguage` et
`requestEngineAccess`, et pourquoi `pages.js` existe. Écrire une valeur dans le worker *et* dans
une page la fait diverger en silence : c'est d'où vient `constants.js`.

Le contrôle de types a **deux configurations** ici : `jsconfig.json` tient les pages (popup,
options, content script), `jsconfig.worker.json` le service worker — avec `constants.js` dans les
deux, puisqu'il est dans les deux portées. Les lire comme un seul programme signalerait des
collisions qui ne peuvent pas arriver, les deux scopes n'étant jamais chargés ensemble. Un
fichier nouveau dans `src/` entre de lui-même dans la configuration des pages ; s'il est pour le
worker, l'ajouter à ses `files`. `types/storage.d.ts` décrit ce que l'extension garde dans
`chrome.storage.local` — c'est la seule description qui en existe, et une clé nouvelle s'y
ajoute.

## Service worker

`background.js` peut être arrêté à tout moment : aucun état en mémoire ne survit.

- L'état vit dans `chrome.storage.local` (`config`, `engineIds`, `titles`, `syncedTitles`, `queue`,
  `status`, `pairing`) ; la file hors-ligne est plafonnée à `MAX_QUEUE` et rejouée par une
  **alarme** (`chrome.alarms`), jamais par `setInterval`.
- Tout accès à la file passe par `withLock` : un envoi et une nouvelle mesure ne doivent ni se
  marcher dessus ni créer deux fichiers pour le même document.
- L'authentification est un **token d'API (Bearer)** obtenu par **appairage** : aucun mot de
  passe n'est demandé nulle part. L'appairage attend **ici**, pas dans la popup — celle-ci se
  ferme dès que l'étudiant change d'onglet pour confirmer le code — donc son état vit dans
  `chrome.storage.local` et c'est l'alarme d'une minute qui le termine. `adoptToken` est le seul
  chemin qui écrit une configuration, et il écrit toujours un token.
- Pas de DOM dans le service worker (ni `document`, ni `localStorage`).

`content.js` tourne dans Google Docs, dans l'iframe d'édition de Word Online
(`all_frames: true`) et dans Overleaf : les trois éditeurs sont décrits par l'objet `EDITORS`,
qui isole tout ce qui est spécifique à l'un (id du document, zone d'édition, iframes de saisie,
sens du blur, lecture du volume). Ajouter un éditeur, c'est ajouter une entrée là, pas des `if`
ailleurs — y compris dans le service worker, où le dépôt du document distingue les éditeurs au
**préfixe de l'id** (Google Docs est le seul sans préfixe, parce qu'il est le seul exportable).

Un **quatrième** éditeur, `site`, sert les adresses que l'étudiant déclare lui-même : la
popup propose *Mesurer cette page* là où aucun éditeur n'est reconnu (l'adresse vient
d'`activeTab`, que l'ouverture de la popup débloque), la page d'options porte la liste et son
retrait. Dans les deux cas la permission est demandée **dans une page** — elle exige un geste,
qu'un service worker n'a pas — puis `syncSiteScripts()` enregistre le script pour cette origine
seule. Ne jamais remplacer ça par un `https://*/*` demandé une fois : un capteur sur toutes les
pages ouvrirait une fenêtre de mesure dans une webmail et créerait un document par page.

**Comment une copie se rend est aussi l'affaire de l'éditeur**, pas de la popup : `deposit` vaut
`export` (Google Docs), `pick` (Word Online, Overleaf) ou `text` (site ajouté — sur un devoir
« texte en ligne » d'un Moodle, il n'y a pas de fichier, la copie est dans la page). Le repli
d'un éditeur qui ne dit rien est `pick`, **jamais** `text` : ce serait faire sortir du contenu
d'un éditeur qui n'a rien demandé. L'envoi reste explicite — le texte est demandé à la page au
moment du clic, et ne passe par aucune fenêtre de mesure.

Les plateformes reconnues (Moodle, Canvas) ne font qu'**affiner** un site ajouté : le nom du
document et le champ à lire. Une empreinte se périme ; rien n'y est conditionné.

Un éditeur peut ne pas savoir tout mesurer : Overleaf n'a pas de `real_volume_chars` (CodeMirror ne
rend que les lignes visibles). Son entrée rend alors `null`, et rien n'est envoyé — jamais un
zéro, que le moteur ne distinguerait pas d'un document vide.

## Accessibilité

Popup, page d'options et volet Word sont vendus à l'enseignement supérieur public :
libellés associés aux champs, focus visible, contrastes de `ui.css`, messages d'erreur lus par
les lecteurs d'écran. Les couleurs de verdict portent du sens : ne jamais les laisser seules
porter l'information. Elles sont **bleu, ambre et grenat** et non vert/orange/rouge, pour rester
distinctes sans voir toutes les couleurs — `tests/theme.test.mjs` mesure l'écart qui reste sous
chaque déficience, et c'est ce test qui interdit d'y revenir
([developpement.md](../../../docs/developpement.md)).

## Vérifier

```bash
make -C browser lint       # ESLint, types (tsc), Stylelint (ui.css), html-validate
make -C browser test-host  # un vrai Chromium, en conteneur : manifest, worker, pages, capteur
make -C browser build      # dist/{chrome,firefox,safari}.zip
make build                 # tous les paquets, les quatre agents
make -C browser lint-amo   # validation AMO du paquet Firefox (après build)
```

## Mesure suspendue

La clé `paused` de `chrome.storage.local` est lue par `content.js` **dans chaque page** (elle
n'est pas poussée : une page ouverte pendant la pause doit démarrer suspendue) et par
`background.js` pour le badge `II`. La règle commune est dans `mesures-redaction` ; ici, le piège
est d'ajouter un gestionnaire d'événement sans sa garde — `recordInjection` en porte une, parce
que c'est là que le comptage a lieu.

## Langues

`browser/src/i18n.js` porte les textes de l'interface (partagé avec le complément Word, copié par
le build), `_locales/{fr,en}/messages.json` ceux que le navigateur et la boutique lisent avant
notre code — d'où `__MSG_extensionName__` et `default_locale` dans le manifest. Le service worker
charge le dictionnaire par `importScripts` ; Firefox le charge par `background.scripts`, où
`importScripts` n'existe pas. Règle complète : skill `langues-interface`.

## Ce que les tests ne voient pas

`make test` remplace `chrome.*` par des objets à nous : c'est ce qui permet de charger le
fichier livré tel quel, et c'est le plafond. Un manifest que Chromium refuse, un service worker
qui jette au démarrage, une page dont une balise `<script>` manque, un content script jamais
injecté : tout cela passe les linters, passe les tests, et donne une extension qui s'installe et
ne fait rien.

`make -C browser test-host` lance l'extension dépaquetée dans un **vrai Chromium**, en conteneur
jetable (`tests/host/Dockerfile`) : manifest accepté, worker démarré, popup et options affichées
sans erreur de console, capteur injecté dans une page que le manifest nomme, frappes réelles
jusqu'à la file. La page mesurée est **la nôtre**, servie à l'adresse d'Overleaf par
l'interception de Playwright : ce qui est éprouvé, c'est la règle du manifest, pas le DOM
d'Overleaf.

Le DOM des trois éditeurs, lui, reste à vérifier à la main — c'est la première cause de panne
réelle, et `browser/TESTING.md` en tient la liste avec le reste.
