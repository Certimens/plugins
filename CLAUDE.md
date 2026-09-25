# Certimens — plugins

Les **agents de mesure** de Certimens : trois implémentations d'un même capteur de rédaction.

Ce dépôt (`Certimens/plugins`) est **autonome**. Le moteur qui reçoit les mesures vit dans un
autre dépôt (`Certimens/engine`) : il peut être cloné à côté, ou pas du tout. Rien ici ne doit
donc supposer son chemin sur le disque ni dépendre de ses fichiers — ses `CLAUDE.md`, skills et
outillage ne sont pas chargés quand on travaille sur ce seul dépôt. Quand une modification touche
les deux (ajouter une metric, changer l'origine CORS autorisée), les skills le disent
explicitement et nomment le fichier concerné côté moteur.

| Dossier | Ce que c'est |
| --- | --- |
| `extension/` | extension navigateur MV3 (Google Docs, Word Online) — Chrome, Firefox, Safari, Edge, Opera |
| `word/` | complément Office pour Word (Office.js, servi par GitHub Pages) |
| `libreoffice/` | extension Writer en Python/UNO, paquet `.oxt` |
| `scripts/` | build des paquets, certificat de dev Word, visuels de marque |
| `legacy/` | anciens agents de bureau, conservés pour référence — ne pas faire évoluer |

Le `README.md` est la documentation de référence (installation, metrics, CI, publication dans
chaque boutique) : le lire avant d'intervenir, et le tenir à jour dans le même commit que le code
qu'il décrit.

## Skills à charger

- `mesures-redaction` — **sur toute modification d'un capteur, d'une constante de mesure ou
  d'une metric**, quel que soit le dossier : la définition est unique, les implémentations sont
  trois.
- `extension-navigateur` — travail dans `extension/`, `scripts/build.mjs` ou `eslint.config.js`.
- `complement-word` — travail dans `word/` ou sur le manifest Office.
- `extension-libreoffice` — travail dans `libreoffice/`.

## Conventions

- **Commentaires de code en anglais ; documentation et textes d'interface en français.**
- Pas de bundler, pas de framework : des scripts classiques côté JavaScript, la bibliothèque
  standard seule côté Python.
- La version vient de git (tag, ou dernier tag + commit) : **ne jamais l'incrémenter à la main**
  dans un manifest.
- Aucun texte rédigé par l'étudiant ne quitte son poste : les agents n'envoient que des
  compteurs.

```bash
npm run lint              # ESLint (extension/, word/, scripts/, tests/)
npm test                  # toute la suite, sans navigateur, sans Word, sans LibreOffice
npm run build             # tous les paquets dans dist/
npm run lint:firefox      # validation AMO (après build)
npm run lint:word         # validation Microsoft du manifest (après build, réseau requis)
npm run test:libreoffice  # tests Python, sans LibreOffice
```
