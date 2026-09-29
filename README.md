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
| [`extension/`](docs/extension-navigateur.md) | Google Docs, Word Online | MV3 — Chrome, Firefox, Safari, Edge, Opera |
| [`word/`](docs/complement-word.md) | Word (Windows, Mac, web) | complément Office servi par GitHub Pages |
| [`libreoffice/`](docs/extension-libreoffice.md) | LibreOffice Writer | `.oxt` (Python / UNO) |
| [`vscode/`](docs/extension-vscode.md) | Visual Studio Code, fichier par fichier | `.vsix` |

Le reste du dépôt : `scripts/` (build des paquets, certificat de dev Word, visuels de marque),
`store/` (visuels et textes des fiches des boutiques), `tests/` (les capteurs, sans hôte), et
`legacy/` (anciens agents de bureau, conservés pour référence — ne pas faire évoluer).

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
npm ci
npm run lint              # ESLint (extension/, word/, vscode/, scripts/, tests/)
npm test                  # toute la suite, sans navigateur, sans Word, sans LibreOffice, sans VS Code
npm run build             # tous les paquets dans dist/
```

Charger un agent dans son hôte : voir sa page ci-dessus. Pour travailler contre un moteur local,
saisir `http://localhost:8080` comme adresse du moteur.

Publier : poser un tag `vX.Y.Z` et le pousser — **c'est le tag qui donne la version**, rien ne
s'incrémente à la main dans un manifest ([docs/publication.md](docs/publication.md)).

## Et le moteur ?

Ce dépôt est **autonome** : il se lit, se teste et se construit seul. Le moteur qui reçoit les
mesures, calcule le score et sert l'espace web est développé à part et n'est pas public — rien
ici n'y renvoie. Ce qu'un agent attend de lui passe entièrement par son API, décrite du point de
vue des agents dans [docs/moteur.md](docs/moteur.md).
