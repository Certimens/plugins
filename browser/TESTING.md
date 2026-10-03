# Ce qui reste à vérifier à la main — extension navigateur

Ce fichier est à la racine de l'agent : il n'est, par construction, jamais livré dans un paquet.

## Ce qui est déjà tenu par les tests

| Commande | Ce qu'elle voit |
| --- | --- |
| `make test` | les règles de comptage du capteur, le service worker (file, `offline`, ordre des clés, générations de metrics, appairage), le dictionnaire, les contrastes du thème |
| `make test-host` | un **vrai Chromium** : le manifest accepté, le service worker démarré, la popup et la page d'options affichées sans erreur, le capteur injecté dans une page que le manifest nomme, des frappes réelles qui arrivent jusqu'à la file, et la sonde d'insertion qui entend un bloc qu'aucune touche n'a tapé |

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

### L'enquête en cours : ce qu'une complétion acceptée annonce

Les deux éditeurs qui restent sont suivis par
[Certimens/plugins#16](https://github.com/Certimens/plugins/issues/16).

Le capteur compte des touches et des collages ; les caractères qu'une suggestion acceptée pose ne
sont donc comptés nulle part (`docs/mesures.md`, *Écarts assumés*). Avant de leur donner une
metric, il faut savoir ce que chaque éditeur en dit — et cela ne se sait qu'en le faisant, sur un
vrai document. La sonde est dans `src/content.js` (*THE INSERTION PROBE*) : elle ne mesure rien,
ne compte rien, et ne parle qu'en mode debug.

La plomberie, elle, est déjà éprouvée : `make test-host` vérifie dans un vrai Chromium qu'un bloc
inséré sans touche derrière lui produit bien sa ligne. Un éditeur muet est donc muet pour son
propre compte, et c'est un résultat, pas une panne de la sonde.

| Éditeur | Ce qu'on entend | Conclusion |
| --- | --- | --- |
| **Google Docs** | des `keydown` dans `iframe.docs-texteventtarget-iframe`, qui a bien le focus — et **jamais** d'`beforeinput` ni d'`input` ; une correction validée au clic n'émet rien du tout (20 octobre 2026) | **route fermée.** Docs annule la frappe et écrit dans son propre modèle. L'agent n'a rien à ajouter pour cet éditeur : l'écart entre le volume et les frappes reste ce que le moteur en lit |
| **Word Online** | — | à faire |
| **Overleaf** | — | à faire |

Le résultat de Docs a été obtenu en écoutant **hors de l'extension**, dans la console de la page :
`keydown`, `beforeinput` et `input` posés en capture sur le document du haut et sur chaque iframe
de même origine. C'est ce qui sépare « l'éditeur est muet » de « on écoute au mauvais endroit », et
c'est le geste à refaire pour les deux autres.

- [ ] Charger `dist/chrome` dépaqueté, cocher **debug** dans la page d'options, ouvrir la console
      de la page de l'éditeur.
- [ ] Dans chacun des trois éditeurs : taper une demi-phrase, laisser la suggestion s'afficher,
      **l'accepter** au clavier. Puis relire les lignes `input probe:`.
- [ ] Noter, pour chaque éditeur : quel événement arrive (`beforeinput`, `input`, les deux,
      aucun), quel `inputType`, combien de caractères d'un coup, et le délai depuis la dernière
      frappe — c'est lui qui sépare un caractère tapé d'un bloc arrivé seul.

Taper normalement produit déjà une ligne par caractère : ce qu'on cherche est la ligne qui en
porte **plusieurs d'un coup**. Une touche d'acceptation est une frappe comme une autre pour le
capteur, donc le délai y sera court ; c'est le nombre de caractères qui trahit le geste.

| Ce que la sonde montre | Ce qu'on en fait |
| --- | --- |
| un événement portant le texte, avec un `inputType` qui distingue la complétion de la frappe | la route est ouverte : une entrée de plus dans `EDITORS`, comme `volume`, et une metric à ajouter — **génération nouvelle, moteur d'abord** |
| un événement, mais sans le texte ni sa taille (`data` vide) | on saurait qu'il s'est passé quelque chose, pas combien — et un compteur de gestes sans volume est exactement ce que VS Code refuse d'envoyer : on s'en tient à l'écart assumé |
| rien du tout — l'éditeur écrit dans son DOM | la route est fermée pour cet éditeur, et il ne reste que le résidu de volume, que l'âge des lectures interdit |

Nom candidat, si metric il y a : `unattributed_chars_total` — on nomme ce que le capteur sait
(des caractères entrés sans geste compté), jamais ce qu'on devine du geste. Tant que les trois
éditeurs ne sont pas renseignés, **aucun nom n'est réservé** : une metric documentée qui n'est
dans aucune génération est refusée par `make check`, et à raison — elle partirait jusqu'au premier
moteur qui ne la connaît pas, et il refuserait la fenêtre entière.

**La correction orthographique est une question voisine, et sa réponse est déjà écrite.** Une
suggestion de correcteur acceptée ne pose pas du texte que personne n'a écrit : elle **remplace**
un mot que l'étudiant a tapé, donc c'est un remaniement et non un volume à attribuer — un
`immediate_corrections`, aucune frappe, et pas de saut de navigation pour le clic de menu (voir
`docs/mesures.md`, *Règles de comptage*). La sonde la croise de toute façon, puisqu'elle écoute
les mêmes événements : si un éditeur annonce un remplacement — `insertReplacementText` est le
`inputType` que la spécification prévoit pour celui-là — la route est ouverte **sans qu'aucune
metric nouvelle soit nécessaire**, et c'est donc le cas le moins cher des deux à livrer. Noter
l'`inputType` suffit à les séparer.

Et une fois les trois lignes remplies, la sonde a fait son travail : elle devient une entrée
d'`EDITORS` à côté de `volume`, ou elle disparaît. Elle n'a pas vocation à rester livrée.

### Le menu du correcteur, à lire une fois par éditeur

Une orthographe choisie dans le correcteur est une **correction immédiate**, et le clic qui la
choisit n'est pas un saut de navigation (`docs/mesures.md`, *Règles de comptage*). Encore
faut-il reconnaître ce menu : c'est `correctionMenu`, dans l'entrée `EDITORS` de chaque éditeur,
et il vaut `null` tant que personne n'a lu le DOM — un sélecteur non vérifié ne compterait rien,
en silence, ce qui est exactement la panne que ce fichier existe pour éviter.

- [ ] **Google Docs**, **Word Online**, **Overleaf** : dans la console de la page, coller le
      relevé ci-dessous, faire un clic droit sur un mot souligné, puis cliquer une suggestion.
      La deuxième ligne imprimée nomme le menu ; en extraire le sélecteur le plus stable (une
      classe du conteneur, pas un identifiant engendré) et le poser dans `correctionMenu`.

```js
document.addEventListener('mousedown', (e) => {
    const chain = [];
    for (let n = e.target; n && n !== document.documentElement; n = n.parentElement) {
        const classes = String(n.className || '').trim();
        chain.push(n.tagName.toLowerCase() + (classes ? '.' + classes.split(/\s+/).join('.') : ''));
    }
    console.log(chain.join('  <  '));
}, true);
```

Une fois posé, le vérifier dans le journal du mode debug : choisir une suggestion doit imprimer
`spelling chosen in the corrector → immediate correction`, et **plus** `click in the document →
navigation jump`.

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
| `keystrokes_total` | Taper. | Maj/Ctrl/Alt seules, touches mortes et répétition automatique ne comptent pas. **La touche qui colle non plus** (Ctrl/Cmd+V, Maj+Inser) : un collage est pesé là où il est lu, une frappe pour une restitution et aucune pour une injection. |
| `effective_time_ms` | Vient seul dès deux frappes à moins de 2 s d'écart. | — |
| `immediate_corrections` | Taper, puis Retour arrière **sans bouger le curseur**. Ou Ctrl+Z. | Ctrl+**Maj**+Z est un *refaire* : il ne compte rien. |
| `deferred_reformulations` | **←** (sans Maj) puis Retour arrière. Ou Maj+← trois fois puis Retour arrière. | Cliquer au lieu d'utiliser les flèches donne une révision massive. Seule la **première** suppression après le déplacement compte. |
| `macro_revisions` | Cliquer dans le texte puis Retour arrière. Ou Ctrl+A puis taper. Ou Ctrl+X sur une sélection. | — |
| `navigation_jumps` | Flèches, Début/Fin, Page préc./suiv., clics dans le texte. | Un clic dans les menus ou la barre d'outils ne compte pas : le document, c'est `.kix-appview-editor`. |
| `cognitive_pauses` | Taper, attendre **entre 3 s et 5 min**, retaper. | La pause tombe dans la fenêtre **suivante** : la précédente est partie à 2 s. |
| `lexical_hesitations` | Taper, attendre **entre 1 s et 3 s**, retaper. | La borne haute est partagée avec la pause cognitive : à 3 s pile c'est une hésitation, au-delà c'est une pause. En dessous de 800 ms, c'est un flight time. |
| `flight_median_ms` | Taper une dizaine de caractères au rythme normal. | Il faut **au moins deux** écarts de moins de 800 ms dans la même fenêtre, sinon rien n'est envoyé. |
| `flight_mad_ms` | Le même geste : les deux partent ensemble. | — |
| `paste_events` | Coller du texte venu d'ailleurs, quelle que soit sa taille. | Du texte venu du document est une restitution, pas un collage. |
| `injected_chars_total` | Le même geste avec **plus de 15 caractères**. | En dessous de 16, seul `paste_events` bouge. |
| `injected_chars_max` | Coller deux textes de tailles différentes dans la même fenêtre. | Il garde le plus gros, pas le dernier. |
| `injected_chars_after_return` | Alt+Tab, revenir, coller plus de 15 caractères **dans les 15 s**. | Ne se déclenche que si la sortie a été comptée (ligne suivante). |
| `focus_losses` | Alt+Tab, ou changer d'onglet. | Partir après 2 s d'inactivité trouve une fenêtre vide : le compteur est **reporté** et n'apparaît qu'après avoir retapé en revenant. |
| `keystrokes_after_return` | Alt+Tab, revenir, **taper** dans les 15 s. | Mêmes conditions que la ligne `injected_chars_after_return` : sans sortie comptée, pas de retour. Les suppressions et Ctrl+Z en font partie, ce sont des frappes. |
| `self_paste_events` | Sélectionner un passage du document, Ctrl+C, recoller. | Un texte **modifié entre-temps** (passé à un correcteur) n'est reconnu que si 70 % de ses empreintes tiennent : sur une phrase courte, deux mots corrigés suffisent à le perdre. |
| `self_paste_chars_total` | Le même geste : les deux partent ensemble. | Compte les caractères du texte **revenu**, pas ceux qui étaient sortis. |
| `real_volume_chars` | Vient seul. | Lu au plus **une fois par 30 s** sur Google Docs, par export en tâche de fond : il faut être connecté à Google, et un échec se voit dans la console (`text export failed`). |

Google Docs reçoit les frappes dans une iframe dédiée, à laquelle le capteur s'accroche au
chargement : un document ouvert **avant** l'extension ne compte rien tant que la page n'est pas
rechargée.

Un couper-coller interne compte **deux révisions massives** — celle du Ctrl+X, puis celle du
collage reconnu. C'est voulu : le bloc a été retiré, puis reposé, et la suite de tests du
complément Word épingle ces deux-là. Ce n'est donc pas un chiffre à corriger en le voyant.
