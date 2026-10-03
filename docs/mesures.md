# Les mesures

Une seule définition, quatre implémentations indépendantes. Ce document est la **référence
lisible** de ce que comptent les agents ; les détails propres à chacun sont dans sa page, et la
forme de ce qui part vers le moteur — le corps, champ par champ — est dans
[moteur.md](moteur.md#le-corps-de-mesure).

| Agent | Fenêtres de mesure | Capteur |
| --- | --- | --- |
| Extension navigateur | `browser/src/content.js` | le même fichier (clavier et souris), quatre éditeurs |
| Complément Word | `word/src/sensor.js` | le même fichier (différences de texte) |
| Extension LibreOffice | `libreoffice/src/pythonpath/certimens_agent/measure.py` | `sensor.py` (UNO) |
| Extension VS Code | `vscode/src/sensor.js` | le même fichier (modifications du document) |

Une règle changée dans l'une doit l'être dans les trois autres, ou être justifiée par une limite
de la plateforme (voir *Écarts assumés*).

**Un capteur observe, il ne conclut pas.** Ce qu'il envoie est ce qu'il a vu — le **déroulé**
ordonné des gestes, la distribution du rythme, la portée du texte — plus les quelques nombres
que lui seul peut classer (`counts`). Tout ce qui se déduit du déroulé — le nombre de frappes,
de collages, de caractères injectés, de restitutions, de pauses, d'hésitations — est **déduit
par le moteur** et ne voyage pas : une règle de comptage de ce genre vit à un seul endroit, et
un compteur ne peut pas contredire le déroulé dont il sort.

## La fenêtre de mesure

Une **fenêtre** est ce qu'un capteur a observé sur une période. Elle va de la **première à la
dernière activité** : l'inactivité n'y entre jamais — le moteur pondère ses moyennes par la durée
des fenêtres, une fenêtre gonflée de temps mort fausserait tout.

Elle est scellée (puis envoyée) après **2 s sans activité**, à **200 frappes**, sur
**Ctrl/Cmd+S**, quand l'étudiant **quitte le document** (autre onglet, autre fenêtre, éditeur
réduit), à la fermeture du document et au moment de suspendre la mesure. Une fenêtre n'est
scellée que si elle porte une activité : une fenêtre vide ne part pas et ne consomme pas de
numéro.

Les trois derniers déclencheurs demandent que l'hôte les signale. Le complément Word ne voit ni
l'enregistrement ni la sortie du document : ses fenêtres partent sur l'inactivité, sur les
200 frappes et à la fermeture du volet. C'est sans conséquence sur ce qui est compté — une
fenêtre scellée plus tard reste la même fenêtre —, seulement sur le moment où elle part.

### La session, le numéro et les cumuls

