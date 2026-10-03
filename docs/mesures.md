# Les mesures

Une seule définition, quatre implémentations indépendantes. Ce document est la **référence
lisible** de ce que comptent les agents ; les détails propres à chacun sont dans sa page.

| Agent | Fenêtres de mesure | Capteur |
| --- | --- | --- |
| Extension navigateur | `browser/src/content.js` | le même fichier (clavier et souris), quatre éditeurs |
| Complément Word | `word/src/sensor.js` | le même fichier (différences de texte) |
| Extension LibreOffice | `libreoffice/src/pythonpath/certimens_agent/measure.py` | `sensor.py` (UNO) |
| Extension VS Code | `vscode/src/sensor.js` | le même fichier (modifications du document) |

Une règle changée dans l'une doit l'être dans les trois autres, ou être justifiée par une limite
de la plateforme (voir *Écarts assumés*).

## La fenêtre de mesure

Une **fenêtre** est un lot de compteurs sur une période. Sa période va de la **première à la
dernière activité** : l'inactivité n'y entre jamais — le moteur pondère ses moyennes par la durée
des périodes, une fenêtre gonflée de temps mort fausserait tout.

Elle est vidée (envoyée) après **2 s sans activité**, à **200 frappes**, sur **Ctrl/Cmd+S**,
quand l'étudiant **quitte le document** (autre onglet, autre fenêtre, éditeur réduit), à la
fermeture du document et au moment de suspendre la mesure.

Les trois derniers déclencheurs demandent que l'hôte les signale. Le complément Word ne voit ni
l'enregistrement ni la sortie du document : ses fenêtres partent sur l'inactivité, sur les
200 frappes et à la fermeture du volet. C'est sans conséquence sur ce qui est compté — une
fenêtre vidée plus tard reste la même fenêtre —, seulement sur le moment où elle part.

## Pourquoi la fenêtre s'est fermée

Une fenêtre **n'est pas une rafale de frappe** : c'est une période qu'un agent a décidé de
clore, et les déclencheurs ci-dessus ne disent pas du tout la même chose de l'étudiant. Le
moteur ne peut pas les distinguer tout seul : il ne voit que la suite des fenêtres, et un
enregistrement qui coupe une rafale en deux y ressemble à quelqu'un qui ne s'arrête jamais,
tandis qu'une sortie vers une seconde fenêtre y ressemble à un silence de réflexion. Chaque
mesure part donc avec le mot qui dit ce qui a fermé la fenêtre.

Le vocabulaire fait six mots et il est le même pour les quatre agents. C'est le moteur qui le
tient : y ajouter un mot est un chantier de son côté d'abord.

| Mot envoyé | Ce qu'il dit |
| --- | --- |
| `idle` | l'étudiant a cessé de taper : ce qui suit est un vrai silence |
| `volume` | `FLUSH_KEYSTROKES` atteintes : c'est le compteur qui s'est arrêté, pas l'étudiant |
| `save` | une action explicite a scellé la fenêtre en pleine rédaction — un enregistrement, et chez VS Code un rendu, un renommage, un « envoyer maintenant » |
| `focus` | le focus a quitté le document sans que l'étudiant le quitte (en-tête de Word Online) |
| `away` | l'étudiant a quitté le document, et la sortie a été comptée |
| `end` | la séance s'achève : page fermée, éditeur quitté, mesure suspendue |

Chaque agent traduit **ses** déclencheurs vers ces six mots, dans une table
`WIRE_FLUSH_REASONS` qu'il déclare en tête de son capteur. Les agents n'ont pas les mêmes
déclencheurs — le complément Word ne voit pas la sortie du document, donc il n'envoie jamais
`away` ; l'extension VS Code en a le plus, puisqu'une commande peut y sceller une fenêtre.

Un déclencheur absent de la table **n'envoie rien**, et le moteur lit une fenêtre sans mot comme
venant d'un agent qui ne sait pas le dire : il retombe sur ce qu'il faisait avant. C'est la
bonne façon d'échouer, et elle est silencieuse — c'est pourquoi `make check` compare la table de
chaque agent à ses propres appels, et refuse un mot hors du vocabulaire.

