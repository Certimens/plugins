# Extension VS Code

Une extension pour **Visual Studio Code** dans `vscode/`, paquet `dist/certimens-vscode.vsix`
(VS Code 1.90+), pour les devoirs qui se rendent en code plutôt qu'en traitement de texte.

C'est le seul agent qui mesure **un projet entier, fichier par fichier** : chaque fichier écrit
devient un document Certimens distinct, avec ses propres fenêtres de mesure — ce qu'un enseignant
corrige, ce sont des fichiers, pas un projet en bloc.

## Les fichiers

- `sensor.js` : les fenêtres de mesure, une instance par document ouvert, sans aucune dépendance
  à l'API de VS Code — c'est ce qui rend les règles vérifiables sans éditeur
  (`tests/vscode-sensor.test.mjs`).
- `engine.js` : moteur et file hors-ligne (stockage global de l'extension), jeton d'API dans le
  **SecretStorage** de l'éditeur et non dans `settings.json`, qui se synchronise entre machines
  et se lit par-dessus l'épaule. Pas de CORS : les appels partent de Node, pas d'une page.
- `extension.js` : l'hôte. Il traduit les événements de l'éditeur en mesures, tient un capteur
  par document, la barre d'état et les commandes.
- `panel.js` : le panneau latéral (webview), le même écran que la popup de l'extension et que le
  volet Word ; il réutilise `ui.css`, ne détient aucun état et ne voit jamais le jeton.
- `README.md` : la fiche du Marketplace, écrite pour l'étudiant. Le build la copie dans le
  paquet ; la documentation de référence, elle, reste ici.

## Ce que voit l'éditeur

VS Code ne livre pas les frappes : il signale **ce qui change** dans le document
(`onDidChangeTextDocument`, un événement par modification, avec le texte inséré et la longueur
de ce qu'il remplace) et **d'où vient le curseur** (`onDidChangeTextEditorSelection`, avec
l'origine du déplacement : clavier, souris ou commande).

C'est plus que ce que donne Office — l'origine d'un déplacement étant connue, la règle « une
suppression solde le déplacement qui la précède » y tient — et moins qu'un navigateur, aucune
touche n'étant jamais vue. Un déplacement qui suit une frappe de moins de 50 ms
(`SELECTION_ECHO_MS`) est l'écho du curseur, pas une navigation.

## Quels fichiers sont mesurés

**Rien n'est créé tant que l'étudiant n'a pas écrit** : ouvrir un projet de quatre cents fichiers
n'en crée aucun côté moteur. Le réglage `certimens.exclude` écarte en plus les dépendances, la
sortie de compilation et les fichiers générés.

Un fichier est identifié par un condensé du chemin du dossier de travail et son chemin
**relatif** dans le projet ; ce qui part au moteur est `projet/chemin/du/fichier`, jamais le
chemin absolu, qui nomme le compte de l'étudiant. Un fichier renommé ou déplacé garde ses
mesures : le document Certimens est renommé (`PUT /api/documents/:id`), pas remplacé.

## Rendre un fichier

La commande *Certimens : rendre ce fichier* (palette de commandes, ou le bouton du panneau)
envoie le fichier ouvert (`PUT /api/documents/:id`, base64, 18 Mo au plus) puis propose les devoirs
auxquels l'étudiant est rattaché. C'est **la seule** action qui fait sortir du texte du poste ;
la mesure, elle, n'envoie que des compteurs.

## Installer

```bash
code --install-extension dist/certimens-vscode.vsix
```

Ou *Extensions › … › Installer à partir d'un VSIX*. En développement, `npm run vscode:dev`
construit le paquet et ouvre une fenêtre VS Code sur `dist/vscode/` — le dossier `vscode/` seul
ne suffit pas, `media/` (la feuille de style, les polices et l'icône partagées avec l'extension
navigateur) est rempli par le build.

## Côté moteur

La famille de client `vscode` doit être connue de l'ingestion du moteur, sinon chaque envoi est
marqué `client_unknown` sur le document : voir [moteur.md](moteur.md).
