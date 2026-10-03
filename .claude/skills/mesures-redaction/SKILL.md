---
name: mesures-redaction
description: Définitions partagées des mesures de rédaction (fenêtres, compteurs, metrics envoyées au moteur) implémentées quatre fois — extension navigateur, complément Word, extension LibreOffice, extension VS Code. À charger avant toute modification d'un capteur, d'une constante de mesure, d'une règle de comptage ou d'une metric, et avant d'expliquer ce que compte un agent.
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
limite de la plateforme (voir *Écarts assumés*). Le tableau des metrics de `docs/mesures.md`
(section *Metrics envoyées*) est la référence lisible : il se met à jour dans le même commit.

## Constantes communes

Identiques dans les trois fichiers, à ne pas désynchroniser :

Les trois premières implémentations comptent une frappe par touche ou par caractère ; VS Code,
lui, ajoute une constante qui n'a de sens que chez lui, `SELECTION_ECHO_MS` (50 ms) : l'éditeur
signale un déplacement du curseur après chaque frappe, et sans ce délai `navigation_jumps`
suivrait exactement `keystrokes_total`.

| Constante | Valeur | Ce qu'elle borne |
| --- | --- | --- |
| `FLUSH_KEYSTROKES` | 200 | envoi de la fenêtre au bout de 200 frappes |
| `IDLE_FLUSH_MS` / `IDLE_FLUSH_S` | 2 s | envoi après 2 s sans activité |
| `PAUSE_MIN_S` / `PAUSE_MAX_S` | 3 s / 300 s | ce qui compte comme pause cognitive |
| `ACTIVE_GAP_MAX_S` | 60 s | ce qu'un trou ajoute au temps effectif |
| `INJECTION_MIN_CHARS` | 15 | en deçà, un collage n'est pas une injection |
| `FLIGHT_MAX_MS` | 800 | au-delà, l'écart entre deux frappes n'est pas un flight time |
| `SHINGLE_WORDS` | 4 | la taille d'une empreinte : quatre mots consécutifs |
| `SELF_PASTE_RATIO` | 0,7 | recoupement au-delà duquel un collage est le texte de l'étudiant |
| `SELF_PASTE_TTL_MS` / `SELF_PASTE_TTL_S` | 3600 s | délai sans servir au bout duquel une sortie n'est plus comparable |
| `SELF_PASTE_MAX_COPIES` | 20 | nombre de sorties retenues : la mémoire est bornée |
| `HESITATION_MIN_MS` / `HESITATION_MAX_MS` | 1 s / 3 s | le silence qui compte comme une hésitation lexicale |
| `RETURN_WINDOW_MS` / `RETURN_WINDOW_S` | 15 s | après un retour au document, délai pendant lequel ce qui est collé vient d'ailleurs |

`PAUSE_MAX_S` et `ACTIVE_GAP_MAX_S` sont **deux règles distinctes** qui ont partagé la même
valeur par accident. Un long silence compte comme une pause sans être crédité en temps de frappe :
ne pas les réunifier.

## Règles de comptage

- **Une suppression solde le déplacement qui la précède.** Première Suppr après un clic =
  révision massive ; après une flèche = reformulation différée ; **les suivantes sont des
  corrections immédiates**. Sans cette remise à zéro, un seul clic faisait basculer toute une
  rafale en reformulations et `immediate_corrections` restait à zéro.
- **Une orthographe choisie dans un correcteur est une correction immédiate**, et rien d'autre :
  un `immediate_corrections`, **aucune frappe** — le mot n'a pas été tapé, et la part tapée est
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
- **Entre le flight time et la pause, il y a l'hésitation.** Un silence de `HESITATION_MIN_MS`
  à `HESITATION_MAX_MS`, les mains sur le clavier : quelqu'un qui cherche son mot. En deçà de
  `FLIGHT_MAX_MS` l'écart est un flight time, au-delà de `PAUSE_MIN_S` c'est une pause
  cognitive, et la bande entre les deux ne relevait d'aucune des deux règles.
  `lexical_hesitations` est la **preuve de vie** qui manquait au modèle : qui recopie un texte
  déjà écrit fait des pauses et des corrections comme tout le monde, mais n'hésite pas sur un
  mot déjà choisi. Les bornes se touchent sans se recouvrir — hésitation de 1 s à 3 s incluses,
  pause **au-delà** de 3 s — donc un silence n'est jamais compté deux fois ; c'est le piège à
  ne pas défaire en bougeant l'une des deux.
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
  `key: "Process"`) : palette d'accents de macOS, IME. Elle entre dans `keystrokes_total` — les
  ignorer ferait passer pour un colleur quelqu'un qui tape en japonais — mais ni dans
  `navigation_jumps`, ni dans les flight times, et elle ne solde pas le déplacement qui la
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
  **révision massive** et une frappe, jamais dans `paste_events` ni `injected_chars_total`. Ce
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
  l'insertion au **document**, exactement et non par empreintes, et n'envoie donc que
  `self_paste_chars_total` (voir *Écarts assumés*).
