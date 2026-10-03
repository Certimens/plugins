# Certimens — plugins

Les **agents de mesure** de Certimens : quatre implémentations d'un même capteur de rédaction.

Ce dépôt est **autonome**. Le moteur qui reçoit les mesures est développé à part, dans un dépôt
**privé** : rien ici ne doit supposer son chemin sur le disque, dépendre de ses fichiers, ni le
citer — ni son nom, ni ses chemins de code, ni ses pages de documentation. Ce dépôt-ci est
public : ce qu'on écrit du moteur se limite à ce que son **API** expose, et qu'un agent doit de
toute façon connaître. Quand une modification touche les deux côtés (ajouter une metric, changer
l'origine CORS autorisée), les skills le disent explicitement, sans nommer le fichier d'en
face.

| Dossier | Ce que c'est |
| --- | --- |
| `browser/` | extension navigateur MV3 (Google Docs, Word Online) — Chrome, Firefox, Safari, Edge, Opera |
| `word/` | complément Office pour Word (Office.js, servi par GitHub Pages) |
| `libreoffice/` | extension Writer en Python/UNO, paquet `.oxt` |
| `vscode/` | extension Visual Studio Code, paquet `.vsix` — un document moteur par fichier du projet |
| `scripts/` | la marque et le script qui régénère icônes et visuels — tout ce qui n'est à aucun agent |
| `legacy/` | anciens agents de bureau, conservés pour référence — ne pas faire évoluer |

La documentation de référence vit dans **`docs/`** ([docs/README.md](docs/README.md) en est le
sommaire) : `mesures.md` (ce que comptent les agents), une page par agent, `langues.md`,
`moteur.md` (le contrat avec le moteur), `developpement.md` et `publication.md`. Le `README.md`
de la racine n'est qu'une porte d'entrée. Lire la page concernée avant d'intervenir, et la tenir
à jour dans le même commit que le code qu'elle décrit.

Ce qui est décidé par le moteur — types de metrics acceptés, origine CORS autorisée, familles de
client, calcul du score — se documente **côté moteur** ; `docs/moteur.md` dit seulement ce que
les agents en présentent. **Le dépôt du moteur n'est pas public : ne jamais le citer ici**, ni
son nom, ni ses chemins de fichiers, ni ses pages de documentation. On parle du « moteur » et de
son API, rien de plus.

## Skills à charger

- `mesures-redaction` — **sur toute modification d'un capteur, d'une constante de mesure ou
  d'une metric**, quel que soit le dossier : la définition est unique, les implémentations sont
  quatre.
- `extension-navigateur` — travail dans `browser/` : code, `build.mjs` ou configuration de lint.
- `complement-word` — travail dans `word/` ou sur le manifest Office.
- `extension-libreoffice` — travail dans `libreoffice/`.
- `extension-vscode` — travail dans `vscode/`.
- `langues-interface` — **sur tout texte affiché à l'étudiant**, quel que soit l'agent :
  deux langues, une règle, quatre dictionnaires.
- `depot-licence-boutiques` — **avant de commiter, de poser un tag, d'ajouter une dépendance ou
  de toucher à `LICENSE`/`NOTICE`**, et dès qu'un parcours visible par l'étudiant change : ce
  qui engage le dépôt au-delà du code, y compris les notes aux relecteurs des boutiques.

## Conventions

- **Commentaires de code en anglais ; documentation en français.** Les textes d'interface
  existent en **français et en anglais** : ils ne s'écrivent pas en dur, ils s'ajoutent au
  dictionnaire de l'agent (voir le skill `langues-interface`).
- Pas de bundler, pas de framework : des scripts classiques côté JavaScript, la bibliothèque
  standard seule côté Python.
- La version vient de git (tag, ou dernier tag + commit) : **ne jamais l'incrémenter à la main**
  dans un manifest.
- Le dépôt est sous **AGPL-3.0-only** (`LICENSE`, `NOTICE`) : copyleft fort, clause réseau
  comprise — tout dérivé, y compris servi à distance, reste sous la même licence. Chaque agent
  y est lié et chaque paquet l'emporte ; un `package.json` nouveau déclare
  `"license": "AGPL-3.0-only"`. La licence ne concède **aucun droit sur la marque** (terme
  additionnel, clause 7(e)) : ne jamais l'écrire autrement. Ne jamais introduire une dépendance
  d'exécution dont la licence est incompatible avec l'AGPL.
- Aucun texte rédigé par l'étudiant ne quitte son poste : les agents n'envoient que des
  compteurs.
- **Chaque agent est un projet autonome**, et tous ont la même forme : `src/` (ce qui est
  livré, et rien d'autre), `tests/`, `store/` (une fiche par boutique), `dist/` (ignoré), son
  `Makefile`, et son outillage — `package.json` ou `requirements-dev.txt`, avec son verrou.
  **Un paquet, c'est `src/` plus `LICENSE` et `NOTICE`** : un fichier posé à la racine d'un
  agent n'est, par construction, jamais livré.
- **Chaque agent est écrit dans sa langue de bout en bout** : les trois agents JavaScript ont
  un `build.mjs`, celui en Python a un `build.py` et pas une ligne de Node.
- Un outil s'ajoute **dans le projet qui l'utilise**, jamais à la racine ; le `Makefile` de la
  racine ne fait que les parcourir, et c'est tout ce que lance la CI. Ne rien faire pointer
  d'un agent vers `../`, et laisser chaque agent ignorer ce qu'il produit dans son
  `.gitignore`.
- Ce que les quatre partagent — `ui.css`, `ui.js`, `i18n.js`, les polices, les icônes et le bac
  à sable des tests — vit dans `browser/src/` et **arrive chez les autres par des liens
  symboliques**, versionnés comme tels : ne jamais en recopier le contenu.
- Dans les trois agents JavaScript, **les commandes sont déclarées dans `package.json`** et le
  `Makefile` ne fait que les appeler : une commande nouvelle s'ajoute comme script npm, pas
  comme recette make.
- Les linters couvrent cinq langages (JS, CSS, HTML, Python, shell) et leurs configurations
  sont commentées : **désactiver une règle, c'est écrire pourquoi**
  ([docs/developpement.md](docs/developpement.md)). La racine n'a ni outillage ni
  `package.json`.

```bash
make install                # installe l'outillage de chaque projet (à faire une fois)
make                        # lint puis tests, agent par agent
make build                  # chaque agent construit son paquet dans <agent>/dist/
make -C browser lint        # un seul agent : lint, test, build, publish…
make -C browser lint-amo    # validation AMO (après build)
make -C word lint-manifest  # validation Microsoft du manifest (après build, réseau requis)
make -C libreoffice test    # tests Python, sans LibreOffice
```
