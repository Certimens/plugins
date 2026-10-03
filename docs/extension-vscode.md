# Extension VS Code

Une extension pour **Visual Studio Code** dans `vscode/`, paquet `vscode/dist/certimens-vscode.vsix`
(VS Code 1.90+), pour les devoirs qui se rendent en code plutôt qu'en traitement de texte.

C'est le seul agent qui mesure **un projet entier, fichier par fichier** : chaque fichier écrit
devient un document Certimens distinct, avec ses propres fenêtres de mesure — ce qu'un enseignant
corrige, ce sont des fichiers, pas un projet en bloc.

## Les fichiers

- `sensor.js` : les fenêtres de mesure, une instance par document ouvert, sans aucune dépendance
  à l'API de VS Code — c'est ce qui rend les règles vérifiables sans éditeur
  (`tests/sensor.test.mjs`).
- `engine.js` : moteur et file hors-ligne (stockage global de l'extension), jeton d'API dans le
  **SecretStorage** de l'éditeur et non dans `settings.json`, qui se synchronise entre machines
  et se lit par-dessus l'épaule. Pas de CORS : les appels partent de Node, pas d'une page.
- `extension.js` : l'hôte. Il traduit les événements de l'éditeur en mesures, tient un capteur
  par document, la barre d'état et les commandes.
- `panel.js` : le panneau latéral (webview), le même écran que la popup de l'extension et que le
  volet Word ; il réutilise `ui.css`, ne détient aucun état et ne voit jamais le jeton.
- `i18n.js` : les deux dictionnaires d'interface, plus ceux qui n'ont de sens que dans un éditeur
  — `bar.*` pour la barre d'état, `notify.*` pour les notifications ([langues.md](langues.md)).
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

Les motifs sont comparés **segment par segment**, jamais par une expression régulière construite
à la volée. Les deux raisons tiennent dans la même fonction. Compiler le motif par
remplacements successifs laissait chaque passe réécrire les métacaractères que la précédente
venait d'émettre : aucun des douze motifs livrés par défaut ne correspondait à quoi que ce soit,
et le seul levier dont dispose l'étudiant pour tenir un chemin hors du moteur ne faisait rien —
sans rien dire. Et l'expression produite revenait en arrière sans borne, de sorte qu'un motif
fourni par le `.vscode/settings.json` d'un dépôt cloné figeait **le fil de l'hôte d'extensions**,
partagé par toutes les extensions, pendant des minutes sur une seule frappe. Comparer
directement coûte un temps proportionnel au motif et au chemin, quel que soit le contenu du
motif.

Deux conséquences à connaître : le réglage est déclaré **configuration restreinte**, donc un
espace de travail non fiable ne peut pas le poser ; et la décision d'exclusion est mise en cache
par chemin, rejetée au changement du réglage — un fichier exclu n'a pas de capteur pour s'en
souvenir, et la liste était donc reparcourue à chaque évènement.

Un fichier est identifié par un condensé du chemin du dossier de travail et son chemin
**relatif** dans le projet ; ce qui part au moteur est `projet/chemin/du/fichier`, jamais le
chemin absolu, qui nomme le compte de l'étudiant. Un fichier renommé ou déplacé garde ses
mesures : le document Certimens est renommé (`PUT /api/documents/:id`), pas remplacé.

## Se connecter

Le panneau ne demande **aucun mot de passe** : son bouton **Se connecter** obtient un code court
auprès du moteur, l'étudiant le saisit dans son espace Certimens, et l'extension reçoit un jeton
d'API — le flux est décrit dans [moteur.md](moteur.md#adresse-et-authentification). L'adresse du
moteur est repliée dans ses **paramètres avancés**, qui ne s'ouvrent d'eux-mêmes que pour une
adresse autre que celle par défaut.

L'attente vit **côté extension**, pas dans la webview : VS Code démonte une vue dès qu'une autre
passe devant, et c'est précisément le moment où l'étudiant est parti confirmer le code. La
commande *Certimens : se connecter* (palette) fait la même chose sans ouvrir le panneau : elle
affiche le code dans une notification avec le bouton qui ouvre l'espace, et reprend l'adresse
déjà enregistrée — une adresse à changer passe par le panneau.

## Rendre un fichier

La commande *Certimens : rendre ce fichier* (palette de commandes, ou le bouton du panneau)
envoie le fichier ouvert (`PUT /api/documents/:id`, base64, 18 Mo au plus) puis propose les devoirs
auxquels l'étudiant est rattaché. C'est **la seule** action qui fait sortir du texte du poste ;
la mesure, elle, n'envoie que des compteurs.

L'état du document est relu **avant** l'envoi, et non après : une copie dont l'échéance est
passée (`assignment_deadline`) arrête la commande là, plutôt que de lire le fichier et de
l'envoyer pour un refus. La *quick pick* n'ayant pas de ligne désactivée, un devoir échu y est
listé, le dit dans son libellé, et est refusé à la sortie ([moteur.md](moteur.md)).

## Installer

```bash
code --install-extension vscode/dist/certimens-vscode.vsix
```

Ou *Extensions › … › Installer à partir d'un VSIX*. En développement, `make -C vscode dev`
ouvre une fenêtre VS Code sur le dossier `vscode/` lui-même, sans rien construire : `media/`
(la feuille de style, les polices et l'icône partagées avec l'extension navigateur) y est fait
de **liens symboliques** vers `browser/`, que l'hôte d'extension suit comme des fichiers.

## « Certimens a été mis à jour »

Après une mise à jour, le panneau dit une fois quelle version tourne, avec un lien vers les
notes de release. La règle est la même dans les quatre agents et elle est écrite une
fois : [extension-navigateur.md](extension-navigateur.md#certimens-a-été-mis-à-jour).

La version vient de `context.extension.packageJSON`, et elle est lue au moment où la vue est
résolue : l'éditeur détruit et reconstruit une webview dès qu'une autre vue passe devant,
et la ligne se dirait à chaque retour si elle n'était pas consommée là. Une extension
chargée depuis un dossier (`make dev`) n'a pas de descripteur : rien n'est annoncé.

## Côté moteur

La famille de client `vscode` doit être connue de l'ingestion du moteur, sinon chaque envoi est
marqué `client_unknown` sur le document : voir [moteur.md](moteur.md).
