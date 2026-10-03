# Développement

Le dépôt contient **quatre projets** — un par agent. Chacun déclare son outillage et porte son
`Makefile` : `make install` les installe tous d'un coup, puis tout passe par `make`. La racine,
elle, n'a ni outillage ni dépendance : pas de `package.json`, rien à y installer — son seul
script, `scripts/check-coherence.py`, compare les quatre entre eux et n'a besoin que de python3.

```bash
make install  # installe l'outillage de chaque projet (à faire une fois)
make          # lint, tests, puis cohérence des quatre
make lint     # les linters de chaque agent
make test     # les tests de chaque agent
make check    # ce qui lie les quatre : constantes, metrics, noms, moteur, schémas d'URL, fichiers partagés
make build    # chaque agent construit son paquet dans <agent>/dist/
make clean    # efface les dist/ et l'outillage installé par chaque agent
```

Agent par agent — les mêmes cibles, plus ce que son hôte demande en propre :

```bash
make -C browser lint            # ESLint, Stylelint (ui.css), html-validate
make -C browser test            # les règles de comptage du capteur
make -C browser build           # dist/{chrome,firefox,safari}.zip
make -C browser lint-amo        # validation addons.mozilla.org (après build)
make -C browser safari          # macOS : projet Xcode dans dist/safari-xcode/, sans signature
make -C browser publish-chrome  # une boutique à la fois (voir publication.md)
make -C word lint-manifest      # validation Microsoft du manifest (après build, réseau requis)
make -C word serve              # complément Word sur https://localhost:3000 (après build)
make -C libreoffice test        # tests Python, sans LibreOffice
make -C libreoffice coverage    # ce que ces tests couvrent (rapport, pas une barrière)
make -C vscode dev              # construit le paquet et ouvre une fenêtre VS Code dessus
make -C vscode publish          # Visual Studio Marketplace (après build)
```

## make et npm

Dans les trois agents JavaScript, **les commandes sont déclarées dans `package.json`**, et le
`Makefile` ne fait que les appeler. Un développeur JavaScript peut donc ignorer make
complètement :

```bash
cd word
npm run          # liste tout ce que l'agent sait faire
npm run lint     # eslint . && html-validate *.html
npm test
npm run build -- --release v1.5.0
```

`make` existe pour la raison inverse : donner aux **quatre** agents les mêmes cibles, y compris
à celui qui est en Python et n'a pas de npm. `make -C word lint` appelle `npm run lint`, et
`make -C libreoffice lint` appelle ruff directement — c'est la seule différence. Chaque
`Makefile` décrit en tête ce qu'il sait faire : `head -20 word/Makefile` tient lieu d'aide.

Il n'y a pas de projet npm à la racine : `make` y est la seule commande, et elle ne fait que
parcourir les agents.

Pas de bundler, pas de framework : des scripts classiques côté JavaScript, la bibliothèque
standard seule côté Python. Le build d'un agent assemble son paquet ; il ne transforme pas le
code, il le range.

## Un dossier par agent

Un agent est un **projet autonome** : son code, son `Makefile`, ses linters et leur
configuration, ses tests, son build, et son `dist/`. Rien n'y renvoie à la racine, et la
racine ne garde que ce qui n'appartient à personne. Un dossier pourrait partir dans son propre
dépôt sans qu'on ait à démêler quoi que ce soit.

Chaque agent a la même forme :

```text
<agent>/
  src/        ce qui est livré, et rien d'autre
  tests/      ce qui le vérifie
  store/      les fiches de ses boutiques, une par dossier
  dist/       ce que le build produit (ignoré par git)
  Makefile    les mêmes cibles que les trois autres
  …           son outillage : package.json, configuration des linters, build
```

**`src/` est la règle, pas une liste d'exceptions.** Un paquet, c'est ce dossier — plus
`LICENSE` et `NOTICE`, que la licence demande de faire voyager. Avant, chaque build portait une
liste de fichiers à ne pas emporter, qu'il fallait tenir à jour : le `.oxt` y avait déjà gagné
un `.coverage` et un `.coveragerc`. Un outil nouveau posé à la racine d'un agent ne peut plus
atterrir dans une boutique.