## Constantes communes

Identiques dans les quatre implémentations, à ne pas désynchroniser :

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
valeur par accident : un long silence compte comme une pause sans être crédité en temps de
frappe. Ne pas les réunifier.

L'extension VS Code ajoute `SELECTION_ECHO_MS` (50 ms), qui n'a de sens que chez elle : l'éditeur
signale un déplacement du curseur après chaque frappe, et sans ce délai `navigation_jumps`
suivrait exactement `keystrokes_total`.

## Metrics envoyées

| Type | Mesure |
| --- | --- |
| `keystrokes_total` | Frappes (hors répétition automatique et touches de modification seules) |
| `effective_time_ms` | Temps de frappe effectif |
| `immediate_corrections` | Backspace/Suppr en cours de frappe, Ctrl/Cmd+Z |
| `deferred_reformulations` | **Première** Backspace/Suppr après un déplacement au clavier, ou remplacement d'une sélection Maj+flèches |
| `macro_revisions` | **Première** Backspace/Suppr après un clic, Ctrl/Cmd+X, ou remplacement d'une sélection Ctrl/Cmd+A ou tracée à la souris |
| `navigation_jumps` | Flèches, Début/Fin, Page préc./suiv., clics dans le document |
| `cognitive_pauses` | Reprises après 3 s à 5 min d'inactivité |
| `flight_mad_ms` | Écart absolu médian des flight times |
| `injected_chars_total` | Caractères collés ou glissés (collages > 15 caractères), hors restitution du texte de l'étudiant |
| `real_volume_chars` | Caractères du document |
| `paste_events` | Nombre de collages / glisser-déposer, quelle que soit leur taille, hors restitution |
| `focus_losses` | Nombre de sorties du document pendant la fenêtre |
| `flight_median_ms` | Temps médian entre deux frappes (cadence) |
| `self_paste_events` | Nombre de restitutions reconnues : le texte de l'étudiant qui revient |
| `injected_chars_max` | Le plus gros collage de la fenêtre, pris seul |
| `injected_chars_after_return` | Caractères injectés dans les 15 s suivant un retour au document |
| `self_paste_chars_total` | Caractères reconnus comme une restitution : le volume, là où `self_paste_events` donne le nombre de gestes |
| `lexical_hesitations` | Silences de 1 à 3 s entre deux frappes : l'étudiant cherche son mot |
| `keystrokes_after_return` | Frappes dans les 15 s suivant un retour au document |

Les neuf dernières sont plus récentes que certains moteurs déployés, en **trois générations** :
`paste_events`, `focus_losses` et `flight_median_ms` d'abord ; `self_paste_events`,
`injected_chars_max` et `injected_chars_after_return` ensuite ; `self_paste_chars_total`,
`lexical_hesitations` et `keystrokes_after_return` enfin. Un agent qui se voit refuser un type
retire **la génération la plus récente** et renvoie le reste, puis la suivante si le refus
persiste (voir [moteur.md](moteur.md)) : un moteur qui connaît les deux premières générations
mais pas la troisième ne perd que la troisième.

### Comment un nom de metric se forme

Un type s'écrit `<sujet>_<statistique>_<unité>`, dans cet ordre, et il n'omet que ce qui n'existe
pas :

- le **sujet** d'abord, pour que les mesures d'une même chose se suivent quand on les trie :
  `injected_chars_total`, `injected_chars_max`, `injected_chars_after_return` ; `flight_mad_ms`,
  `flight_median_ms` ;
- la **statistique** ensuite — `total`, `max`, `median`, `mad` — et rien quand c'est un simple
  décompte d'événements : `paste_events`, `focus_losses`, `cognitive_pauses` ;
- l'**unité** en dernier, toujours abrégée (`_ms`, `_chars`), et seulement quand la valeur en a
  une. Un décompte n'en a pas. **Une durée se compte en millisecondes**, comme les flight
  times : un capteur compte en millisecondes, et arrondir à la seconde avant d'envoyer ne ferait
  que perdre jusqu'à une demi-seconde par fenêtre — sur une fenêtre qui en dure quelques-unes —
  pour une division que le moteur devrait refaire dans l'autre sens.

