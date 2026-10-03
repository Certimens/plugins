---
name: mesures-redaction
description: Définitions partagées des mesures de rédaction (fenêtres, déroulé des gestes, ce qui part vers le moteur) implémentées quatre fois — extension navigateur, complément Word, extension LibreOffice, extension VS Code. À charger avant toute modification d'un capteur, d'une constante de mesure, d'une règle de comptage ou du corps envoyé au moteur, et avant d'expliquer ce que compte un agent.
---

# Mesures de rédaction

Une seule définition, quatre implémentations indépendantes :

| Implémentation | Fenêtres de mesure | Capteur |
| --- | --- | --- |
| Extension navigateur | `browser/src/content.js` | le même fichier (clavier/souris) |
| Complément Word | `word/src/sensor.js` | le même fichier (différences de texte) |
| Extension LibreOffice | `libreoffice/src/pythonpath/certimens_agent/measure.py` | `sensor.py` (UNO) |
| Extension VS Code | `vscode/src/sensor.js` | le même fichier (modifications du document) |

**Une règle changée dans l'une doit l'être dans les trois autres**, ou être justifiée par une
limite de la plateforme (voir *Écarts assumés*). Les tables de `docs/mesures.md`
(*Le déroulé*, *Ce que seul le capteur sait classer*) sont la référence lisible : elles se
mettent à jour dans le même commit.

## Constantes communes

Identiques dans les quatre fichiers, à ne pas désynchroniser :

Les trois premières implémentations comptent une frappe par touche ou par caractère ; VS Code,
lui, ajoute une constante qui n'a de sens que chez lui, `SELECTION_ECHO_MS` (50 ms) : l'éditeur
signale un déplacement du curseur après chaque frappe, et sans ce délai `counts.jumps`
suivrait exactement le nombre de frappes.

| Constante | Valeur | Ce qu'elle borne |
| --- | --- | --- |
| `FLUSH_KEYSTROKES` | 200 | la fenêtre est scellée au bout de 200 frappes |
| `IDLE_FLUSH_MS` / `IDLE_FLUSH_S` | 2 s | la fenêtre est scellée après 2 s sans activité |
| `GAP_MIN_MS` | 1 s | le plus court silence entre deux frappes comptées qui s'écrit en `gap` |
| `ACTIVE_GAP_MAX_S` | 60 s | ce qu'un trou ajoute au temps effectif |
| `INJECTION_MIN_CHARS` | 15 | en deçà, un collage n'est pas une injection (pour `sum.chars` et `counts.back_chars`) |
| `FLIGHT_MAX_MS` | 800 | au-delà, l'écart entre deux frappes n'est pas un flight time |
| `SHINGLE_WORDS` | 4 | la taille d'une empreinte : quatre mots consécutifs |
| `SELF_PASTE_RATIO` | 0,7 | recoupement au-delà duquel un collage est le texte de l'étudiant |
| `SELF_PASTE_TTL_MS` / `SELF_PASTE_TTL_S` | 3600 s | délai sans servir au bout duquel une sortie n'est plus comparable |
| `SELF_PASTE_MAX_COPIES` | 20 | nombre de sorties retenues : la mémoire est bornée |
| `ERASE_RUN_REFORMULATES` | 6 | à partir de là, une rafale de suppression d'un seul tenant n'est plus une coquille |
| `NAV_STEPS_AWAY` | 2 | nombre de pas à partir duquel on est reparti dans le texte : une flèche vaut un pas, un saut en vaut deux |
| `RETURN_WINDOW_MS` / `RETURN_WINDOW_S` | 15 s | après un retour au document, délai pendant lequel ce qui est collé vient d'ailleurs |
| `TIMELINE_MAX_RUNS` | 512 | le nombre de suites qu'un déroulé peut porter : la fenêtre est scellée avant |
| `SESSION_ID_BYTES` | 16 | les octets tirés au hasard derrière un identifiant de session |

Quatre autres ne sont pas des nombres seuls ou ne vivent pas dans un capteur, et `make check` les
compare à part (`docs/mesures.md`, *Les nombres du protocole*) : `FLIGHT_BINS_MS` et
`DWELL_BINS_MS` (les bornes des histogrammes, dans le capteur qui les remplit),
`BATCH_MAX_WINDOWS` (64, dans le client qui envoie) et `TEXT_KEPT_MAX_WORDS` (2 000, un
plafond : l'extension navigateur s'arrête à 1 000).

