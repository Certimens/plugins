---
name: extension-vscode
description: Extension Visual Studio Code (vscode/, paquet .vsix) — un capteur par fichier du projet, hôte et panneau webview, jeton dans le SecretStorage, empaquetage vsce et famille de client côté moteur. À charger avant toute modification dans vscode/, et avant de diagnostiquer une mesure qui ne remonte pas ou un document moteur créé en trop.
---

# Extension VS Code

`vscode/` mesure la rédaction **d'un projet de code, fichier par fichier**. `sensor.js` est le
capteur (voir `mesures-redaction`), `engine.js` l'envoi au moteur et la file hors-ligne,
`extension.js` l'hôte qui traduit les événements de l'éditeur, `panel.js` le panneau latéral.

## Un document moteur par fichier source

C'est ce qui distingue cet agent des trois autres : un document par fichier du projet, chacun
avec ses propres fenêtres. Deux règles en découlent, à ne pas défaire :

- **Rien n'est créé tant que l'étudiant n'a pas écrit.** Un capteur naît localement dès qu'un
  document est modifié ; le document moteur, lui, n'est créé qu'au premier envoi d'une fenêtre
  portant de l'activité réelle (`Engine.ensureDocument`, appelé depuis `pushItem`). Créer le fichier
  à l'ouverture d'un document rendrait un projet de quatre cents fichiers illisible côté moteur.
- **Rien d'absolu ne sort du poste.** L'identifiant est un condensé du dossier de travail plus le
  chemin *relatif* ; ce qui part au moteur est `projet/chemin/du/fichier`. Un chemin absolu
  nommerait le compte de l'étudiant.

`certimens.exclude` (réglage, valeurs par défaut dans `DEFAULT_EXCLUDE`) écarte dépendances,
sortie de compilation et fichiers générés. Le filtrage se fait dans `Agent.identify`, une fois
par document : un fichier exclu ne crée jamais de capteur.

## Ce que l'API donne, et ne donne pas

VS Code ne livre aucune touche. Trois événements portent toute la mesure :

- `onDidChangeTextDocument` : une modification, avec le texte inséré et **la longueur de ce
  qu'elle remplace** (`rangeLength`) — mais jamais le texte effacé, d'où un décompte des
  suppressions en unités de la modification et non en caractères visibles ;
- `onDidChangeTextEditorSelection` : le déplacement **et son origine** (clavier, souris,
  commande). C'est ce qui permet la règle « une suppression solde le déplacement qui la
  précède », que le complément Word ne peut pas tenir ;
- `onDidChangeWindowState` : la sortie de l'éditeur, donc `focus_losses`.

`SELECTION_ECHO_MS` (50 ms) est la constante propre à cette implémentation : l'éditeur signale un
déplacement après **chaque** frappe, et sans ce délai `navigation_jumps` suivrait exactement
`total_keystrokes`.

Une annulation (`reason === Undo`) compte **une** correction et **une** frappe, sans rejouer les
modifications qu'elle porte : les compter ferait peser un Ctrl+Z autant que le paragraphe qu'il
restaure.

## Le jeton ne va pas dans les réglages

Il vit dans le **SecretStorage** de l'éditeur (`context.secrets`), jamais dans `settings.json` :
ce fichier se synchronise entre machines, se commite et se lit par-dessus l'épaule. Le panneau
est une webview : elle affiche ce qu'on lui envoie et ne voit ni le jeton ni la configuration.
Sa CSP n'autorise que `media/` et le script porteur du nonce — pas de CDN, pas de police
distante.

Le reste de la file (`engineIds`, `queue`, `names`) est dans `context.globalState`, et la file part
comme partout ailleurs : verrou unique, renvoi chaque minute, `400 metric_type_unknown` seul
désactive les metrics étendues.

## Mesure suspendue

`Agent.paused()` (dans `globalState`, donc persistée) est consultée en tête de chaque gestionnaire
de l'hôte ; `setPaused()` vide d'abord les fenêtres ouvertes. La commande
`certimens.togglePause`, le bouton du panneau et la barre d'état disent tous le même état — la
règle commune est dans `mesures-redaction`. Noter que la file continue de partir : `Engine` ne
connaît pas la pause, et c'est voulu.

## Langues

`vscode/i18n.js` porte les textes que notre code affiche ; `package.nls.json` (français, le repli)
et `package.nls.en.json` ceux que l'éditeur lit dans `package.json` avant nous — d'où les `%clé%`.
Les messages propres à l'éditeur ont leur espace de noms : `bar.*` pour la barre d'état, `notify.*`
pour les notifications, parce qu'ils disent la même chose que le volet mais avec les icônes de
VS Code et le nom du produit devant. Règle complète : skill `langues-interface`.

## L'envoi du texte est une commande, jamais la mesure

`certimens.submit` est le seul chemin par lequel du texte de l'étudiant quitte le poste
(`PUT /api/documents/:id`, base64, 18 Mo). Toute évolution qui ferait transiter du contenu pendant la
mesure casse la promesse affichée sur la fiche du Marketplace.

## Côté moteur

La famille de client `vscode` doit être connue de l'ingestion du moteur, sinon chaque envoi
lève `client_unknown` sur le fichier. Node n'ajoute de lui-même aucun en-tête qu'un navigateur
trahirait : l'agent s'annonce donc par un `User-Agent` explicite, `Certimens-VSCode/X.Y.Z`. Pas
de CORS à prévoir — les requêtes partent de Node, pas d'une page.

Le moteur accepte un fichier de code parce que ses octets se reniflent en `text/plain`, et il
compte son volume sans les sauts de ligne
(`content.TextCharCount`) : `real_volume` se compte de la même façon côté capteur.

## Construire et essayer

```bash
npm run vscode:dev   # build puis une fenêtre VS Code sur dist/vscode/
npm test             # dont tests/vscode-sensor.test.mjs
```

Le dossier `vscode/` **seul ne se charge pas** : `media/ui.css`, `media/fonts/` et
`media/icon128.png` viennent de `extension/` et sont copiés par `scripts/build.mjs`. Seul
`media/shield.svg` (l'icône monochrome de la barre d'activité) est versionné.

La version vient du tag git, comme partout : `vscode/package.json` n'en porte qu'un repli, et le
Marketplace n'accepte que `X.Y.Z` — un build de branche (`X.Y.Z-commit`) n'est pas publiable,
c'est voulu.