La règle existe parce que les noms, laissés à eux-mêmes, se font un par un : l'un oublie de dire
de quoi il est l'écart, un autre écrit son unité en toutes lettres, un troisième compte des
caractères sans le dire — et l'ensemble n'est plus lisible. **Un nom de metric est un terme du
contrat avec le moteur** : le renommer est le même chantier en deux temps qu'en ajouter une — le
moteur d'abord, les agents ensuite (voir [moteur.md](moteur.md)). D'où l'intérêt de le choisir
juste du premier coup, et de laisser `make check` le vérifier.

## Règles de comptage

**Une suppression solde le déplacement qui la précède.** La première touche Suppr après un clic
est une révision massive, après une flèche une reformulation différée, et **les suivantes sont
des corrections immédiates** — on efface là où on se trouve. Sans cette remise à zéro (le
comportement hérité des agents de bureau), un seul clic suffisait à faire compter toute une
rafale de suppressions en reformulations, et `immediate_corrections` restait à zéro chez un
étudiant qui clique avant de corriger.

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
tapé, `real_volume_chars` se compare au document déposé, et gonfler `keystrokes_total` serait la
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
décision sur une lettre —, et c'est la définition même d'`immediate_corrections`. Un capteur qui
ne voit pas ce geste compte zéro remaniement là où l'étudiant en a fait quarante : une pénalité
pour avoir utilisé le correcteur de son éditeur. La règle est appliquée côté moteur ; aucun des
quatre agents ne la tient encore (voir *Écarts assumés*), et c'est la définition à reprendre le
jour où l'un d'eux sait nommer le geste. Trois précisions, et la dernière est celle qui coûte :

- **Un remaniement, jamais une frappe.** Le mot que l'étudiant n'a pas retapé n'a pas été tapé.
  Gonfler `keystrokes_total` de ses caractères fausserait la part tapée, que le moteur recoupe
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
  problème d'attribution de volume (*Écarts assumés*, et `unattributed_chars_total` si cette
  metric voit le jour), le second est un remaniement. Les ranger ensemble parce que ni l'un ni
  l'autre n'a de touche derrière lui donnerait à l'étudiant une injection là où il a révisé.

**Une pause va de 3 s à 5 minutes.** Le plafond était à 60 s, ce qui faisait compter *rien du
tout* — ni pause, ni temps effectif — toute délibération de plus d'une minute, alors que
s'arrêter une à cinq minutes sur un paragraphe est justement la marque de quelqu'un qui compose.
Au-delà de cinq minutes, l'étudiant a quitté le document : ce n'est plus de la friction
cognitive.

**Entre le flight time et la pause, il y a l'hésitation.** Un silence d'une à trois secondes,
les mains sur le clavier, c'est quelqu'un qui cherche son mot. En deçà de 800 ms l'écart est un
flight time, au-delà de 3 s c'est une pause cognitive : la bande entre les deux ne relevait
d'aucune des deux règles et n'était comptée nulle part. `lexical_hesitations` la compte, et
c'est la **preuve de vie** qui manquait au reste du modèle — quelqu'un qui recopie un texte déjà
écrit fait des pauses et des corrections comme tout le monde, mais n'hésite pas sur un mot déjà
choisi, posé sous ses yeux. Les deux bornes se touchent sans se recouvrir : une hésitation va de
1 s à 3 s **incluses**, une pause commence **au-delà** de 3 s, et un même silence n'est donc
jamais compté deux fois.

**La répétition automatique ne compte pas** : garder Suppr enfoncée pour effacer un mot vaut une
seule suppression.

