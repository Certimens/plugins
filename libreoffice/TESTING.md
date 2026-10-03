# Ce qui reste à vérifier à la main — extension LibreOffice

Ce fichier est à la racine de l'agent : il n'est, par construction, jamais livré dans le `.oxt`.

## Ce qui est déjà tenu par les tests

| Commande | Ce qu'elle voit |
| --- | --- |
| `make test` | les règles de comptage, la fenêtre telle qu'elle part (déroulé et forme de chaque suite, silences, rythme, texte, session et cumuls — et chaque relation que le moteur recoupe, sur des séances jouées), l'envoi au moteur sur un vrai corps HTTP (file, `offline`, ordre des clés à chaque niveau, lots, fenêtre refusée abandonnée, entrée de file d'une autre forme jetée), le dictionnaire — **sans LibreOffice** |
| `make test-host` | un **vrai LibreOffice**, en conteneur : le `.oxt` s'installe, le bureau liste l'extension, il enregistre le composant `fr.certimens.Agent`, celui-ci démarre comme au lancement (`XJob.execute`) et écrit son état dans le profil, un document déjà identifié se rouvre et **l'agent s'y branche** — il en retient le titre —, **le compte de Writer est bien la longueur du corps du texte** sur des paragraphes simples (ce dont dépend la portée du texte), puis l'extension se désinstalle |

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
      vérifier que les suites du déroulé (`runs`) et les `counts` suivent. C'est le trou
      principal de l'automatisation ci-dessus, et le cœur de l'agent.
- [ ] **Le corps, contre un vrai moteur** : une séance courte — frappe, silence de deux secondes,
      collage, enregistrement — doit être acceptée (201) fenêtre après fenêtre, sans `400`. Les
      tests jouent le moteur par une doublure qui ne valide pas le corps ; seul le moteur dit
      qu'une clé est de trop.
- [ ] **Le collage, au clavier puis par le menu** : Ctrl/Cmd+V, Maj+Inser, et *Édition ▸ Coller*
      doivent donner **le même** chiffre — une frappe pour son propre texte qui revient, aucune
      pour un texte venu d'ailleurs. C'est `sensor.py` qui reconnaît ces touches et les classe en
      `PASTE` ; `make test` ne voit que la suite de la règle, la catégorie lui étant donnée toute
      faite. Sur un Mac, la même chose avec Cmd : `MOD1` *est* Cmd, et rien d'autre ne le dit.
- [ ] **Les relâchements de touches**, que seul un vrai clavier livre : taper une phrase,
      maintenir une lettre deux secondes, puis lire la fenêtre partie (mode debug).
      `dwell.bins` doit porter à peu près autant de valeurs que de frappes `type`, la touche
      maintenue une seule valeur dans la dernière tranche, et jamais plus de valeurs que de
      frappes. À refaire
      sous **X11, Wayland, Windows et macOS** : la répétition automatique n'y arrive pas de la
      même façon, et c'est `sensor.py` qui les réconcilie.
- [ ] **AltGr sous Windows** : taper `@`, `#` ou `€` au milieu d'un mot ne doit **pas** couper
      la suite `type` du déroulé. Le capteur lit Ctrl+Alt comme une frappe qui écrit ; ce que
      LibreOffice livre réellement pour AltGr sous Windows n'a pas été observé.
- [ ] **La portée du texte sur un vrai mémoire** : notes de bas de page, titres numérotés,
      tableau, cadre. Le bloc `text` doit se réduire à `{len}` quand le compte de Writer et le
      corps du texte diffèrent, et porter la portée sinon — et la frappe ne doit pas saccader sur un document de
      deux cent mille caractères, la lecture du corps étant faite toutes les cinq secondes sur
      le fil de l'interface. Son coût côté LibreOffice n'a pas été mesuré, seul celui de la
      comparaison l'a été.
- [ ] **Les fenêtres UNO** : la fenêtre Certimens, l'appairage, et les aides au survol
      (`HelpText`) — elles remplacent les icônes des trois autres agents, qui n'existent pas
      ici. Vérifier qu'aucune ne s'ouvre vide ni ne tombe.
- [ ] **Le menu Certimens** (`Addons.xcu`) et la **barre d'info** d'un document non encore lié :
      les deux chemins qui appellent `service:fr.certimens.Agent?open`.
- [ ] **Un document repris d'un éditeur à l'autre** : écrire dans un `.odt` suivi par
      l'extension, l'enregistrer en `.docx`, l'ouvrir dans Word avec le complément. Word doit
      poursuivre **le même** document Certimens, et non en ouvrir un second. Puis dans l'autre
      sens, un `.docx` écrit dans Word et rouvert dans Writer : la barre d'info nomme le
      document repris, à la place de l'invite de liaison. C'est le seul endroit où les deux
      agents se rencontrent, et ils ne se rencontrent que dans le fichier.
- [ ] **Les deux propriétés sont là, et lisibles** : *Fichier ▸ Propriétés ▸ Propriétés
      personnalisées* montre `CertimensDocumentId` et `CertimensEngineDocument`. La seconde
      n'apparaît qu'une fois le document Certimens créé.
- [ ] **Une copie ne reprend pas le dossier de l'original** : *Enregistrer sous* un document
      suivi, écrire dans la copie. Elle doit recevoir son propre document Certimens, et la barre
      d'info de liaison avec.
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
