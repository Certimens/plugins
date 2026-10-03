---
name: performance-capteurs
description: Le budget de temps des quatre capteurs — ce qui tourne sur le fil de l'étudiant pendant qu'il écrit, ce qui doit être mis en cache avec un âge, ce qui s'écrit dans la file, et ce qui ne doit pas tourner quand personne ne regarde. À charger avant d'ajouter une lecture du document, une empreinte, un observateur DOM, un intervalle, une écriture dans la file, ou avant de diagnostiquer un éditeur qui saccade avec l'agent installé.
---

# Performance des capteurs

Un capteur tourne **sur le fil de l'étudiant pendant qu'il rédige** : le script de contenu dans
la page de l'éditeur, Office.js dans le volet, UNO sur le fil d'interface de LibreOffice,
l'extension dans l'*extension host* de VS Code. Une milliseconde prise ici est prise à la frappe
suivante, et le poste d'un étudiant n'est pas une machine de développement : **compter sur un
facteur 3 à 5** par rapport à ce qu'on mesure chez soi.

Un agent qui fait saccader l'éditeur ne sera pas désinstallé pour ses mesures : il sera
désinstallé.

## Ce qui tourne à chaque fenêtre

Une fenêtre se ferme après 2 s d'inactivité, à 200 frappes, à chaque sortie du document et à
chaque sauvegarde — soit, pour quelqu'un qui écrit, **plusieurs fois par minute**. Tout ce que
`flush()` appelle est donc dans le chemin chaud.

| Agent | Lu à chaque fenêtre | Plafonné à |
| --- | --- | --- |
| Navigateur — Google Docs | export texte, par le *service worker* | 30 s (`VOLUME_REFRESH_MS`) |
| Navigateur — Word Online | `innerText` du panneau d'édition | 5 s (`LOCAL_VOLUME_REFRESH_MS`) |
| Navigateur — site ajouté | `innerText` de chaque zone d'édition de la page | 5 s |
| Complément Word | `chars(previousText)`, le corps déjà lu | la lecture l'est (250 ms) |
| LibreOffice | `CharacterCount` du document | 5 s (`VOLUME_REFRESH_S`) |
| VS Code | `chars(document.getText())` | — |

