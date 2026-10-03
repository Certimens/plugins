# Ce qui reste à vérifier à la main — extension navigateur

Ce fichier est à la racine de l'agent : il n'est, par construction, jamais livré dans un paquet.

## Ce qui est déjà tenu par les tests

| Commande | Ce qu'elle voit |
| --- | --- |
| `make test` | les règles de comptage du capteur, le service worker (file, `offline`, ordre des clés du corps de mesure, refus du moteur, appairage), le dictionnaire, les contrastes du thème |
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
| un événement portant le texte, avec un `inputType` qui distingue la complétion de la frappe | la route est ouverte : une entrée de plus dans `EDITORS`, comme `volume`, et une mesure à ajouter — **le contrat d'abord, côté moteur** ([moteur.md](../docs/moteur.md#ajouter-ou-changer-une-mesure)) |
| un événement, mais sans le texte ni sa taille (`data` vide) | on saurait qu'il s'est passé quelque chose, pas combien — et un compteur de gestes sans volume est exactement ce que VS Code refuse d'envoyer : on s'en tient à l'écart assumé |
| rien du tout — l'éditeur écrit dans son DOM | la route est fermée pour cet éditeur, et il ne reste que le résidu de volume, que l'âge des lectures interdit |

Tant que les trois éditeurs ne sont pas renseignés, **rien n'est réservé dans le corps** : le
vocabulaire du corps de mesure est fermé, et un genre de suite ou une clé que le moteur ne
connaît pas lui ferait refuser la fenêtre entière. On nommera ce que le capteur sait (des
caractères entrés sans geste compté), jamais ce qu'on devine du geste.

**La correction orthographique est une question voisine, et sa réponse est déjà écrite.** Une
suggestion de correcteur acceptée ne pose pas du texte que personne n'a écrit : elle **remplace**
un mot que l'étudiant a tapé, donc c'est un remaniement et non un volume à attribuer — un
`counts.corrections`, aucune frappe, et pas de saut de navigation pour le clic de menu (voir
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

## Les gestes qui produisent chaque mesure

De quoi faire bouger chaque partie d'une fenêtre, une par une, sur **Google Docs dans Chrome** —
l'éditeur où tout est mesurable, le seul des trois à compter une sortie quand on passe à une
autre application (`blurMeansLeaving`). Charger `dist/chrome` dépaqueté (`chrome://extensions`,
mode développeur), appairer, puis cocher **debug** dans la page d'options : chaque fenêtre
envoyée y tient une ligne, `heure · raison · chiffres non nuls`. Le journal relit la fenêtre
comme le moteur la lira (frappes, collages et restitutions y sont comptés **depuis le déroulé**) ;
les silences, eux, ne s'y lisent pas — ils se voient dans la file (`chrome.storage.local`, clé
`queue`, champ `window.runs`) ou dans la requête, onglet Réseau du *service worker*.

**La fenêtre se ferme après 2 secondes sans activité** (`IDLE_FLUSH_MS`), ou au bout de 200
frappes. Chaque geste se fait donc d'un trait, puis on attend deux secondes et on lit la ligne.
C'est la première cause d'un chiffre qu'on croit muet.