| | `browser/` | `word/` | `libreoffice/` | `vscode/` |
| --- | --- | --- | --- | --- |
| Commandes déclarées dans | `package.json` | `package.json` | son `Makefile` | `package.json` |
| `Makefile` (mêmes cibles pour tous) | ✓ | ✓ | ✓ | ✓ |
| Build `src/` → `dist/` | `build.mjs` | `build.mjs` | **`build.py`** | `build.mjs` + `.vscodeignore` |
| `tests/` | ✓ | ✓ | ✓ (Python) | ✓ |
| Outillage déclaré dans | `package.json` | `package.json` | `requirements-dev.txt` | `package.json` |
| Verrou | `package-lock.json` | `package-lock.json` | version épinglée | `package-lock.json` |
| ESLint | `eslint.config.mjs` | `eslint.config.mjs` | — | `eslint.config.mjs` |
| Autres linters | Stylelint, html-validate | html-validate | ruff (`ruff.toml`) | — |
| Outils de boutique | `web-ext`, `publish-browser-extension` | `office-addin-*` | — | `@vscode/vsce` |
| Ignore ce qu'il produit | `.gitignore` | `.gitignore` | `.gitignore` | `.gitignore` |

Chaque agent **déclare ce qu'il utilise** : ESLint, html-validate et les autres sont dans son
`package.json`, avec son propre `package-lock.json` et son propre `npm ci`. C'est quatre
installations au lieu d'une, et une montée de version d'ESLint se fait en quatre endroits —
c'est le prix de l'autonomie, et il est assumé. `make install` fait la tournée.

**Les versions sont exactes, jamais des intervalles** — `eslint: "10.13.0"`, `ruff==0.17.3` — et
le verrou n'en est que la conséquence : ce qui est déclaré est ce qui a été vérifié, pas ce qui
sera installé. Les relever est donc une commande délibérée, `make update`, qui fait la tournée
des quatre : `npm-check-updates` appelé par `npx` chez les trois agents JavaScript (sans entrer
dans leurs dépendances), `pip` et deux lignes de shell chez celui en Python. Une exception, et
elle est tenue par la commande : **`@types/vscode` n'est jamais relevé** (`--reject`), parce
qu'il vaut `engines.vscode` — l'API minimale sur laquelle l'extension promet de tourner, que
relever est une décision et pas une mise à jour.

Rien de tout cela ne voyage dans un paquet : les quatre agents n'ont **aucune dépendance
d'exécution**. Ce qui bouge est l'outillage, et c'est `make` qui dit si le relèvement passe —
une version relevée est une version non vérifiée, et c'est souvent une règle de linter nouvelle
ou un type plus strict qui s'en aperçoit.

Le même jeu de règles ESLint est répété dans les quatre configurations plutôt qu'importé d'un
fichier commun : un agent qui importerait `../quelque-chose` ne serait plus détachable. Une
règle décidée pour les quatre s'applique donc aux quatre fichiers — ils se lisent en entier,
et chacun dit à qui il ressemble.

