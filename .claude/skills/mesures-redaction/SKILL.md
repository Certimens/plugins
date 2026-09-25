---
name: mesures-redaction
description: Définitions partagées des mesures de rédaction (fenêtres, compteurs, metrics envoyées au moteur) implémentées trois fois — extension navigateur, complément Word, extension LibreOffice. À charger avant toute modification d'un capteur, d'une constante de mesure, d'une règle de comptage ou d'une metric, et avant d'expliquer ce que compte un agent.
---

# Mesures de rédaction

Une seule définition, trois implémentations indépendantes :

| Implémentation | Fenêtres de mesure | Capteur |
| --- | --- | --- |
| Extension navigateur | `extension/content.js` | le même fichier (clavier/souris) |
| Complément Word | `word/sensor.js` | le même fichier (différences de texte) |
| Extension LibreOffice | `libreoffice/pythonpath/certimens_agent/measure.py` | `sensor.py` (UNO) |

**Une règle changée dans l'une doit l'être dans les deux autres**, ou être justifiée par une
limite de la plateforme (voir *Écarts assumés*). Le tableau des metrics du `README.md`
(section *Metrics envoyées*) est la référence lisible : il se met à jour dans le même commit.

## Constantes communes

Identiques dans les trois fichiers, à ne pas désynchroniser :

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

## Vérifier

Chaque implémentation a sa suite, et les trois se lisent comme la **spécification exécutable**
des règles ci-dessus : une règle qui change s'y voit d'abord.

| Implémentation | Tests |
| --- | --- |
| Extension navigateur | `tests/extension-sensor.test.mjs` |
| Complément Word | `tests/word-sensor.test.mjs` |
| Extension LibreOffice | `libreoffice/tests/test_measure.py` |

Les tests JavaScript chargent le fichier livré tel quel dans un contexte isolé
(`tests/helpers/sandbox.mjs`) : **rien n'est ajouté au code de production pour le rendre
testable**, et l'horloge est pilotée par le test, sans quoi les règles de pause et de temps
effectif ne seraient pas mesurables.

Une règle commune ajoutée ou changée se teste des deux côtés — les cas sont volontairement les
mêmes d'une suite à l'autre, c'est ce qui rend une divergence visible.

```bash
npm test                   # les deux suites
npm run test:js            # capteurs navigateur et Word (node --test, sans dépendance)
npm run test:libreoffice   # python3 -m unittest discover -s libreoffice/tests
npm run lint               # ESLint sur extension/, word/, scripts/ et tests/
```
