# Ce qui reste à vérifier à la main — extension LibreOffice

Ce fichier est à la racine de l'agent : il n'est, par construction, jamais livré dans le `.oxt`.

## Ce qui est déjà tenu par les tests

| Commande | Ce qu'elle voit |
| --- | --- |
| `make test` | les règles de comptage, la fenêtre telle qu'elle part (déroulé et forme de chaque suite, silences, rythme, texte, session et cumuls — et chaque relation que le moteur recoupe, sur des séances jouées), l'envoi au moteur sur un vrai corps HTTP (file, `offline`, ordre des clés à chaque niveau, lots, fenêtre refusée abandonnée, entrée de file d'une autre forme jetée), les compteurs que l'agent tient sur lui-même (comptes, plafond, quart d'heure, remise à zéro sur `204` seulement, corps et en-têtes de l'envoi) et les erreurs qui partent avec eux (frames de l'extension seulement, sous leur nom nu, jamais le message ; dix au plus ; oubliées avec les compteurs), le lien « Signaler un problème » (forme, ordre des clés, `unknown`, plafond, moteur refusé, ce qui n'y est jamais) et le bouton qui l'ouvre (`SystemShellExecute`, `URIS_ONLY`), le dictionnaire — **sans LibreOffice** |
| `make test-host` | un **vrai LibreOffice**, en conteneur : le `.oxt` s'installe, le bureau liste l'extension, il enregistre le composant `fr.certimens.Agent`, celui-ci démarre comme au lancement (`XJob.execute`), la version de LibreOffice que lit « Signaler un problème » se lit dans sa configuration et écrit son état dans le profil, un document déjà identifié se rouvre et **l'agent s'y branche** — il en retient le titre —, **le compte de Writer est bien la longueur du corps du texte** sur des paragraphes simples (ce dont dépend la portée du texte) ; puis, Writer relancé sur un **écran virtuel** (Xvfb) et de **vraies touches et de vrais clics** envoyés par `xdotool`, l'agent appairé à un moteur qui ne répond pas garde ses fenêtres en file, où la suite les lit : **une touche arrive au gestionnaire avant que le curseur bouge**, un déplacement (Ctrl+Fin, puis un clic) qui laisse le curseur à la fin du texte n'est ni un saut ni le début d'une reformulation, `caret_at_end` répond juste sur des paragraphes vides, un tableau, une note et un cadre, Ctrl+A, Ctrl+C puis Ctrl+V est reconnu comme le texte de l'étudiant, et *Enregistrer sous* lève `OnSaveAsDone`, fait suivre les fenêtres en file et le dossier au nouveau fichier — l'ancien, rouvert, reçoit une identité neuve ; enfin l'extension se désinstalle |

Deux limites à connaître :

- **L'écran du conteneur est virtuel, et son clavier aussi.** La seconde moitié de la suite
  lance Writer sous Xvfb et tape avec `xdotool` : c'est le chemin d'un vrai clavier X11 jusqu'au
  `XKeyHandler`, mais **sous X11 seulement**, sans gestionnaire de fenêtres, sur un document de
  deux paragraphes et pour quelques gestes. Wayland, Windows et macOS livrent les touches
  autrement (répétition automatique, AltGr, Cmd), et une vraie séance de rédaction n'a rien à
  voir avec dix touches : la mesure reste à vérifier à la main, première ligne ci-dessous.
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
- [ ] **« Signaler un problème »**, depuis la fenêtre de connexion puis depuis celle du
      document : le bouton est sous la ligne de message, son aide au survol s'affiche, et le
      **navigateur du système** s'ouvre sur le formulaire d'aide de l'espace Certimens, **en
      mode « problème »**, le bloc affiché à part avec ses onze lignes (`host: LibreOffice
      7.x.y.z`, jamais de jeton, d'e-mail ni de nom de document). Le refaire après une erreur
      (moteur injoignable) : le bouton est juste sous le message. `make test` vérifie le lien
      et l'appel à `SystemShellExecute` sur des doublures, `make test-host` la lecture de la
      version ; que le navigateur s'ouvre, et sur la bonne page, aucun test ne le voit.
      **Sous macOS et Windows aussi** : `SystemShellExecute` y passe par le système, et un
      fragment encodé (`%0A`, `%3A`) doit arriver intact au navigateur.
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
- [ ] ***Enregistrer sous* par la boîte de dialogue** : ouvrir `A.odt` suivi, *Fichier ›
      Enregistrer sous* `B.odt`, écrire. Les fenêtres vont au **même** dossier, renommé « B » ;
      fermer, rouvrir `B.odt` : toujours le même dossier, sans barre d'info. Rouvrir `A.odt`
      (laissé derrière) : un document neuf, et la barre d'info de liaison. `make test-host` le
      fait par `storeAsURL`, pas par la boîte de dialogue ; refaire aussi avec un enregistrement
      au format `.docx` (la boîte demande de confirmer le format).
- [ ] ***Enregistrer une copie*** : la copie, rouverte, reçoit son propre document Certimens ;
      le document ouvert garde le sien.
- [ ] **La fin du texte, au vrai clavier et à la vraie souris** : écrire trois paragraphes,
      remonter au milieu (clic), revenir à la fin par Ctrl+Fin puis par un clic sous le texte,
      continuer d'écrire. La fenêtre partie (mode debug) ne compte qu'**un** saut (le clic au
      milieu) et aucune reformulation pour ce qui suit le retour à la fin. Refaire en finissant
      dans un tableau, une note de bas de page et un cadre : là, le retour compte (le curseur
      n'est pas dans le corps du texte). Puis Maj+Haut depuis la fin : compté.
- [ ] **Une copie massive ne fige pas Writer** : Ctrl+A puis Ctrl+C sur un mémoire de deux cent
      mille caractères, sur un poste modeste. La frappe reprend aussitôt (les empreintes sont
      calculées sur un autre fil), et un Ctrl+V immédiat est bien une restitution (`self`), pas
      un collage. Seule la lecture de la sélection reste sur le fil de l'interface, et son coût
      côté LibreOffice n'a pas été mesuré.
- [ ] **Les compteurs de l'agent, contre un vrai moteur** : un démarrage puis un appairage
      doivent faire partir, dans le quart d'heure, un `POST /api/plugins/telemetry` que le
      moteur accepte (`204`) avec `installed` ou `updated` et `started`. La doublure des tests
      répond ce qu'on lui dit ; seul le moteur dit si la route existe et si le corps lui
      convient. Puis débrancher le réseau, écrire une minute, rebrancher : `network.failure`
      doit arriver au rapport suivant. Enfin une exception levée dans un écouteur de l'extension
      installée : son `fonction@fichier.py:ligne` doit arriver dans `faults`, sans le chemin du
      profil — les tests le vérifient depuis un checkout, pas depuis un `.oxt` déployé.
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

- [ ] **Les lettres accentuées en roulé** : taper vite « déçu », « élève », « où ça » sur un
      clavier français. Autant de frappes que de touches — ces lettres arrivent sans code de
      touche, et deux d'entre elles enchaînées passaient pour une touche maintenue.
- [ ] **Maj+Inser sur une sélection** : une révision, comme Ctrl+V — pas deux.
- [ ] **Se déconnecter en pleine phrase** : la fenêtre en cours part avant la révocation (elle
      est côté moteur), et rien n'attend dans `certimens.json` pour le compte suivant.
- [ ] **Un fichier qui nomme son document, ouvert avant de se connecter** : une fois connecté,
      la première fenêtre rejoint le document nommé, et la barre d'information le dit.
- [ ] **Un nom déjà pris**, par les deux chemins : depuis la fenêtre Certimens (c'est dit, rien
      n'est créé) et par la mesure seule (le document arrive sous `Nom (date heure)`).
- [ ] **HTTPS sur macOS et Windows** : appairer contre le moteur de production. Le Python
      embarqué par LibreOffice n'y trouve pas toujours un magasin de certificats, et chaque
      appel serait alors compté en `network.failure` sans autre signe.

### Hors Linux

- [ ] **macOS et Windows** : le `.oxt` est le même, le Python embarqué par LibreOffice ne l'est
      pas, et les chemins du profil non plus.

### Au dépôt

- [ ] **extensions.libreoffice.org** se remplit à la main — le site n'a pas d'API. La licence
      s'y choisit dans une liste, et la fiche (`store/`) doit dire la même chose que le code sur
      ce qui est collecté.
