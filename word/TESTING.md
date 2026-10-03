# Ce qui reste à vérifier à la main — complément Word

Ce fichier est à la racine de l'agent : il n'est, par construction, jamais livré dans un paquet.

## Ce qui est déjà tenu par les tests

| Commande | Ce qu'elle voit |
| --- | --- |
| `make test` | le capteur par différences de texte (déroulé et ses relations, silences, classements, session, texte lu et sa portée), l'envoi au moteur (file, paquets hors ligne, `offline`, octets et ordre des clés du corps, aucun repli sur un refus, entrées de file d'une autre forme écartées, fichier renommé ou copié et fenêtres retenues jusqu'à la réponse, appairage, compteurs de l'agent et leur envoi, le lien *Signaler un problème* et ses valeurs), le dictionnaire |
| `make lint` | ESLint, le vérificateur de types (Office.js typé par `@types/office-js`), html-validate |
| `make lint-manifest` | la validation Microsoft du manifest, celle d'AppSource (réseau requis) |

**Cet agent n'a pas de `make test-host`, et n'en aura pas.** Office.js ne s'exécute que dans
Word, il n'existe pas de Word sans affichage, et charger `taskpane.html` dans un navigateur
contre un faux Office.js reviendrait à remplacer l'hôte par un double — ce que les tests
unitaires font déjà. Les trois autres agents ont un hôte qu'on peut lancer dans un conteneur ;
celui-ci n'en a pas. **Tout ce qui suit est donc la seule vérification qui existe.**

## À faire à la main

### Avant chaque release

- [ ] **Charger le complément** (`make build`, puis `make serve` et le manifest
      `dist/word-localhost.xml`) dans **Word Desktop** et dans **Word Online** : ce sont deux
      hôtes différents, et `isWordOnline()` les distingue pour de bonnes raisons.
- [ ] **Le volet s'ouvre et parle la bonne langue** : celle du compte Certimens une fois
      appairé, celle de Word avant. Le nom dans le ruban peut rester dans l'autre langue, c'est
      Office qui le traduit depuis le manifest — vérifier que ce n'est pas autre chose.
- [ ] **Le capteur par différences** : taper une phrase, vérifier que le compteur monte ;
      remplacer une sélection ; coller un paragraphe. Word ne livre pas les frappes, tout passe
      par la comparaison du texte, et c'est la partie la plus facile à casser sans le voir.
- [ ] **La restitution de son propre texte** : sélectionner une phrase du document, Ctrl+C,
      cliquer plus bas, Ctrl+V. Le compteur de restitutions monte, celui d'injection ne bouge
      pas. C'est le seul endroit où la chaîne complète s'éprouve — `SelectionChanged`,
      `getSelectedDataAsync`, puis le hachage sur le tour suivant — car les tests appellent le
      capteur directement et n'en voient rien. À refaire dans **Word Online**, et sur une
      sélection qui contient un tableau ou une image : `getSelectedDataAsync` n'en rend que ce
      qu'il sait réduire à du texte.
- [ ] **Le runtime partagé** : fermer le volet et continuer à écrire. La mesure doit continuer —
      c'est toute la raison du `<Runtimes>` du manifest.
- [ ] **La réouverture automatique** : un document lié doit rouvrir le complément tout seul
      (`Office.addin.setStartupBehavior`). Sur un Word trop ancien, l'appel échoue en silence et
      l'étudiant ouvre le volet lui-même : vérifier que rien ne casse.
- [ ] **Le dépôt du .docx** depuis le volet, sur un devoir réel.
- [ ] **Deux documents ouverts en même temps** : une seule file, un seul bail de vidage
      (`RUNTIME_ID`, `LEASE_MS`), deux documents moteur distincts.
- [ ] **Deux sessions, pas une** : avec ces deux documents, écrire dans l'un puis dans l'autre
      et lire les corps envoyés (onglet réseau du volet). Chaque document a son `session`, ses
      `seq` repartent de `0`, et aucune requête ne mêle les deux. Suspendre depuis l'un des
      volets, écrire dans l'autre document, reprendre : les deux repartent sur une session neuve.
- [ ] **Les deux horloges** : `mono` avance d'une fenêtre à l'autre comme `at`, et `ms` est la
      durée lue sur l'horloge monotone. Les tests
      pilotent `performance.now()` ; seul un vrai Word dit ce que son moteur de rendu en fait
      quand le poste se met en veille, volet fermé.
- [ ] **Une file rattrapée** : couper le réseau, écrire assez pour sceller plusieurs fenêtres,
      le rétablir. Elles partent en une requête (`offline` à `true` sur chacune), dans l'ordre.
