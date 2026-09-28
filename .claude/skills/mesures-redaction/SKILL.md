---
name: mesures-redaction
description: Définitions partagées des mesures de rédaction (fenêtres, compteurs, metrics envoyées au moteur) implémentées quatre fois — extension navigateur, complément Word, extension LibreOffice, extension VS Code. À charger avant toute modification d'un capteur, d'une constante de mesure, d'une règle de comptage ou d'une metric, et avant d'expliquer ce que compte un agent.
---

# Mesures de rédaction

Une seule définition, quatre implémentations indépendantes :

| Implémentation | Fenêtres de mesure | Capteur |
| --- | --- | --- |
| Extension navigateur | `extension/content.js` | le même fichier (clavier/souris) |
| Complément Word | `word/sensor.js` | le même fichier (différences de texte) |
| Extension LibreOffice | `libreoffice/pythonpath/certimens_agent/measure.py` | `sensor.py` (UNO) |
| Extension VS Code | `vscode/sensor.js` | le même fichier (modifications du document) |

**Une règle changée dans l'une doit l'être dans les trois autres**, ou être justifiée par une
limite de la plateforme (voir *Écarts assumés*). Le tableau des metrics du `README.md`
(section *Metrics envoyées*) est la référence lisible : il se met à jour dans le même commit.

## Constantes communes

Identiques dans les trois fichiers, à ne pas désynchroniser :

Les trois premières implémentations comptent une frappe par touche ou par caractère ; VS Code,
lui, ajoute une constante qui n'a de sens que chez lui, `SELECTION_ECHO_MS` (50 ms) : l'éditeur
signale un déplacement du curseur après chaque frappe, et sans ce délai `navigation_jumps`
suivrait exactement `total_keystrokes`.

| Constante | Valeur | Ce qu'elle borne |
| --- | --- | --- |
| `FLUSH_KEYSTROKES` | 200 | envoi de la fenêtre au bout de 200 frappes |
| `IDLE_FLUSH_MS` / `IDLE_FLUSH_S` | 2 s | envoi après 2 s sans activité |
| `PAUSE_MIN_S` / `PAUSE_MAX_S` | 3 s / 300 s | ce qui compte comme pause cognitive |
| `ACTIVE_GAP_MAX_S` | 60 s | ce qu'un trou ajoute au temps effectif |
| `INJECTION_MIN_CHARS` | 15 | en deçà, un collage n'est pas une injection |
| `FLIGHT_MAX_MS` | 800 | au-delà, l'écart entre deux frappes n'est pas un flight time |

`PAUSE_MAX_S` et `ACTIVE_GAP_MAX_S` sont **deux règles distinctes** qui ont partagé la même
valeur par accident. Un long silence compte comme une pause sans être crédité en temps de frappe :
ne pas les réunifier.

## Règles de comptage

- **Une suppression solde le déplacement qui la précède.** Première Suppr après un clic =
  révision massive ; après une flèche = reformulation différée ; **les suivantes sont des
  corrections immédiates**. Sans cette remise à zéro, un seul clic faisait basculer toute une
  rafale en reformulations et `immediate_corrections` restait à zéro.
- **Remplacer une sélection est une suppression**, à l'échelle de la sélection (Ctrl/Cmd+A,
  tracé souris, Maj+déplacement). Maj seule ne sélectionne rien ; un déplacement sans Maj ou un
  clic annule la sélection ; elle n'est décomptée qu'une fois.
- **La répétition automatique ne compte pas** : Suppr maintenue = une suppression.
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
| Extension navigateur | `chrome.storage.local`, clé `paused` | `extension/content.js` (chaque gestionnaire, et `recordInjection`) |
| Complément Word | `localStorage` partagé, `isPaused()` d'`agent.js` | `word/sensor.js` (`noteLocalEvent`, `onSelectionChanged`) |
| Extension LibreOffice | `certimens.json`, `Engine.paused()` | `sensor.py` (`on_key`, `on_click`, `on_paste`, `on_deactivated`) |
| Extension VS Code | `globalState`, `Agent.paused()` | `vscode/extension.js` (les gestionnaires de l'hôte) |

Le complément Word est le seul cas où la lecture du document **continue** pendant la pause : son
capteur travaille par différences, et sans rafraîchir sa référence, tout ce qui a été écrit
pendant la pause atterrirait d'un coup dans la première fenêtre d'après (voir `BASELINE_REFRESH_MS`).

## Invariant de confidentialité

Aucune touche, aucun caractère, aucun texte ne quitte le poste ni n'est conservé au-delà de ce
qu'exige le calcul. Les capteurs traduisent chaque touche en **catégorie** (`erase`,
`navigation`, `modifier`, `other`) puis l'oublient ; `word/sensor.js` ne garde que la lecture
précédente du texte, le temps de la différence. Le mode debug journalise **des compteurs et des
catégories uniquement**. Toute modification qui ferait transiter du texte vers le moteur casse la
promesse produit affichée dans les boutiques : c'est un changement de contrat, pas un détail
d'implémentation.