**Une touche de modification seule n'est pas une frappe.** Maj, Ctrl, **Cmd**, Alt/Option, AltGr,
Verr. Maj, Fn — toutes celles que la plateforme nomme — pressée pour elle-même n'écrit rien :
elle n'ouvre pas de fenêtre, ne compte pas dans `keystrokes_total` et n'entre pas dans les
flight times — l'écart minuscule qu'elle laisse avant la lettre qu'elle
modifie passerait pour une frappe impossiblement rapide et régulière, ce que `flight_mad_ms` et
`flight_median_ms` servent justement à distinguer. Elle ne solde pas non plus le déplacement qui
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
donc elles entrent dans `keystrokes_total` — les ignorer ferait passer pour un colleur un
étudiant qui tape en japonais. Mais elles ne disent rien de l'endroit où il se trouve dans son
document, ni de son rythme : elles n'entrent ni dans `navigation_jumps`, ni dans les flight
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
`immediate_corrections` chez quiconque hésite à voix haute — et sur un Mac, où Cmd+Maj+Z *est* le
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
**révision massive** et une frappe — le bloc remplacé —, jamais dans `paste_events` ni dans
`injected_chars_total`.

**Le même bloc recollé plusieurs fois reste le sien.** Copier un paragraphe de son document et le
recoller dix fois, à une heure d'intervalle s'il le faut, ne produit aucun collage : à partir du
deuxième retour, le bloc ne compte même plus pour une révision — il n'a pas été révisé dix fois,
il a été dupliqué — mais toujours pour une frappe, comme le bloc qu'il pose.

`self_paste_chars_total` en donne le **volume**, là où `self_paste_events` donne le nombre de
gestes : quatre restitutions ne disent pas si c'est un paragraphe ou un tiers du document qui
est passé par le correcteur. C'est exactement le volume dont le même texte aurait été accusé
s'il avait été collé par quelqu'un qui ne l'a jamais écrit — les deux compteurs se lisent donc
l'un contre l'autre.

Une restitution est comptée pour elle-même, dans `self_paste_events`. Sans elle, le moteur voit
une révision massive sans pouvoir dire si l'étudiant a réécrit son paragraphe à la main ou l'a
passé à un correcteur — deux gestes différents, qui ne se jugent pas pareil. C'est aussi le seul
compteur par lequel une régression de cette reconnaissance se verrait : tout le reste de la règle
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

**Un gros collage et vingt petits ne se valent pas.** `injected_chars_total` les confond :
vingt collages de cent caractères et un seul de deux mille y pèsent le même poids.
`injected_chars_max` donne le plus gros d'une fenêtre, pris seul — la taille du bloc arrivé d'un
coup, qui est ce qu'on cherche à voir. Dans VS Code, c'est aussi la taille de ce qui a été
accepté en un geste (une complétion, un bloc proposé par un assistant).

**Ce qui est collé juste après un retour vient d'ailleurs.** Sortir du document, aller consulter
quelque chose, revenir et coller est un seul geste, et c'est celui qu'un étudiant fait quand il
va chercher un texte hors de son éditeur. `injected_chars_after_return` compte les caractères
injectés dans les **15 secondes** qui suivent un retour — et un retour n'existe que si la sortie
a été comptée (`focus_losses`), ce qui écarte les changements de focus à l'intérieur de la page.
C'est un sous-ensemble strict de `injected_chars_total` : rien n'y est compté deux fois, et le
rapport des deux dit la part de ce qui est entré dans le document sans y avoir été écrit.

**Et ce qui est tapé juste après un retour vient peut-être d'ailleurs aussi.** Le collage après
un retour était mesuré, la frappe après un retour ne l'était pas : sortir, lire, revenir et
**taper** ce qu'on vient de lire échappait entièrement à la seule règle qui regarde ce qu'un
étudiant fait en revenant à son document. `keystrokes_after_return` compte les frappes des
**15 secondes** qui suivent un retour, au miroir exact d'`injected_chars_after_return`, et aux
mêmes conditions : un retour n'existe que si la sortie a été comptée. C'est un sous-ensemble de
`keystrokes_total`, jamais un ajout : toutes les **touches** y passent, une suppression et une
annulation comprises, qui en sont.

Une seule frappe en est exclue, et délibérément : celle qui tient lieu de **restitution**. Recoller
son propre texte compte pour une frappe — le bloc qu'il remplace —, mais ce n'est pas de la
frappe, et la question posée ici est « a-t-il tapé en revenant ? ». La compter gonflerait le
compteur avec le seul geste que l'agent a justement reconnu comme le texte de l'étudiant.
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