- [ ] **Un document partagé** (Word Online, un co-auteur qui écrit) : ses frappes ne sont
      toujours pas comptées, et son texte apparaît dans `text.add` de la fenêtre suivante.
- [ ] **Le corps, lu dans l'onglet réseau** : `unseen` vaut `["hesitations"]` sur chaque
      requête ; chaque fenêtre a un `runs` non vide, quatre clés dans `counts`, ni `flight` ni
      `dwell` ; la première fenêtre d'une session a `text` réduit à `len`, les suivantes la
      portée. Réfléchir plus de trois secondes puis reprendre : la fenêtre s'ouvre sur un `gap`.
- [ ] **Un document repris d'un éditeur à l'autre** : écrire dans un `.docx` suivi par le
      complément, l'enregistrer, l'ouvrir dans LibreOffice Writer avec l'extension installée.
      Writer doit poursuivre **le même** document Certimens — sa barre d'info le nomme — et non
      en ouvrir un second. Puis dans l'autre sens, un `.odt` enregistré en `.docx`. C'est le seul
      endroit où les deux agents se rencontrent, et ils ne se rencontrent que dans le fichier :
      `make check` compare les noms des propriétés, rien ne compare ce que les hôtes en font.
- [ ] **Les deux propriétés sont là, et lisibles** : *Fichier ▸ Informations ▸ Propriétés ▸
      Propriétés avancées ▸ Personnalisation* montre `CertimensDocumentId` et
      `CertimensEngineDocument`. La seconde n'apparaît qu'une fois le document Certimens créé.
- [ ] **Une copie ne reprend pas le dossier de l'original** : *Enregistrer sous* un document
      suivi, l'ouvrir, répondre « Une copie » à la question du volet, écrire dans la copie. Elle
      doit recevoir son propre document Certimens, et l'invite de liaison avec.
- [ ] **Un fichier renommé garde son dossier (Word Desktop)** : fermer un document suivi, le
      renommer dans l'Explorateur ou le Finder (`mémoire.docx` → `mémoire_v2.docx`), le rouvrir.
      Le volet doit **se montrer de lui-même** (`Office.addin.showAsTaskpane`, que les tests ne
      voient pas) et poser la question en nommant le dossier Certimens et l'ancien fichier.
      Écrire **avant** de répondre, puis répondre « Le même fichier » : aucune requête ne doit
      être partie avant la réponse (onglet réseau), puis les fenêtres partent vers le document
      d'origine, aucun `POST /api/documents`, et le dossier est renommé « mémoire_v2 ». Fermer,
      rouvrir : plus de question. C'est la partie qui compte le plus — c'est
      `Office.context.document.url` qui dit l'emplacement, et seul un vrai Word dit ce qu'il
      vaut juste après un renommage, et si l'identité réécrite tient à l'enregistrement.
- [ ] **Un fichier déplacé sur SharePoint/OneDrive (Word Online et Desktop)** : déplacer un
      document suivi dans un autre dossier depuis le navigateur, le rouvrir dans les deux hôtes.
      Même question, même parcours ; vérifier que l'adresse ne change pas d'une ouverture à
      l'autre sans déplacement (un paramètre de requête variable ferait poser la question à
      chaque fois).
- [ ] **La question elle-même** : rendu dans le volet étroit (texte long, deux boutons pleine
      largeur), dans les deux langues ; moteur coupé, elle est posée sans le nom du dossier, et
      « Le même fichier » affiche l'erreur et laisse la question. Fermer le document sans
      répondre : rouvert après enregistrement, il est une copie et n'est plus questionné.
- [ ] **La ligne « Certimens a été mis à jour »** : ouvrir le volet (ce qui enregistre le
      build vu), republier le site avec un autre build, rouvrir le volet. La reprise de cache le
      recharge, puis la ligne s'affiche une fois — et une seule, même avec deux documents
      ouverts, qui partagent ce `localStorage`.

- [ ] **La suspension survit au redémarrage de Word**, et elle est globale : les deux documents
      ouverts la voient.
- [ ] **Les compteurs de l'agent** ([docs/complement-word.md](../docs/complement-word.md#ce-que-le-complément-dit-de-lui-même)) :
      `POST /api/plugins/telemetry` part dans l'onglet réseau du volet, au plus tous les quarts
      d'heure **pour tous les documents ouverts ensemble**, avec un corps `{"events":{…}}` —
      plus `"faults":[…]` quand une erreur de nos scripts a été gardée, dont les `frames` sont
      des noms de fichiers nus du volet (`agent.js:1520:15`), jamais une adresse ni un message,
      sur chaque plateforme (pile V8 sous Windows et en ligne, pile Safari sur Mac) — et la
      requête de contrôle CORS (`OPTIONS`) est acceptée par le moteur. Puis
      ce que seul un vrai Word montre : une erreur levée par Office.js lui-même (document fermé
      sous le volet, par exemple) **n'augmente pas** `error.runtime`, alors qu'une exception de
      nos scripts l'augmente — à lire dans `localStorage` (`certimens.telemetry`) depuis les
      outils de développement du volet.