| Dans la fenêtre | Le geste | Ce qui fait rater le test |
| --- | --- | --- |
| suites `type`, `erase`, `nav`, `other` (« frappes ») | Taper. | Maj/Ctrl/Alt seules, touches mortes et répétition automatique ne comptent pas. **La touche qui colle non plus** (Ctrl/Cmd+V, Maj+Inser) : un collage est pesé là où il est posé — une frappe `other` pour une restitution, aucune pour une injection. |
| `active` | Vient seul dès deux frappes à moins de 2 s d'écart. | — |
| `counts.corrections` | Taper, puis Retour arrière **sans bouger le curseur**. Ou Ctrl+Z (qui ajoute une suite `undo`). | Ctrl+**Maj**+Z est un *refaire* : il ne compte rien. |
| `counts.reformulations` | **←** (sans Maj) puis Retour arrière, ou cliquer dans le texte puis Retour arrière. Ou Ctrl+Retour arrière. Ou six Retour arrière d'affilée — martelés ou maintenus. Ou deux flèches puis une lettre. | Une seule flèche puis une lettre n'en est pas une : un pas est un effleurement. |
| `counts.revisions` | Ctrl+A puis taper. Ou Ctrl+X sur une sélection. Ou tracer une sélection à la souris puis taper. | Un clic simple n'en donne plus : c'est une reformulation. |
| `counts.jumps` (et une suite `click` par série de clics) | Flèches, Début/Fin, Page préc./suiv., clics dans le texte. | Un clic dans les menus ou la barre d'outils ne compte pas : le document, c'est `.kix-appview-editor`. |
| suite `["gap", ms]` | Taper, attendre **au moins 1 s**, retaper. | Le silence s'écrit à la **frappe** qui reprend, à sa durée réelle : après 2 s la fenêtre précédente est partie, et il est alors la **première suite** de la suivante. Un clic ou un collage ne le termine pas et ne le relance pas. Le capteur ne le classe pas : c'est le moteur qui y lit une hésitation (1 à 3 s) ou une pause (au-delà, jusqu'à 5 min). La première fenêtre d'une session n'en porte jamais en tête. |
| `flight` (`med`, `mad`, `bins`) | Taper une dizaine de caractères au rythme normal. | Il faut **au moins deux** écarts de moins de 800 ms dans la même fenêtre, sinon le bloc est absent. |
| `dwell` (`bins`, `rollover`) | Le même geste. | Toujours envoyé, vide (`[]`) si aucune touche `type` n'a été relâchée dans la fenêtre. |
| suite `["paste", n]` (« collages ») | Coller du texte venu d'ailleurs, quelle que soit sa taille. Une suite par collage. | Du texte venu du document est une restitution, pas un collage. Le moteur ne compte en caractères injectés que les collages de **plus de 15 caractères** ; `sum.chars` suit la même règle. |
| `counts.back_chars` | Alt+Tab, revenir, coller plus de 15 caractères **dans les 15 s**. | Ne se déclenche que si la sortie a été comptée (ligne suivante). |
| `counts.exits` | Alt+Tab, ou changer d'onglet. | Partir après 2 s d'inactivité trouve une fenêtre vide : le chiffre est **reporté** et n'apparaît qu'après avoir retapé en revenant. |
| `counts.back_keys` | Alt+Tab, revenir, **taper** dans les 15 s. | Mêmes conditions que `counts.back_chars` : sans sortie comptée, pas de retour. Les suppressions et Ctrl+Z en font partie, la frappe d'une restitution non. Absent du journal : à lire dans la file. |
| suites `["other", 1, 0]` puis `["self", n]` (« restitutions ») | Sélectionner un passage du document, Ctrl+C, recoller. | Un texte **modifié entre-temps** (passé à un correcteur) n'est reconnu que si 70 % de ses empreintes tiennent. `n` compte les caractères du texte **revenu**, pas ceux qui étaient sortis. |
| suite `["copy", n]` | Ctrl+C ou Ctrl+X sur une sélection du document. | `0` si le geste est vu sans que la sélection soit lisible. |
| `text` | Vient seul. | Lu au plus **une fois par 30 s** sur Google Docs, par export en tâche de fond : il faut être connecté à Google, et un échec se voit dans la console (`text export failed`). La première lecture d'une session et les fenêtres servies par le cache n'ont que `len` ; la portée (`since`, `at`, `cut`, `add`, `kept`) vient à chaque nouvel export. |
| `sum` | Vient seul. | Cumule depuis le début de la session : il repart de zéro après une suspension ou un nouvel appairage, avec `seq`. |

Google Docs reçoit les frappes dans une iframe dédiée, à laquelle le capteur s'accroche au
chargement : un document ouvert **avant** l'extension ne compte rien tant que la page n'est pas
rechargée.

Un couper-coller interne compte **deux révisions massives** — celle du Ctrl+X, puis celle du
collage reconnu. C'est voulu : le bloc a été retiré, puis reposé, et la suite de tests du
complément Word épingle ces deux-là. Ce n'est donc pas un chiffre à corriger en le voyant.
