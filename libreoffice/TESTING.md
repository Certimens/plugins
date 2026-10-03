# Ce qui reste à vérifier à la main — extension LibreOffice

Ce fichier est à la racine de l'agent : il n'est, par construction, jamais livré dans le `.oxt`.

## Ce qui est déjà tenu par les tests

| Commande | Ce qu'elle voit |
| --- | --- |
| `make test` | les règles de comptage, l'envoi au moteur sur un vrai corps HTTP (file, `offline`, ordre des clés, générations de metrics), le dictionnaire — **sans LibreOffice** |
| `make test-host` | un **vrai LibreOffice**, en conteneur : le `.oxt` s'installe, le bureau liste l'extension, il enregistre le composant `fr.certimens.Agent`, celui-ci démarre comme au lancement (`XJob.execute`) et écrit son état dans le profil, un document déjà identifié se rouvre et **l'agent s'y branche** — il en retient le titre —, puis l'extension se désinstalle |

Deux limites à connaître :

- **Le conteneur n'a pas d'écran**, et le capteur reçoit les frappes par un `XKeyHandler` posé
  sur la vue : sans fenêtre, aucune touche ne lui parvient. `make test-host` prouve que l'agent
  s'installe, démarre et **se branche sur un document** ; il ne prouve pas qu'il compte. La
  mesure elle-même reste à vérifier à la main, première ligne ci-dessous.
- **La version testée est celle de Debian** (LibreOffice 7.4), pas la minimale déclarée par
  `description.xml` (7.0) ni celle qu'un étudiant aura.

## À faire à la main

### Avant chaque release

- [ ] **Le capteur, dans une vraie fenêtre Writer** : taper, effacer, coller, cliquer, et
      vérifier que les compteurs montent. C'est le trou principal de l'automatisation ci-dessus,
      et le cœur de l'agent.
- [ ] **Les fenêtres UNO** : la fenêtre Certimens, l'appairage, et les aides au survol
      (`HelpText`) — elles remplacent les icônes des trois autres agents, qui n'existent pas
      ici. Vérifier qu'aucune ne s'ouvre vide ni ne tombe.
- [ ] **Le menu Certimens** (`Addons.xcu`) et la **barre d'info** d'un document non encore lié :
      les deux chemins qui appellent `service:fr.certimens.Agent?open`.
- [ ] **L'appairage complet** avec un vrai compte : le code, la confirmation dans l'espace
      Certimens, le retour. Aucun mot de passe nulle part.
- [ ] **La suspension survit au redémarrage de LibreOffice**, et son message reste affiché —
      c'est le seul agent sans bandeau permanent, son message *est* l'affichage de l'état.
- [ ] **La version minimale déclarée** (`LibreOffice-minimal-version` de `description.xml`) :
      installer le `.oxt` sur cette version-là au moins une fois par cycle. Le conteneur en
      teste une autre.

- [ ] **La mise à jour depuis le gestionnaire d'extensions**, et c'est la vérification que rien
      d'autre ne fait : installer le `.oxt` d'une version publiée, puis *Outils › Gestionnaire
      des extensions › Vérifier les mises à jour*. La version du flux doit être proposée, le
      `.oxt` se télécharger depuis la release GitHub et s'installer. Un flux qui ne répond pas,
      une adresse de téléchargement fausse ou un identifiant qui ne correspond pas se voient
      **là et nulle part ailleurs** : aucun test ne joint le réseau, et le gestionnaire ne dit
      rien quand il ne trouve rien. Vérifier aussi ce que `curl` renvoie sur
      `https://certimens.github.io/plugins/libreoffice/update.xml`.

- [ ] **La ligne « Certimens a été mis à jour »** apparaît une fois dans la fenêtre Certimens
      après cette mise à jour, et le bouton ouvre bien les notes de release dans le navigateur.

### Hors Linux

- [ ] **macOS et Windows** : le `.oxt` est le même, le Python embarqué par LibreOffice ne l'est
      pas, et les chemins du profil non plus.

### Au dépôt

- [ ] **extensions.libreoffice.org** se remplit à la main — le site n'a pas d'API. La licence
      s'y choisit dans une liste, et la fiche (`store/`) doit dire la même chose que le code sur
      ce qui est collecté.
