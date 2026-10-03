# Ce qui reste à vérifier à la main — extension navigateur

Ce fichier est à la racine de l'agent : il n'est, par construction, jamais livré dans un paquet.

## Ce qui est déjà tenu par les tests

| Commande | Ce qu'elle voit |
| --- | --- |
| `make test` | les règles de comptage du capteur, le service worker (file, `offline`, ordre des clés, générations de metrics, appairage), le dictionnaire, les contrastes du thème |
| `make test-host` | un **vrai Chromium** : le manifest accepté, le service worker démarré, la popup et la page d'options affichées sans erreur, le capteur injecté dans une page que le manifest nomme, et des frappes réelles qui arrivent jusqu'à la file |

`make test-host` sert une page **à nous** à l'adresse d'Overleaf : ce qu'il éprouve, c'est la
règle du manifest et le capteur, pas le DOM d'Overleaf. D'où la première ligne ci-dessous.

## À faire à la main

### Avant chaque release

- [ ] **Le DOM des trois éditeurs**, dans un vrai document, un par un : Google Docs, Word Online,
      Overleaf. C'est la **première cause de panne réelle** — ces trois pages changent leur
      structure sans prévenir, et aucun test ne peut le voir sans compte ni sans dépendre de
      leurs sélecteurs. Taper quelques phrases et vérifier dans la page d'options (mode debug)
      que les compteurs montent. Un éditeur muet se reconnaît à un journal vide — et, depuis
      qu'il y a une vérification au chargement, à un avertissement dans la console de la page
      disant quelle zone d'édition est introuvable. Le geste qui produit chaque compteur est en
      fin de fichier.
- [ ] **L'appairage complet** avec un vrai compte : demander le code, le confirmer dans l'espace
      Certimens, revenir sur la popup. Aucun mot de passe ne doit être demandé nulle part.
- [ ] **Le dépôt de la copie**, une fois par mode : export sur Google Docs (la permission
      `googleusercontent.com` est demandée **au clic**, pas avant), fichier choisi sur Word
      Online et Overleaf, texte de la page sur un site ajouté.
- [ ] **Firefox**, qui n'est pas Chromium : charger `dist/firefox.zip` (`about:debugging`),
      vérifier que `background.scripts` démarre et que la permission d'hôte du moteur est bien
      **demandée** — Firefox n'accorde pas les `host_permissions` de MV3 tout seul.
- [ ] **La ligne « Certimens a été mis à jour »** : installer une version, ouvrir la popup
      (ce qui enregistre la version vue), charger une version différente, rouvrir. La ligne
      apparaît une fois, dans la première des deux fenêtres ouvertes, et le lien s'ouvre dans un
      onglet. Une **première** installation ne doit rien afficher du tout.

- [ ] **La mesure suspendue survit au redémarrage du navigateur** : suspendre, fermer, rouvrir,
      le badge doit toujours afficher `II`.

### Quand le parcours de l'étudiant change

- [ ] **Un site ajouté par l'étudiant**, sur un vrai Moodle : *Mesurer cette page* depuis la
      popup, la permission demandée pour cette origine seule, la mesure qui démarre **sans
      recharger**, le retrait depuis la page d'options.
- [ ] **Les notes aux relecteurs** de chaque boutique (`store/<boutique>/README.md`) rejouées
      geste par geste : ce sont elles que la boutique suivra, et un champ déplacé les périme
      sans qu'aucun test n'échoue.
- [ ] **Le clavier et le lecteur d'écran** sur la popup et la page d'options : tout atteignable
      au clavier, focus visible, messages d'erreur annoncés.
- [ ] **Le thème sombre**, à l'œil. Les contrastes sont mesurés par `tests/theme.test.mjs` ; ce
      qu'il ne mesure pas, c'est qu'une icône reste lisible sur son fond.

### Hors Linux

- [ ] **Safari** : `make safari` sur macOS, puis Xcode, macOS **et** iOS. Rien de tout cela ne
      tourne ailleurs, et la publication est manuelle.
- [ ] **Edge et Opera** : `dist/chrome.zip` chargé dépaqueté, une fois. Le paquet est le même
      que celui de Chrome, mais leurs boutiques relisent séparément.

## Les gestes qui produisent chaque metric