- **Une sortie reste comparable tant qu'elle sert.** `SELF_PASTE_TTL_S` court depuis le dernier
  collage reconnu, pas depuis la copie, et c'est la sortie la **moins récemment vue** qui cède la
  place quand il y en a plus de `SELF_PASTE_MAX_COPIES` : copier une fois et recoller toute la
  soirée ne doit jamais redevenir une injection. À partir du **deuxième** retour d'une même
  sortie, le collage ne compte plus la révision massive — c'est une duplication, pas une
  deuxième révision — mais toujours la frappe du bloc posé.
- **Une restitution est comptée pour elle-même** (`self_paste_events`). Sans ce compteur, le
  moteur voit une révision massive sans pouvoir dire si l'étudiant a réécrit son paragraphe à la
  main ou l'a passé à un correcteur — et c'est le seul compteur par lequel une régression de
  cette reconnaissance se verrait, tout le reste de la règle étant invisible côté moteur.
  `self_paste_chars_total` en donne le **volume** : quatre restitutions ne disent pas si c'est un
  paragraphe ou un tiers du document qui est revenu. C'est exactement le volume dont le même
  texte aurait été accusé s'il avait été collé par quelqu'un d'autre — les tests des trois agents
  qui savent le reconnaître le vérifient ainsi, en comparant au `injected_chars_total` d'un
  inconnu qui colle le même texte.
- **Un gros collage et vingt petits ne se valent pas.** `injected_chars_max` donne le plus gros
  d'une fenêtre, pris seul ; `injected_chars_total` les confond. Dans VS Code, c'est aussi la
  taille de ce qui a été accepté en un geste.
- **Ce qui est collé juste après un retour vient d'ailleurs.** `injected_chars_after_return`
  compte les caractères injectés dans les `RETURN_WINDOW_S` suivant un retour au document, et un
  retour n'existe **que si la sortie a été comptée** (`focus_losses`) — sans quoi un changement
  de focus à l'intérieur de la page daterait ce qui suit. C'est un sous-ensemble strict de
  `injected_chars_total`.
- **Ce qui est tapé juste après un retour vient peut-être d'ailleurs aussi.**
  `keystrokes_after_return` est le miroir exact d'`injected_chars_after_return`, aux mêmes
  conditions (un retour n'existe que si la sortie a été comptée). Le collage après un retour
  était mesuré, la frappe après un retour ne l'était pas : sortir, lire, revenir et **taper**
  échappait à la seule règle qui regarde le retour au document. C'est un sous-ensemble de
  `keystrokes_total`, jamais un ajout : **toutes** les frappes y passent — une suppression et une
  annulation en sont — sinon deux agents donneraient deux chiffres différents sous le même nom,
  et rien côté moteur ne pourrait le dire.
- La période d'une fenêtre va de la première à la dernière activité : le temps mort n'y entre
  jamais.

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
précédente du texte, le temps de la différence. Le mode debug journalise **des compteurs et des
catégories uniquement**. Toute modification qui ferait transiter du texte vers le moteur casse la
promesse produit affichée dans les boutiques : c'est un changement de contrat, pas un détail
d'implémentation.

## Metrics étendues

Certaines metrics sont plus récentes que des moteurs déployés, et elles le sont en **trois
générations** :

| Génération | Metrics |
| --- | --- |
| 1 | `paste_events`, `focus_losses`, `flight_median_ms` |
| 2 | `self_paste_events`, `injected_chars_max`, `injected_chars_after_return` |
| 3 | `self_paste_chars_total`, `lexical_hesitations`, `keystrokes_after_return` |

La liste vit dans `EXTENDED_GENERATIONS`, **quatre fois** — le service worker de l'extension,
l'agent Word, les clients moteur de VS Code et de LibreOffice — et `make check` les tient
d'accord entre elles et avec le tableau de `docs/moteur.md`. Il refuse aussi une metric
documentée qui n'est dans **aucune** génération : c'est le piège exact, puisque tout passe
jusqu'au premier moteur qui ne connaît pas le type et refuse alors la fenêtre entière.

Face à un **`400` portant le code `metric_type_unknown`** — et seulement celui-là — l'agent
retire **la génération la plus récente encore envoyée** et renvoie la fenêtre ; si le refus
persiste, la suivante. Un moteur qui connaît les deux premières mais pas la troisième ne perd
que la troisième : tout lâcher d'un coup lui retirerait des mesures qu'il sait lire, et personne ne le
verrait. L'état retenu est donc un **nombre de générations retirées**, pas un booléen (une
installation plus ancienne porte le booléen : il vaut « tout ce qui existait alors »). L'agent
réessaie au prochain appairage.