**Les seuils qui lisent un silence ne sont plus des constantes d'agent** : l'hésitation (1 à 3 s)
et la pause (au-delà, jusqu'à 5 minutes) sont lues par le moteur dans la durée des `gap`.
`GAP_MIN_MS` ne dit que ce qui s'écrit, et `ACTIVE_GAP_MAX_S` borne une
tout autre règle — ce qu'un trou crédite en temps de frappe (`active`). Ne pas les rapprocher.

## Règles de comptage

- **Une suppression solde le déplacement qui la précède.** Première Suppr après un déplacement
  (clic **ou** flèche) = reformulation différée ; **les suivantes sont des corrections
  immédiates**. Sans cette remise à zéro, un seul clic faisait basculer toute une rafale en
  reformulations et `counts.corrections` restait à zéro.
- **Les trois clés de remaniement, et leur frontière.** `counts.corrections` : réparer
  sur place ce qu'on vient de taper, moins de `ERASE_RUN_REFORMULATES` caractères d'un seul
  tenant, sans avoir bougé. `counts.reformulations` : un mot effacé au raccourci
  (`Ctrl`/`Cmd`+Suppr ; `Option`+Suppr aussi dans un navigateur, Writer ne le liant pas), une
  rafale de suppression d'un seul tenant — martelée ou **maintenue** — qui atteint
  `ERASE_RUN_REFORMULATES` caractères, ou un retour (clic, ou `NAV_STEPS_AWAY` pas) suivi d'une
  suppression **ou d'une insertion**. `counts.revisions` : les gestes de bloc — sélection tracée
  ou `Ctrl`/`Cmd`+`A` remplacée, `Ctrl`/`Cmd`+`X` — et, chez Word et VS Code seulement, une
  suppression de plus d'`INJECTION_MIN_CHARS` caractères d'un coup (*Écarts assumés*).
  La clé du milieu ne se déclenchait pour ainsi dire jamais : la branche ne s'ouvrait que
  sur « flèches puis Suppr », et reprendre sa fin de phrase, cliquer sur le mot à reprendre ou
  insérer sans supprimer passaient tous à côté. **Un geste ne compte qu'une fois** — les deux
  agents qui mesurent par différences comptaient une reformulation *par caractère* — et une
  sélection qu'on vient de remplacer n'est pas recomptée comme un trajet.
  **Le pas** : une flèche vaut un, un saut (Début, Fin, page, flèche avec `Ctrl`/`Cmd`/`Option`,
  clic) vaut `NAV_STEPS_AWAY`. L'extension et LibreOffice lisent la touche, VS Code la distance
  (un caractère ou une ligne : une flèche ; plus : un saut), Word un événement par déplacement.
  **La rafale** : à la touche chez l'extension et LibreOffice, les répétitions d'une touche
  maintenue l'allongeant sans compter de frappe ; aux caractères, en une ou plusieurs
  différences, chez Word et VS Code. Toute insertion **remet le pas et la rafale à zéro**, chez
  les quatre et sans condition — VS Code ne le faisait que lorsqu'il avait compté, et une flèche
  survivait jusqu'à la suppression suivante.
- **Une orthographe choisie dans un correcteur est une correction immédiate**, et rien d'autre :
  une `counts.corrections`, **aucune frappe** — le mot n'a pas été tapé, et la part tapée est
  recoupée côté moteur avec le document déposé. Un clic dans un menu dessiné *dans* la zone
  d'édition n'est pas un saut de navigation (le clic droit qui l'ouvre, si), et la correction
  solde le déplacement comme le ferait une suppression, sinon la suppression suivante bascule en
  révision massive. À ne pas confondre avec une complétion, qui pose du texte que personne n'a
  écrit : celle-là est un problème d'attribution de volume, pas un remaniement. **Aucun des
  quatre agents ne tient encore cette règle** — deux ne voient pas le geste, les deux capteurs
  par différences le comptent comme un mot retapé (frappes + une correction par caractère
  effacé) ; voir *Écarts assumés* de `docs/mesures.md`.
- **Une orthographe choisie dans le correcteur est une correction immédiate**, et le clic qui la
  choisit n'est **pas** un saut de navigation : les suggestions sont dessinées dans la zone
  d'édition, et chaque correction y coûtait deux traversées du document. Elle solde le geste qui
  a ouvert le menu (sinon le Retour arrière suivant devient une révision massive), et **aucune
  frappe n'est inventée** — le mot qu'on n'a pas retapé n'a pas été tapé. Le clic droit qui ouvre
  le menu reste compté. L'extension reconnaît le menu par un sélecteur par éditeur
  (`correctionMenu`), vide tant que le DOM n'a pas été lu en vrai ; Word et VS Code le voient par
  leur différence de texte ; LibreOffice n'intercepte que la fenêtre du document, donc rien.
- **Remplacer une sélection est une suppression**, à l'échelle de la sélection (Ctrl/Cmd+A,
  tracé souris, Maj+déplacement). Maj seule ne sélectionne rien ; un déplacement sans Maj ou un
  clic annule la sélection ; elle n'est décomptée qu'une fois.
- **Un silence s'écrit, il ne se classe pas.** Tout silence d'au moins `GAP_MIN_MS` entre deux
  frappes **comptées** part en `gap`, à sa durée réelle ; l'hésitation (1 à 3 s, la **preuve de
  vie** du modèle : qui recopie un texte déjà écrit n'hésite pas sur un mot déjà choisi) et la
  pause sont lues par le moteur. Jamais à la reprise d'un clic, d'un collage (raccourci
  compris), d'une injection ou d'un choix dans le correcteur — et ces gestes ne remettent pas le
  silence à zéro. Ne pas rappeler la règle du silence depuis un geste qui ne compte pas de
  frappe (voir *Le déroulé, le rythme, le texte*).
- **La répétition automatique ne compte pas** : Suppr maintenue = une suppression.
- **Une touche de modification seule n'est pas une frappe.** Maj, Ctrl, Cmd, Alt/Option, AltGr,
  Verr. Maj, Fn pressée pour elle-même n'ouvre pas de fenêtre, ne compte pas, n'entre pas dans
  les flight times et ne solde pas le déplacement qui la précède. Elle est écartée **avant tout
  le reste** dans `onKeyDown` et dans `Measure.on_key` ; Word et VS Code, qui comptent des
  caractères, n'en voient jamais.
  L'extension les reconnaît **par leur nom** — `MODIFIER_KEYS`, les valeurs de UI Events — et
  LibreOffice **par leur forme**, un événement UNO sans code de touche ni caractère. Seule la
  première a donc une liste à tenir : une touche qui y manquerait compterait pour une frappe.
- **Une touche morte n'écrit rien non plus**, donc elle est écartée comme un modificateur
  (`key: "Dead"`). Deux frappes pour un `ê` faisaient diverger l'extension de Word et de VS Code,
  qui en comptent une.
- **Une frappe prise par une composition compte, et rien d'autre n'en est lu** (`isComposing`,
  `key: "Process"`) : palette d'accents de macOS, IME. C'est une frappe `type` — les
  ignorer ferait passer pour un colleur quelqu'un qui tape en japonais — mais ni dans
  `counts.jumps`, ni dans les flight times, et elle ne solde pas le déplacement qui la
  précède. C'est le piège : les flèches de la palette étaient des sauts de navigation, et la
  suppression suivante devenait une reformulation différée.
- **Cmd est lu partout où Ctrl l'est** : `ctrlKey || metaKey` côté extension, le modificateur UNO
  `MOD1` côté LibreOffice — qui *est* Cmd sur macOS. Un raccourci ajouté d'un côté seulement
  ferait d'un étudiant sur Mac un étudiant qui ne coupe ni n'annule jamais.
- **Refaire n'est pas annuler**, et Maj est ce qui les distingue : Ctrl/Cmd+Z est une correction
  immédiate, Ctrl/Cmd+Maj+Z ne compte pour rien. La sélection en attente s'effondre dans les deux
  cas, donc elle se solde **avant** le test sur Maj.
- **Un collage pèse ce qu'il a posé, pas la touche qui l'a posé.** Ctrl/Cmd+V ne compte aucune
  frappe par elle-même : ce que le collage pose est pesé dans le gestionnaire de collage — une
  frappe pour une restitution, aucune pour une injection — et pesé là quel que soit le geste, le
  menu et le glisser-déposer n'ayant pas de touche. Compter la touche en plus faisait coûter deux
  frappes au clavier ce qui en coûtait une au menu. **Cmd est lu partout où Ctrl l'est**, Maj
  n'est pas exclue (« coller sans mise en forme » est un collage) et **Maj+Inser** en est un
  troisième — qui, ne portant pas Ctrl, soldait en plus la sélection dans le gestionnaire de
  touches et faisait compter deux révisions pour un collage. L'extension reconnaît ces raccourcis
  par leur nom (`isPasteShortcut`), LibreOffice par leurs codes de touche, dans `sensor.py`, qui
  en fait une **catégorie** `PASTE`. Ctrl/Cmd+C reste une frappe ordinaire : il ne pose rien.
- **Son propre texte qui revient n'est pas une injection.** Copier son paragraphe, le passer à un
  correcteur (Scribens, Antidote, un traducteur) et recoller la version corrigée compte pour une
  **révision massive** et une frappe (une suite `other` sans durée, puis une suite `self`), jamais
  pour un collage (aucune suite `paste`). Ce
  qui sort du document (Ctrl+C, Ctrl+X ; dans Word, ce que la différence voit disparaître **et le
  bloc sélectionné**, faute d'événement de copie) est retenu en **empreintes** — des suites de `SHINGLE_WORDS` mots réduites à un FNV-1a 32 bits,
  jamais le texte — et un collage qui les recoupe à `SELF_PASTE_RATIO` est une restitution. La
  normalisation (casse, accents, ponctuation) absorbe exactement ce qu'un correcteur change. Le
  piège : compter deux fois la révision — la sélection remplacée, ou la suppression côté Word,
  la compte déjà ; n'ajouter la révision que lorsque le collage ne remplace rien.
- **Deux agents n'ont pas de presse-papiers, et ils s'en passent autrement.** Word retient le
  **bloc sélectionné** — un Ctrl+C est invisible à un complément, la sélection sur laquelle il a
  été fait ne l'est pas — haché sur un tour suivant et seulement une fois la sélection stabilisée
  (`SELECTION_SETTLE_MS`), l'entrée étant *mise à jour* et non remplacée : re-sélectionner un bloc
  ne lui rend pas son histoire, sinon la duplication redeviendrait une révision. VS Code, lui, ne
  voit ni le presse-papiers ni le contenu de ce qu'une modification remplace : il compare
  l'insertion au **document**, exactement et non par empreintes, et l'écrit en suite
  `self` sans compter de révision (voir *Écarts assumés*).
- **Une sortie reste comparable tant qu'elle sert.** `SELF_PASTE_TTL_S` court depuis le dernier
  collage reconnu, pas depuis la copie, et c'est la sortie la **moins récemment vue** qui cède la
  place quand il y en a plus de `SELF_PASTE_MAX_COPIES` : copier une fois et recoller toute la
  soirée ne doit jamais redevenir une injection. À partir du **deuxième** retour d'une même
  sortie, le collage ne compte plus la révision massive — c'est une duplication, pas une
  deuxième révision — mais toujours la frappe du bloc posé.
- **Une restitution est écrite pour elle-même** (une suite `self` par geste). Sans elle, le
  moteur voit une révision massive sans pouvoir dire si l'étudiant a réécrit son paragraphe à la
  main ou l'a passé à un correcteur — et c'est la seule trace par laquelle une régression de
  cette reconnaissance se verrait, tout le reste de la règle étant invisible côté moteur.
  Son `n` en donne le **volume** : quatre restitutions ne disent pas si c'est un
  paragraphe ou un tiers du document qui est revenu. C'est exactement le volume dont le même
  texte aurait été accusé s'il avait été collé par quelqu'un d'autre — les tests des trois agents
  qui savent le reconnaître le vérifient ainsi, en comparant à la suite `paste` d'un
  inconnu qui colle le même texte.
- **Un gros collage et vingt petits ne se valent pas** : un collage est **une suite `paste` par
  geste**, jamais fondue dans la précédente. Le moteur en tire le nombre, le volume et le plus
  gros bloc. Dans VS Code, c'est aussi la taille de ce qui a été accepté en un geste.
- **Ce qui est collé juste après un retour vient d'ailleurs.** `counts.back_chars`
  compte les caractères injectés dans les `RETURN_WINDOW_S` suivant un retour au document, et un
  retour n'existe **que si la sortie a été comptée** (`counts.exits`) — sans quoi un changement
  de focus à l'intérieur de la page daterait ce qui suit. C'est un sous-ensemble strict du
  volume injecté que le moteur déduit des suites `paste`.
- **Ce qui est tapé juste après un retour vient peut-être d'ailleurs aussi.**
  `counts.back_keys` est le miroir exact de `counts.back_chars`, aux mêmes
  conditions (un retour n'existe que si la sortie a été comptée). Le collage après un retour
  était mesuré, la frappe après un retour ne l'était pas : sortir, lire, revenir et **taper**
  échappait à la seule règle qui regarde le retour au document. C'est un sous-ensemble des
  frappes du déroulé, jamais un ajout : **toutes** les frappes y passent — une suppression et une
  annulation en sont — sinon deux agents donneraient deux chiffres différents sous le même nom,
  et rien côté moteur ne pourrait le dire.
- Une fenêtre va de la première à la dernière activité : le temps mort n'y entre
  jamais.

## Le déroulé, le rythme, le texte

Une fenêtre est **numérotée dans une session** et porte le **déroulé** (`runs`), ce que seul le
capteur sait classer (`counts`), la **distribution** du rythme (`flight`, `dwell`), le **texte
lu** (`text`) et les cumuls de la session (`sum`). Le moteur **déduit** du déroulé les frappes,
les collages, les caractères injectés, les restitutions, les pauses et les hésitations : aucun
de ces nombres ne voyage, et un capteur n'en tient plus que ce qu'il lui faut pour `sum` et
pour sceller à `FLUSH_KEYSTROKES`. La référence est `docs/mesures.md` ; les règles à ne pas
défaire :

- **`runs` n'est jamais vide, jamais abandonné, jamais tronqué.** Une fenêtre qui approche
  `TIMELINE_MAX_RUNS` est scellée avant, avec `volume`. Il n'y a pas d'échappatoire « le déroulé
  est perdu » : sans lui, le moteur ne compte rien.
- **Une frappe entre dans le déroulé par la fonction qui la compte**, avec le genre que le
  capteur lui donne déjà. Ajouter un endroit qui compte une frappe, un collage ou une
  restitution sans y écrire la suite fait diverger `sum` de ce que le moteur déduit — et
  inversement.
- **Trois formes, selon le genre** : `[genre, n, ms]` pour `type`, `erase`, `nav`, `other` ;
  `[genre, n]` pour `move`, `click`, `paste`, `self`, `copy`, `undo`, `fix` ; `["gap", ms]`.
  Deux suites voisines n'ont jamais le même genre, sauf `gap`, `paste` et `self`.
- **`seq` et `sum` avancent au scellement, dans la même opération, pas à l'envoi** — y compris
  pour une fenêtre qui ne partira jamais. Le scellement est synchrone : rien ne s'attend entre
  la prise des nombres et le numéro. `sum` suit les règles du moteur : `keys` les `n` des quatre
  genres de frappe, `pastes` les suites `paste`, `chars` celles de plus
  d'`INJECTION_MIN_CHARS`.
- **Un `gap` s'écrit pour tout silence d'au moins `GAP_MIN_MS` entre deux frappes comptées**, à
  sa durée réelle, non plafonnée, et nulle part ailleurs. **Le capteur ne le classe pas** : il
  ne tient ni seuil d'hésitation ni seuil de pause, ce sont des règles du moteur. Ne pas
  l'écrire à la reprise d'un clic, d'un collage (raccourci compris), d'une injection ou d'un
  choix dans le correcteur — ces gestes ne remettent pas le silence à zéro — ni le mesurer
  depuis la dernière touche *pressée*, qu'un raccourci de collage déplace sans compter de
  frappe. Celui qui a commencé avant la fenêtre en est **toujours la première suite**, même si
  un clic l'a ouverte.
- **Deux exceptions, un seuil de 3 000 ms** : un silence d'au plus 3 000 ms (inclus) qu'achève
  une touche prise par une composition n'est pas écrit ; et un capteur qui ne résout pas les
  silences courts (Word) n'écrit que ceux de plus de 3 000 ms et envoie
  `unseen: ["hesitations"]`. Ce seuil n'est pas une constante commune : chaque capteur concerné
  le tient sous son nom (`SHORT_GAP_MAX_MS` dans l'extension, `SILENCE_RESOLUTION_MS` dans Word).
- **Un silence ne traverse jamais une session** : il se mesure depuis la dernière frappe de la
  session en cours, et la première fenêtre d'une session n'en porte jamais en tête.
- **Toute durée se lit sur l'horloge monotone** — `ms`, `active`, la durée d'une suite et d'un
  silence, les flight times, les durées d'appui. L'horloge murale ne donne que `at` et `sent`.
- **Les durées ne se recouvrent pas** : seuls `type`, `erase`, `nav`, `other` et `gap` en ont
  une, une suite de frappes s'arrête où le silence commence, et la frappe que vaut une
  restitution n'allonge pas la suite où elle tombe.
- **Une suite ne se coupe jamais sur ce qui est tapé** — espace, ponctuation, Entrée, AltGr.
  C'est une règle de confidentialité avant d'être une règle de forme.
- **`flight` est omis sous deux écarts ; `dwell` part toujours chez qui voit les touches
  relâchées**, zéros compris. Les zéros de queue d'un histogramme ne s'envoient pas.
- **`dwell` se compte au relâchement, pour une touche enfoncée dans la fenêtre encore
  ouverte** : le moteur le compare aux frappes `type` de la même fenêtre.
- **`text` a deux formes** : `len` seul (taille reprise du cache, ou première lecture de la
  session), ou `len` avec la portée (`since`, `at`, `cut`, `add`, et `kept` s'il est calculé) à
  chaque lecture qui en suit une autre. La portée se calcule sur la lecture qui donne déjà la
  taille, jamais sur une lecture de plus (skill `performance-capteurs`), contre la seule
  lecture précédente, gardée en mémoire et relâchée quand la mesure s'arrête. `kept` est omis,
  pas estimé, quand il n'est pas calculé.
- **Une mesure qu'on ne sait pas prendre est absente, jamais à zéro** : une clé de `counts`, un
  bloc.

Chaque suite d'agent affirme ces règles une à une sur des séances scriptées (une fenêtre de
collages seuls, un silence clos par un clic puis de la frappe, le plafond de 200 frappes, un
silence de tête de plus de cinq minutes) : une règle de comptage qui change s'y voit aussitôt.

## Suspension de la mesure

Les quatre agents ont un bouton qui **suspend la mesure**. Quatre règles, identiques partout :

- **Elle suspend la mesure, pas l'envoi.** La file continue de partir : ce qui a été mesuré avant
  la pause appartient déjà au moteur, et le retenir ne ferait que transformer une pause en un lot
  tardif — `late_ingestion` et `multi_window_batch` côté moteur.
- **La fenêtre en cours est vidée au moment de suspendre.** Rien de mesuré n'est perdu, et rien
  ne s'accumule derrière un capteur suspendu.
- **Pendant la suspension, aucun événement n'est compté** : pas de fenêtre ouverte, pas de temps
  effectif, pas de pause cognitive. Ce n'est pas « mesurer sans envoyer ».
- **Elle est explicite et elle dure** : elle survit au redémarrage de l'éditeur, et seule une
  reprise explicite la lève. Un agent qui reprendrait tout seul serait pire que pas de pause du
  tout — l'étudiant se croirait mesuré sans l'être. Pour la même raison, l'état est affiché en
  permanence (badge, barre d'état, volet), jamais seulement au moment du clic.

L'état est **global à l'agent**, pas par document : c'est l'étudiant qui suspend, pas un fichier.

**Le contrôle est une icône, dans l'en-tête.** Les trois agents à interface HTML (popup, volet
Word, panneau VS Code) portent la suspension et la déconnexion en haut à droite, en icônes
seules&nbsp;: une popup n'a pas la largeur pour deux boutons pleins. Une icône ne nomme rien, donc
chacune porte son action en `aria-label` et, en `title`, la phrase qui dit ce que presser
déclenche&nbsp;; la suspension est un basculement, d'où `aria-pressed`. Sa couleur ne fait que
**seconder** le bandeau — l'état ne doit jamais tenir à la seule icône. La fenêtre LibreOffice n'a
pas d'icônes (dialogue UNO) mais a la même aide au survol, par `HelpText`.

Piège rencontré&nbsp;: un élément **SVG n'a pas la propriété `hidden`** (elle vit sur
`HTMLElement`). L'affecter en JavaScript ne crée qu'une propriété morte et l'icône ne bascule
jamais&nbsp;: il faut poser l'attribut, et une règle de `ui.css` agit dessus.

**Il s'affiche une fois, pas deux.** Le bandeau permanent porte l'état ; le message transitoire ne
confirme que la **reprise**, qui ne laisse rien à l'écran. Les deux ensemble donnaient deux blocs
rouges l'un sous l'autre, disant la même chose en deux formulations — c'était
[Certimens/plugins#2](https://github.com/Certimens/plugins/issues/2). La fenêtre LibreOffice fait
exception : faute de bandeau permanent, son message *est* l'affichage de l'état.

| Implémentation | Où l'état est gardé | Où les événements sont filtrés |
| --- | --- | --- |
| Extension navigateur | `chrome.storage.local`, clé `paused` | `browser/src/content.js` (chaque gestionnaire, et `recordInjection`) |
| Complément Word | `localStorage` partagé, `isPaused()` d'`agent.js` | `word/src/sensor.js` (`noteLocalEvent`, `onSelectionChanged`) |
| Extension LibreOffice | `certimens.json`, `Engine.paused()` | `sensor.py` (`on_key`, `on_click`, `on_paste`, `on_deactivated`) |
| Extension VS Code | `globalState`, `Agent.paused()` | `vscode/src/extension.js` (les gestionnaires de l'hôte) |

Le complément Word est le seul cas où la lecture du document **continue** pendant la pause : son
capteur travaille par différences, et sans rafraîchir sa référence, tout ce qui a été écrit
pendant la pause atterrirait d'un coup dans la première fenêtre d'après (voir `BASELINE_REFRESH_MS`).

## Invariant de confidentialité

Aucune touche, aucun caractère, aucun texte ne quitte le poste ni n'est conservé au-delà de ce
qu'exige le calcul. Seule exception, bornée : les empreintes de ce qui sort du document, des
nombres en mémoire vive, `SELF_PASTE_MAX_COPIES` sorties au plus, effacées au bout de
`SELF_PASTE_TTL_S` sans
servir — rien sur le disque, rien dans une fenêtre, rien vers le moteur. Les capteurs traduisent
chaque touche en **catégorie** (`erase`, `navigation`, `modifier`, `paste`, `other`) puis l'oublient ; `word/src/sensor.js` ne garde que la lecture
précédente du texte, le temps de la différence. Le mode debug journalise **des nombres et des
catégories uniquement**. Le calcul du corps demande trois choses gardées en mémoire vive,
et rien d'autre : **la lecture précédente du texte** dans les quatre agents (une seule, jusqu'à
la suivante ou jusqu'à l'arrêt de la mesure), **l'instant d'un enfoncement de touche** le temps
de son relâchement (extension et LibreOffice : dix au plus, vidés à la sortie du document,
jamais la touche elle-même une fois relâchée), et **un identifiant de session tiré au hasard**.
Ce qui part reste des nombres et des catégories — pas d'empreinte du contenu, délibérément.
Toute modification qui ferait transiter du texte vers le moteur casse la
promesse produit affichée dans les boutiques : c'est un changement de contrat, pas un détail
d'implémentation.

## Ajouter ou changer une mesure

Il n'y a **qu'un corps**, sans numéro, et son vocabulaire est **fermé** : une clé, un genre de
suite ou un mot que le moteur ne connaît pas fait refuser la fenêtre entière. Aucun agent ne
négocie, ne se replie ni ne retire une mesure devant un refus — un `400` ou un `409` abandonne
la fenêtre, et rien d'autre ne change. Il n'y a donc ni liste de mesures « récentes » à tenir,
ni état à retenir d'un refus.

Avant d'ajouter quoi que ce soit, **se demander si cela se déduit du déroulé**. Un décompte de
suites, un seuil sur la durée d'un `gap`, un maximum : c'est une règle du moteur, qui change
sans toucher aux agents. Ne voyage que ce que le capteur est seul à savoir.

Quand il faut vraiment un champ de plus, l'ordre est celui-ci :

1. **Le contrat, côté moteur, d'abord** : le champ s'y définit et le moteur apprend à le lire.
   Rien n'est à nommer ici de ce dépôt-là — on demande le changement, on ne le décrit pas.
2. **Les quatre capteurs, ensemble** : un genre de suite, une clé de `counts` ou un bloc — avec,
   pour celui qui ne sait pas le mesurer, l'**absence** et non un zéro, et une ligne dans les
   *Écarts assumés*.
3. **Les tables de `docs/mesures.md`** (*Le déroulé*, *Ce que seul le capteur sait classer*,
   *Constantes communes*, *Les nombres du protocole*) et l'énoncé du corps dans
   `docs/moteur.md`, dans le même commit.
4. **`make check`**, qui compare les quatre capteurs à ces tables, et un cas dans chacune des
   quatre suites.

Renommer une clé ou déplacer une constante commune suit le même ordre. Une fenêtre restée en
file sous une forme que l'agent ne produit plus est **abandonnée**, pas convertie.

## La forme du corps n'est pas libre

L'énoncé complet est dans `docs/moteur.md`, *Le corps de mesure*. Ce qu'il faut avoir en tête en
touchant un sérialiseur :

- **L'ordre des clés est fixé à tous les niveaux** (dans `counts` seulement il est libre), le
  corps n'est jamais indenté, et un bloc ou une clé facultatifs absents sont **omis** — jamais
  vides, jamais `null`. `offline` n'apparaît que quand il est vrai.
- **Une fenêtre qui sort de la file est reconstruite clé par clé** à l'envoi : une file se relit
  depuis le stockage de l'hôte — `chrome.storage.local`, le stockage global de VS Code, le
  profil sur disque —, et rien ne promet qu'il rende les clés dans l'ordre où on les lui a
  confiées. Les doubles de stockage des tests les rendent dans le désordre, et l'agent Python
  relit une file réécrite sur le disque — sans quoi l'assertion passerait sans rien garder.
- **`sent` est réécrit à chaque tentative** ; il n'est pas gardé dans la file.
- **`offline` décrit la fenêtre, pas la file** : vrai si, à la clôture de la fenêtre, la
  dernière tentative d'envoi avait échoué — jamais `navigator.onLine`, qu'un portail captif
  trompe et que deux agents sur quatre n'ont pas. Il est posé à la mise en file, pas au départ.
- **Une fenêtre en direct part seule** ; seule une file qui a attendu part par lots, de
  `BATCH_MAX_WINDOWS` fenêtres voisines d'une même session au plus, **toutes `offline`**. Une
  fenêtre qui a attendu pour une autre raison repart seule.
- **`why` dit lequel des déclencheurs a scellé la fenêtre**, dans un vocabulaire de six mots qui
  est celui du moteur (`docs/mesures.md`, *Pourquoi la fenêtre s'est fermée*), et il est
  obligatoire. Chaque agent traduit **ses** déclencheurs dans une table `WIRE_FLUSH_REASONS`, en
  tête de son capteur ; un déclencheur absent de la table donne une fenêtre que le moteur
  refuse. `make check` compare la table de chaque agent à ses propres appels — une règle
  qu'aucune suite d'agent ne peut voir.
- **Ne jamais déclarer `away` sans avoir compté la sortie.** Cette déclaration rapporte quelque
  chose au document — le moteur sort du rythme les silences qui suivent un départ — donc il la
  recoupe avec `counts.exits`, et une fenêtre qui se contredit est signalée.

Vérification : chaque agent tient l'ordre sur son propre sérialiseur —
`libreoffice/tests/test_engine.py` sur un vrai corps HTTP, `browser/tests/background.test.mjs`,
`vscode/tests/engine.test.mjs` et `word/tests/agent.test.mjs` sur le corps que leur `fetch`
reçoit. Un test ne peut rien dire d'un sérialiseur qu'il n'exécute pas.

## Écarts assumés

La référence est la section du même nom de `docs/mesures.md` ; l'essentiel :

- **Complément Word** : pas de bloc `flight` ni `dwell`, pas de `counts.exits`,
  `counts.back_keys` ni `counts.back_chars` (qui supposent de savoir qu'on est revenu, donc
  qu'on était parti), et `unseen: ["hesitations"]` — une hésitation est un silence *entre deux
  frappes*, il n'écrit donc que les `gap` de plus de 3 000 ms (`SILENCE_RESOLUTION_MS`). Office ne livre pas
  les frappes (le capteur travaille par différences de texte) ni la sortie du document ; une
  cadence calculée sur ses événements serait fausse. Une « frappe » y est un caractère inséré ou
  effacé, une suite par différence, `ms` à `0`. N'ayant jamais compté que des différences, il
  n'a jamais eu le biais du clic — ni le clic : un déplacement y est un pas (suite `move`), quel
  qu'il soit, et une suppression de plus d'`INJECTION_MIN_CHARS` caractères d'un coup est une
  révision massive, sélection vue ou non.
- **LibreOffice** : mêmes blocs et mêmes définitions que l'extension, flight times compris
  (`XUserInputInterception` donne clavier et souris) ; seule exception, son gestionnaire de clic
  ne donne pas de coordonnées, donc une sélection **tracée à la souris** n'y est pas détectable.
  Pas de `fix`.
- **VS Code** : pas de bloc `dwell`, pas de suite `nav`, `copy` ni `fix`. L'API donne le texte
  inséré et la *longueur* de ce qu'il remplace, jamais son contenu, donc rien à comparer à ce
  qui sort du document. La restitution y est reconnue autrement, sur le **document** (une
  insertion qu'il contenait déjà ailleurs est une duplication, comparaison exacte) : elle part
  en suite `self`, pour son volume, sans compter de révision. Une insertion faite en un coup y
  est un collage, un extrait de code ou une complétion acceptée (IntelliSense, assistant), et
  l'API ne dit pas laquelle : elle part en suite `paste`. Pour la même raison les flight times
  ne retiennent que les modifications de la taille d'une frappe. Tout le reste est mesuré, y
  compris `counts.exits` (la fenêtre de l'éditeur perd le focus) et les trois cases de
  révision : une modification porte la longueur de ce qu'elle efface, et l'origine du
  déplacement précédent (clavier, souris, commande) est connue. Une frappe y est un caractère
  inséré ou effacé, comme dans Word — et, comme dans Word, une suppression de plus
  d'`INJECTION_MIN_CHARS` caractères d'un coup est une révision massive. Un déplacement au
  clavier y est mesuré à la distance (`isNudge`), l'éditeur ne nommant pas la touche : c'est une
  suite `move`, pas une frappe.
- **Extension navigateur** : tous les blocs, tous les genres sauf `move`. Pas de `text` sur
  Overleaf ; `kept` omis au-delà de 1 000 mots.

## Vérifier

Chaque implémentation a sa suite, et les quatre se lisent comme la **spécification exécutable**
des règles ci-dessus : une règle qui change s'y voit d'abord.

| Implémentation | Capteur | Envoi au moteur |
| --- | --- | --- |
| Extension navigateur | `browser/tests/sensor.test.mjs` | `browser/tests/background.test.mjs` |
| Complément Word | `word/tests/sensor.test.mjs` | `word/tests/agent.test.mjs` |
| Extension LibreOffice | `libreoffice/tests/test_measure.py` | `libreoffice/tests/test_engine.py` |
| Extension VS Code | `vscode/tests/sensor.test.mjs` | `vscode/tests/engine.test.mjs` |

Les tests JavaScript chargent le fichier livré tel quel dans un contexte isolé
(`tests/helpers/sandbox.mjs`) : **rien n'est ajouté au code de production pour le rendre
testable**, et l'horloge est pilotée par le test, sans quoi les règles de pause et de temps
effectif ne seraient pas mesurables.

Une règle commune ajoutée ou changée se teste dans chaque suite — les cas sont volontairement les
mêmes de l'une à l'autre, c'est ce qui rend une divergence visible.

Ce qu'aucune de ces suites ne peut voir — les quatre implémentations **comparées entre elles** —
est tenu par `make check` (`scripts/check-coherence.py`) : les constantes communes, les genres
de suite, les clés de `counts`, les mots de `why`, les nombres du protocole, l'adresse du moteur
par défaut et les fichiers partagés par lien symbolique.

```bash
make check                 # les quatre comparés entre eux : constantes, vocabulaire du corps, liens
make test                  # toutes les suites, agent par agent
make -C browser test       # un seul agent (node --test, sans dépendance)
make -C libreoffice test   # python3 -m unittest discover -s tests
make lint                  # tous les linters : JS, CSS, HTML, Python, shell
```
