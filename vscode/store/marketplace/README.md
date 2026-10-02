# Visual Studio Marketplace — fiche de l'extension

Particularité de VS Code : **la fiche, c'est le paquet**. Le Marketplace lit tout dans
`package.json` et affiche `README.md` comme page de présentation — il n'y a pas de formulaire à
remplir. Ce dossier ne contient donc pas de textes à copier, mais ce qu'il faut vérifier avant
de publier.

Publication : `make -C vscode build && make -C vscode publish`, avec `VSCE_PAT` dans
l'environnement. La release s'en charge ensuite à chaque tag.

## Ce que le Marketplace lit dans `package.json`

| Champ | Valeur | Remarque |
| --- | --- | --- |
| `publisher` | `certimens` | créé une fois sur le [portail](https://marketplace.visualstudio.com/manage), **ne change plus** |
| `name` | `certimens` | avec l'éditeur, forme l'identifiant `certimens.certimens` |
| `main` | `./src/extension.js` | le code est dans `src/`, le manifest reste à la racine |
| `displayName` | `%extension.displayName%` | traduit par `package.nls.json` / `package.nls.en.json` |
| `description` | `%extension.description%` | idem |
| `categories` | Education, Other | |
| `keywords` | certimens, authorship, rédaction, intégrité | 5 au maximum, celles-ci en font 4 |
| `icon` | `src/media/icon128.png` | lien symbolique vers `browser/src/icons/` ; vsce le déréférence |
| `version` | imposée par le tag git | trois nombres, chiffres seulement ; le `0.0.0` du fichier est un repli |

Un texte affiché se change **dans `package.nls.json` et `package.nls.en.json`**, jamais en dur
dans le manifest (voir le skill `langues-interface`).

## La page de présentation

C'est [`../../README.md`](../../README.md), celui de l'agent — pas celui du dépôt, que le build
laisse de côté. Il doit se lire seul : un lecteur du Marketplace n'a ni le dépôt, ni le contexte.

Les liens relatifs n'y fonctionnent pas : le Marketplace les résout sur sa propre adresse. Tout
lien doit être absolu (`https://certimens.fr`, `https://github.com/Certimens/plugins`).

## Vérifications avant publication

- `make -C vscode build` passe, et le `.vsix` fait une vingtaine de fichiers : s'il en fait
  des milliers, `node_modules` ou `dist/` s'y est glissé — c'est `.vscodeignore` qui tient
  cette liste.
- Le manifest empaqueté garde `scripts` et `devDependencies` : `build.mjs` ne réécrit pas
  `package.json`, il passe la version à vsce en ligne de commande. Ces champs sont inertes et
  le Marketplace n'en affiche rien.
- L'extension ne déclare **aucune dépendance d'exécution** (`--no-dependencies`).

## Licence

**Apache-2.0**, déclaré en SPDX dans `package.json`. `LICENSE` est un lien vers celui de la
racine, et vsce l'empaquette : le Marketplace affiche l'onglet *License* sans rien de plus à
faire. La licence porte sur le code et **pas sur la marque** « Certimens » (clause 6) ; c'est
dit dans `NOTICE`, qui voyage avec le paquet.

## Confidentialité

Pas de questionnaire sur le Marketplace. La page de présentation doit tout de même dire ce que
l'agent mesure et ce qui quitte le poste, et renvoyer vers
`https://certimens.fr/politique-de-confidentialite/`.
