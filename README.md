# Certimens — Agents de rédaction

Les **agents de mesure** de Certimens : quatre implémentations d'un même capteur, qui observent
la **manière** dont un document est écrit — rythme, pauses, corrections, navigation, injections —
et poussent des compteurs au moteur Certimens (`POST /api/documents/:id/metrics`), authentifiés par
un jeton d'API créé à la connexion et conservé à la place du mot de passe, qui n'est jamais
stocké.

**Aucun texte, aucune touche n'est enregistré** : seulement des compteurs par fenêtre de mesure.
Seul un envoi explicite de document, à la demande de l'étudiant, fait sortir du contenu de son
poste.

| Agent | Où il mesure | Paquet |
| --- | --- | --- |
| [`browser/`](docs/extension-navigateur.md) | Google Docs, Word Online | MV3 — Chrome, Firefox, Safari, Edge, Opera |
| [`word/`](docs/complement-word.md) | Word (Windows, Mac, web) | complément Office servi par GitHub Pages |
| [`libreoffice/`](docs/extension-libreoffice.md) | LibreOffice Writer | `.oxt` (Python / UNO) |
| [`vscode/`](docs/extension-vscode.md) | Visual Studio Code, fichier par fichier | `.vsix` |

Les quatre dossiers ont la même forme : `src/` (ce qui est livré), `tests/`, `store/` (une
fiche par boutique), et l'outillage de l'agent autour. Le reste du dépôt : `scripts/` (la
marque et le script qui régénère icônes et visuels) et `legacy/` (anciens agents de bureau,
conservés pour référence — ne pas faire évoluer).

## Documentation

Tout est dans **[`docs/`](docs/README.md)** :

| Document | Contenu |
| --- | --- |
| [docs/mesures.md](docs/mesures.md) | Ce que comptent les agents : fenêtres, constantes, règles, metrics, suspension |
| [docs/extension-navigateur.md](docs/extension-navigateur.md) | L'extension navigateur |
| [docs/complement-word.md](docs/complement-word.md) | Le complément Word |
| [docs/extension-libreoffice.md](docs/extension-libreoffice.md) | L'extension LibreOffice |
| [docs/extension-vscode.md](docs/extension-vscode.md) | L'extension VS Code |
| [docs/langues.md](docs/langues.md) | Français et anglais dans les quatre agents |
| [docs/moteur.md](docs/moteur.md) | Le contrat avec le moteur : endpoints, jeton, CORS, familles de client |
| [docs/developpement.md](docs/developpement.md) | Commandes, tests, versions, charte graphique |
| [docs/publication.md](docs/publication.md) | CI, releases, boutiques |

La documentation se met à jour **dans le même commit** que le code qu'elle décrit.

## Démarrage rapide

```bash
make install              # installe l'outillage de chaque projet (à faire une fois)
make                      # lint puis tests, agent par agent
make build                # chaque agent construit son paquet dans <agent>/dist/
```

Le dépôt contient **quatre projets autonomes**, un par agent : chacun déclare son outillage et
porte son `Makefile`, ses linters, ses tests et son build — `make -C word lint`,
`make -C libreoffice test`, `make -C browser build`… `make` à la racine les parcourt tous, et
n'a rien d'autre à lui. Dans les trois agents JavaScript, `npm run` liste aussi tout ce que
l'agent sait faire ([docs/developpement.md](docs/developpement.md)).

Charger un agent dans son hôte : voir sa page ci-dessus. Pour travailler contre un moteur local,
saisir `http://localhost:8080` comme adresse du moteur.

Publier : poser un tag `vX.Y.Z` et le pousser — **c'est le tag qui donne la version**, rien ne
s'incrémente à la main dans un manifest ([docs/publication.md](docs/publication.md)).

## Et le moteur ?

Ce dépôt est **autonome** : il se lit, se teste et se construit seul. Le moteur qui reçoit les
mesures, calcule le score et sert l'espace web est développé à part et n'est pas public — rien
ici n'y renvoie. Ce qu'un agent attend de lui passe entièrement par son API, décrite du point de
vue des agents dans [docs/moteur.md](docs/moteur.md).

## Licence

**Apache License 2.0** — voir [LICENSE](LICENSE) et [NOTICE](NOTICE). Le code des quatre agents
est libre de lecture, de modification et de redistribution, y compris pour un usage commercial.

Deux précisions :

- La licence porte sur **le code, pas sur la marque** (clause 6) : elle ne concède aucun droit
  sur le nom « Certimens » ni sur l'écu doré. Un dérivé se distribue sous un autre nom.
- Les polices **Plus Jakarta Sans**, livrées dans les paquets, sont sous SIL Open Font License
  1.1 : leur licence les accompagne dans [`browser/src/fonts/LICENSE`](browser/src/fonts/LICENSE).

Chaque agent porte un lien vers ce `LICENSE`, et chaque paquet l'emporte : l'extension, le
`.oxt`, le `.vsix` et le site du complément Word en contiennent une copie réelle.
