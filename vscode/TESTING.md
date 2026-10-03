# Ce qui reste à vérifier à la main — extension VS Code

Ce fichier est à la racine de l'agent : il n'est, par construction, jamais livré dans le `.vsix`
(il est nommé dans `.vscodeignore`).

## Ce qui est déjà tenu par les tests

| Commande | Ce qu'elle voit |
| --- | --- |
| `make test` | le capteur (les suites, les silences, la portée du texte, les cumuls de session), l'envoi au moteur (file, `offline`, ordre des clés du corps, paquets, refus abandonnés), les compteurs que l'agent tient sur lui-même (mots, plafond, cadence, remise à zéro), le panneau (dont le lien *Signaler un problème*, qui ne fait que poster un message, et le bouton des notifications d'erreur), le lien de signalement (forme, ordre des clés, `unknown`, ni jeton ni e-mail ni chemin même présents, borne de 1 500 caractères, moteur refusé), le dictionnaire |
| `make test-host` | un **vrai VS Code**, à la version **minimale** déclarée par `engines.vscode`, puis à **1.97.0**, la première qui annonce les collages : l'extension s'active, toutes les commandes du manifest sont enregistrées, le réglage est lisible, le SecretStorage répond, le panneau s'ouvre, *Certimens : signaler un problème* passe à `openExternal` (remplacé le temps du cas) un lien en chaîne, au bon format, un document modifié pour de vrai ne fait rien jeter, et, un dossier ouvert, la file s'écrit dans un fichier du dossier de stockage de l'espace de travail. Pour les collages : la surveillance s'enregistre sans jeter (nulle part en 1.90), un vrai collage par `editor.action.clipboardPasteAction` arrive intact, annoncé en 1.97, et part en `paste` ; une édition par l'API et un extrait (`insertSnippet`) partent en `suggest` en 1.97, en `paste` en 1.90 |

`make test-host` répond à « est-ce que ça s'installe et fait quelque chose ». Il ne regarde
rien : le panneau s'ouvre, personne ne dit qu'il est lisible.

Et le **SecretStorage y est celui d'un Linux sans trousseau** : le conteneur n'en a pas, donc
l'éditeur est lancé avec `--password-store=basic`, qui est le repli réel de VS Code dans ce cas.
Le chemin éprouvé est donc un vrai chemin, mais pas celui d'un poste de bureau — gnome-keyring,
KWallet, le Trousseau macOS et DPAPI restent à vérifier à la main.

## À faire à la main

### Avant chaque release

- [ ] **Le `.vsix` installé depuis le fichier** (`Extensions : Install from VSIX…`), pas le
      dossier de développement. C'est ce que `.vscodeignore` décide, et une ressource oubliée
      s'y voit — pas avant.
- [ ] **L'appairage complet** avec un vrai compte : la commande *Certimens : se connecter*, le
      code, la confirmation dans l'espace Certimens, le retour. Aucun mot de passe nulle part.
      C'est aussi le seul moment où le **trousseau du système** est éprouvé : fermer l'éditeur,
      le rouvrir, et vérifier que la session tient. Sur un Linux de bureau, un trousseau
      verrouillé fait échouer la lecture du jeton — le conteneur ne peut pas le voir.
- [ ] **La barre d'état** : son texte au repos, pendant la mesure, hors ligne, en pause ; et ce
      que son clic ouvre. Les icônes `$(…)` ne se rendent que dans l'éditeur.
- [ ] **Le panneau**, à l'œil, en thème clair **et** sombre : il emprunte `ui.css` à l'extension
      navigateur et doit suivre les couleurs de l'éditeur, pas les siennes.
- [ ] **`certimens.exclude` sur un vrai projet** : `node_modules`, `.git`, `dist` ignorés. Un
      document moteur par fichier, et un projet qui en crée trois cents est un bug visible côté
      moteur, pas ici.
- [ ] **La ligne « Certimens a été mis à jour »** : installer un `.vsix`, ouvrir le panneau,
      installer un `.vsix` d'une autre version, rouvrir. La ligne s'affiche une fois ; passer sur
      une autre vue et revenir ne doit pas la redire (l'éditeur reconstruit la webview à chaque
      retour). Le lien doit s'ouvrir dans le navigateur, malgré la CSP du panneau.

- [ ] **La suspension survit au redémarrage de l'éditeur**, et le dit en permanence.

- [ ] **Les compteurs de l'agent arrivent au moteur** : après l'appairage, attendre un tour de
      boucle (au plus quinze minutes après le précédent envoi), et vérifier côté moteur qu'un
      `started` est compté pour cette version, et `installed` ou `updated` selon le cas. Les
      tests voient le corps que `fetch` reçoit, pas un moteur qui l'accepte. Pour une erreur :
      dans l'extension installée (pas en développement, dont le dossier diffère), provoquer une
      exception d'un écouteur, puis vérifier que la ligne `agent fault` du moteur porte des frames
      `fonction@fichier.js:ligne:colonne` sans aucun chemin.

- [ ] **Le panneau a ses marges.** Sa CSP n'autorise une feuille de style que sous nonce, et
      aucun attribut `style` : un test le refuse dans le HTML généré, mais seul l'œil dit que la
      webview applique bien la feuille (espacement entre les blocs, liste des fichiers mesurés
      bornée en hauteur, lien vers le code d'appairage) — elle s'est affichée sans, longtemps.
- [ ] **Deux fenêtres, un compte.** Écrire dans deux fenêtres de l'éditeur ouvertes sur deux
      dossiers, réseau coupé, puis le rétablir : les fenêtres de mesure des deux partent, aucune
      n'est perdue. Se déconnecter dans l'une : la barre d'état de l'autre le dit dès qu'elle
      revient au premier plan, et sa file ne part pas sous le compte suivant.
- [ ] **Renommer un fichier mesuré, puis un dossier** dans l'explorateur : côté moteur, le
      document est renommé — pas de second document du nouveau nom.
- [ ] **Une fenêtre distante** (WSL, conteneur de développement ou SSH) : un fichier y est
      mesuré comme un fichier local. Ce cas n'a jamais tourné que sur le papier — l'hôte de
      test est local. Y regarder aussi où va la file : `queue.jsonl` sous le dossier de
      stockage si l'éditeur en donne un chemin local, sinon le `workspaceState` (plus lent,
      mais rien ne se perd).
- [ ] **La file survit à un éditeur tué.** Réseau coupé, écrire quelques minutes dans un
      dossier, tuer l'éditeur (`kill -9`, pas *Quitter*), le relancer, rétablir le réseau :
      tout part, rien deux fois côté moteur, et `queue.jsonl` est vide ensuite. Les tests
      coupent les écritures une à une sous Node ; un vrai arrêt brutal, c'est ici.
- [ ] **Collage ou suggestion, geste par geste**, dans un VS Code **1.97 ou plus récent** —
      `make test-host` fait un collage par la commande et une édition par l'API, rien de ce
      qu'une main fait. Connecté, ouvrir un fichier du projet, et pour chaque geste ci-dessous
      (un bloc de plus de quinze caractères, chacun dans une fenêtre à lui : attendre deux
      secondes entre deux) regarder la fenêtre scellée — la file (`queue.jsonl`, sous le dossier
      de stockage de l'espace de travail, réseau coupé) ou le corps envoyé côté moteur :
      - Ctrl+V (Cmd+V) → `["paste", n]` ;
      - *Édition › Coller* et *Coller* du menu contextuel → `["paste", n]` ;
      - un bloc glissé depuis **une autre fenêtre** (un navigateur, un autre éditeur) →
        `["paste", n]` ;
      - une complétion IntelliSense de plus de quinze caractères acceptée par Tab ou Entrée, et
        celle qui reprend un préfixe tapé → `["suggest", n]`, aucune suite `erase` ni
        correction pour le préfixe ;
      - une suggestion en ligne d'un assistant (Copilot ou autre) acceptée par Tab, et un bloc
        appliqué depuis sa fenêtre de discussion, si l'un est disponible → `["suggest", n]` ;
      - un extrait de code (`for` + Tab) → `["suggest", n]` ;
      - une ligne du fichier copiée puis recollée → `["other", 1]`, `["self", n]` ;
      - *Coller comme…* (`editor.action.pasteAs`), en prenant son temps dans la liste →
        `["paste", n]`.
      Et à chaque collage : **rien de nouveau à l'écran** — ni widget « coller comme… » qui
      n'apparaissait pas sans l'extension, ni indicateur d'attente, ni délai perceptible. Un
      fichier TypeScript ou Markdown affiche déjà ses propres options de collage : comparer
      avec l'extension désactivée. Puis `editor.pasteAs.enabled` à `false` : Ctrl+V doit
      toujours donner `paste`, et une complétion aussi (l'extension ne sait plus faire la
      différence). Dans un VS Code **1.90 à 1.96**, tout bloc reste `paste`, et la console de
      l'hôte d'extensions ne montre aucune erreur Certimens à l'activation.
- [ ] **Un collage dans un navigateur** (un codespace ou un code-server ouvert dans un onglet — vscode.dev ne charge pas l'extension, qui n'a pas de point d'entrée web) :
      tout bloc doit partir en `paste` — la commande Coller du menu y écrit le presse-papiers
      sans consulter aucun fournisseur, et l'extension n'y enregistre rien. Et **avec VSCodeVim**
      installé, `p` après un `"+y` : `paste`, jamais `suggest`.
- [ ] **Signaler un problème, jusqu'au formulaire** : la commande, le lien du panneau
      (connecté **et** déconnecté) et le bouton d'une notification d'erreur (moteur coupé,
      *Certimens : rendre ce fichier*) ouvrent le navigateur sur le formulaire d'aide de
      l'espace, en mode « problème », le bloc affiché à part, en clair, avec sa case. Le test
      d'hôte remplace `openExternal` : que le navigateur reçoive le fragment intact — `?`, `=`,
      `&` non encodés — ne se voit qu'ici, et de même sous VSCodium et dans une fenêtre distante,
      où `openExternal` passe par l'interface locale.
- [ ] **Un lien dans une notification** : nommer un devoir `[x](command:workbench.action.quit)`
      côté moteur, rendre un fichier pour ce devoir — la notification affiche le texte, sans
      lien cliquable.

### Quand le parcours de l'étudiant change

- [ ] **VSCodium, Cursor, Gitpod** — les éditeurs servis par Open VSX, où la publication reste
      manuelle. Ils n'ont pas le même ensemble d'API, et `engines.vscode` ne dit rien d'eux.
- [ ] **Une version plus récente de VS Code** : `VSCODE_VERSION=stable make test-host` passe la
      suite sur la dernière. La suite par défaut vise la **minimale**, celle de l'étudiant dont
      l'éditeur n'a pas bougé.
- [ ] **Les notes de la fiche du Marketplace** (`store/marketplace/README.md`), si le parcours a
      changé.
