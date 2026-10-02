# Les mesures

Une seule définition, quatre implémentations indépendantes. Ce document est la **référence
lisible** de ce que comptent les agents ; les détails propres à chacun sont dans sa page.

| Agent | Fenêtres de mesure | Capteur |
| --- | --- | --- |
| Extension navigateur | `browser/src/content.js` | le même fichier (clavier et souris) |
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

`PAUSE_MAX_S` et `ACTIVE_GAP_MAX_S` sont **deux règles distinctes** qui ont partagé la même
valeur par accident : un long silence compte comme une pause sans être crédité en temps de
frappe. Ne pas les réunifier.

L'extension VS Code ajoute `SELECTION_ECHO_MS` (50 ms), qui n'a de sens que chez elle : l'éditeur
signale un déplacement du curseur après chaque frappe, et sans ce délai `navigation_jumps`
suivrait exactement `total_keystrokes`.

## Metrics envoyées

| Type | Mesure |
| --- | --- |
| `total_keystrokes` | Frappes (hors répétition automatique et touches de modification seules) |
| `effective_time_seconds` | Temps de frappe effectif |
| `immediate_corrections` | Backspace/Suppr en cours de frappe, Ctrl/Cmd+Z |
| `deferred_reformulations` | **Première** Backspace/Suppr après un déplacement au clavier, ou remplacement d'une sélection Maj+flèches |
| `macro_revisions` | **Première** Backspace/Suppr après un clic, Ctrl/Cmd+X, ou remplacement d'une sélection Ctrl/Cmd+A ou tracée à la souris |
| `navigation_jumps` | Flèches, Début/Fin, Page préc./suiv., clics dans le document |
| `cognitive_pauses` | Reprises après 3 s à 5 min d'inactivité |
| `mad_ms` | Écart absolu médian des flight times |
| `total_injected_chars` | Caractères collés ou glissés (collages > 15 caractères) |
| `real_volume` | Caractères du document |
| `paste_events` | Nombre de collages / glisser-déposer, quelle que soit leur taille |
| `focus_losses` | Nombre de sorties du document pendant la fenêtre |
| `median_flight_ms` | Temps médian entre deux frappes (cadence) |

Les trois dernières sont plus récentes que certains moteurs déployés : un agent qui se les voit
refuser les retire et renvoie le reste (voir [moteur.md](moteur.md)).

## Règles de comptage

**Une suppression solde le déplacement qui la précède.** La première touche Suppr après un clic
est une révision massive, après une flèche une reformulation différée, et **les suivantes sont
des corrections immédiates** — on efface là où on se trouve. Sans cette remise à zéro (le
comportement hérité des agents de bureau), un seul clic suffisait à faire compter toute une
rafale de suppressions en reformulations, et `immediate_corrections` restait à zéro chez un
étudiant qui clique avant de corriger.

**Remplacer une sélection est une suppression**, à l'échelle de la sélection. Taper ou coller
par-dessus une sélection efface tout ce qu'elle couvre : c'était invisible tant que le capteur ne
regardait que Backspace, Suppr, Ctrl+X et Ctrl+Z. Une sélection en cours est donc suivie —
Ctrl/Cmd+A ou un tracé à la souris pour un bloc, Maj + touche de déplacement pour une portion
ciblée — et la frappe ou le collage qui la remplace est compté à cette échelle. Maj seule ne
sélectionne rien (c'est aussi ainsi qu'on tape les majuscules), un déplacement sans Maj ou un
clic annule la sélection, et elle n'est décomptée qu'une fois. Le cas « tout sélectionner puis
coller la réponse » ne comptait auparavant qu'une injection, jamais une révision.

**Une pause va de 3 s à 5 minutes.** Le plafond était à 60 s, ce qui faisait compter *rien du
tout* — ni pause, ni temps effectif — toute délibération de plus d'une minute, alors que
s'arrêter une à cinq minutes sur un paragraphe est justement la marque de quelqu'un qui compose.
Au-delà de cinq minutes, l'étudiant a quitté le document : ce n'est plus de la friction
cognitive.

**La répétition automatique ne compte pas** : garder Suppr enfoncée pour effacer un mot vaut une
seule suppression.