Une **session** commence quand le capteur se met à mesurer un document — ouverture de la page,
du volet ou du fichier, reprise après une suspension, nouvel appairage — et s'achève quand il
cesse. Son identifiant est tiré au hasard (`SESSION_ID_BYTES` octets, en base64 d'URL), n'est
dérivé ni du compte ni de la machine, et n'est écrit nulle part ailleurs que dans une fenêtre
restée en file. Elle peut s'ouvrir à la première activité mesurée, qui est alors le zéro de son
horloge.

Chaque fenêtre **scellée** reçoit le numéro suivant (`seq`, depuis `0`), et les cumuls de la
session (`sum`) avancent **dans la même opération** : `keys`, les frappes ; `chars`, les
caractères injectés ; `pastes`, les collages. C'est le scellement qui numérote, pas l'envoi — y
compris pour une fenêtre qui ne partira jamais. Une fenêtre retenue en chemin se voit alors
d'elle-même : la suivante porte un numéro qui saute et des cumuls que les fenêtres reçues
n'atteignent pas, et l'écart est exactement ce que la manquante contenait.

Les cumuls sont les **seuls** décomptes tirés du déroulé qu'un capteur tient encore, et il les
tient avec les règles mêmes du moteur : `keys` additionne les `n` des suites `type`, `erase`,
`nav` et `other` ; `pastes` compte les suites `paste` ; `chars` additionne celles qui dépassent
`INJECTION_MIN_CHARS`. C'est pour `chars` que cette constante reste dans les capteurs.

La fenêtre est datée sur **deux horloges** : `at`, l'horloge murale à sa première activité, et
`mono`, le même instant sur une horloge monotone dont le zéro est le début de la session, que
l'étudiant ne peut pas régler. Sa durée (`ms`) est lue sur l'horloge monotone. Le moteur lit
l'écart entre les deux horloges d'une fenêtre à l'autre.

## Pourquoi la fenêtre s'est fermée

Une fenêtre **n'est pas une rafale de frappe** : c'est une période qu'un agent a décidé de
clore, et les déclencheurs ci-dessus ne disent pas du tout la même chose de l'étudiant. Le
moteur ne peut pas les distinguer tout seul : il ne voit que la suite des fenêtres, et un
enregistrement qui coupe une rafale en deux y ressemble à quelqu'un qui ne s'arrête jamais,
tandis qu'une sortie vers une seconde fenêtre y ressemble à un silence de réflexion. Chaque
fenêtre part donc avec le mot qui dit ce qui l'a fermée, dans son champ `why`.

Le vocabulaire fait six mots et il est le même pour les quatre agents. C'est le moteur qui le
tient : y ajouter un mot est un chantier de son côté d'abord.

| Mot envoyé | Ce qu'il dit |
| --- | --- |
| `idle` | l'étudiant a cessé de taper : ce qui suit est un vrai silence |
| `volume` | `FLUSH_KEYSTROKES` atteintes, ou un déroulé qui approche `TIMELINE_MAX_RUNS` : c'est le compteur qui s'est arrêté, pas l'étudiant |
| `save` | une action explicite a scellé la fenêtre en pleine rédaction — un enregistrement, et chez VS Code un rendu, un renommage, un « envoyer maintenant » |
| `focus` | le focus a quitté le document sans que l'étudiant le quitte (en-tête de Word Online) |
| `away` | l'étudiant a quitté le document, et la sortie a été comptée |
| `end` | la séance s'achève : page fermée, éditeur quitté, mesure suspendue |

Chaque agent traduit **ses** déclencheurs vers ces six mots, dans une table
`WIRE_FLUSH_REASONS` qu'il déclare en tête de son capteur. Les agents n'ont pas les mêmes
déclencheurs — le complément Word ne voit pas la sortie du document, donc il n'envoie jamais
`away` ; l'extension VS Code en a le plus, puisqu'une commande peut y sceller une fenêtre.

`why` est **obligatoire** : une fenêtre sans mot est refusée par le moteur. Un déclencheur
absent de la table est donc une fenêtre perdue, et rien chez l'étudiant ne le dirait — c'est
pourquoi `make check` compare la table de chaque agent à ses propres appels, et refuse un mot
hors du vocabulaire.

## Constantes communes

Identiques dans les quatre implémentations, à ne pas désynchroniser :

| Constante | Valeur | Ce qu'elle borne |
| --- | --- | --- |
| `FLUSH_KEYSTROKES` | 200 | la fenêtre est scellée au bout de 200 frappes |
| `IDLE_FLUSH_MS` / `IDLE_FLUSH_S` | 2 s | la fenêtre est scellée après 2 s sans activité |
| `GAP_MIN_MS` | 1 s | le plus court silence entre deux frappes comptées qui s'écrit en `gap` dans le déroulé |
| `ACTIVE_GAP_MAX_S` | 60 s | ce qu'un trou ajoute au temps effectif (`active`) |
| `INJECTION_MIN_CHARS` | 15 | en deçà, un collage n'est pas une injection : le capteur en a besoin pour `sum.chars` et `counts.back_chars` |
| `FLIGHT_MAX_MS` | 800 | au-delà, l'écart entre deux frappes n'est pas un flight time |
| `SHINGLE_WORDS` | 4 | la taille d'une empreinte : quatre mots consécutifs |
| `SELF_PASTE_RATIO` | 0,7 | recoupement au-delà duquel un collage est le texte de l'étudiant |
| `SELF_PASTE_TTL_MS` / `SELF_PASTE_TTL_S` | 3600 s | délai sans servir au bout duquel une sortie n'est plus comparable |
| `SELF_PASTE_MAX_COPIES` | 20 | nombre de sorties retenues : la mémoire est bornée |
| `ERASE_RUN_REFORMULATES` | 6 | à partir de là, une rafale de suppression d'un seul tenant n'est plus une coquille |
| `NAV_STEPS_AWAY` | 2 | nombre de pas à partir duquel on est reparti dans le texte : une flèche vaut un pas, un saut (Début, Fin, page, mot, clic) en vaut deux |
| `RETURN_WINDOW_MS` / `RETURN_WINDOW_S` | 15 s | après un retour au document, délai pendant lequel ce qui est collé ou tapé vient peut-être d'ailleurs |
| `TIMELINE_MAX_RUNS` | 512 | le nombre de suites qu'un déroulé peut porter : la fenêtre est scellée avant |
| `SESSION_ID_BYTES` | 16 | les octets tirés au hasard derrière un identifiant de session (128 bits) |

**Les seuils qui lisent un silence ne sont pas ici, et c'est voulu.** Ce qui fait d'un silence
une hésitation (de 1 à 3 s incluses) ou une pause (au-delà de 3 s, jusqu'à 5 minutes) est une
règle du **moteur** : un capteur écrit le silence à sa durée réelle et ne le classe pas.
`GAP_MIN_MS` ne dit que **ce qui s'écrit** ; `ACTIVE_GAP_MAX_S` borne
une tout autre règle, ce qu'un trou crédite en temps de frappe. Ne pas les rapprocher.

L'extension VS Code ajoute `SELECTION_ECHO_MS` (50 ms), qui n'a de sens que chez elle : l'éditeur
signale un déplacement du curseur après chaque frappe, et sans ce délai `counts.jumps` suivrait
exactement le nombre de frappes.

## Le déroulé

Ce qui s'est passé dans la fenêtre, dans l'ordre : `runs`, une liste de **suites** — « 20
frappes en 4,1 s », un silence, trois déplacements. C'est la pièce centrale de la fenêtre :
jamais vide, jamais abandonnée, et c'est d'elle que le moteur tire les décomptes. Une suite a
l'une de **trois formes**, selon son genre ([moteur.md](moteur.md#runs--le-déroulé)) :
`[genre, n, ms]` pour les quatre genres de frappe, `[genre, n]` pour un geste sans durée,
`["gap", ms]` pour un silence.

| Genre | `n` | Ce que c'est |
| --- | --- | --- |
| `type` | frappes | frappes qui **insèrent** un caractère |
| `erase` | frappes | Retour arrière, Suppr, et leurs variantes par mot |
| `nav` | frappes | déplacements **au clavier** (flèches, Début, Fin, pages), chez les capteurs pour qui ce sont des frappes (extension, LibreOffice) |
| `other` | frappes | toute autre frappe comptée : un raccourci, une touche nommée, la frappe que vaut une restitution |
| `move` | déplacements | déplacements du curseur qui ne sont **pas** des frappes pour ce capteur : ceux qu'un capteur par différences ou par événements d'éditeur voit sans voir la touche (Word, VS Code au clavier) |
| `click` | clics | clics **dans le document**. Sans durée : un clic tombe souvent dans un silence, et lui en donner une ferait compter deux fois le même temps |
| `paste` | caractères | un collage ou un glisser-déposer venu d'ailleurs — **une suite par geste**, quelle que soit sa taille |
| `self` | caractères | une restitution reconnue (le texte de l'étudiant qui revient) — une suite par geste |
| `copy` | caractères | du texte **sorti** du document : copier, couper, début de glisser. `0` si le capteur voit le geste sans sa taille |
| `undo` | gestes | annulations (refaire n'est pas envoyé : il ne compte rien) |
| `fix` | gestes | orthographes choisies dans un correcteur |
| `gap` | — | un silence entre deux **frappes** comptées ; la suite ne porte que sa durée |

Deux suites voisines n'ont jamais le même genre — un geste de plus du même genre allonge la
suite en cours — sauf `gap`, `paste` et `self`, qui restent un par un. Au plus
`TIMELINE_MAX_RUNS` suites : une fenêtre qui s'en approche est **scellée avant**, avec `volume`,
comme celle qui atteint `FLUSH_KEYSTROKES`. Un capteur n'abandonne ni ne tronque jamais son
déroulé : il n'a pas d'autre moyen de dire ce qu'il a compté.

**Une frappe entre dans le déroulé par la fonction même qui la compte**, jamais par un second
classement à côté : c'est ce qui fait que `sum.keys`, tenu par le capteur, et le nombre de
frappes que le moteur déduit ne peuvent pas diverger.

### Le silence

Un `gap` s'écrit pour **tout silence d'au moins `GAP_MIN_MS` entre deux frappes comptées**, à sa
durée réelle, non plafonnée — et nulle part ailleurs. Le capteur ne le classe pas. Quatre
règles, et chacune a été un piège :

- **Le silence se mesure depuis la dernière frappe comptée**, et s'écrit quand une frappe
  comptée reprend : un caractère, une suppression, un déplacement au clavier, une annulation.
  Un clic, un collage (son raccourci compris, qui ne compte pas de frappe), une orthographe
  choisie dans le correcteur ne terminent pas un silence et ne le remettent pas à zéro :
  s'arrêter, lire une minute la souris à la main puis reprendre, c'est **un** silence, écrit à
  la reprise.
- **Le silence qui a précédé la première frappe de la fenêtre en est toujours la première
  suite**, même si un clic ou un collage l'a ouverte avant : il a commencé avant elle, et c'est
  le seul que le moteur ne retient pas contre sa durée. Les autres prennent place là où ils ont
  commencé, avant les clics faits pendant.
- **Un silence ne traverse jamais une session.** Il se mesure depuis la dernière frappe de la
  session **en cours** : la première frappe après une ouverture, une suspension levée ou un
  nouvel appairage ne termine aucun silence, et la première fenêtre d'une session (`seq` à `0`)
  n'en porte donc jamais en tête. Ce qui s'est passé pendant que rien n'était mesuré n'est pas
  un silence de l'étudiant.
- **Toute durée se lit sur l'horloge monotone** : la durée de la fenêtre (`ms`), le temps de
  frappe (`active`), la durée d'une suite et celle d'un silence, les écarts entre frappes et
  les durées d'appui. L'horloge murale, que l'étudiant peut régler, ne donne que `at` (et
  `sent`, à l'envoi) : une durée lue dessus bougerait avec elle.
- **Les durées ne se recouvrent jamais.** Seuls les quatre genres de frappe et le silence en
  ont une ; une suite de frappes s'arrête où le silence commence ; un clic n'en a pas, et la
  frappe que vaut une restitution non plus (`ms` à `0`) — elle n'est pas sur l'horloge du
  clavier. La somme des durées, hors silence de tête, ne dépasse donc pas celle de la fenêtre.
- **Un silence d'au plus 3 000 ms (inclus) qu'achève une touche prise par une composition**
  (palette d'accents, IME) n'est pas écrit : la touche ne dit rien d'une recherche de mot. Et
  un capteur qui ne résout pas les silences courts n'écrit que ceux de **plus de 3 000 ms**, en
  le déclarant (`unseen: ["hesitations"]`, voir *Écarts assumés*). Ce seuil-là n'est pas une
  constante commune : seuls les capteurs concernés le tiennent, chacun sous son nom
  (`SHORT_GAP_MAX_MS` dans l'extension navigateur, `SILENCE_RESOLUTION_MS` dans le complément
  Word).

**Ce que le moteur en lit.** Entre le flight time (moins de 800 ms) et la pause, il y a
l'hésitation : un silence d'une à trois secondes, les mains sur le clavier, c'est quelqu'un qui
cherche son mot — la **preuve de vie** du modèle, parce que quelqu'un qui recopie un texte déjà
écrit n'hésite pas sur un mot posé sous ses yeux. Au-delà de trois secondes et jusqu'à cinq
minutes, c'est une pause de réflexion ; au-delà, l'étudiant a quitté le document. Ces bandes
sont celles du moteur ([moteur.md](moteur.md#ce-que-le-moteur-déduit-du-déroulé)), et elles
peuvent bouger sans qu'aucun capteur change : c'est la raison pour laquelle un silence part à sa
durée réelle, y compris celui qui est trop long pour être l'une ou l'autre.

**Une suite ne se coupe jamais sur ce qui a été tapé.** Une espace, une virgule, Entrée et une
lettre sont la même frappe `type` : aucune suite n'a la longueur d'un mot. Dans l'extension,
AltGr arrive comme Ctrl+Alt sous Windows et tape `@`, `#`, `{` ou `€` sur un clavier français :
ce n'est pas un raccourci, et le lire comme tel couperait la suite sur une classe de
caractères.

## Ce que seul le capteur sait classer

Classer une suppression en correction ou en reformulation demande de savoir quelle touche,
quelle sélection, quel clic l'a précédée — ce que le déroulé ne porte pas et qui ne quitte
jamais le poste. Ces nombres-là voyagent, dans `counts` : des entiers, et **une clé que le
capteur ne sait pas mesurer est absente**, jamais à zéro.

| Clé | Ce que c'est |
| --- | --- |
| `corrections` | Backspace/Suppr sur ce qu'on vient de taper, sans avoir bougé, tant que la rafale n'atteint pas `ERASE_RUN_REFORMULATES` caractères ; Ctrl/Cmd+Z ; une orthographe choisie dans le correcteur |
| `reformulations` | **première** Backspace/Suppr après un déplacement (clic ou touche) ; un mot effacé au raccourci ; une rafale de suppression qui atteint `ERASE_RUN_REFORMULATES` caractères (comptée une fois) ; une insertion après un trajet (`NAV_STEPS_AWAY` pas) ; remplacement d'une sélection Maj+flèches |
| `revisions` | Ctrl/Cmd+X, remplacement d'une sélection Ctrl/Cmd+A ou tracée à la souris, première restitution d'un bloc |
| `jumps` | flèches, Début/Fin, Page préc./suiv., clics dans le document |
| `exits` | sorties du document pendant la fenêtre |
| `back_keys` | frappes dans les `RETURN_WINDOW_MS` suivant un retour au document |
| `back_chars` | caractères injectés (collages de plus d'`INJECTION_MIN_CHARS`) dans les `RETURN_WINDOW_MS` suivant un retour |

À côté de `counts`, la fenêtre porte `active`, le **temps de frappe effectif** : l'écart réel
entre deux activités s'il ne dépasse pas 2 s, 250 ms forfaitaires jusqu'à `ACTIVE_GAP_MAX_S`,
rien au-delà. Les règles exactes de chaque clé sont la section suivante.

## Règles de comptage

**Une suppression solde le déplacement qui la précède.** La première touche Suppr après un
déplacement — clic ou flèche — est une reformulation différée, et **les suivantes sont des
corrections immédiates** : on efface là où on se trouve. Sans cette remise à zéro (le
comportement hérité des agents de bureau), un seul clic suffisait à faire compter toute une
rafale de suppressions en reformulations, et `counts.corrections` restait à zéro chez un
étudiant qui clique avant de corriger.

### Les trois clés de remaniement, et celle qui ne se déclenchait jamais

`counts.reformulations` ne se déclenchait pour ainsi dire jamais, pendant que
`counts.corrections` se remplissait. Ce n'était pas que personne ne reformule : c'est que la
définition ne décrivait pas le geste. La branche « reformulation » ne s'ouvrait que sur une
séquence étroite — déplacer le curseur **aux flèches**, puis commencer par Suppr. Quatre façons
ordinaires de reformuler passaient à côté :

- **Reprendre sa fin de phrase**, sans flèche, le curseur y étant déjà : `Ctrl`/`Cmd`+Suppr, ou
  une rafale de Suppr. Tout partait en corrections immédiates, confondu avec une coquille.
- **Cliquer sur le mot à reprendre** plutôt que reculer de trente caractères. Le clic envoyait la
  suppression en **révision massive**, à cinq fois le poids : le compteur du milieu se vidait par
  le haut autant que par le bas.
- **Insérer sans supprimer** : reculer dans la phrase et taper le mot qui manquait. La première
  touche après les flèches étant une lettre, le déplacement était perdu en silence.
- **Maintenir la touche** enfoncée : la répétition automatique étant écartée, une phrase effacée
  d'une pression tenue valait une suppression, donc une coquille — là où les deux agents qui
  lisent le texte voyaient partir vingt caractères.

La frontière des trois, désormais :

| Clé | Le geste | Pourquoi là |
| --- | --- | --- |
| `counts.corrections` | Réparer sur place ce qu'on vient de taper : moins de `ERASE_RUN_REFORMULATES` caractères d'un seul tenant, sans avoir bougé | Une coquille, pas une décision sur le texte |
| `counts.reformulations` | Revenir sur ce qui est écrit : un mot effacé au raccourci, une rafale de suppression d'un seul tenant — touche martelée ou maintenue — qui atteint `ERASE_RUN_REFORMULATES` caractères, un retour (clic, ou `NAV_STEPS_AWAY` pas) suivi d'une suppression **ou d'une insertion** | Le mot est retiré parce qu'il a été jugé, pas parce qu'il a été mal frappé |
| `counts.revisions` | Les gestes de bloc : une sélection tracée ou `Ctrl`/`Cmd`+`A` remplacée, `Ctrl`/`Cmd`+`X` — et, chez les deux agents qui lisent le texte, une suppression de plus d'`INJECTION_MIN_CHARS` caractères d'un coup (voir *Écarts assumés*) | C'est ce qui justifie son poids dans le taux de remaniement — un clic simple ne restructure rien |

Trois garde-fous, parce qu'un compteur qui se déclenche sur tout ne sépare plus rien :

- **Un geste n'est compté qu'une fois.** Une suppression de vingt caractères est *un*
  remaniement, pas vingt ; au-delà du seuil, la suite de la rafale n'est plus comptée du tout.
  Les deux agents qui mesurent par différences de texte comptaient une reformulation **par
  caractère** : le compteur pouvait être gros pour une retouche minime et vide pour un vrai
  remaniement.
- **Le déplacement reste soldé par la suppression qui le suit**, règle qui précède cet
  élargissement et reste délibérée (voir juste au-dessus).
- **Une seule flèche ne suffit pas** à faire d'une insertion un remaniement : un caractère de
  recul est un effleurement, deux sont un trajet — et un saut en est un à lui seul : Début, Fin,
  une page, une flèche avec `Ctrl`/`Cmd`/`Option` qui franchit un mot, un clic. Et une sélection
  qu'on vient de remplacer n'est **pas** recomptée comme un trajet : Maj+flèches déplace le
  curseur en même temps qu'elle étend la sélection, et un acte ne vaut pas deux remaniements.

**La rafale et le trajet, vus par chaque capteur.** La règle est la même, le signal diffère.
L'extension et LibreOffice comptent la rafale **à la touche** : les cinq premières pressions sont
des corrections, la sixième est le remaniement, les suivantes ne comptent plus ; une touche
**maintenue** reste *une* frappe et *une* suppression, mais ses répétitions allongent la rafale,
sinon une phrase effacée d'une pression tenue ne serait jamais qu'une coquille. Word et VS Code
voient les caractères partir, en une différence ou en plusieurs : un mot retiré d'un coup
franchit le seuil à lui seul, une touche martelée le franchit en chemin, et les deux comptent
alors pareil que les agents à touches. Pour le trajet, l'extension et LibreOffice lisent la
**touche** (flèche : un pas ; Début, Fin, page, flèche modifiée : `NAV_STEPS_AWAY`), VS Code
lit la **distance** — un caractère sur la ligne ou une ligne au-dessus, c'est une flèche ; plus
loin, c'est un saut —, et Word ne voit qu'un événement par déplacement, un pas chacun.

**Ce que ça déplace.** Du volume passe d'un compteur à l'autre, donc le taux de remaniement que
le moteur en tire change : ce qui partait en révisions massives sur un simple clic en sort. Les
seuils du moteur n'ont pas été retouchés en même temps — un seul changement d'échelle à la fois —
et devront être relus sur des mesures prises après celui-ci.

**Une orthographe choisie dans le correcteur est la correction immédiate qu'elle est.** Réparer
une faute en cliquant la bonne orthographe et la réparer au Retour arrière sont le même acte
d'édition — une décision sur une lettre — et seul le second la créditait : quarante fautes
réparées au clic valaient quarante remaniements de moins que les mêmes réparées au clavier, soit
une pénalité pour avoir utilisé une fonction de son traitement de texte. Le clic qui choisit une
suggestion n'est donc **pas** un saut de navigation — le correcteur dessine ses propositions
*dans* la zone d'édition, et chaque correction y coûtait deux traversées du document — tandis que
le clic droit qui ouvre le menu, lui, reste compté : là, l'étudiant est bien allé jusqu'à ce mot.
Elle solde ce geste, comme une suppression solde le clic qui la précède, sans quoi le Retour
arrière suivant passerait pour une révision massive chez quelqu'un qui a seulement réparé une
faute. Et **aucune frappe n'est inventée** : le mot que l'étudiant n'a pas retapé n'a pas été
tapé, `text.len` se compare au document déposé, et gonfler le nombre de frappes serait la
falsification que tout le reste refuse — il reste donc un écart résiduel assumé, de l'ordre d'un
caractère par correction.

Encore faut-il voir le correcteur, et les quatre agents n'y sont pas égaux. L'extension le
reconnaît par un sélecteur **propre à chaque éditeur** (`correctionMenu` dans `EDITORS`), laissé
vide tant que le DOM n'a pas été lu dans un vrai document : un sélecteur que personne n'a vérifié
ne compterait rien, en silence. Word et VS Code, qui lisent le texte, voient le remplacement par
leur différence et le comptent déjà ; ils en comptent aussi les caractères en frappes, ce qui est
leur définition de la frappe — un caractère inséré ou effacé — et non une entorse nouvelle.
LibreOffice ne voit ni l'un ni l'autre : son capteur n'intercepte que la fenêtre du document, et
le menu contextuel de Writer est une fenêtre à part.

**Remplacer une sélection est une suppression**, à l'échelle de la sélection. Taper ou coller
par-dessus une sélection efface tout ce qu'elle couvre : c'était invisible tant que le capteur ne
regardait que Backspace, Suppr, Ctrl+X et Ctrl+Z. Une sélection en cours est donc suivie —
Ctrl/Cmd+A ou un tracé à la souris pour un bloc, Maj + touche de déplacement pour une portion
ciblée — et la frappe ou le collage qui la remplace est compté à cette échelle. Maj seule ne
sélectionne rien (c'est aussi ainsi qu'on tape les majuscules), un déplacement sans Maj ou un
clic annule la sélection, et elle n'est décomptée qu'une fois. Le cas « tout sélectionner puis
coller la réponse » ne comptait auparavant qu'une injection, jamais une révision.

**Une orthographe choisie dans un correcteur est une correction immédiate.** Réparer une faute
en cliquant la bonne orthographe et la réparer au Retour arrière sont le même acte d'édition — une
décision sur une lettre —, et c'est la définition même d'`counts.corrections`. Un capteur qui
ne voit pas ce geste compte zéro remaniement là où l'étudiant en a fait quarante : une pénalité
pour avoir utilisé le correcteur de son éditeur. La règle est appliquée côté moteur ; aucun des
quatre agents ne la tient encore (voir *Écarts assumés*), et c'est la définition à reprendre le
jour où l'un d'eux sait nommer le geste. Trois précisions, et la dernière est celle qui coûte :

- **Un remaniement, jamais une frappe.** Le mot que l'étudiant n'a pas retapé n'a pas été tapé.
  Gonfler les suites `type` de ses caractères fausserait la part tapée, que le moteur recoupe
  avec le document déposé, et c'est exactement la falsification que le reste de ces règles
  refuse. Le résidu est assumé : le mot corrigé est souvent un peu plus long que le mot fautif,
  donc chaque correction laisse un caractère environ sans frappe en face.
- **Un clic dans un menu dessiné à l'intérieur de la zone d'édition n'est pas un saut de
  navigation** — les suggestions d'un correcteur, le menu contextuel d'un éditeur, un sélecteur
  de sa barre d'outils. Cliquer une ligne de menu est une décision sur l'interface, pas un
  déplacement dans le texte, et la compter faisait valoir deux traversées du document à chaque
  correction. Le clic droit qui ouvre le menu, lui, reste un saut : l'étudiant est bien allé
  jusqu'à ce mot. Et le geste **solde le déplacement**, au même titre qu'une suppression :
  sans ça, le clic qui a ouvert les suggestions fait compter la suppression suivante en révision
  massive, pour quelqu'un qui venait de réparer un mot.
- **Une correction n'est pas une complétion.** Une complétion pose du texte que personne n'a
  écrit ; une correction **remplace** du texte que l'étudiant a tapé. Le premier geste est un
  problème d'attribution de volume (*Écarts assumés*), le second est un remaniement. Les ranger ensemble parce que ni l'un ni
  l'autre n'a de touche derrière lui donnerait à l'étudiant une injection là où il a révisé.

**Un silence s'écrit, il ne se classe pas.** Les capteurs comptaient eux-mêmes les pauses et les
hésitations, sur des seuils tenus quatre fois ; ils écrivent désormais chaque silence d'au moins
`GAP_MIN_MS` entre deux frappes comptées, à sa durée réelle, et c'est le moteur qui y lit une
hésitation ou une pause (voir *Le silence*, plus haut). Deux pièges d'alors restent des règles
du capteur, parce qu'ils tiennent à **ce qui ouvre et ferme un silence** : il ne se mesure
qu'entre deux frappes **comptées** — jamais depuis la dernière touche *pressée*, ce qu'est le
raccourci de collage, ni jusqu'à un clic ou un collage, sans quoi une fenêtre portait plus de
silences que de frappes — et un même silence ne s'écrit qu'**une** fois. Word, qui ne voit pas
les touches, en écrit au plus un par différence **tapée** ; VS Code l'écrit sur une insertion
tapée, un effacement ou une annulation, jamais sur une injection ni sur un déplacement du
curseur.

**La répétition automatique ne compte pas** : garder Suppr enfoncée pour effacer un mot vaut une
seule suppression.

**Une touche de modification seule n'est pas une frappe.** Maj, Ctrl, **Cmd**, Alt/Option, AltGr,
Verr. Maj, Fn — toutes celles que la plateforme nomme — pressée pour elle-même n'écrit rien :
elle n'ouvre pas de fenêtre, n'entre dans aucune suite du déroulé et n'entre pas dans les
flight times — l'écart minuscule qu'elle laisse avant la lettre qu'elle
modifie passerait pour une frappe impossiblement rapide et régulière, ce que `flight.mad` et
`flight.med` servent justement à distinguer. Elle ne solde pas non plus le déplacement qui
la précède : un Maj glissé entre un clic et une Suppr laisse la suppression compter pour une
révision massive. La règle ne concernait que l'extension navigateur et LibreOffice, les seuls à
voir les touches ; Word et VS Code, qui comptent des caractères, n'en voyaient déjà aucune — les
compter d'un côté faisait paraître le même étudiant plus rapide et plus prolixe dans le
navigateur que dans un éditeur. L'extension les reconnaît **par leur nom** (`MODIFIER_KEYS`,
les valeurs de la spécification UI Events), LibreOffice **par leur forme** — un événement UNO
sans code de touche ni caractère —, et c'est pour cela que seule la première a une liste à tenir
à jour : une touche qui y manquerait compterait pour une frappe qu'elle n'a jamais été.

**Une touche morte n'est pas une frappe non plus.** `^` qui attend le `e` dont il fera `ê`
n'écrit rien par lui-même : c'est un modificateur qui ne dit pas son nom, et il est écarté comme
tel. Le compter donnait deux frappes là où Word et VS Code, qui comptent des caractères, en
comptent une.

**Une frappe prise par une composition compte, et rien d'autre n'en est lu.** La palette
d'accents que macOS ouvre sur une lettre maintenue, un IME : ces touches-là finissent par écrire,
donc elles sont des frappes `type` — les ignorer ferait passer pour un colleur un
étudiant qui tape en japonais. Mais elles ne disent rien de l'endroit où il se trouve dans son
document, ni de son rythme : elles n'entrent ni dans `counts.jumps`, ni dans les flight
times, et elles ne soldent pas le déplacement ou le clic qui les précède. Les flèches qui
parcourent la palette étaient comptées comme des sauts, et faisaient passer la suppression
suivante pour une reformulation différée chez quelqu'un qui n'avait jamais quitté sa ligne.

Les trois formes que le navigateur envoie : `key: "Dead"` (touche morte), `isComposing` (pendant
une composition) et `key: "Process"` (la touche avalée par un IME). **Ce qui reste à confirmer
sur une vraie machine** : que la palette de macOS lève bien `isComposing` dans Chrome et Safari.
Les deux autres formes sont celles de la spécification. Côté LibreOffice, une touche morte tombe
*probablement* déjà dans la catégorie `MODIFIER` — le capteur UNO reconnaît un modificateur à sa
forme, un événement sans code de touche ni caractère — mais cela n'a pas été vérifié dans un
vrai LibreOffice avec une disposition française.

**Refaire n'est pas annuler.** Ctrl/Cmd+Z est une correction immédiate ; Ctrl/**Cmd+Maj+Z** remet
ce que l'étudiant avait enlevé, et ne compte pour rien. Les compter ensemble gonflait
`counts.corrections` chez quiconque hésite à voix haute — et sur un Mac, où Cmd+Maj+Z *est* le
raccourci de « refaire », chez quiconque s'en sert. La sélection en attente s'effondre dans les
deux cas.

**Cmd est lu partout où Ctrl l'est** : l'extension teste `ctrlKey || metaKey`, LibreOffice le
modificateur UNO `MOD1`, qui *est* Cmd sur macOS. Un raccourci ajouté d'un côté sans l'autre
ferait d'un étudiant sur Mac un étudiant qui ne coupe ni n'annule jamais.

**Un collage pèse ce qu'il a posé, pas la touche qui l'a posé.** Ctrl/Cmd+V ne compte aucune
frappe par elle-même : ce que le collage met dans le document est pesé par le gestionnaire de
collage — **une** frappe pour le texte de l'étudiant qui revient, **aucune** pour une injection —
et pesé là quel que soit le geste, le menu, la barre d'outils et le glisser-déposer n'ayant
aucune touche à compter. Compter la touche *en plus* faisait coûter deux frappes au clavier ce
qui en coûtait une au menu, et une frappe au clavier ce qui n'en coûtait aucune au menu ; les
quatre agents comptent désormais pareil, Word et VS Code n'ayant jamais vu de touche. Cmd est lu
partout où Ctrl l'est, Maj n'est pas exclue — « coller sans mise en forme » est un collage — et
**Maj+Inser** en est un troisième, là où le clavier en a un. Ctrl/Cmd+C reste une frappe
ordinaire : il ne pose rien dans le document, donc aucun autre gestionnaire ne le compte.

**Son propre texte qui revient n'est pas une injection.** Un étudiant qui copie son paragraphe,
le passe à un correcteur (Scribens, Antidote, un traducteur) et recolle la version corrigée ne
colle pas le texte de quelqu'un d'autre : il révise le sien. Le collage compte alors pour une
**révision massive** (`counts.revisions`) et une frappe — le bloc remplacé —, jamais pour un
collage : dans le déroulé, une suite `other` d'une frappe sans durée, puis une suite `self` qui
porte la taille du bloc, et aucune suite `paste`.

**Le même bloc recollé plusieurs fois reste le sien.** Copier un paragraphe de son document et le
recoller dix fois, à une heure d'intervalle s'il le faut, ne produit aucun collage : à partir du
deuxième retour, le bloc ne compte même plus pour une révision — il n'a pas été révisé dix fois,
il a été dupliqué — mais toujours pour une frappe, comme le bloc qu'il pose.

La suite `self` porte le **volume** du bloc, et il y en a une par geste : quatre restitutions ne disent pas si c'est un paragraphe ou un tiers du document qui
est passé par le correcteur. C'est exactement le volume dont le même texte aurait été accusé
s'il avait été collé par quelqu'un qui ne l'a jamais écrit — le moteur lit donc les suites
`self` contre les suites `paste`.

Une restitution est écrite pour elle-même, par sa suite `self`. Sans elle, le moteur voit
une révision massive sans pouvoir dire si l'étudiant a réécrit son paragraphe à la main ou l'a
passé à un correcteur — deux gestes différents, qui ne se jugent pas pareil. C'est aussi la seule
trace par laquelle une régression de cette reconnaissance se verrait : tout le reste de la règle
est, par construction, invisible côté moteur.

Pour le reconnaître, chaque agent retient ce qui **sort** du document — un Ctrl+C, un Ctrl+X,
dans Word le texte que la différence voit disparaître **et le bloc que l'étudiant sélectionne** —
sous forme d'**empreintes** : des suites de quatre mots réduites à un nombre (FNV-1a 32 bits),
jamais le texte. Un collage dont au moins
70 % des empreintes se retrouvent dans ce qui est sorti depuis moins d'une heure est une
restitution. La normalisation (casse, accents, ponctuation, espaces) absorbe exactement ce qu'un
correcteur modifie, et le seuil laisse la place à une phrase ou deux réécrites. Au-delà, le
texte a trop changé pour être encore celui qui est sorti.

Un texte plus court qu'une empreinte — deux mots déplacés d'une phrase à l'autre — est haché
**entier** plutôt qu'abandonné : sans cela, déplacer « développement durable » dans son propre
document comptait pour une injection, puisque rien n'avait été retenu à la sortie. Une empreinte
de moins de quatre mots ne peut jamais correspondre qu'à un collage tout aussi court, donc elle
n'excuse pas davantage un texte venu d'ailleurs.

Le garde-fou qui reste est le temps : une sortie est oubliée au bout d'**une heure sans
servir** — le délai repart à chaque collage reconnu, sans quoi un bloc qu'on recolle toute la
soirée finirait par passer pour une injection. Vingt sorties au plus sont gardées, et c'est la
moins récemment vue qui cède la place, jamais celle dont l'étudiant se sert encore. Dix minutes
et cinq sorties, les bornes d'avant, démentaient la règle au-dessus : un aller-retour chez un
correcteur prend le temps qu'il prend, et le texte qui revenait après en était un d'ailleurs. Un étudiant
ne peut donc pas « blanchir » un texte étranger en copiant d'abord le sien : ce qui revient doit
toujours ressembler à ce qui est sorti.

**Word ne voit pas le presse-papiers, mais il voit la sélection.** Un complément Office ne reçoit
aucun événement de copie : seul ce que la différence voyait disparaître — une coupe, une
sélection remplacée — était retenu, si bien que le geste le plus banal qui soit, copier une de
ses phrases et la recoller plus bas, comptait pour du texte importé de l'extérieur. Le bloc
sélectionné est donc retenu lui aussi, et ce qu'il peut excuser est borné par ce qu'il est : du
texte lu **dans le document**, donc jamais un texte venu d'ailleurs. Une sélection qu'on étend
touche après touche reste une seule sélection : elle n'est hachée qu'une fois qu'elle a cessé de
bouger, et son entrée est **mise à jour**, pas ajoutée — sans quoi les vingt sorties gardées se
rempliraient des préfixes d'un même paragraphe, et tout le bloc serait rehaché à chaque touche.
Re-sélectionner un bloc avant de le recoller — ce que fait tout le monde, plutôt que de se fier
au presse-papiers — ne lui rend pas son histoire : il reste celui qui est déjà revenu, donc une
duplication et non une seconde révision.

**VS Code s'y prend autrement, parce qu'il le doit.** L'éditeur ne donne ni le presse-papiers ni
le contenu de ce qu'une modification remplace : la route des empreintes y est fermée. Il donne
en revanche le document, et un texte que le document contenait déjà ailleurs ne peut pas avoir
été importé par le geste qui l'y met une seconde fois. La comparaison y est donc **exacte** et
non empreintée : une duplication est une copie, et ce qu'un correcteur a reformulé reste une
injection — c'est le côté prudent de l'erreur. Les occurrences qu'un même geste apporte (un
collage sur cinq curseurs insère cinq fois le même texte) ne s'excusent pas elles-mêmes : le
document doit en contenir **une de plus** que l'événement n'en a apportées. Le revers est connu
et il est assumé : une complétion qui redit une ligne déjà présente — du code répétitif en
produit — y passe pour une duplication. Cet agent ne sait de toute façon pas nommer le geste,
et c'est pourquoi il n'en envoie que le volume.

**Un gros collage et vingt petits ne se valent pas**, et c'est pourquoi un collage est **une
suite `paste` par geste**, jamais fondue dans la précédente : vingt collages de cent caractères
et un seul de deux mille feraient le même total, et le déroulé les garde distincts. Le moteur
en tire le nombre de collages, le volume injecté — les suites de plus d'`INJECTION_MIN_CHARS`
caractères — et le plus gros bloc arrivé d'un coup, qui est ce qu'on cherche à voir. Dans
VS Code, c'est aussi la taille de ce qui a été accepté en un geste (une complétion, un bloc
proposé par un assistant).

**Ce qui est collé juste après un retour vient d'ailleurs.** Sortir du document, aller consulter
quelque chose, revenir et coller est un seul geste, et c'est celui qu'un étudiant fait quand il
va chercher un texte hors de son éditeur. `counts.back_chars` compte les caractères
injectés dans les **15 secondes** qui suivent un retour — et un retour n'existe que si la sortie
a été comptée (`counts.exits`), ce qui écarte les changements de focus à l'intérieur de la page.
C'est un sous-ensemble strict du volume injecté que le moteur déduit des suites `paste` : rien
n'y est compté deux fois, et seul le capteur peut le tenir, le déroulé ne datant pas le retour.

**Et ce qui est tapé juste après un retour vient peut-être d'ailleurs aussi.** Le collage après
un retour était mesuré, la frappe après un retour ne l'était pas : sortir, lire, revenir et
**taper** ce qu'on vient de lire échappait entièrement à la seule règle qui regarde ce qu'un
étudiant fait en revenant à son document. `counts.back_keys` compte les frappes des
**15 secondes** qui suivent un retour, au miroir exact de `counts.back_chars`, et aux
mêmes conditions : un retour n'existe que si la sortie a été comptée. C'est un sous-ensemble des
frappes du déroulé, jamais un ajout : toutes les **touches** y passent, une suppression et une
annulation comprises, qui en sont.

Une seule frappe en est exclue, et délibérément : celle qui tient lieu de **restitution**. Recoller
son propre texte compte pour une frappe — le bloc qu'il remplace —, mais ce n'est pas de la
frappe, et la question posée ici est « a-t-il tapé en revenant ? ». La compter gonflerait la
clé avec le seul geste que l'agent a justement reconnu comme le texte de l'étudiant.
L'écart va dans le sens prudent : le dénominateur la garde, le numérateur non, donc le rapport
est sous-estimé plutôt que l'inverse.

**Une sortie est comptée une fois, par le premier signal qui l'annonce.** Dans un navigateur,
changer d'onglet en émet deux — la page est masquée, et la fenêtre perd le focus — et le second
ne peut pas se prononcer sur-le-champ : il doit laisser passer un tour avant de demander si la
page a encore le focus, sans quoi un déplacement vers l'iframe d'édition passerait pour un
départ. Or ce tour, un onglet masqué ne l'obtient pas avant une seconde, parce que le navigateur
y ralentit les minuteries. L'étudiant qui revient aussitôt a de nouveau le focus à ce
moment-là : la vérification renonce, et le départ n'était compté nulle part. Les deux signaux
sont donc mis en commun, et c'est le fait d'être déjà sorti qui empêche d'en compter deux pour
un. Il est remis à zéro au retour : chaque aller-retour compte pour un.

## Les nombres du protocole

Ce que le corps ne dit pas et que les quatre capteurs doivent pourtant tenir pareil : les bornes
des deux histogrammes, qui ne voyagent nulle part — le corps porte des effectifs, et le moteur
les lit sur les bornes qu'il tient —, la taille d'un lot, et le plafond d'un calcul.

| Constante | Valeur | Ce qu'elle borne |
| --- | --- | --- |
| `FLIGHT_BINS_MS` | 0, 20, 40, 60, 80, 100, 130, 160, 200, 250, 320, 400, 500, 650 | bornes inférieures des quatorze tranches de flight times ; la dernière s'arrête à `FLIGHT_MAX_MS` |
| `DWELL_BINS_MS` | 0, 20, 40, 60, 80, 100, 120, 150, 200, 300 | bornes inférieures des dix tranches de durée d'appui ; la dernière est ouverte |
| `BATCH_MAX_WINDOWS` | 64 | fenêtres d'une même session dans une requête, quand une file se vide |
| `TEXT_KEPT_MAX_WORDS` | 2000 | mots de part ou d'autre d'une portée au-delà desquels `text.kept` est omis. C'est un plafond : un capteur peut s'arrêter plus bas, et l'extension navigateur s'arrête à mille |

`TIMELINE_MAX_RUNS` et `SESSION_ID_BYTES` sont dans les *Constantes communes*. Les bornes sont
déclarées dans le capteur qui remplit l'histogramme, la taille d'un lot dans le client qui
l'envoie ; `make check` compare les quatre. Un histogramme compté sur d'autres bornes serait une
autre mesure sous le même nom, de la bonne longueur, que rien ne refuserait.

### Le rythme

Deux blocs, `flight` et `dwell`
([moteur.md](moteur.md#flight-et-dwell--le-rythme)) : combien de valeurs dans chaque tranche,
**jamais leur ordre**.

- `flight` : les flight times de la fenêtre — les écarts de moins de `FLIGHT_MAX_MS` entre deux
  frappes consécutives —, leur médiane (`med`), leur écart absolu médian (`mad`) et leur
  répartition sur `FLIGHT_BINS_MS` (`bins`). Envoyé dès qu'il y en a deux, **omis sinon** : un
  zéro fausserait la moyenne. Avec un nombre pair d'écarts la médiane est la moyenne des deux du
  milieu : elle peut tomber dans une tranche vide entre les leurs, et c'est entre ces deux
  tranches que le moteur l'attend.
- `dwell` : la durée d'appui des touches `type`, de l'enfoncement au relâchement, répartie sur
  `DWELL_BINS_MS` (`bins`), et `rollover`, le nombre de touches `type` enfoncées alors qu'une
  autre ne l'était pas encore relâchée.

Les zéros de queue d'un histogramme ne s'envoient pas, et un histogramme entièrement nul part
vide.

`dwell` demande de voir une touche relâchée : seuls l'extension et LibreOffice l'envoient, et
ils l'envoient toujours, zéros compris. Le moteur attend au plus autant d'appuis que de frappes
`type` dans la même fenêtre (à deux près, pour les touches encore enfoncées au scellement), et
pas plus de chevauchements que d'appuis : l'appui et le chevauchement se comptent donc **au
relâchement, et seulement pour une touche enfoncée dans la fenêtre encore ouverte**. Un
relâchement qui arrive après le scellement n'est compté nulle part.

Pour apparier un enfoncement et son relâchement, le capteur retient l'**instant** de
l'enfoncement sous la position physique de la touche, le temps que le relâchement arrive :
dix entrées au plus, vidées quand le document est quitté, jamais journalisées ni envoyées.

### Le texte lu

Le bloc `text` ([moteur.md](moteur.md#text--le-texte-lu)) porte la taille du texte, `len`,
comptée en caractères hors sauts de ligne — comme le moteur compte le document déposé, auquel
il la compare — et, quand il y a de quoi comparer, la **portée** de ce qui a changé.

À chaque **nouvelle lecture** du texte — celle qui donne déjà la taille, jamais une lecture de
plus — l'agent la compare à la précédente par leur plus long préfixe et leur plus long suffixe
communs, sans chevauchement, et envoie des **longueurs** : `since`, le numéro de la fenêtre qui
portait la lecture précédente ; `at`, où la modification commence ; `cut`, ce qui a disparu ;
`add`, ce qui est apparu ; et `kept` quand il est calculé. La taille de la lecture précédente,
moins `cut`, plus `add`, est celle de celle-ci.

Le bloc a donc deux formes : **`len` seul** quand la fenêtre ne porte pas de lecture neuve
(taille reprise du cache) et à la première lecture d'une session, **avec la portée** à chaque
lecture qui en suit une autre — y compris identique, avec des zéros. Il est omis quand le texte
n'a pas pu être lu, et là où il ne l'est pas (Overleaf).

**Une portée est une enveloppe, pas une modification.** Deux endroits touchés entre deux
lectures donnent une seule portée, du premier au dernier, et le texte intact entre les deux
figure des deux côtés. `kept` lève l'ambiguïté : c'est la plus longue sous-suite commune des
deux côtés, prise **mot à mot** — un mot avec les blancs qui le suivent, pour qu'un passage
intact soit gardé entier — et le texte neuf est `add − kept`. Le calcul croît avec le produit
des deux côtés : il est abandonné au-delà de `TEXT_KEPT_MAX_WORDS` mots de part ou d'autre
(mille dans l'extension navigateur, où il tourne sur le fil de la page), et `kept` est alors
**omis**, pas estimé.

L'agent ne garde que **la lecture précédente**, en mémoire vive, jusqu'à ce que la suivante la
remplace ou que la session se ferme (voir *Confidentialité*).

## Écarts assumés

- **Complément Word** : pas de bloc `flight` ni `dwell`, pas de `counts.exits`,
  `counts.back_keys` ni `counts.back_chars`, et `unseen: ["hesitations"]`. Office ne livre ni
  les frappes (le capteur travaille par différences de texte), ni la sortie du document, ni
  l'enregistrement ; une cadence calculée sur ses événements serait fausse. Les autres absences
  suivent des mêmes causes : une hésitation est un *silence entre deux frappes*, et qui ne voit
  pas les frappes ne voit pas les silences courts qui les séparent ; et savoir ce qui a été
  tapé ou collé au retour suppose de savoir qu'on est revenu, donc qu'on était parti. Une
  « frappe » y est un caractère inséré ou effacé. N'ayant jamais compté que des différences, il
  n'a jamais eu le biais du clic et voyait déjà le remplacement d'une sélection. Lisant le
  texte, il **voit** en revanche une prédiction acceptée, et au-delà de quinze caractères il
  l'écrit comme un collage (une suite `paste`) : un geste qui n'en était pas un. C'est le revers
  du capteur par différences — il voit les caractères sans voir le geste — et il est assumé, une
  prédiction d'Office dépassant rarement cette taille. Le même revers vaut pour les
  remaniements : une suppression de plus d'`INJECTION_MIN_CHARS` caractères d'un coup y est une
  **révision massive** (`counts.revisions`), sélection vue ou non, parce qu'une sélection
  remplacée entre deux lectures n'a laissé aucune trace ; et un **clic** n'y est qu'un
  déplacement parmi d'autres, un pas — insérer juste après un clic n'y est donc pas une
  reformulation, là où les trois autres agents voient le clic pour le trajet qu'il est. Son
  déroulé est fait d'**une suite par différence, sans durée** (`ms` à `0`) : `type`, `erase`,
  `paste`, `self`, `other` pour la frappe qu'une restitution compte, et `move` pour un
  déplacement — qui n'y est pas une frappe, donc pas un `nav`. Il n'y a ni `click`, ni `copy`,
  `undo` ou `fix`, qu'Office ne livre pas. Deux suites voisines du même genre y fusionnent,
  comme ailleurs (jamais `paste`, `self` ni `gap`). Un `gap` n'y est écrit que pour un silence
  de plus de `SILENCE_RESOLUTION_MS` (3 000 ms) entre deux différences tapées, et il s'achève
  au premier événement de la différence tapée suivante : en dessous, il mesurerait l'espacement
  des événements de Word, pas une recherche de mot — d'où la déclaration `unseen`, sans
  laquelle le moteur lirait zéro hésitation là où rien n'a été regardé. `active` y repart de
  zéro avec une fenêtre de seuls déplacements reportée à la suivante, et ne dépasse jamais
  `ms`. Une fenêtre scellée pendant qu'une différence est encore en cours d'analyse annonce le
  texte que sa dernière différence a produit. Pour la portée du
  texte, il garde en mémoire, le temps d'une fenêtre, le texte que la fenêtre précédente a
  annoncé, en plus de la dernière lecture ; elle contient ce qu'un co-auteur a écrit, et `kept`
  y est omis au-delà de `TEXT_KEPT_MAX_WORDS` mots ([complement-word.md](complement-word.md)).
- **LibreOffice** : mêmes blocs et mêmes définitions que l'extension, flight times compris
  (`XUserInputInterception` donne le clavier et la souris) ; seule exception, son gestionnaire de
  clic ne donne pas de coordonnées, donc une sélection **tracée à la souris** n'y est pas
  détectable. Trois choses lui échappent encore : `fix` n'est jamais émis, le correcteur
  n'étant pas vu ; les touches **sans code UNO** (un `é`, un `ç`) ne sont pas chronométrées à
  l'appui, leur relâchement ne pouvant être apparié — `dwell` porte alors moins de valeurs que
  la fenêtre n'a de frappes `type` ; et la **portée du texte** est omise quand le compte de
  Writer et le corps du texte ne coïncident pas (une note de bas de page, un cadre, une liste
  numérotée), plutôt que dite d'un autre texte que celui qui est compté — `text` part alors
  avec `len` seul. `kept` y est en outre abandonné plus tôt que la borne commune, sur le coût
  du calcul ([extension-libreoffice.md](extension-libreoffice.md)).
- **VS Code** : le geste d'un bloc inséré n'y est pas nommable. Une insertion faite en un coup
  y est un collage, un extrait de code ou une complétion acceptée (IntelliSense, assistant), et
  l'API ne dit pas laquelle : elle part en suite `paste`, une par bloc compté en injection —
  c'est même là qu'une réponse générée se voit, et dans VS Code la taille de la plus grosse
  suite est aussi celle de ce qui a été accepté en un geste. Pour la même raison, les flight
  times ne retiennent que les modifications de la taille d'une frappe. Tout le reste est
  mesuré, `counts.exits` compris, et les trois cases de révision y sont distinguées comme dans
  le navigateur : une modification porte la longueur de ce qu'elle efface, et l'origine du
  déplacement précédent est connue. **Une restitution n'y est pas reconnue par empreintes** :
  l'API donne le texte inséré et la *longueur* de ce qu'il remplace, jamais son contenu, donc
  rien à comparer à ce qui sort du document — et un geste qu'on ne sait pas nommer ne doit pas
  peser comme une révision. Ce que l'éditeur donne, c'est le document, et un texte qu'il
  contenait déjà ailleurs ne peut pas avoir été importé par le geste qui l'y met une seconde
  fois : il part en suite `self`, pour son volume, sans compter de révision. Le document est lu
  une fois par modification qui apporte un bloc d'un coup — une fois, quel que soit le nombre de
  curseurs —, cherché, et relâché dans l'appel : rien de cette lecture-là n'est conservé (celle
  du scellement d'une fenêtre l'est, en mémoire, jusqu'à la suivante). Comme Word, il range une
  suppression de plus d'`INJECTION_MIN_CHARS` caractères d'un coup en révision massive,
  sélection vue ou non : une commande qui retire une ligne entière ne passe par aucune
  sélection. Et un déplacement au clavier y est mesuré à la **distance**, l'éditeur disant où
  le curseur est allé et jamais quelle touche l'y a envoyé. Ce qu'il n'envoie pas suit des
  mêmes causes. Pas de bloc `dwell` : aucune touche n'est vue, donc aucun relâchement. Pas de
  suite `nav` : ce genre compte des frappes, et un déplacement au clavier n'en est pas une ici
  (il est dans `counts.jumps`) ; il part en suite `move`, un déplacement d'origine souris en
  suite `click`, et celui qu'une commande a fait (aller à la définition, rechercher) n'est pas
  écrit. Pas de `copy` ni de `fix` : ni le presse-papiers ni le geste du correcteur ne sont
  visibles. Une annulation est une frappe (`other`) suivie d'un `undo` ; un rétablissement, que
  cet agent compte aussi comme une frappe, est la frappe seule. Un silence ne s'y écrit
  qu'entre deux modifications de la taille d'une frappe : une ou deux secondes avant une
  annulation ou avant quelques caractères effacés d'un coup ne sont pas un `gap`. `text.kept`
  est calculé par mots et omis au-delà de `TEXT_KEPT_MAX_WORDS` mots d'un côté ou de l'autre ;
  un mot que le bord de la portée coupe en deux n'y est pas reconnu. Le détail, et la lecture
  du texte que la portée oblige à garder en mémoire, sont dans
  [extension-vscode.md](extension-vscode.md).

- **Extension navigateur et LibreOffice : une complétion acceptée n'est pas vue.** Leurs capteurs
  lisent le clavier et la souris, jamais le texte. Accepter une suggestion — Smart Compose dans
  Google Docs, l'autocomplétion de Writer, un assistant branché sur l'éditeur — compte donc pour
  la touche qui l'accepte et pour rien d'autre : les caractères qu'elle pose ne sont dans
  aucune suite, ni `type` ni `paste`. Les deux agents qui lisent le texte, eux, les voient —
  VS Code les écrit en `paste` sans nommer le geste, Word en nomme un de trop. Ce volume n'est
  pas perdu pour autant : il est dans `text.len`, et le moteur lit l'écart entre la taille du
  texte et les frappes — et, là où une portée part, `add` dit ce qui est arrivé sans geste. Ce
  qui manque est l'**attribution** — on peut dire que ce texte n'a pas été tapé, pas par quel
  geste il est arrivé. Le combler suppose de savoir mesurer : aucune API ne nomme ce geste, et
  le texte se lit avec un âge (30 s sur Google Docs, où c'est un export réseau) alors qu'une
  fenêtre se ferme plusieurs fois par minute ; et Overleaf, qui est précisément l'éditeur où
  ces assistants se branchent, n'a pas de lecture du tout. Ce que chaque éditeur annonce
  réellement se sonde en mode debug (`browser/TESTING.md`, *L'enquête en cours*), et c'est
  cette enquête qui dira s'il y a un genre de suite à ajouter — pas l'inverse.
  **Google Docs a déjà répondu : rien.** Sa zone de saisie reçoit les frappes et n'émet aucun
  `InputEvent` — il annule la touche et écrit dans son propre modèle — et une correction validée
  au clic n'émet rien non plus. Pour cet éditeur, l'agent n'a donc rien à ajouter. Elle y compte
  en revanche un saut de navigation, comme tout clic dans le document, avec ce que cela implique
  pour la suppression qui suivrait : comptée en reformulation différée, le clic ayant soldé le
  déplacement.

- **La correction orthographique : trois agents ne la voient pas, le quatrième la voit de
  travers.** Extension navigateur et LibreOffice lisent le clavier et la souris : une suggestion
  validée dans le menu natif du navigateur ou dans celui de Writer n'émet aucune touche, donc
  rien n'est compté — et pour Google Docs la sonde a déjà répondu que son menu à lui n'émet rien
  non plus (`browser/TESTING.md`). Word et VS Code, qui lisent le texte, comptent le remplacement
  **comme si le mot avait été retapé** : les caractères insérés passent en frappes, et les
  caractères effacés en autant de corrections immédiates — ou, si l'hôte a signalé une sélection
  sur le mot fautif, en une révision massive, cinq fois le poids. Un clic sur « recommandation »
  vaut ainsi une vingtaine de frappes que personne n'a tapées, et de un à treize remaniements
  pour un seul geste, selon ce que l'hôte a dit de la sélection. C'est le revers du capteur
  par différences, le même que pour les prédictions : il voit les caractères sans voir le geste.
  Aucun des deux biais n'est réparable sans un signal qui nomme le geste — `insertReplacementText`
  est celui que la spécification prévoit pour un remplacement d'orthographe, et c'est ce que la
  sonde cherche déjà dans les éditeurs qui restent. Le jour où l'un répond, c'est la règle des
  *Règles de comptage* qui s'applique : une suite `fix` et une correction, aucune frappe, et pas
  de saut de navigation pour le clic de menu.

- **Overleaf** (extension navigateur) : pas de bloc `text`, donc ni taille ni portée. CodeMirror
  ne rend que les lignes visibles du projet — compter les caractères présents dans la page
  donnerait une fraction du document, et cette fraction bougerait avec l'ascenseur. Tout le
  reste y est mesuré comme dans les deux autres éditeurs, et le dépôt du document se fait par le
  fichier téléchargé, comme dans Word Online.

- **Extension navigateur.** Elle envoie tous les blocs et tous les genres de suite sauf `move`
  — un déplacement au clavier y est une frappe, donc un `nav` —, avec cinq limites. Le bloc
  `text` n'existe que **là où le texte est lu, et sa portée au même rythme** : à chaque export
  sur Google Docs (30 s au plus tôt), à chaque lecture de la page sur Word Online et sur un site
  ajouté (5 s), jamais sur Overleaf ; entre deux lectures, et à la fermeture de la page d'un
  Google Docs, la taille repart du cache et `text` ne porte que `len`. `kept` y est omis
  au-delà de **1 000 mots** de part ou d'autre, la moitié de `TEXT_KEPT_MAX_WORDS`, parce que
  la comparaison tourne sur le fil de la page que l'étudiant est en train d'écrire. Une touche
  prise par une **composition** (IME, palette d'accents) est une frappe `type` dont l'appui
  n'est pas mesuré, et le silence d'au plus `SHORT_GAP_MAX_MS` (3 000 ms, constante propre à
  l'extension) qui la précède n'est pas un `gap`. Une suite `copy` arrive une cinquantaine de millisecondes après le geste — la
  sélection se lit sur un tour suivant — et vaut `0` caractère quand rien n'a pu en être lu.
  Enfin `fix` n'est émis nulle part aujourd'hui : aucun éditeur n'a encore de sélecteur de
  correcteur vérifié (voir plus haut).

Une mesure qu'un agent ne sait pas prendre n'est **pas envoyée à zéro** : la clé de `counts` ou
le bloc est absent, le moteur distingue l'absence de la valeur nulle et sort la dimension du
maximum du score. Envoyer un zéro pour une mesure qu'on ne sait pas faire condamnerait
l'étudiant à la place du capteur. Ce que le moteur *déduit* du déroulé n'a pas cette ressource —
zéro `gap` court se lit zéro hésitation — et c'est pourquoi le seul capteur qui ne voit pas les
silences courts le déclare dans `unseen`.

## Suspendre la mesure

Les quatre agents ont un bouton qui **suspend la mesure** : la popup de l'extension, le volet du
complément Word, la fenêtre **Certimens** de LibreOffice et le panneau VS Code (ou la commande
*Certimens : suspendre ou reprendre la mesure*). Quatre règles, identiques partout :

- **la mesure s'arrête, pas l'envoi.** La file continue de partir : ce qui a été mesuré avant la
  pause appartient déjà au moteur. Le retenir ne ferait que transformer la pause en un lot
  tardif, que le moteur signalerait (`late_ingestion`, `multi_window_batch`) ;
- **la fenêtre en cours est vidée** au moment de suspendre : rien de mesuré n'est perdu, rien ne
  s'accumule derrière un capteur suspendu ;
- **pendant la pause, rien n'est compté** : ni frappe, ni temps effectif, ni silence. Ce
  n'est pas « mesurer sans envoyer » ;
- **la suspension dure** : elle survit au redémarrage du navigateur, de Word, de LibreOffice ou
  de VS Code, et seule une reprise explicite la lève. Un agent qui reprendrait tout seul serait
  pire que pas de pause du tout — l'étudiant se croirait mesuré sans l'être.

Un agent qui ne sait pas encore s'il est suspendu **ne mesure pas**. L'extension navigateur est
la seule des quatre à lire ce drapeau de façon asynchrone — un aller-retour vers le processus du
navigateur, pendant que ses écouteurs sont déjà posés : elle démarre donc fermée et n'ouvre qu'une
fois la réponse connue. Démarrer ouverte revenait à mesurer une page chargée pendant une pause, et
à garder ce qui avait été compté là, puisque la correction assigne le drapeau sans sceller la
fenêtre.

### La mesure appartient à une session

Se déconnecter arrête la mesure, exactement comme une suspension — c'est ce que les quatre
dictionnaires promettent à l'étudiant. Ce qu'il écrit ensuite n'appartient à aucun compte : le
garder en file reviendrait à l'envoyer sous le porteur du compte suivant, vers les documents du
précédent.

La déconnexion se déroule donc dans cet ordre : les fenêtres encore ouvertes sont scellées et
**envoyées pendant que le jeton qui les a mesurées est encore valable**, le jeton est révoqué,
puis tout ce qu'il autorisait sur ce poste est effacé — la carte des documents, les titres
observés et synchronisés, la file et son curseur, et le bail de drain du complément Word. La
suspension est remise à zéro : c'était le choix d'un étudiant sur sa propre mesure, pas celui du
suivant. Ce qui reste est l'adresse du moteur et la langue, pour que l'appairage suivant reparte
d'où celui-ci était.

**Ce qui n'a pas pu partir avant la révocation est perdu** : hors ligne au moment de la
déconnexion, les fenêtres en attente ne survivent pas au jeton qui les a mesurées. C'est le prix
de la règle, et il se dit plutôt qu'il ne se contourne.

Les sites que l'étudiant a ajoutés dans l'extension ne sont **pas** effacés : ce sont des
permissions d'hôte accordées par le geste de consentement du navigateur, et les reprendre est une
action visible, distincte d'une déconnexion.

S'appairer de nouveau sous un autre compte, sans s'être déconnecté, passe par le même effacement :
aucun geste ne l'interdit, et il laisse exactement le même résidu.

Elle est **globale à l'agent**, pas par document : c'est l'étudiant qui suspend, pas un
document.

| Agent | Où l'état est gardé | Où les événements sont filtrés |
| --- | --- | --- |
| Extension navigateur | `chrome.storage.local`, clé `paused` | `browser/src/content.js` (chaque gestionnaire, et `recordInjection`) |
| Complément Word | `localStorage` partagé, `isPaused()` d'`agent.js` | `word/src/sensor.js` (`noteLocalEvent`, `onSelectionChanged`) |
| Extension LibreOffice | `certimens.json`, `Engine.paused()` | `sensor.py` (`on_key`, `on_click`, `on_paste`, `on_deactivated`) |
| Extension VS Code | `globalState`, `Agent.paused()` | `vscode/src/extension.js` (les gestionnaires de l'hôte) |

Le complément Word est le seul cas où la lecture du document **continue** pendant la pause : son
capteur travaille par différences, et sans rafraîchir sa référence, tout ce qui a été écrit
pendant la pause atterrirait d'un coup dans la première fenêtre d'après
(`BASELINE_REFRESH_MS`).

L'état est affiché **en permanence** — badge `II` sur l'icône de l'extension, bandeau dans le
volet, barre d'état de VS Code : le seul état qu'un agent de mesure ne doit jamais produire,
c'est « suspendu mais qui en a l'air actif ». Il s'affiche **une fois**, pas deux : le bandeau
permanent porte l'état, et le message transitoire ne confirme que la reprise, qui ne laisse rien
à l'écran. Dans le panneau VS Code, la ligne d'état ne parle pendant une pause que s'il reste des
mesures d'avant à envoyer. La fenêtre LibreOffice fait exception : faute de bandeau permanent,
son message *est* l'affichage de l'état.

La suspension et la déconnexion sont deux **icônes en haut à droite** dans les trois agents à
interface HTML — une popup n'a pas la largeur pour deux boutons pleins. Chacune porte son action
en `aria-label` et, au survol, la phrase qui dit ce qu'elle déclenche ; la suspension ajoute
`aria-pressed` et prend la couleur de l'échec, sans jamais être le seul indice de l'état. La fenêtre
LibreOffice garde ses boutons texte — un dialogue UNO n'a pas d'icônes — avec la même aide au
survol (`HelpText`), et la page d'options de l'extension, qui n'a pas la contrainte de largeur
d'une popup, reprend la déconnexion en bouton texte.

Côté moteur, rien n'est déclaré : le trou reste lisible dans le nombre de fenêtres et dans
l'`unmeasured_ratio` du document — la part qu'aucune mesure n'explique. Un devoir
écrit pour moitié pendant une pause le montre là.

## Confidentialité

Aucune touche, aucun caractère, aucun texte ne quitte le poste ni n'est conservé au-delà de ce
qu'exige le calcul. Les capteurs traduisent chaque touche en **catégorie** (`erase`, `paste`,
`navigation`, `modifier`, `other`) puis l'oublient. Le mode debug journalise **des nombres
et des catégories uniquement**.

Le corps ([moteur.md](moteur.md#le-corps-de-mesure)) est fait de **nombres et de
catégories**, et trois choix les empêchent de redevenir du texte :

- le déroulé est fait de **suites** (« 20 frappes en 4,1 s »), jamais d'un enregistrement par
  touche, et une suite ne se coupe jamais sur une classe de caractère — ni espace, ni
  ponctuation, ni retour à la ligne. La longueur des mots ne s'y lit pas ;
- le rythme part en **histogramme** : combien d'écarts et d'appuis dans chaque tranche, jamais
  leur ordre, jamais la touche ;
- la portée d'une modification est faite de **longueurs** — où, combien retiré, combien apparu,
  combien conservé — calculées sur le poste.

**Une empreinte du contenu n'en fait pas partie, et c'est délibéré** : un hachage du texte
lierait plus fortement la mesure au document rendu, mais ferait transiter un dérivé du texte par
la mesure.

Ce que ces calculs demandent de garder, et pour combien de temps — c'est plus qu'avant, et il
faut le dire tel quel :

- **la lecture précédente du texte**, dans les quatre agents désormais, et non plus dans les
  seuls capteurs par différences. Elle est gardée en mémoire vive, une seule à la fois, jusqu'à
  ce que la lecture suivante la remplace, et relâchée quand la mesure s'arrête (suspension,
  déconnexion, fermeture du document). Elle n'est ni écrite sur le disque, ni envoyée. Dans
  l'extension, sur Google Docs, ce texte est celui de l'export que le *service worker* faisait
  déjà pour le volume : il le rend maintenant à la page **du document lui-même, et à elle
  seule** — un capteur posé sur une autre page ne reçoit que la taille ;
- **l'instant où une touche a été enfoncée**, sous sa position physique sur le clavier, le
  temps d'en voir le relâchement (extension et LibreOffice) : dix entrées au plus, vidées quand
  le document est quitté, jamais journalisées, jamais envoyées. Aucune touche n'est retenue
  après son relâchement ;
- **l'identifiant de session**, tiré au hasard, qui ne dit rien du compte ni de la machine et
  n'est écrit que dans une fenêtre restée en file.

La reconnaissance d'une restitution est la seule chose qu'un agent garde du texte, et elle n'en
garde pas le texte : des **nombres**, un par suite de quatre mots, en mémoire vive, au plus
vingt sorties, effacés au bout d'une heure sans servir ou à la fermeture du document. Rien n'est
écrit sur le disque, rien n'entre dans une fenêtre de mesure, rien ne part vers le moteur — ce
qui est envoyé reste des nombres. Une empreinte ne se relit pas : un hachage sur 32 bits ne rend pas ses
mots.

Toute modification qui ferait transiter du texte **par la mesure** casse la promesse affichée
dans les boutiques : c'est un changement de contrat, pas un détail d'implémentation. Le dépôt du
document en est l'exception, et il est explicite — un bouton, un clic, jamais la mesure : le
fichier rendu, ou, sur un site ajouté par l'étudiant, le texte de la zone où il écrit
(voir [extension-navigateur.md](extension-navigateur.md)).

## Vérifier

Chaque implémentation a sa suite, et elles se lisent comme la **spécification exécutable** des
règles ci-dessus : une règle qui change s'y voit d'abord.

| Agent | Tests |
| --- | --- |
| Extension navigateur | `browser/tests/sensor.test.mjs` |
| Complément Word | `word/tests/sensor.test.mjs` |
| Extension LibreOffice | `libreoffice/tests/test_measure.py` |
| Extension VS Code | `vscode/tests/sensor.test.mjs` |

Les tests JavaScript chargent le fichier livré tel quel dans un contexte isolé
(`tests/helpers/sandbox.mjs`) : **rien n'est ajouté au code de production pour le rendre
testable**, et l'horloge est pilotée par le test, sans quoi les règles de pause et de temps
effectif ne seraient pas mesurables. Une règle commune ajoutée ou changée se teste dans chaque
suite — les cas sont volontairement les mêmes de l'une à l'autre, c'est ce qui rend une
divergence visible.