De quoi faire monter les seize compteurs un par un, sur **Google Docs dans Chrome** — l'éditeur
où tout est mesurable, le seul des trois à compter une sortie quand on passe à une autre
application (`blurMeansLeaving`). Charger `dist/chrome` dépaqueté (`chrome://extensions`, mode
développeur), appairer, puis cocher **debug** dans la page d'options : chaque fenêtre envoyée y
tient une ligne, `heure · raison · compteurs non nuls`.

**La fenêtre se ferme après 2 secondes sans activité** (`IDLE_FLUSH_MS`), ou au bout de 200
frappes. Chaque geste se fait donc d'un trait, puis on attend deux secondes et on lit la ligne.
C'est la première cause d'un compteur qu'on croit muet.

| Metric | Le geste | Ce qui fait rater le test |
| --- | --- | --- |
| `keystrokes_total` | Taper. | Maj/Ctrl/Alt seules, touches mortes et répétition automatique ne comptent pas. |
| `effective_time_ms` | Vient seul dès deux frappes à moins de 2 s d'écart. | — |
| `immediate_corrections` | Taper, puis Retour arrière **sans bouger le curseur**. Ou Ctrl+Z. | Ctrl+**Maj**+Z est un *refaire* : il ne compte rien. |
| `deferred_reformulations` | **←** (sans Maj) puis Retour arrière. Ou Maj+← trois fois puis Retour arrière. | Cliquer au lieu d'utiliser les flèches donne une révision massive. Seule la **première** suppression après le déplacement compte. |
| `macro_revisions` | Cliquer dans le texte puis Retour arrière. Ou Ctrl+A puis taper. Ou Ctrl+X sur une sélection. | — |
| `navigation_jumps` | Flèches, Début/Fin, Page préc./suiv., clics dans le texte. | Un clic dans les menus ou la barre d'outils ne compte pas : le document, c'est `.kix-appview-editor`. |
| `cognitive_pauses` | Taper, attendre **entre 3 s et 5 min**, retaper. | La pause tombe dans la fenêtre **suivante** : la précédente est partie à 2 s. |
| `flight_median_ms` | Taper une dizaine de caractères au rythme normal. | Il faut **au moins deux** écarts de moins de 800 ms dans la même fenêtre, sinon rien n'est envoyé. |
| `flight_mad_ms` | Le même geste : les deux partent ensemble. | — |
| `paste_events` | Coller du texte venu d'ailleurs, quelle que soit sa taille. | Du texte venu du document est une restitution, pas un collage. |
| `injected_chars_total` | Le même geste avec **plus de 15 caractères**. | En dessous de 16, seul `paste_events` bouge. |
| `injected_chars_max` | Coller deux textes de tailles différentes dans la même fenêtre. | Il garde le plus gros, pas le dernier. |
| `injected_chars_after_return` | Alt+Tab, revenir, coller plus de 15 caractères **dans les 15 s**. | Ne se déclenche que si la sortie a été comptée (ligne suivante). |
| `focus_losses` | Alt+Tab, ou changer d'onglet. | Partir après 2 s d'inactivité trouve une fenêtre vide : le compteur est **reporté** et n'apparaît qu'après avoir retapé en revenant. |
| `self_paste_events` | Sélectionner un passage du document, Ctrl+C, recoller. | Un texte **modifié entre-temps** (passé à un correcteur) n'est reconnu que si 70 % de ses empreintes tiennent : sur une phrase courte, deux mots corrigés suffisent à le perdre. |
| `real_volume_chars` | Vient seul. | Lu au plus **une fois par 30 s** sur Google Docs, par export en tâche de fond : il faut être connecté à Google, et un échec se voit dans la console (`text export failed`). |

Google Docs reçoit les frappes dans une iframe dédiée, à laquelle le capteur s'accroche au
chargement : un document ouvert **avant** l'extension ne compte rien tant que la page n'est pas
rechargée.

Un couper-coller interne compte **deux révisions massives** — celle du Ctrl+X, puis celle du
collage reconnu. C'est voulu : le bloc a été retiré, puis reposé, et la suite de tests du
complément Word épingle ces deux-là. Ce n'est donc pas un chiffre à corriger en le voyant.
