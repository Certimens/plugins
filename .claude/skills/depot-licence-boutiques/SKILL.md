---
name: depot-licence-boutiques
description: Ce qui engage le dépôt au-delà du code — licence AGPL et dépendances, version tirée des tags git, forme de l'historique, et les fiches de boutique qu'un changement d'interface périme. À charger avant de commiter, de poser un tag, d'ajouter une dépendance, de toucher à LICENSE ou NOTICE, et dès qu'un parcours visible par l'étudiant change (connexion, permissions, ce qui part au moteur).
---

# Dépôt, licence et boutiques

Trois choses de ce dépôt ne vivent pas dans le code mais l'engagent : sa **licence**, la forme de
son **historique**, et les **fiches de boutique** qui décrivent aux relecteurs ce que fait
l'agent. Les trois se périment en silence — rien ne casse, rien n'échoue au lint, et la
découverte se fait au moment du dépôt sur une boutique.

## Licence : AGPL-3.0-only

Le dépôt est passé d'Apache-2.0 à **AGPL-3.0-only** le 3 octobre 2026 : copyleft fort, clause
réseau comprise. Ce que ça change au quotidien :

- **Toute dépendance d'exécution doit être compatible AGPL.** MIT, BSD, Apache-2.0 et ISC le
  sont ; une dépendance sous licence propriétaire ou sous GPL incompatible ne peut pas entrer.
  L'outillage de développement (linters, build) ne voyage pas dans les paquets : il n'est pas
  concerné. Les trois agents JavaScript ne déclarent d'ailleurs **aucune dépendance
  d'exécution**, et celui en Python s'en tient à la bibliothèque standard — la meilleure façon
  de ne pas avoir à trancher.
- **Un `package.json` nouveau déclare `"license": "AGPL-3.0-only"`**, et `LICENSE` + `NOTICE`
  voyagent dans chaque paquet (c'est le build qui s'en charge, voir `docs/developpement.md`).
- **La clause marque n'est pas la licence.** Elle est un *terme additionnel au titre de la clause
  7(e)* de l'AGPL, écrit dans `NOTICE` : la licence ne concède aucun droit sur le nom
  « Certimens » ni sur l'écu doré. Ne jamais l'écrire autrement, et ne jamais laisser entendre
  qu'un dérivé peut garder le nom.
- Les commits antérieurs à la bascule restent distribués sous Apache-2.0 : un fork parti de là
  est légitime. Ce n'est pas un problème à corriger, c'est un fait à connaître avant de promettre
  une protection qui n'existe pas.

## Version et historique

- **La version vient de git, un tag par agent** : `browser-vX.Y.Z`, `word-vX.Y.Z`,
  `libreoffice-vX.Y.Z`, `vscode-vX.Y.Z` pour une release, sinon le dernier tag **de cet agent**
  + commit. Ne **jamais** l'incrémenter à la main dans un manifest — ce qui y est écrit n'est
  qu'un repli pour un dépôt sans tag. Les quatre versions divergent, et c'est le but : un agent
  qu'aucun commit n'a touché n'est pas redéposé dans ses boutiques, où chaque dépôt coûte une
  relecture. Attention aux **fichiers partagés** (`browser/src/ui.css`, `ui.js`, `i18n.js`, les
  polices, les icônes) : ils arrivent chez trois agents par lien symbolique, donc un changement
  là demande trois tags.
- **Le tag ne se pose pas à la main : il se pose depuis GitHub**, *Actions › Release › Run
  workflow*. Le formulaire demande l'agent (ou `report only`, le défaut, qui ne publie rien),
  la version (vide : celle de la section du journal qui n'a pas encore de tag) et laisse
  `dry_run` coché — décocher est le geste qui publie. Le run écrit d'abord **ce qu'il reste à
  publier** : quel agent a bougé depuis son dernier tag, quel fichier partagé en engage
  plusieurs, ce que le journal consacre déjà à chacun (`python3 scripts/release-plan.py` donne
  le même rapport en local). Il refuse de publier un agent dont le paquet n'a pas bougé ; le tag
  poussé à la main reste accepté quand c'est voulu quand même, et déclenche le même workflow
  (voir `docs/publication.md`).
- **Avant un tag, la liste de `<agent>/TESTING.md`** : ce qui ne se vérifie qu'à la main — le
  DOM des éditeurs, les fenêtres, les parcours avec un vrai compte. L'agent dans son hôte réel,
  lui, est tenu par la CI (`make -C <agent> test-host`, dernier job). Le complément Word n'a que
  la liste : Office.js ne s'exécute que dans Word.
- **Une section de `CHANGELOG.md` s'écrit avant le tag**, `## <agent> <version>`, sortie de
  « Non publié » et portant les deux phrases bilingues que la boutique colle dans ses
  « Nouveautés ». La release en fait ses notes et **échoue si elle manque**, avant même de
  construire : la liste des commits dit ce que le dépôt a fait, mêle les quatre agents et ne se
  colle dans aucune fiche. `python3 scripts/changelog-section.py <agent> <version>` montre ce
  qui sera publié.
- **Tant qu'aucune release n'est publiée, l'historique est un seul commit racine.** Un correctif
  se fond dedans (`git reset --soft <racine>` puis `git commit --amend`), il n'ajoute pas un
  commit de suite. Préserver l'auteur d'origine (`--amend` sans `--reset-author`) et les trailers
  du message. La règle tombe à la première release, où l'historique devient la trace de ce qui a
  été livré.
- **Réécrire est local ; pousser ne l'est pas.** Poser une branche de secours avant toute
  réécriture, et ne **jamais** forcer un push sans le demander : le dépôt est public, les forks
  et clones gardent ce qu'on croit effacer, et un `--force` ne reprend rien à GitHub, qui sert
  encore les commits orphelins par leur SHA.

## Les fiches de boutique se périment sans prévenir

`<agent>/store/<boutique>/README.md` contient, pour plusieurs boutiques, les **notes aux
relecteurs** : le compte de test et la suite de gestes à faire pour voir l'agent fonctionner.
Un changement d'interface les périme sans qu'aucun test ne s'en aperçoive.

Relire ces fiches dès qu'on touche à :

- l'**appairage** (un geste de plus ou de moins, un champ déplacé ou replié dans les paramètres
  avancés) — les notes de Firefox, Safari et AppSource décrivent les gestes du relecteur, et
  rappellent que le compte de test sert à l'espace Certimens, jamais à l'agent, qui ne demande
  aucun mot de passe ;
- les **permissions** du manifest, ou ce que l'agent collecte : la fiche Chrome et les
  `data_collection_permissions` de Firefox doivent dire la même chose que le code ;
- ce qui **part au moteur** : la promesse « aucun texte ne quitte le poste » est affichée dans
  les quatre boutiques. Une mesure nouvelle qui ferait transiter du texte n'est pas un détail
  d'implémentation, c'est un changement de contrat à annoncer partout.

```bash
grep -rn "compte de test\|Compte de test" */store/*/README.md   # les notes aux relecteurs
make -C browser lint-amo        # ce que Mozilla refusera, avant Mozilla (après build)
make -C word lint-manifest      # validation Microsoft du manifest (après build, réseau requis)
```

La licence, elle, se déclare aussi dans les fiches : Open VSX **refuse** un paquet sans licence,
le Marketplace affiche l'onglet *License* à partir du SPDX de `package.json`, et le formulaire
d'extensions.libreoffice.org demande de la choisir dans une liste.