## Écarts assumés

- **Complément Word** : pas de `flight_mad_ms`, `flight_median_ms`, `focus_losses`,
  `injected_chars_after_return`, `lexical_hesitations` ni `keystrokes_after_return`. Office ne
  livre ni les frappes (le capteur travaille par différences de texte), ni la sortie du
  document, ni l'enregistrement ; une cadence calculée sur ses événements serait fausse. Les
  deux dernières absences suivent des mêmes causes : une hésitation lexicale est un *silence
  entre deux frappes*, et qui ne voit pas les frappes ne voit pas les silences qui les séparent ;
  et savoir ce qui a été tapé au retour suppose de savoir qu'on est revenu, donc qu'on était
  parti. Une « frappe » y est un caractère inséré ou effacé. N'ayant jamais compté que des
  différences, il n'a jamais eu le biais du clic et voyait déjà le remplacement d'une
  sélection. Lisant le texte, il **voit** en revanche une prédiction acceptée, et au-delà de
  quinze caractères il la compte comme un collage (`paste_events`, `injected_chars_total`) : un
  geste qui n'en était pas un. C'est le revers du capteur par différences — il voit les
  caractères sans voir le geste — et il est assumé, une prédiction d'Office dépassant rarement
  cette taille.
- **LibreOffice** : mêmes metrics et mêmes définitions que l'extension, flight times compris
  (`XUserInputInterception` donne le clavier et la souris) ; seule exception, son gestionnaire de
  clic ne donne pas de coordonnées, donc une sélection **tracée à la souris** n'y est pas
  détectable.
- **VS Code** : pas de `paste_events`. Une insertion faite en un coup y est un collage, un
  extrait de code ou une complétion acceptée (IntelliSense, assistant), et l'API ne dit pas
  laquelle : les caractères comptent bien dans `injected_chars_total` — c'est même là qu'une
  réponse générée se voit — mais le *nombre* de collages serait faux, et une mesure fausse vaut
  moins que pas de mesure. Pour la même raison, les flight times ne retiennent que les
  modifications de la taille d'une frappe. Tout le reste est mesuré, `focus_losses` compris, et
  les trois cases de révision y sont distinguées comme dans le navigateur : une modification
  porte la longueur de ce qu'elle efface, et l'origine du déplacement précédent est connue.
  **Le nombre de restitutions n'y est pas mesurable non plus** (pas de `self_paste_events`) :
  l'API donne le texte inséré et la *longueur* de ce qu'il remplace, jamais son contenu, donc
  rien à comparer à ce qui sort du document — et un geste qu'on ne sait pas nommer ne doit pas
  peser comme une révision. Leur **volume**, lui, est mesuré et envoyé
  (`self_paste_chars_total`) : ce que l'éditeur donne, c'est le document, et un texte qu'il
  contenait déjà ailleurs ne peut pas avoir été importé par le geste qui l'y met une seconde
  fois. Le document est lu une fois par modification qui apporte un bloc d'un coup —
  une fois, quel que soit le nombre de curseurs —, cherché, et relâché dans l'appel : rien n'en
  est conservé.

