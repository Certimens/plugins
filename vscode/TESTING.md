# Ce qui reste à vérifier à la main — extension VS Code

Ce fichier est à la racine de l'agent : il n'est, par construction, jamais livré dans le `.vsix`
(il est nommé dans `.vscodeignore`).

## Ce qui est déjà tenu par les tests

| Commande | Ce qu'elle voit |
| --- | --- |
| `make test` | le capteur, l'envoi au moteur (file, `offline`, ordre des clés, générations de metrics), le panneau, le dictionnaire |
| `make test-host` | un **vrai VS Code**, à la version **minimale** déclarée par `engines.vscode` : l'extension s'active, toutes les commandes du manifest sont enregistrées, le réglage est lisible, le SecretStorage répond, le panneau s'ouvre, un document modifié pour de vrai ne fait rien jeter |

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

### Quand le parcours de l'étudiant change

- [ ] **VSCodium, Cursor, Gitpod** — les éditeurs servis par Open VSX, où la publication reste
      manuelle. Ils n'ont pas le même ensemble d'API, et `engines.vscode` ne dit rien d'eux.
- [ ] **Une version plus récente de VS Code** : `VSCODE_VERSION=stable make test-host` passe la
      suite sur la dernière. La suite par défaut vise la **minimale**, celle de l'étudiant dont
      l'éditeur n'a pas bougé.
- [ ] **Les notes de la fiche du Marketplace** (`store/marketplace/README.md`), si le parcours a
      changé.