**Une touche de modification seule n'est pas une frappe.** Maj, Ctrl, Alt ou AltGr pressée pour
elle-même n'écrit rien : elle n'ouvre pas de fenêtre, ne compte pas dans `total_keystrokes` et
n'entre pas dans les flight times — l'écart minuscule qu'elle laisse avant la lettre qu'elle
modifie passerait pour une frappe impossiblement rapide et régulière, ce que `mad_ms` et
`median_flight_ms` servent justement à distinguer. Elle ne solde pas non plus le déplacement qui
la précède : un Maj glissé entre un clic et une Suppr laisse la suppression compter pour une
révision massive. La règle ne concernait que l'extension navigateur et LibreOffice, les seuls à
voir les touches ; Word et VS Code, qui comptent des caractères, n'en voyaient déjà aucune — les
compter d'un côté faisait paraître le même étudiant plus rapide et plus prolixe dans le
navigateur que dans un éditeur.

## Écarts assumés

- **Complément Word** : pas de `mad_ms`, `median_flight_ms` ni `focus_losses`. Office ne livre ni
  les frappes (le capteur travaille par différences de texte), ni la sortie du document, ni
  l'enregistrement ; une cadence calculée sur ses événements serait fausse. Une « frappe » y
  est un caractère inséré ou effacé. N'ayant jamais compté que des différences, il n'a jamais
  eu le biais du clic et voyait déjà le remplacement d'une sélection.
- **LibreOffice** : mêmes metrics et mêmes définitions que l'extension, flight times compris
  (`XUserInputInterception` donne le clavier et la souris) ; seule exception, son gestionnaire de
  clic ne donne pas de coordonnées, donc une sélection **tracée à la souris** n'y est pas
  détectable.
- **VS Code** : pas de `paste_events`. Une insertion faite en un coup y est un collage, un
  extrait de code ou une complétion acceptée (IntelliSense, assistant), et l'API ne dit pas
  laquelle : les caractères comptent bien dans `total_injected_chars` — c'est même là qu'une
  réponse générée se voit — mais le *nombre* de collages serait faux, et une mesure fausse vaut
  moins que pas de mesure. Pour la même raison, les flight times ne retiennent que les
  modifications de la taille d'une frappe. Tout le reste est mesuré, `focus_losses` compris, et
  les trois cases de révision y sont distinguées comme dans le navigateur : une modification
  porte la longueur de ce qu'elle efface, et l'origine du déplacement précédent est connue.

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
`aria-pressed` et vire au rouge, sans jamais être le seul indice de l'état. La fenêtre
LibreOffice garde ses boutons texte — un dialogue UNO n'a pas d'icônes — avec la même aide au
survol (`HelpText`).

Côté moteur, rien n'est déclaré : le trou reste lisible dans le nombre de fenêtres et dans
l'`unmeasured_ratio` du document — la part qu'aucune mesure n'explique. Un devoir
écrit pour moitié pendant une pause le montre là.

## Confidentialité

Aucune touche, aucun caractère, aucun texte ne quitte le poste ni n'est conservé au-delà de ce
qu'exige le calcul. Les capteurs traduisent chaque touche en **catégorie** (`erase`,
`navigation`, `modifier`, `other`) puis l'oublient ; `word/src/sensor.js` ne garde que la lecture
précédente du texte, le temps d'en faire la différence. Le mode debug journalise **des compteurs
et des catégories uniquement**.

Toute modification qui ferait transiter du texte vers le moteur casse la promesse affichée dans
les boutiques : c'est un changement de contrat, pas un détail d'implémentation.

## Vérifier

Chaque implémentation a sa suite, et elles se lisent comme la **spécification exécutable** des
règles ci-dessus : une règle qui change s'y voit d'abord.

| Agent | Tests |
| --- | --- |
| Extension navigateur | `tests/extension-sensor.test.mjs` |
| Complément Word | `tests/word-sensor.test.mjs` |
| Extension LibreOffice | `libreoffice/tests/test_measure.py` |
| Extension VS Code | `tests/vscode-sensor.test.mjs` |

Les tests JavaScript chargent le fichier livré tel quel dans un contexte isolé
(`tests/helpers/sandbox.mjs`) : **rien n'est ajouté au code de production pour le rendre
testable**, et l'horloge est pilotée par le test, sans quoi les règles de pause et de temps
effectif ne seraient pas mesurables. Une règle commune ajoutée ou changée se teste dans chaque
suite — les cas sont volontairement les mêmes de l'une à l'autre, c'est ce qui rend une
divergence visible.
