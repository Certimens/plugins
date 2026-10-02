# Documentation — agents de mesure Certimens

Les **agents de mesure** de Certimens : quatre implémentations d'un même capteur de rédaction
(extension navigateur, complément Word, extension LibreOffice Writer, extension VS Code). Un
agent observe la **manière** dont un document est écrit — rythme, pauses, corrections,
navigation, injections — et pousse des **compteurs** au moteur Certimens.

Aucun texte rédigé par l'étudiant ne quitte son poste pendant la mesure. Seul un envoi explicite
de document (« rendre ce fichier ») fait sortir du contenu, et jamais une touche ni un caractère.

## Sommaire

| Document | Contenu |
| --- | --- |
| [mesures.md](mesures.md) | Ce que comptent les agents : fenêtres, constantes, règles de comptage, metrics envoyées, suspension |
| [extension-navigateur.md](extension-navigateur.md) | Google Docs et Word Online (MV3), popup, page d'options, mode debug |
| [complement-word.md](complement-word.md) | Word pour Windows, Mac et web (Office.js), site GitHub Pages |
| [extension-libreoffice.md](extension-libreoffice.md) | Writer en Python/UNO, paquet `.oxt` |
| [extension-vscode.md](extension-vscode.md) | VS Code, un document Certimens par fichier du projet, paquet `.vsix` |
| [langues.md](langues.md) | Français et anglais : règle de choix, dictionnaires, manifests |
| [moteur.md](moteur.md) | Le contrat avec le moteur : endpoints, jeton, CORS, familles de client, metrics refusées |
| [developpement.md](developpement.md) | Installer les agents en développement, commandes, tests, versions, charte graphique |
| [publication.md](publication.md) | CI, releases, et la mise en place de chaque boutique |

## Frontière avec le moteur

Ce dépôt est **autonome** : il se lit et se construit seul. Le moteur qui reçoit les mesures est
développé à part et n'est pas public — cette documentation ne renvoie donc **jamais** à ses
fichiers, ni à son code, ni à ses pages. Elle décrit ce qu'un agent fait et ce qu'il attend du
moteur **à travers son API**, qui est tout ce qu'un agent en voit.

Le partage est celui de la mesure et de son exploitation :

| Documenté ici | Décidé et documenté côté moteur |
| --- | --- |
| Ce qu'un agent observe, et comment il le compte | Ce qu'une mesure devient : le calcul du score |
| Les règles communes aux quatre agents et leurs écarts assumés | Les types de metrics acceptés et leur stockage |
| Ce qu'un agent envoie, quand, et ce qu'il fait d'un refus | Les endpoints, leurs corps et leurs codes |
| Comment un agent s'annonce (en-têtes, `User-Agent`, origine CORS) | Ce que le moteur en déduit et signale |
| L'interface vue par l'étudiant dans son éditeur | L'espace web, l'enseignant, le certificat |
| L'empaquetage, les boutiques, la CI de ce dépôt | L'hébergement et le déploiement du moteur |

Deux règles pratiques en découlent :

- **Une metric s'ajoute côté moteur d'abord**, agents ensuite. Le moteur refuse un type qu'il ne
  connaît pas (`metric_type_unknown`) ; l'inverse rendrait la mesure invisible et bruyante. Voir
  [moteur.md](moteur.md).
- **Une valeur qui vit des deux côtés ne se documente qu'une fois, du côté qui la décide** :
  l'origine CORS autorisée et les familles de client sont décidées par le moteur, ce dossier se
  contente de dire ce que les agents en présentent, sans citer où cela se trouve chez lui.

## Conventions

- **Commentaires de code en anglais ; documentation en français.** Les textes affichés à
  l'étudiant existent en français **et** en anglais (voir [langues.md](langues.md)).
- Pas de bundler, pas de framework : des scripts classiques côté JavaScript, la bibliothèque
  standard seule côté Python.
- **Un dossier par agent**, avec son `Makefile` et ses linters ; ce que les quatre partagent
  vit dans `browser/` et leur arrive par des liens symboliques (voir
  [developpement.md](developpement.md)).
- La version vient de git : elle ne s'incrémente jamais à la main dans un manifest (voir
  [developpement.md](developpement.md)).