- [ ] **Deux documents ouverts, un seul stockage.** Suspendre dans le volet de l'un : le
      bandeau de l'autre le dit aussitôt (évènement `storage` — rien ne prouve ici qu'il
      traverse deux webviews de Word, sur chaque plateforme). Se déconnecter dans l'un pendant
      qu'on écrit dans l'autre : rien ne reste en file pour le compte suivant.
- [ ] **Reprendre après une suspension** : suspendre, taper une phrase, reprendre, taper un mot.
      La fenêtre suivante porte le mot en `type`, pas la phrase en `paste`.
- [ ] **Un fichier qui nomme son document, ouvert avant de se connecter** (ou réseau coupé) :
      une fois connecté, la première fenêtre rejoint le document nommé — pas de second document,
      et la propriété `CertimensEngineDocument` du fichier n'a pas changé.
- [ ] **Un nom déjà pris** : créer depuis le volet un document du nom d'un document existant —
      le volet le dit, et ne crée rien. Laisser la mesure le créer seule pour un second fichier
      du même nom : il arrive sous `Nom (date heure)`, avec ses fenêtres.
- [ ] **Un fichier nommé avec un `%`** (`Rapport 100% final.docx`, sur le bureau) : le volet
      s'ouvre, le nom est le bon, la mesure part.
- [ ] **Signaler un problème**, dans **Word Desktop** (Windows et Mac) : le lien du bas du volet
      ouvre le formulaire d'aide dans le **navigateur du système** (`openBrowserWindow`), pas
      dans une fenêtre d'Office sans barre d'adresse ; le formulaire est en mode « problème »,
      le bloc affiché à part, `host` nomme Word, sa plateforme et son build, `os` le système.
      Dans **Word Online** : un onglet du même navigateur (`window.open`), et `os` vaut
      `unknown`. Ni le nom ni l'adresse du document dans le bloc.
- [ ] **Un moteur qui ne répond pas** (pare-feu qui avale les paquets) : au bout de trente
      secondes le volet le dit, et le bouton de déconnexion répond encore. `AbortSignal.timeout`
      n'existe pas dans les plus vieilles webviews d'Office : y vérifier que rien ne casse.

### Quand le parcours de l'étudiant change

- [ ] **Les notes aux relecteurs d'AppSource** (`store/appsource/README.md`) rejouées geste par
      geste. Microsoft relit à la main, en quelques jours, et un champ déplacé les périme sans
      qu'aucun test n'échoue.
- [ ] **Le clavier et le lecteur d'écran** dans le volet : il est étroit, et c'est là que les
      pièges d'ordre de tabulation se voient.
- [ ] **CORS** : le moteur doit autoriser l'origine GitHub Pages du complément. Un changement
      d'adresse du site est un changement des deux côtés.

### Deux chantiers connus, qui attendent un vrai Word

- [ ] **Donner au volet son propre domaine.** Le site est servi sur `certimens.github.io`, une
      origine que **tout dépôt Pages du même compte partage** — le chemin `/plugins/word/`
      n'isole rien, et le jeton d'API vit dans le `localStorage` de cette origine. Tant que ce
      compte ne publie qu'un site, le risque est latent ; il devient réel au second. Le
      correctif est un `CNAME`, et il touche trois choses d'un coup : `WORD_BASE_URL`, la
      `SourceLocation` du manifest — donc un nouveau dépôt AppSource — et **la liste des origines
      autorisées côté moteur**, à demander avant de publier.
- [ ] **Poser une CSP sur `taskpane.html`.** C'est la seule des quatre fenêtres des agents qui
      n'en a aucune. Elle n'est pas posée parce qu'elle ne se vérifie nulle part ici — Office.js
      ne s'exécute que dans Word, et cet agent n'a pas de `test-host` : une directive trop
      étroite casserait le volet de tous les étudiants à la fois. À poser et à éprouver dans un
      vrai Word, en même temps : `script-src` doit nommer `https://appsforoffice.microsoft.com`
      et porter l'empreinte du script *inline* de reprise de cache, calculée au build (son
      contenu change à chaque version) ; `style-src` a besoin de `'unsafe-inline'` tant que les
      pages portent des attributs `style` ; `connect-src` doit laisser passer l'adresse d'un
      moteur que l'étudiant peut changer. **Elle ne remplace pas le point ci-dessus** : une CSP
      sur cette page n'empêche pas une autre page de la même origine de lire son `localStorage`.