Tout autre `400` (période invalide, corps mal formé) ne doit pas désactiver les metrics étendues :
c'était le bug qui empêchait `focus_losses` de repartir.

La liste des types acceptés est tenue par le moteur, lui seul. Ajouter une metric, c'est donc
**deux chantiers** : le moteur d'abord, les agents ensuite, avec la dégradation ci-dessus — et
dans une **génération nouvelle**, jamais dans une existante, qu'elle ferait perdre entière à un
moteur qui ne connaîtrait que la metric manquante. **Renommer une metric est le même chantier**,
dans le même ordre : le moteur accepte les deux noms, les agents basculent, l'ancien ne tombe
qu'une fois les quatre publiés.

## Comment un nom de metric se forme

`<sujet>_<statistique>_<unité>`, et rien de ce qui n'existe pas : le **sujet** d'abord pour que
les mesures d'une même chose se suivent (`injected_chars_total`, `injected_chars_max`,
`injected_chars_after_return` ; `flight_mad_ms`, `flight_median_ms`), la **statistique** ensuite
(`total`, `max`, `median`, `mad`) et rien pour un simple décompte d'événements (`paste_events`,
`focus_losses`), l'**unité** en dernier, toujours abrégée (`_ms`, `_chars`) et seulement quand la
valeur en a une. **Une durée se compte en millisecondes**, comme les flight times : le capteur
mesure en millisecondes et n'a aucune raison d'arrondir avant d'envoyer.

Laissés à eux-mêmes, les noms se font un par un et la forme se perd : l'un oublie de dire de
quoi il est l'écart, un autre écrit son unité en toutes lettres ou compte en secondes là où le
capteur mesure en millisecondes, un troisième compte des caractères sans le dire. `make check`
tient la règle — il refuse une unité écrite en toutes
lettres, une statistique en tête de nom et un nom qui se termine par `_s` — en plus de tenir le
tableau de `docs/mesures.md` et le code d'accord.

## La forme d'une mesure n'est pas libre

Le moteur reconnaît le sérialiseur d'un agent à **l'ordre** des clés, et il n'en connaît que
quatre : `{type, value, period}`, la même avec **`offline` ajouté**, et chacune des deux avec
**`reason` en dernier**. Un corps
indenté, une clé insérée ailleurs, ou `offline` envoyé systématiquement plutôt que seulement
quand il est vrai : chacun sort de la forme acceptée. Ce que le moteur en fait se documente de
son côté — ici on tient le contrat, pas ses conséquences.

`offline` décrit la **fenêtre**, pas la file : vrai si, à la clôture de la fenêtre, la dernière
tentative d'envoi avait échoué — jamais `navigator.onLine`, qu'un portail captif trompe et que
deux agents sur quatre n'ont pas. Il est posé à la mise en file, pas au départ.