**Toute lecture du document porte un âge**, et l'âge appartient à l'éditeur
(`volumeMaxAgeMs` dans l'objet `EDITORS`), pas au lecteur : le plafond est appliqué **une fois**,
dans `documentVolume()`, pour que l'ajout d'un éditeur n'ait pas à y penser. Une lecture locale
n'est pas gratuite pour autant : `innerText` force un recalcul de mise en page **synchrone** de
tout le panneau d'édition, et c'est le plus cher de ce tableau.

Deux règles vont avec, et chacune a coûté un bug :

- un lecteur rend ce qu'il sait lire **maintenant**, ou `null` ; il ne décide pas s'il faut
  relire. Mélanger les deux est ce qui avait laissé `cachedVolumeAt` n'être renseigné que par un
  chemin sur trois ;
- un lecteur qui rend `null` a échoué : la dernière valeur connue repart, mais **son âge ne
  bouge pas**, sinon la fenêtre suivante camperait sur un échec pendant tout le délai.

C'est exactement le genre d'écart qu'aucun agent ne peut voir depuis chez lui, et que
`make check` ne compare pas.

## Compter des caractères sans allouer

`[...texte].length` est la façon juste de compter des points de code, et elle alloue **un tableau
d'un élément par caractère**. Sur un document de 215 000 caractères, mesuré sous Node 22 :

| | par lecture |
| --- | --- |
| `[...texte.replace(RE, '')].length` | 1,44 ms |
| même résultat, sans allocation | 0,11 ms |

Le raccourci est exact : un texte sans demi-codet n'a qu'à rendre sa `length`, et
`/[\uD800-\uDBFF]/.test(s)` le dit en un balayage natif. Le cas général — compter les paires de
substitution et les retrancher — ne sert que pour les emojis et les écritures hors du plan de
base.

Le résultat **doit rester identique** : le moteur compte un document déposé de la même façon, et
`real_volume_chars` se compare à ce compte-là.

## Les empreintes coûtent en proportion du texte sorti

`shingles()` hache chaque groupe de quatre mots : le coût suit la taille du texte copié, et il
est payé **dans le gestionnaire `copy`**, donc Ctrl+A puis Ctrl+C sur une dissertation entière se
voit à l'écran.

| Texte copié (224 000 caractères, ~37 000 mots) | sous Node 22 |
| --- | --- |
| `shingles()` tel qu'il était livré | 21 ms |
| sans `slice()` ni `join()` par empreinte | 11 ms |

Trois règles, et elles tiennent ensemble :

1. **Copier saisit, le tour suivant hache.** `doc.getSelection()` ne se lit que dans le
   gestionnaire ; `rememberOwnText()` part dans un `setTimeout(…, 0)`. Entre une copie et le
   retour du texte depuis un correcteur il s'écoule des secondes, jamais la fraction de
   milliseconde qu'attend un délai nul.
2. **Coller ne peut pas attendre** : `matchOwnText()` doit répondre avant que le collage soit
   classé. C'est pour ce chemin-là que `hashShingle(words, from)` lit les mots sur place au lieu
   d'en découper une tranche et de la joindre — deux objets par mot du document, sinon.
3. **Ne pas hacher ce qui ne peut rien reconnaître.** Word ne retient que ce qui dépasse
   `INJECTION_MIN_CHARS` : une suppression d'un caractère ne porte aucune empreinte.

**Une empreinte est un contrat entre les quatre agents** : le même texte doit donner le même
nombre partout, sans quoi une restitution cesse d'être reconnue chez l'un d'eux — en silence.
Une réécriture de `hashShingle`, même « équivalente », se vérifie donc sur des valeurs épinglées
des deux côtés (`browser/tests/sensor.test.mjs`, `word/tests/sensor.test.mjs`,
`libreoffice/tests/test_measure.py`).

Ne pas plafonner la taille du texte haché : « tout sélectionner, passer au correcteur, recoller »
est précisément le geste que `self_paste_events` existe pour reconnaître.

## Ne pas installer un observateur qui n'a rien à chercher

`browser/src/content.js` n'installe son `MutationObserver` — `document.documentElement` en
`subtree + childList`, l'arbre entier de la page — **que si `editor.inputIframes` est renseigné**.
Il ne l'était pas : sur Word Online et sur Overleaf, les deux éditeurs qui remanient le plus leur
DOM, le rappel sortait aussitôt sans rien pouvoir trouver.

La règle vaut au-delà de ce cas : un observateur, un intervalle, un écouteur ne s'installent que
là où ils peuvent trouver quelque chose, et le `500 ms` d'anti-rebond qui suit ne rattrape pas une
observation qu'il ne fallait pas ouvrir.

## Vider la file écrit un curseur, pas la file

Ce qui doit être écrit **entre deux envois**, c'est « jusqu'où on est allé » — sans quoi une
fenêtre repartirait. Les quatre agents y réécrivaient toute la file. Mesuré côté LibreOffice, où
l'état est un seul document JSON : **120 ms par écriture** pour 5000 fenêtres, soit ~300 s de
disque et 7,5 Go écrits pour une seule journée hors ligne rattrapée.

Ce qui est écrit maintenant est un curseur, et son coût ne dépend plus de ce qu'il y a derrière :

| Agent | Le curseur | Pourquoi celui-là |
| --- | --- | --- |
| Navigateur | `queueSent`, un nombre, dans `chrome.storage.local` | une clé à part s'écrit seule |
| VS Code | `queueSent` dans le stockage global | idem |
| Complément Word | `queueSent`, **l'identifiant** de la dernière fenêtre partie | plusieurs documents partagent un `localStorage` : un compteur bougerait sous l'instance qui vide la file |
| LibreOffice | un fichier `certimens.json.sent` à côté de l'état | l'état est un seul document JSON : y écrire quoi que ce soit réécrit la file avec |

Le tableau se lit par sa dernière colonne : le mécanisme diffère parce que le stockage diffère,
pas par goût.

Deux invariants, et ils ne se négocient pas :

- **le curseur avance avant l'envoi suivant** — une fenêtre partie ne repart jamais, même si la
  reprise est coupée en deux (testé dans les quatre suites) ;
- **la file se compacte là où elle est déjà réécrite** : à la mise en file, et une fois à la fin
  d'une reprise. Jamais une écriture de plus pour compacter.

## Ce qui tourne quand personne ne regarde

- La relecture de référence du volet Word part de `BASELINE_REFRESH_MS` (5 s) et **double tant que
  le document ne bouge pas**, jusqu'à `BASELINE_MAX_MS`. Elle existe pour rattraper les
  co-auteurs ; Word annonce les siens (`onParagraphEvent`), donc le minuteur n'est que le filet
  sous ce qu'il n'annonce pas. Le plafond est à 20 s et non à une minute pour une raison écrite
  dans le code : ce qu'il élargit, c'est la maille du filet.
- La page d'options **retient son souffle quand l'onglet est masqué** : chaque rafraîchissement
  est un message au *service worker*, et un message est ce qui en réveille un. Revenir sur
  l'onglet redessine.
- Le sondage du titre (`TITLE_CHECK_MS`, 3 s) tourne encore dans **chaque onglet d'éditeur
  ouvert**, masqué compris. Il ne lit qu'un `document.title` et un `querySelector` : c'est le
  moins cher des trois, et il n'a pas été touché.

Un capteur qui ne mesure rien doit tendre vers zéro travail. Ce n'est pas une optimisation : sur
un portable, c'est l'autonomie de l'étudiant.

## Mesurer avant d'affirmer

Les chiffres ci-dessus se refont en quelques lignes, hors du dépôt (le bac à sable de la session,
jamais `/tmp` ni l'arborescence du projet) : construire un texte de la taille visée, appeler la
fonction telle qu'elle est livrée, boucler, diviser. Pour ce qui touche au DOM — `innerText`, un
observateur — le vrai banc est `make -C browser test-host`, qui lance l'agent dans un Chromium
réel : un coût de mise en page ne se mesure pas sous Node.