À la racine il ne reste que ce qui n'est à personne : la documentation, et
`scripts/brand-assets.mjs`, qui régénère les icônes et les visuels de boutique pour tout le
monde. **Aucun outillage**, donc : ni `package.json`, ni `node_modules`, ni linter — et un
`.gitignore` qui ne porte que `.DS_Store` et les permissions locales de Claude Code, chaque
agent ignorant ce qu'il produit lui-même. Le
JavaScript appartient aux agents, et `brand-assets.mjs` se lance à la main avec `sharp` (voir
[Charte graphique](#charte-graphique)), hors build, hors CI et hors lint.

Il n'y a pas non plus de tests « du dépôt ». Les vérifications qui regardent deux agents à la
fois appartiennent à **celui qui doit s'aligner** : le navigateur porte le dictionnaire de
référence, et ce sont `vscode/tests/i18n.test.mjs` et `libreoffice/tests/test_i18n.py` qui
vérifient que leur copie dit la même chose. Un agent est responsable de son accord avec la
référence, pas l'inverse.

### Les fichiers partagés sont des liens symboliques

`ui.css`, `ui.js`, `i18n.js`, `fonts/`, les icônes et le bac à sable des tests vivent dans
**`browser/`**. Les trois autres agents y **pointent**, et ces liens sont versionnés :

```text
word/src/ui.css            -> ../../browser/src/ui.css
word/src/i18n.js           -> ../../browser/src/i18n.js
word/src/fonts             -> ../../browser/src/fonts
word/src/icons/icon16.png  -> ../../../browser/src/icons/icon16.png
word/tests/helpers         -> ../../browser/tests/helpers
vscode/src/media/ui.css    -> ../../../browser/src/ui.css
libreoffice/src/icons/…    -> ../../../browser/src/icons/…
```

Le dossier d'un agent montre donc ce dont il est fait, au lieu qu'un build y recopie des
fichiers dans son dos. **Ne jamais remplacer un de ces liens par une copie** : la règle du
dépôt est qu'un texte, une couleur ou une police n'existe qu'une fois.

Trois conséquences :

- **Un paquet, lui, ne contient que de vrais fichiers**, et chaque build déréférence avec ce
  que son langage ou son outil lui donne : `shutil.copytree(symlinks=False)` côté Python,
  `vsce --follow-symlinks` pour le `.vsix`. Les deux builds en JavaScript parcourent l'arbre
  eux-mêmes, parce que `cpSync` de Node n'y suffit pas — même avec `dereference`, il recrée un
  lien, avec une cible absolue qui pointerait hors du paquet.
- **Le bac à sable des tests ne doit rien déduire de sa propre place** : Node résout un lien
  avant de renseigner `import.meta.url`, et `browser/tests/helpers/sandbox.mjs` chargé depuis
  `word/` se croirait chez lui. C'est le test qui donne le chemin du fichier à charger
  (`new URL('../sensor.js', import.meta.url)`).
- **Sous Windows**, git ne crée ces liens que si `core.symlinks` est actif (mode développeur) ;
  sinon ils arrivent comme des fichiers texte contenant un chemin, et le build produit des
  paquets cassés. Le développement se fait sous Linux ou macOS.

## Linters

`make lint` passe les linters de chaque agent, et c'est lui que la CI lance sur chaque branche.
Chaque configuration est commentée : une exception y dit pourquoi elle en est une. La
documentation, elle, n'est pas lintée — c'est un choix, pas un oubli.

| Outil | Ce qu'il lit | Configuration |
| --- | --- | --- |
| ESLint | le JavaScript de l'agent | `<agent>/eslint.config.mjs` |
| `tsc --noEmit` | le même JavaScript, pour ses **types** | `<agent>/jsconfig.json` |
| Stylelint | `ui.css` | `browser/stylelint.config.mjs` |
| html-validate | les pages de l'agent | `<agent>/.htmlvalidate.cjs` |
| ruff | le Python de l'agent LibreOffice | `libreoffice/ruff.toml` |
| ShellCheck | `browser/safari.sh` | — |
| `check-install-scripts.mjs` | le **verrou** de l'agent : qui exécute du code en s'installant | les arguments de `lint:deps` |

Le dernier n'est pas un linter de code mais de dépendances, et il existe pour un job précis.
Les jobs qui publient — les boutiques, le Marketplace, le déploiement Pages — installent par
**`make -C <agent> install-publish`**, c'est-à-dire `npm ci --ignore-scripts` : ce sont les
seuls jobs qui portent des identifiants, et un `npm ci` ordinaire y exécuterait le script
d'installation de n'importe lequel des quelques centaines de paquets de l'outillage de lint et
de test, à côté d'eux. Aucun n'en déclare aujourd'hui, sauf `@vscode/vsce-sign` ; le script
compare le verrou à cette liste et **échoue sur tout le reste**, ce qui fait de cette propriété
quelque chose de tenu plutôt que d'heureux. Une dépendance nouvelle qui en déclare un se lit
alors, et s'autorise ou se refuse ([publication.md](publication.md)).

### Le contrôle de types, sans TypeScript

Les trois agents JavaScript passent le vérificateur de TypeScript sur leur code — `checkJs`,
`noEmit`, et **rien d'autre ne change** : pas de `.ts`, pas de transpilation, pas de bundler. Le
fichier vérifié est le fichier livré, ce qui est la condition pour que les tests continuent de
charger le code de production tel quel et pour qu'aucune boutique n'ait à réclamer des sources
qui ne sont pas celles du paquet. Les types s'écrivent en **JSDoc** là où ils servent, pas
partout.

`strict` est **délibérément laissé à `false`**, et chaque `jsconfig.json` dit pourquoi : l'activer
réclamerait une annotation JSDoc sur chaque paramètre de chaque fonction, seize fichiers durant,
pour attraper ce que nous n'avons jamais raté. Ce qui est attrapé sans lui est ce que nous ratons
— une propriété qui n'existe pas sur un nœud du DOM ou sur une réponse de l'hôte, un appel au
mauvais nombre d'arguments, une valeur traitée comme un nombre sans en être une. Le resserrer
plus tard est une ligne de configuration, plus les annotations qu'elle réclamera.

L'extension navigateur a **deux configurations**, parce qu'elle a deux portées globales : le
service worker et les pages ne partagent pas leurs déclarations, et les lire comme un seul
programme signalerait des collisions qui ne peuvent pas se produire. C'est le même découpage que
celui que la configuration ESLint décrit déjà, fichier par fichier.

Ce que les types ont attrapé en arrivant : une balise `<meta>` lue comme un `Element` quelconque,
deux tris de dates qui soustrayaient des objets `Date`, un gestionnaire d'événement Office rendant
`undefined` là où Office attend une promesse, et le fait que `@types/vscode` doive être épinglé à
la version **minimale** que l'extension déclare supporter (`engines.vscode`) — sans quoi le
contrôle autoriserait des API absentes de l'éditeur d'un étudiant.

Deux fichiers `.d.ts` échappent à la règle « pas de TypeScript » et le disent en tête :
`browser/types/storage.d.ts`, qui est la seule description qui existe de ce que l'extension garde
dans `chrome.storage.local`, et `word/types/shared-ui.d.ts`, qui note que deux fonctions d'`ui.js`
sont du code mort dans le volet Word. Ni l'un ni l'autre n'est livré : ils sont à la racine de
leur agent, et un paquet, c'est `src/` plus la licence.

Chaque agent a sa configuration ESLint parce que chacun a son hôte : scripts classiques et
globals du navigateur ici, Office.js là, modules CommonJS de l'hôte d'extension pour VS Code.
ESLint prend la configuration la plus proche du fichier, donc un éditeur ouvert sur
`word/src/taskpane.js` voit la bonne sans rien configurer.

Aucun linter ne reformate : les règles de style qui réécriraient un fichier au lieu de le
vérifier sont désactivées, et `legacy/` est hors champ partout. `ui.css` s'écrit une règle par
ligne, les pages livrent leur structure et `i18n.js` les remplit au chargement, les
dictionnaires portent des phrases entières — les configurations le disent, et ne le signalent
plus. `ui.css` n'est linté qu'une fois, dans `browser/` : ailleurs, c'est le même fichier au
bout d'un lien.

**ruff s'installe avec pip**, dans `libreoffice/.venv`, depuis `requirements-dev.txt` ;
`make -C libreoffice lint` s'en charge au premier appel. Il faut donc `python3 -m venv`, c'est-à-dire
le paquet **`python3-venv`** sur Debian et Ubuntu — sans lui, la cible le dit et s'arrête.
L'extension livrée, elle, continue de n'embarquer que la bibliothèque standard : `.venv`,
`ruff.toml` et le `Makefile` sont des outils de développement, et `build.py` les laisse hors
du `.oxt`.

Le jeu de règles de ruff va plus loin que celui des autres linters du dépôt, parce que c'est
le seul agent qui écrit son jeton sur le disque et parle HTTP sans passer par `fetch` : **`S`**
(flake8-bandit) y est activé. C'est lui qui a demandé de vérifier le schéma de l'adresse du
moteur avant d'appeler `urlopen` — les trois autres agents passent par `fetch`, qui ne sait pas
sortir de http(s) ; le quatrième le sait maintenant aussi.

**ShellCheck est un binaire**, que `npm ci` n'installe pas : s'il manque,
`make -C browser lint` le dit et passe son tour (les runners GitHub l'ont déjà). S'il est là et
qu'il trouve quelque chose, le lint échoue.

Deux validations demandent un build, et restent donc des cibles à part :
`make -C browser lint-amo` (paquet Firefox, addons.mozilla.org) et `make -C word lint-manifest`
(manifest Office, Microsoft — réseau requis).

### `make check` : ce qu'aucun agent ne peut voir

Les linters et les tests d'un agent ne regardent que cet agent. Ce qui **lie les quatre** —
« une définition, quatre implémentations » — n'appartient à aucun d'eux et n'était tenu que par
la relecture. `make check` (`scripts/check-coherence.py`, bibliothèque standard seule) compare
six choses :

- les **constantes communes** de [mesures.md](mesures.md) avec les quatre capteurs, unités
  comprises (`IDLE_FLUSH_MS` vaut `IDLE_FLUSH_S`) — la table de la documentation est la
  référence, et c'est elle qui est comparée au code ;
- les **metrics envoyées** par chaque capteur avec la même table, les écarts assumés étant
  nommés dans le script ;
- la **forme de leurs noms** — `<sujet>_<statistique>_<unité>`, l'unité abrégée, la statistique
  jamais en tête, une durée toujours en millisecondes : une unité écrite en toutes lettres, un
  nom qui commence par `max`, `median` ou `mad`, un nom qui se termine par `_s` est refusé.
  Laissés à eux-mêmes les noms se font un par un et la forme se perd ; renommer une metric coûte
  un chantier côté moteur, cette vérification coûte une seconde ;
- l'**adresse du moteur par défaut**, déclarée une fois par agent — `browser/src/constants.js`,
  `word/src/agent.js`, `vscode/src/engine.js`, `engine.py` — parce qu'une constante ne se
  partage pas par un lien symbolique entre du JavaScript et du Python. Un agent resté sur une
  ancienne adresse n'échouerait nulle part : il joindrait un hôte muet, chez l'étudiant, et
  nulle part ailleurs ;
- la **règle disant où le jeton peut voyager** : le motif `LOCAL_ENGINE_HOST`, qui nomme les
  hôtes qu'une adresse de moteur en `http:` a le droit de désigner, doit être identique
  caractère pour caractère dans les quatre clients ([moteur.md](moteur.md), *L'adresse du
  moteur*). C'est la seule règle qui décide si un jeton d'API sans expiration traverse le réseau
  en clair, elle est écrite quatre fois dans deux langages, et c'est typiquement celle qu'on
  élargit chez un agent pour débloquer un déploiement ;
- les **fichiers partagés** : un fichier d'un agent dont le contenu est celui de son jumeau de
  `browser/` sans être un lien symbolique est une copie, qui divergera.

C'est la seule cible de la racine qui ne soit pas un simple parcours des quatre projets, et le
cinquième job de la CI.

Les deux autres scripts de `scripts/` que personne n'appelle à la main, ou presque, servent la
release et sont tous deux lancés par son workflow :

- `changelog-section.py <agent> <version>` sort la section que [`CHANGELOG.md`](../CHANGELOG.md)
  consacre à une version. C'est ce dont une release fait ses notes, et elle **échoue si la
  section manque** ;
- `release-plan.py [<agent> [version]]` dit ce qu'il reste à publier — pour chacun des quatre,
  son dernier tag, les commits qui ont touché **son paquet** depuis (liens symboliques suivis,
  donc un fichier partagé de `browser/src/` se voit chez les trois agents qui le portent) et ce
  que le journal lui consacre déjà. Avec un agent en argument, il donne le feu vert d'une
  release ou le refuse ([publication.md](publication.md)).

## Tests

Chaque agent a ses tests, dans son `tests/`, et `make -C <agent> test` les lance. Ils chargent
le fichier livré tel quel dans un contexte isolé (`browser/tests/helpers/sandbox.mjs`, auquel
les deux autres suites JavaScript pointent) : rien n'est ajouté au code de production pour le
rendre testable, et l'horloge est pilotée par le test. Ils sont la spécification exécutable des
règles de [mesures.md](mesures.md) — une règle qui change s'y voit d'abord, dans les quatre
suites.

### Dans l'hôte, pour de vrai : `make -C <agent> test-host`

Les suites ci-dessus remplacent l'hôte par des doubles — `chrome.*`, `Office`, le module
`vscode`, `uno`. C'est ce qui leur permet de charger le fichier livré tel quel et de piloter
l'horloge, et c'est aussi leur plafond : **elles ne peuvent rien dire de ce qui n'arrive qu'une
fois l'agent installé.** Un manifest que le navigateur refuse, un service worker qui jette au
démarrage, une commande déclarée et jamais enregistrée, un `.oxt` que `unopkg` refuse, une page
dont une balise `<script>` manque : tout cela passe les linters, passe les tests, et donne une
extension qui s'installe et ne fait rien. Aucune boutique ne relit ça.

Trois agents ont donc une seconde cible, qui lance l'agent **dans son hôte réel** :

| Agent | Ce que `make test-host` exerce |
| --- | --- |
| Extension navigateur | un vrai Chromium, l'extension dépaquetée : le manifest accepté, le service worker démarré, la popup et la page d'options affichées sans erreur de console, le capteur injecté dans une page que le manifest nomme, et des **frappes réelles** qui arrivent jusqu'à la file |
| Extension VS Code | un vrai VS Code, à la version **minimale** déclarée par `engines.vscode` : activation, commandes du manifest enregistrées, réglage lisible, panneau ouvert, document modifié |
| Extension LibreOffice | un vrai LibreOffice : le `.oxt` installé, le composant `fr.certimens.Agent` enregistré par le bureau, `XJob.execute` au démarrage, un document Writer ouvert et écrit, puis la désinstallation |

**Chacune tourne dans un conteneur jetable** (`<agent>/tests/host/Dockerfile`), pour deux
raisons : un navigateur et un éditeur Electron réclament un écran, que n'a pas une machine sans
affichage, et installer LibreOffice sur le poste d'un développeur pour une suite de tests serait
disproportionné. L'agent y est monté en **lecture seule** et tout ce qui est téléchargé vit dans
un volume : `make -C <agent> test-host-clean` rend la machine à son état d'avant.

`make test-host` à la racine les enchaîne toutes les trois. La cible est **hors de `make`** —
elle demande Docker, elle télécharge, elle dure des minutes, quand `make` doit rester instantané
et sans réseau — mais **pas hors de la CI** : trois jobs la lancent, un par agent à hôte, chacun
derrière les tests unitaires du sien et de lui seul — un hôte n'a aucune raison d'attendre un
agent qu'il ne contient pas. Le dépôt est public, ses minutes de runner ne
sont pas comptées, et l'alternative — s'en souvenir avant chaque tag — est exactement ce qui se
perd. En local, elle sert quand on a touché un manifest, un chargement ou une interface.

Le complément Word n'en a pas, et n'en aura pas : Office.js ne s'exécute que dans Word, il
n'existe pas de Word sans affichage, et le charger contre un faux Office.js reviendrait à
remplacer l'hôte par un double — ce que les tests unitaires font déjà.

Enfin, ce qu'aucun hôte automatisé ne verra — le DOM de Google Docs qui change, une fenêtre UNO
illisible, un volet Word dans un vrai Word — est écrit agent par agent dans
`<agent>/TESTING.md` : la liste de ce qui reste à la main, et pourquoi.

### Couverture

`make -C libreoffice coverage` dit ce que les tests Python couvrent — **85 %** des modules
testables à ce jour, pour un plancher à 80 % (`libreoffice/.coveragerc`). C'est un rapport
qu'on lance quand on touche à la mesure, pas une barrière de la CI.

Trois modules en sont exclus, et c'est volontaire : `agent.py`, `dialogs.py` et `sensor.py` ne
s'exécutent que **dans** LibreOffice, que la suite ne demande pas. Les mesurer afficherait 0 %
pour toujours et noierait le chiffre qui compte, celui des règles de comptage (`measure.py`,
97 %) et du client du moteur (`engine.py`, 81 %).

Les trois agents JavaScript ont désormais la même cible, `make -C <agent> coverage` : Node sait
instrumenter les fichiers chargés dans un contexte `vm`, ce que cette page affirmait longtemps
impossible. Chacun porte son plancher, choisi **au-dessous de ce qu'il couvre aujourd'hui** —
le but n'est pas le chiffre, c'est qu'une partie testée cesse de l'être sans que personne ne le
voie :

| Agent | Couverture de `src/` | Plancher |
| --- | --- | --- |
| Extension navigateur | 76 % (`content.js` 88 %, `background.js` 70 %, `popup.js` 40 %) | 72 % |
| Extension VS Code | 75 % (`sensor.js` 100 %, `engine.js` 83 %, `panel.js` 21 %) | 73 % |
| Complément Word | 69 % (`sensor.js` 80 %, `agent.js` 63 %) | 65 % |
| Extension LibreOffice | 85 % | 80 % |

Ces chiffres ont une limite à connaître, et elle se retourne : **un fichier qu'aucun test ne
charge n'y figure pas**. `vscode/src/extension.js` en est le cas — il exige le module `vscode`,
que seul l'éditeur fournit —, et son absence du rapport ne le rend pas couvert. L'inverse se
voit aussi : le premier test de `popup.js` a fait **baisser** le chiffre de l'extension
navigateur, parce qu'il a fait entrer dans le rapport trois cents lignes qui n'y étaient pas.
Un plancher qui descend après l'ajout d'un test n'est donc pas forcément une régression — mais
il demande qu'on regarde laquelle des deux choses s'est produite.

## Versions

La version vient de **git** : il n'y a rien à monter à la main, jamais, dans aucun manifest.
Chaque agent la résout lui-même, dans son build, à partir de **ses** tags — `browser-vX.Y.Z`,
`word-vX.Y.Z`, `libreoffice-vX.Y.Z`, `vscode-vX.Y.Z`. Un agent ne voit pas les tags des trois
autres (`git describe --match`), et le build refuse un tag qui ne porte pas son préfixe : sans
ça, publier le complément Word ferait sauter d'une version l'extension navigateur, qu'aucun
commit n'aurait touchée.

| Build | Version des paquets |
| --- | --- |
| Release (tag `<agent>-vX.Y.Z`) | `X.Y.Z` |
| Branche, PR, build local | dernier tag **de cet agent** + commit, par exemple `1.4.2-a9085f3` |
| Dépôt sans aucun tag pour cet agent | `0.0.0` + commit |

Chrome n'accepte qu'une version **numérique** : le repère lisible (`1.4.2-a9085f3`) va donc dans
`version_name`, que les navigateurs Chromium et Safari affichent et qu'addons.mozilla.org
accepte. Word impose quatre nombres (`X.Y.Z.0`) et ne peut pas porter le commit ; le
Marketplace de VS Code en veut trois, chiffres seulement ; LibreOffice, lui, accepte la chaîne
complète. Chaque build écrit aussi ce repère dans son `dist/VERSION`, que la CI affiche.

Un dépôt **sans aucun tag** ne construit pas une version : il construit `0.0.0-<commit>`, et les
quatre agents le disent de la même façon. La `version` écrite dans `browser/src/manifest.json` est
exigée par MV3 mais n'est plus lue par personne — le build l'écrase.

## Un manifest, tous les navigateurs

`browser/src/manifest.json` sert à tous. Le build n'en garde, pour chacun, que ce qu'il comprend :
Chrome et Safari n'ont que `background.service_worker` et pas de `browser_specific_settings`,
Firefox n'a que `background.scripts`. `chrome.zip` sert aussi à Edge, Opera et aux autres
navigateurs Chromium, qui installent l'extension depuis leur store ou depuis le Chrome Web
Store.

Safari n'accepte une extension qu'embarquée dans une app : `browser/safari.sh` la convertit
(`xcrun safari-web-extension-converter`) en app macOS + iOS, identifiant `fr.certimens.agent`.

## Charte graphique

Les agents suivent la **même direction artistique que l'espace web Certimens**. La charte est
tenue dans le dépôt public [`Certimens/certimens.github.io`][charte-depot], page
[`docs/charte-graphique.md`][charte] ;
c'est elle qui fait foi, et une couleur qui change, change là-bas d'abord. En résumé : Plus
Jakarta Sans avec des titres en 800 sur un corps en 500, l'ardoise `#1E293B` comme couleur
dominante et pour tout ce qui est de contour, l'or laiton `#C5A059` en accent unique — le
mot-marque « Certi**mens** », **et l'action principale**, qui est un bouton plein or portant du
texte encre `#1A202C` —, un fond `#F8FAFC` et des surfaces plates posées sur un filet `#E5E5E5`.

L'or n'est jamais du texte sur blanc (2,46:1) : là où il doit se lire, c'est l'or sombre
`#705E3A` (6,27:1). **Un seul bouton plein par vue**, et c'est l'action pour laquelle la vue
existe — le popup n'en montre qu'un à la fois, selon qu'on est connecté ou non ; tout le reste
est `.btn.outlined`, en ardoise.

| Où | Fichier |
| --- | --- |
| Popup, page d'options, volet Word, panneau VS Code | `browser/src/ui.css` (les variables CSS de `:root` ; rien en dur ailleurs) |
| Marque | `scripts/brand-mark.png` — l'écu doré du site, repris tel quel de l'espace web |
| Icônes et visuels de boutique | `scripts/brand-assets.mjs`, régénérés depuis la marque |

Les couleurs de verdict portent du **sens** et non de la marque : elles sont **hors charte**, et
c'est ce qui permet de les changer ici sans toucher au site. Elles sont **bleu `#1D4ED8`, ambre
`#B45309` et grenat `#881337`** — et non vert, orange et rouge.

Simulé pour les déficiences de la vision des couleurs les plus répandues, l'ancien triplet
s'effondrait : le vert `#137333` et le rouge `#c5221f` sortaient le même olive (ΔE 9,2 en thème
sombre, 11,1 en clair), et l'orange se confondait avec le rouge. Recolorer à l'intérieur de la
famille n'y change rien : un dichromate n'a plus d'axe rouge-vert, il ne lui reste que la
clarté, déjà dépensée pour le 4,5:1 que ces couleurs doivent à leur fond. D'où le **bleu** pour
ce qui va bien, et un écart acheté en clarté entre l'attente et l'échec. Le coût est assumé :
« vert = bien » est immédiat, « bleu = bien » s'apprend une fois — et de toute façon, c'est le
mot à côté de la couleur qui porte le sens. L'espace web Certimens porte les mêmes trois.

Un quatrième ton existe, l'information (une échéance passée) : ce n'est pas un verdict, donc pas
une quatrième couleur — c'est l'ardoise, ce que `--primary` veut déjà dire dans chaque thème.

Le badge de l'extension (`background.js`) et les alertes (`ui.css`) partagent ces valeurs, et
`browser/tests/theme.test.mjs` mesure les deux choses : le contraste de chacune sur sa surface,
et la distance qui sépare encore les trois sous protanopie, deutéranopie et tritanopie.

### Les deux thèmes

`ui.css` porte un **thème clair et un thème sombre**, alignés sur ceux de l'espace web. Le
sombre n'est pas un second jeu de valeurs inventé : c'est la même rampe lue par l'autre bout.
L'ardoise devient la page (`#0F172A`) et la surface (`#1E293B`), et ce qui était la couleur
dominante devient le clair qui écrit dessus (`#CBD5E1`).

**Une seule valeur change vraiment de sens d'un thème à l'autre** : l'or *en tant que texte*
(`--accent-text`), or sombre `#705E3A` sur page claire, or clair `#D4AC5F` sur page sombre.
L'or *en tant que surface* ne bouge pas — un bouton plein est doré et porte de l'encre
`#1A202C` (6,64:1), dans les deux thèmes.

Chaque hôte dit lequel s'applique, avec le signal qui est le sien :

| Agent | Ce qui décide |
| --- | --- |
| Navigateur, Word | `prefers-color-scheme` — le thème du système, et pour Word celui d'Office |
| VS Code | **le thème de l'éditeur**, pas celui du système : `panel.js` recopie la classe `vscode-dark` de l'hôte dans `data-theme` et suit ses changements à chaud |
| LibreOffice | rien à faire : ses fenêtres sont des widgets UNO natifs, qui suivent déjà le thème du système |

Les valeurs sombres sont écrites deux fois, une fois sous la media query et une fois sous
`[data-theme='dark']` — un test compare les deux blocs et échoue s'ils divergent.

**Aucune couleur n'est écrite en dur dans une règle** : tout passe par un token, sinon elle ne
suit pas le thème. `browser/tests/theme.test.mjs` mesure les deux thèmes et exige **4,5:1**
(WCAG AA) pour chaque couleur porteuse de sens sur la surface de son propre thème — c'est le
même contrôle que le moteur applique au sien.

Le script redessine les icônes (16, 32, 48 et 128 px pour l'extension, 64 et 80 px pour Word) et
les visuels que chaque agent garde dans son `store/`. Il ne fait pas partie du build : il demande
`sharp` et, pour le texte des visuels, Plus Jakarta Sans installée sur la machine (le dépôt ne
livre que les `.woff2`, que fontconfig ne lit pas). Si elle manque, **le script s'arrête** au
lieu de dessiner : sans ce contrôle, le rendu retombe en silence sur une autre fonte, plus
large, et le texte déborde de son cadre — ce qui ne se voit qu'à l'œil, une fois la bonne image
écrasée.

```bash
npx --yes --package sharp -- node scripts/brand-assets.mjs
```

## `legacy/`

Anciens agents de bureau Python et l'extension « Web Shield », conservés pour référence. Ils
n'atteignent plus le moteur actuel et **ne doivent pas évoluer** : voir `legacy/README.md`.

[charte-depot]: https://github.com/Certimens/certimens.github.io
[charte]: https://github.com/Certimens/certimens.github.io/blob/main/docs/charte-graphique.md
