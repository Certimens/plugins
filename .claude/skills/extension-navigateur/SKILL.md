---
name: extension-navigateur
description: Extension navigateur MV3 de Certimens (extension/, un seul manifest pour Chrome, Firefox, Safari, Edge et Opera) — service worker, content scripts, permissions, empaquetage par navigateur et contraintes des boutiques. À charger avant toute modification dans extension/, scripts/build.mjs ou eslint.config.js, et avant de toucher au manifest ou aux permissions.
---

# Extension navigateur (MV3)

`extension/` mesure la rédaction dans Google Docs et Word Online. `content.js` est le capteur
(voir la skill `mesures-redaction`), `background.js` le service worker qui pousse vers le moteur,
`popup.js` / `options.js` les pages, `ui.js` / `ui.css` le socle partagé avec le complément Word.

## Un seul manifest, trois paquets

`extension/manifest.json` sert tous les navigateurs **et le chargement non empaqueté**.
`scripts/build.mjs` n'en garde, pour chaque cible, que ce qu'elle comprend :

- **Chrome et Safari** : `background.service_worker` seul, pas de `browser_specific_settings` ;
- **Firefox** : `background.scripts` seul ;
- `chrome.zip` sert aussi Edge, Opera, Brave, Vivaldi et Arc.

Une clé ajoutée au manifest doit donc être pensée pour les trois cibles, ou retirée dans
`TARGETS` du build. Ne jamais maintenir de manifest par navigateur.

## Versions : rien à monter à la main

La version vient de git. Release (tag `vX.Y.Z`) → `X.Y.Z` ; sinon dernier tag + commit
(`1.4.2-a9085f3`). Chrome n'accepte qu'une version numérique : le repère lisible va dans
`version_name`. La `version` de `manifest.json` n'est plus qu'un repli pour un dépôt sans tag —
**ne pas l'incrémenter dans un commit de fonctionnalité**.

## Contraintes des boutiques

- `description` ≤ **132 caractères** : au-delà le Chrome Web Store et Opera refusent le paquet,
  et le build échoue avant eux (contrôle en tête de `scripts/build.mjs`).
- Firefox exige `browser_specific_settings.gecko` : `id` stable, `strict_min_version`, et
  `data_collection_permissions` à jour de ce que l'extension collecte réellement. `npm run
  lint:firefox` (après build) traite les avertissements AMO comme des erreurs.
- **Aucun code distant** : tout est empaqueté, pas de `<script src>` externe, pas d'`eval`. Les
  polices sont livrées dans `extension/fonts/`.
- Permissions au plus juste : `storage` et `alarms`, plus les hôtes des éditeurs et du moteur.
  Un moteur personnalisé (`http://localhost:8080`) passe par `optional_host_permissions`,
  demandé à l'exécution — ne pas élargir `host_permissions` pour s'en dispenser.

## Scripts classiques, pas de modules

`sourceType: 'script'` : `popup.js` et `options.js` consomment les fonctions déclarées par
`ui.js`, chargé avant eux. Il n'y a ni `import` ni bundler. Une fonction partagée nouvelle doit
être **déclarée dans `ui.js` et ajoutée aux globals d'`eslint.config.js`**, sinon le lint casse.

## Service worker

`background.js` peut être arrêté à tout moment : aucun état en mémoire ne survit.

- L'état vit dans `chrome.storage.local` (`config`, `files`, `titles`, `syncedTitles`, `queue`,
  `status`) ; la file hors-ligne est plafonnée à `MAX_QUEUE` et rejouée par une **alarme**
  (`chrome.alarms`), jamais par `setInterval`.
- Tout accès à la file passe par `withLock` : un envoi et une nouvelle mesure ne doivent ni se
  marcher dessus ni créer deux fichiers pour le même document.
- L'authentification est un **token d'API (Bearer)** créé à la connexion et gardé à la place du
  mot de passe. La migration d'une ancienne config partage sa promesse en vol (`migration`) :
  sans ça, deux appels concurrents créent deux tokens, dont un restera valide sans moyen de le
  révoquer.
- Pas de DOM dans le service worker (ni `document`, ni `localStorage`).

`content.js` tourne dans Google Docs et dans l'iframe d'édition de Word Online
(`all_frames: true`) : les deux éditeurs sont décrits par l'objet `EDITORS`, qui isole tout ce
qui est spécifique à l'un (id du document, zone d'édition, iframes de saisie, sens du blur,
lecture du volume). Ajouter un éditeur, c'est ajouter une entrée là, pas des `if` ailleurs.

## Accessibilité

Popup, page d'options et volet Word sont vendus à l'enseignement supérieur public :
libellés associés aux champs, focus visible, contrastes de `ui.css`, messages d'erreur lus par
les lecteurs d'écran. Les couleurs de verdict (vert/orange/rouge) portent du sens : ne jamais les
laisser seules porter l'information.

## Vérifier

```bash
npm run lint           # ESLint
npm run build          # dist/{chrome,firefox,safari}.zip, dist/word/, dist/libreoffice.oxt
npm run lint:firefox   # validation AMO du paquet Firefox (après build)
```