`reason` dit **lequel des déclencheurs a scellé la fenêtre**, dans un vocabulaire de six mots
qui est celui du moteur (`docs/mesures.md`, *Pourquoi la fenêtre s'est fermée*). Une fenêtre
n'est pas une rafale de frappe : le moteur ne voit que la suite des fenêtres, et sans ce mot un
enregistrement qui coupe une rafale y ressemble à quelqu'un qui ne s'arrête jamais, tandis
qu'une sortie vers une seconde fenêtre y ressemble à un silence de réflexion. Chaque agent
traduit **ses** déclencheurs dans une table `WIRE_FLUSH_REASONS`, en tête de son capteur ; un
déclencheur absent de la table n'envoie rien, ce que le moteur lit comme un agent qui ne sait
pas le dire. `make check` compare la table de chaque agent à ses propres appels — une règle
qu'aucune suite d'agent ne peut voir.

Et une règle qui ne souffre pas d'exception : **ne jamais déclarer `away` sans avoir compté la
sortie**. Contrairement à `offline`, cette déclaration rapporte quelque chose au document — le
moteur sort du rythme les silences qui suivent un départ — donc il la recoupe avec
`focus_losses`, et une fenêtre qui se contredit est signalée.

**Ajouter un champ à une mesure est donc aussi deux chantiers**, dans le même ordre.
Vérification : chaque agent tient l'ordre sur son propre sérialiseur —
`libreoffice/tests/test_engine.py` sur un vrai corps HTTP, `browser/tests/background.test.mjs`,
`vscode/tests/engine.test.mjs` et `word/tests/agent.test.mjs` sur le corps que leur `fetch`
reçoit. Un test ne peut rien dire d'un sérialiseur qu'il n'exécute pas.

**L'ordre de `period` est le même piège, et il se tend ailleurs.** La mesure est construite à
chaque envoi, donc dans l'ordre du code ; la période, elle, sort de la **file**, et une file se
relit depuis le stockage de l'hôte — `chrome.storage.local`, le stockage global de VS Code, le
profil sur disque. Ce qui en revient n'est pas l'objet qu'on y a rangé mais un objet que l'hôte
reconstruit, et **rien ne promet qu'il en garde l'ordre des clés**. Relue alphabétiquement,
`{start, end}` revient `{end, start}`. Les quatre agents **reconstruisent donc la période clé
par clé** au moment de l'envoi au lieu de transmettre celle de la file ; leurs doubles de
stockage rendent les clés dans le désordre, et l'agent Python relit une file réécrite sur le
disque — sans quoi l'assertion passerait sans rien garder.

## Écarts assumés

- **Complément Word** : pas de `flight_mad_ms`, `flight_median_ms`, `focus_losses`,
  `injected_chars_after_return` (qui suppose de savoir qu'on est revenu, donc qu'on était parti),
  ni `lexical_hesitations` et `keystrokes_after_return`, qui suivent des mêmes causes — une
  hésitation est un silence *entre deux frappes*. Office ne livre
  pas les frappes (le capteur travaille par différences de texte) ni la sortie du document ; une
  cadence calculée sur ses événements serait fausse. Une « frappe » y est un caractère inséré ou
  effacé. N'ayant jamais compté que des différences, il n'a jamais eu le biais du clic.
- **LibreOffice** : mêmes metrics et mêmes définitions que l'extension, flight times compris
  (`XUserInputInterception` donne clavier et souris) ; seule exception, son gestionnaire de clic
  ne donne pas de coordonnées, donc une sélection **tracée à la souris** n'y est pas détectable.
- **VS Code** : pas de `paste_events`, ni de `self_paste_events` — l'API donne le texte inséré et
  la *longueur* de ce qu'il remplace, jamais son contenu, donc rien à comparer à ce qui sort du
  document. La restitution y est reconnue autrement, sur le **document** (une insertion qu'il
  contenait déjà ailleurs est une duplication, comparaison exacte), et son **volume** est mesuré
  et envoyé (`self_paste_chars_total`) ; le *nombre* ne l'est pas, faute de savoir nommer le
  geste. Une insertion faite en un coup y est un collage, un
  extrait de code ou une complétion acceptée (IntelliSense, assistant), et l'API ne dit pas
  laquelle : les caractères comptent dans `injected_chars_total`, le *nombre* de collages serait
  faux. Pour la même raison les flight times ne retiennent que les modifications de la taille
  d'une frappe. Tout le reste est mesuré, y compris `focus_losses` (la fenêtre de l'éditeur perd
  le focus) et les trois cases de révision : une modification porte la longueur de ce qu'elle
  efface, et l'origine du déplacement précédent (clavier, souris, commande) est connue. Une
  frappe y est un caractère inséré ou effacé, comme dans Word.

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
est tenu par `make check` (`scripts/check-coherence.py`) : les constantes communes, les metrics
envoyées, **les générations de metrics étendues**, l'adresse du moteur par défaut, la forme des
noms et les fichiers partagés par lien symbolique.

```bash
make check                 # les quatre comparés entre eux : constantes, metrics, liens
make test                  # toutes les suites, agent par agent
make -C browser test       # un seul agent (node --test, sans dépendance)
make -C libreoffice test   # python3 -m unittest discover -s tests
make lint                  # tous les linters : JS, CSS, HTML, Python, shell
```
