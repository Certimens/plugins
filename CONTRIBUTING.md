# Contribuer

Merci de l'intérêt. Ce dépôt est public et sous **AGPL-3.0-only** : en proposant une
modification, vous acceptez qu'elle soit distribuée sous cette licence, clause réseau comprise.
La licence porte sur le code et **ne concède aucun droit sur la marque** (`NOTICE`, terme
additionnel au titre de la clause 7(e)).

Pour signaler une **faille de sécurité**, ne pas ouvrir d'issue : voir
[`SECURITY.md`](SECURITY.md).

## Avant d'écrire une ligne

Lisez la page concernée dans **[`docs/`](docs/README.md)** — il y en a une par agent, plus
[`mesures.md`](docs/mesures.md) (ce que comptent les agents) et [`moteur.md`](docs/moteur.md)
(ce qu'ils attendent du moteur). La documentation est la référence, et elle se tient à jour
**dans le même commit** que le code qu'elle décrit.

```bash
make install    # l'outillage de chaque projet, une fois
make update     # relève les versions épinglées (puis relancer make)
make            # lint, tests, puis cohérence des quatre
make check      # les constantes, les metrics, l'adresse du moteur et les liens, agent par agent
make build      # chaque agent construit son paquet dans <agent>/dist/
```

[`docs/developpement.md`](docs/developpement.md) explique comment installer chaque agent en
développement, et comment chacun se construit.

## Les cinq règles qui surprennent

1. **Une règle de mesure changée dans un agent doit l'être dans les quatre.** La définition est
   unique, les implémentations sont quatre et indépendantes. `make check` compare les
   constantes communes, les metrics envoyées et les fichiers partagés ; les cas de test sont
   volontairement les mêmes d'une suite à l'autre, c'est ce qui rend une divergence visible. Un
   écart qu'une limite de plateforme impose se documente dans *Écarts assumés*
   ([`docs/mesures.md`](docs/mesures.md)).
2. **Une metric s'ajoute côté moteur d'abord, agents ensuite.** Le moteur refuse un type qu'il
   ne connaît pas ; l'inverse rend la mesure invisible et bruyante
   ([`docs/moteur.md`](docs/moteur.md)).
3. **Aucun texte affiché à l'étudiant ne s'écrit en dur.** Il s'ajoute au dictionnaire de
   l'agent, en **français et en anglais** ([`docs/langues.md`](docs/langues.md)).
4. **La version vient de git** (tag, ou dernier tag + commit) : elle ne s'incrémente jamais à la
   main dans un manifest. Ce qui y est écrit n'est qu'un repli.
5. **Chaque agent est un projet autonome**, écrit dans sa langue de bout en bout : les trois
   agents JavaScript ont un `build.mjs`, celui en Python un `build.py`. Un outil s'ajoute dans
   le projet qui l'utilise, jamais à la racine, et rien ne pointe d'un agent vers `../` — sauf
   les liens symboliques de ce que les quatre partagent, et les quelques tests qui comparent
   deux agents entre eux.

Commentaires de code en **anglais**, documentation en **français**. Pas de bundler, pas de
framework : des scripts classiques côté JavaScript, la bibliothèque standard seule côté Python.
Désactiver une règle de lint, c'est écrire pourquoi.

## La forme d'une contribution

- Une branche par sujet, et une *pull request* qui dit **ce que le changement répare ou ajoute**,
  pas seulement ce qu'il touche.
- Messages de commit préfixés (`feat:`, `fix:`, `docs:`, `chore:`), sujet en français.
- `make` passe (lint et tests) avant d'ouvrir la PR : c'est exactement ce que lance la CI.
- La CI lance en plus `make -C <agent> test-host`, qui exécute l'agent dans son hôte réel (un
  vrai Chromium, un vrai VS Code, un vrai LibreOffice) dans un conteneur : c'est là que se voit
  la panne où un agent s'installe et ne fait rien. Il demande Docker et quelques minutes, d'où
  son absence de `make` — mais rien n'empêche de le lancer avant d'ouvrir la PR si on a touché
  un manifest, un chargement ou une interface. Ce qu'aucun hôte automatisé ne verra est listé
  dans `<agent>/TESTING.md`, à relire quand on change un parcours.
- Une règle de comptage ajoutée ou changée se **teste dans chaque suite** concernée.
- Un parcours visible par l'étudiant qui change (appairage, permissions, ce qui part au moteur)
  périme les **fiches de boutique** : `<agent>/store/<boutique>/README.md` se relit dans le même
  commit.
- **Pas de nouvelle dépendance d'exécution** sans raison forte : les trois agents JavaScript
  n'en déclarent aucune, celui en Python s'en tient à la bibliothèque standard. Une dépendance
  d'outillage doit rester compatible AGPL.

Tant qu'aucune release n'est publiée, l'historique du dépôt est **un seul commit racine** : un
correctif s'y fond plutôt que d'ajouter un commit de suite.