## Metrics étendues

`paste_events`, `focus_losses` et `median_flight_ms` sont plus récentes que certains moteurs
déployés. Face à un **`400` portant le code `metric_type_unknown`** — et seulement celui-là —
l'agent retire ces trois metrics et renvoie le reste, puis réessaie à la prochaine connexion.
Tout autre `400` (période invalide, corps mal formé) ne doit pas désactiver les metrics étendues :
c'était le bug qui empêchait `focus_losses` de repartir.

Les types acceptés sont déclarés côté moteur dans `internal/file/domain/metric.go`
(`apperr.Invalidf("metric_type_unknown", …)`). Ajouter une metric, c'est donc **deux dépôts** :
le moteur d'abord, les agents ensuite, avec la dégradation ci-dessus.

## Écarts assumés

- **Complément Word** : pas de `mad_ms`, `median_flight_ms` ni `focus_losses`. Office ne livre
  pas les frappes (le capteur travaille par différences de texte) ni la sortie du document ; une
  cadence calculée sur ses événements serait fausse. Une « frappe » y est un caractère inséré ou
  effacé. N'ayant jamais compté que des différences, il n'a jamais eu le biais du clic.
- **LibreOffice** : mêmes metrics et mêmes définitions que l'extension, flight times compris
  (`XUserInputInterception` donne clavier et souris) ; seule exception, son gestionnaire de clic
  ne donne pas de coordonnées, donc une sélection **tracée à la souris** n'y est pas détectable.
- **VS Code** : pas de `paste_events`. Une insertion faite en un coup y est un collage, un
  extrait de code ou une complétion acceptée (IntelliSense, assistant), et l'API ne dit pas
  laquelle : les caractères comptent dans `total_injected_chars`, le *nombre* de collages serait
  faux. Pour la même raison les flight times ne retiennent que les modifications de la taille
  d'une frappe. Tout le reste est mesuré, y compris `focus_losses` (la fenêtre de l'éditeur perd
  le focus) et les trois cases de révision : une modification porte la longueur de ce qu'elle
  efface, et l'origine du déplacement précédent (clavier, souris, commande) est connue. Une
  frappe y est un caractère inséré ou effacé, comme dans Word.

## Vérifier

Chaque implémentation a sa suite, et les trois se lisent comme la **spécification exécutable**
des règles ci-dessus : une règle qui change s'y voit d'abord.

| Implémentation | Tests |
| --- | --- |
| Extension navigateur | `tests/extension-sensor.test.mjs` |
| Complément Word | `tests/word-sensor.test.mjs` |
| Extension LibreOffice | `libreoffice/tests/test_measure.py` |
| Extension VS Code | `tests/vscode-sensor.test.mjs` |

Les tests JavaScript chargent le fichier livré tel quel dans un contexte isolé
(`tests/helpers/sandbox.mjs`) : **rien n'est ajouté au code de production pour le rendre
testable**, et l'horloge est pilotée par le test, sans quoi les règles de pause et de temps
effectif ne seraient pas mesurables.

Une règle commune ajoutée ou changée se teste dans chaque suite — les cas sont volontairement les
mêmes de l'une à l'autre, c'est ce qui rend une divergence visible.

```bash
npm test                   # toutes les suites
npm run test:js            # capteurs navigateur, Word et VS Code (node --test, sans dépendance)
npm run test:libreoffice   # python3 -m unittest discover -s libreoffice/tests
npm run lint               # ESLint sur extension/, word/, scripts/ et tests/
```