- **Extension navigateur et LibreOffice : une complétion acceptée n'est pas vue.** Leurs capteurs
  lisent le clavier et la souris, jamais le texte. Accepter une suggestion — Smart Compose dans
  Google Docs, l'autocomplétion de Writer, un assistant branché sur l'éditeur — compte donc pour
  la touche qui l'accepte et pour rien d'autre : les caractères qu'elle pose ne sont ni dans
  `keystrokes_total`, ni dans `injected_chars_total`. Les deux agents qui lisent le texte, eux,
  les voient — VS Code les compte en injection sans nommer le geste, Word en nomme un de trop.
  Ce volume n'est pas perdu pour autant : il est dans `real_volume_chars`, et le moteur lit
  l'écart entre le volume déposé et les frappes. Ce qui manque est l'**attribution** — on peut
  dire que ce texte n'a pas été tapé, pas par quel geste il est arrivé.
  Le combler suppose de savoir mesurer : aucune API ne nomme ce geste, et le seul signal
  générique serait le résidu de volume — or le volume se lit avec un âge (30 s sur Google Docs,
  où c'est un export réseau) alors qu'une fenêtre se ferme plusieurs fois par minute, si bien
  que le résidu serait nul sur trois fenêtres et énorme sur la quatrième ; et Overleaf, qui est
  précisément l'éditeur où ces assistants se branchent, n'a pas de volume du tout. Ce que chaque
  éditeur annonce réellement se sonde en mode debug (`browser/TESTING.md`, *L'enquête en
  cours*), et c'est cette enquête qui dira s'il y a une metric à ajouter — pas l'inverse.
  **Google Docs a déjà répondu : rien.** Sa zone de saisie reçoit les frappes et n'émet aucun
  `InputEvent` — il annule la touche et écrit dans son propre modèle — et une correction validée
  au clic n'émet rien non plus. Pour cet éditeur, l'agent n'a donc rien à ajouter. Elle y compte
  en revanche un saut de navigation, comme tout clic dans le document, avec ce que cela implique
  pour la suppression qui suivrait : comptée en révision massive, le clic ayant soldé le
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
  *Règles de comptage* qui s'applique : un remaniement, aucune frappe, et pas de saut de
  navigation pour le clic de menu.

- **Overleaf** (extension navigateur) : pas de `real_volume_chars`. CodeMirror ne rend que les lignes
  visibles du projet — compter les caractères présents dans la page donnerait une fraction du
  document, et cette fraction bougerait avec l'ascenseur. Tout le reste y est mesuré comme dans
  les deux autres éditeurs, et le dépôt du document se fait par le fichier téléchargé, comme
  dans Word Online.

Une metric qu'un agent ne sait pas voir n'est **pas envoyée à zéro** : le moteur distingue
l'absence de la valeur nulle et sort la dimension du maximum du score. Envoyer un zéro pour une
mesure qu'on ne sait pas faire condamnerait l'étudiant à la place du capteur.

## Suspendre la mesure

Les quatre agents ont un bouton qui **suspend la mesure** : la popup de l'extension, le volet du
complément Word, la fenêtre **Certimens** de LibreOffice et le panneau VS Code (ou la commande
*Certimens : suspendre ou reprendre la mesure*). Quatre règles, identiques partout :

- **la mesure s'arrête, pas l'envoi.** La file continue de partir : ce qui a été mesuré avant la
  pause appartient déjà au moteur. Le retenir ne ferait que transformer la pause en un lot
  tardif, que le moteur signalerait (`late_ingestion`, `multi_window_batch`) ;
- **la fenêtre en cours est vidée** au moment de suspendre : rien de mesuré n'est perdu, rien ne
  s'accumule derrière un capteur suspendu ;
- **pendant la pause, rien n'est compté** : ni frappe, ni temps effectif, ni pause cognitive. Ce
  n'est pas « mesurer sans envoyer » ;
- **la suspension dure** : elle survit au redémarrage du navigateur, de Word, de LibreOffice ou
  de VS Code, et seule une reprise explicite la lève. Un agent qui reprendrait tout seul serait
  pire que pas de pause du tout — l'étudiant se croirait mesuré sans l'être.

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
`navigation`, `modifier`, `other`) puis l'oublient ; `word/src/sensor.js` ne garde que la lecture
précédente du texte, le temps d'en faire la différence. Le mode debug journalise **des compteurs
et des catégories uniquement**.

La reconnaissance d'une restitution est la seule chose qu'un agent garde du texte, et elle n'en
garde pas le texte : des **nombres**, un par suite de quatre mots, en mémoire vive, au plus
vingt sorties, effacés au bout d'une heure sans servir ou à la fermeture du document. Rien n'est
écrit sur le disque, rien n'entre dans une fenêtre de mesure, rien ne part vers le moteur — ce
qui est envoyé reste des compteurs. Une empreinte ne se relit pas : un hachage sur 32 bits ne rend pas ses
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
