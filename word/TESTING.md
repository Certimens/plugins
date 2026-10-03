# Ce qui reste à vérifier à la main — complément Word

Ce fichier est à la racine de l'agent : il n'est, par construction, jamais livré dans un paquet.

## Ce qui est déjà tenu par les tests

| Commande | Ce qu'elle voit |
| --- | --- |
| `make test` | le capteur par différences de texte, l'envoi au moteur (file, `offline`, ordre des clés, générations de metrics, appairage), le dictionnaire |
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
- [ ] **La ligne « Certimens a été mis à jour »** : ouvrir le volet (ce qui enregistre le
      build vu), republier le site avec un autre build, rouvrir le volet. La reprise de cache le
      recharge, puis la ligne s'affiche une fois — et une seule, même avec deux documents
      ouverts, qui partagent ce `localStorage`.

- [ ] **La suspension survit au redémarrage de Word**, et elle est globale : les deux documents
      ouverts la voient.

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
