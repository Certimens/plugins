# Développement

```bash
npm ci
npm run lint              # ESLint (extension/, word/, vscode/, scripts/, tests/)
npm test                  # toute la suite, sans navigateur, sans Word, sans LibreOffice, sans VS Code
npm run test:js           # capteurs navigateur, Word et VS Code (node --test, sans dépendance)
npm run test:libreoffice  # tests Python de l'extension LibreOffice
npm run build             # tous les paquets dans dist/
npm run build:safari      # macOS : projet Xcode dans dist/safari-xcode/, compilé sans signature
npm run lint:firefox      # validation addons.mozilla.org du paquet Firefox (après build)
npm run lint:word         # validation Microsoft du manifest Word (après build, réseau requis)
npm run word:serve        # complément Word sur https://localhost:3000 (après build)
npm run vscode:dev        # construit le paquet VS Code et ouvre une fenêtre dessus
```

Pas de bundler, pas de framework : des scripts classiques côté JavaScript, la bibliothèque
standard seule côté Python. `scripts/build.mjs` assemble les paquets ; il ne transforme pas le
code, il le range.

Installer chaque agent dans son hôte : voir sa page —
[navigateur](extension-navigateur.md), [Word](complement-word.md),
[LibreOffice](extension-libreoffice.md), [VS Code](extension-vscode.md).

Pour travailler contre un moteur local, saisir `http://localhost:8080` comme adresse du moteur
dans l'agent.

## Tests

Les tests des capteurs chargent le fichier livré tel quel dans un contexte isolé
(`tests/helpers/sandbox.mjs`) : rien n'est ajouté au code de production pour le rendre testable,
et l'horloge est pilotée par le test. Ils sont la spécification exécutable des règles de
[mesures.md](mesures.md) — une règle qui change s'y voit d'abord, dans les quatre suites.

## Versions

La version vient de **git** : il n'y a rien à monter à la main, jamais, dans aucun manifest.

| Build | Version des paquets |
| --- | --- |
| Release (tag `vX.Y.Z`) | `X.Y.Z` |
| Branche, PR, build local | dernier tag + commit, par exemple `1.4.2-a9085f3` |

Chrome n'accepte qu'une version **numérique** : le repère lisible (`1.4.2-a9085f3`) va donc dans
`version_name`, que les navigateurs Chromium et Safari affichent et qu'addons.mozilla.org
accepte. Word impose quatre nombres (`X.Y.Z.0`) et ne peut pas porter le commit ; LibreOffice,
lui, accepte la chaîne complète. Le build écrit aussi ce repère dans `dist/VERSION`, que la CI
affiche.

La `version` de `extension/manifest.json` ne sert plus que de valeur de repli, quand le dépôt
n'a encore aucun tag.

## Un manifest, tous les navigateurs

`extension/manifest.json` sert à tous. Le build n'en garde, pour chacun, que ce qu'il comprend :
Chrome et Safari n'ont que `background.service_worker` et pas de `browser_specific_settings`,
Firefox n'a que `background.scripts`. `chrome.zip` sert aussi à Edge, Opera et aux autres
navigateurs Chromium, qui installent l'extension depuis leur store ou depuis le Chrome Web
Store.

Safari n'accepte une extension qu'embarquée dans une app : `scripts/safari.sh` la convertit
(`xcrun safari-web-extension-converter`) en app macOS + iOS, identifiant `fr.certimens.agent`.

## Charte graphique

Les agents suivent la **même direction artistique que l'espace web Certimens**. La charte est
tenue dans le dépôt public [`Certimens/certimens.github.io`](https://github.com/Certimens/certimens.github.io),
[`docs/charte-graphique.md`](https://github.com/Certimens/certimens.github.io/blob/main/docs/charte-graphique.md) ;
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
| Popup, page d'options, volet Word, panneau VS Code | `extension/ui.css` (les variables CSS de `:root` ; rien en dur ailleurs) |
| Marque | `store/brand-mark.png` — l'écu doré du site, repris tel quel de l'espace web |
| Icônes et visuels de boutique | `scripts/brand-assets.mjs`, régénérés depuis la marque |

Les couleurs de verdict (vert, orange, rouge) portent du **sens** et non de la marque : le badge
de l'extension et les alertes les gardent telles quelles.

Le script redessine les icônes (16, 32, 48 et 128 px pour l'extension, 64 et 80 px pour Word) et
les visuels de `store/`. Il ne fait pas partie du build, qui n'a pas à en dépendre : il demande
`sharp` et, pour le texte des visuels, Plus Jakarta Sans installée sur la machine (le dépôt ne
livre que les `.woff2`, que fontconfig ne lit pas).

```bash
npx --yes --package sharp -- node scripts/brand-assets.mjs
```

## `legacy/`

Anciens agents de bureau Python et l'extension « Web Shield », conservés pour référence. Ils
n'atteignent plus le moteur actuel et **ne doivent pas évoluer** : voir `legacy/README.md`.
