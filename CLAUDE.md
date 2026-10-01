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
| `extension/` | extension navigateur MV3 (Google Docs, Word Online) — Chrome, Firefox, Safari, Edge, Opera |
| `word/` | complément Office pour Word (Office.js, servi par GitHub Pages) |
| `libreoffice/` | extension Writer en Python/UNO, paquet `.oxt` |
| `vscode/` | extension Visual Studio Code, paquet `.vsix` — un document moteur par fichier du projet |
| `scripts/` | build des paquets, certificat de dev Word, visuels de marque |
| `tests/` | les capteurs JavaScript, sans navigateur ni hôte (`npm test`) |
| `store/` | visuels et textes des fiches des boutiques |
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
- `extension-navigateur` — travail dans `extension/`, `scripts/build.mjs` ou `eslint.config.js`.
- `complement-word` — travail dans `word/` ou sur le manifest Office.
- `extension-libreoffice` — travail dans `libreoffice/`.
- `extension-vscode` — travail dans `vscode/`.
- `langues-interface` — **sur tout texte affiché à l'étudiant**, quel que soit l'agent :
  deux langues, une règle, quatre dictionnaires.

## Conventions

- **Commentaires de code en anglais ; documentation en français.** Les textes d'interface
  existent en **français et en anglais** : ils ne s'écrivent pas en dur, ils s'ajoutent au
  dictionnaire de l'agent (voir le skill `langues-interface`).
- Pas de bundler, pas de framework : des scripts classiques côté JavaScript, la bibliothèque
  standard seule côté Python.
- La version vient de git (tag, ou dernier tag + commit) : **ne jamais l'incrémenter à la main**
  dans un manifest.
- Aucun texte rédigé par l'étudiant ne quitte son poste : les agents n'envoient que des
  compteurs.

```bash
npm run lint              # ESLint (extension/, word/, vscode/, scripts/, tests/)
npm test                  # toute la suite, sans navigateur, sans Word, sans LibreOffice, sans VS Code
npm run build             # tous les paquets dans dist/
npm run lint:firefox      # validation AMO (après build)
npm run lint:word         # validation Microsoft du manifest (après build, réseau requis)
npm run test:libreoffice  # tests Python, sans LibreOffice
```
