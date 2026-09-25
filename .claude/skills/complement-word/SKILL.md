---
name: complement-word
description: Complément Office pour Word (word/, Office.js, runtime partagé, manifest.xml, hébergement GitHub Pages) — capteur par différences de texte, file hors-ligne partagée entre documents, CORS du moteur et validation AppSource. À charger avant toute modification dans word/ ou du manifest Office, et avant de diagnostiquer un volet qui ne se recharge pas.
---

# Complément Word (Office Add-in)

`word/` mesure la rédaction dans Word pour Windows et Mac (Microsoft 365, Mac 2019+) et Word sur
le web. `sensor.js` est le capteur (voir `mesures-redaction`), `agent.js` l'envoi au moteur,
`taskpane.html`/`taskpane.js` le volet, `index.html` la page d'accueil du site.

## Une page web, pas un paquet

Le complément est **servi par GitHub Pages** (`https://certimens.github.io/plugins/word/`) :
le manifest ne contient que des URL. Conséquences :

- `word/manifest.xml` est un **gabarit** : `{{BASE_URL}}` et `{{VERSION}}` sont remplacés par
  `scripts/build.mjs`. Ne jamais y écrire d'URL ou de version en dur.
- Office impose une version à **quatre nombres** (`X.Y.Z.0`) et ne peut pas porter le commit.
- L'`<Id>` ne doit **plus jamais changer** une fois publié sur AppSource.
- Publier un correctif ne demande ni release ni tag : `gh workflow run pages.yml --ref ma-branche`
  republie le site. C'est **la production** qui est remplacée ; pour un essai sans conséquence,
  `npm run word:serve` + `dist/word-localhost.xml`.
- Le moteur autorise cette origine en CORS sur `/api` : `wordAddinOrigins` dans
  `internal/api/server.go` du dépôt moteur (`https://certimens.github.io` et
  `https://localhost:3000`). Changer d'hébergement impose un changement côté moteur.

## Runtime partagé

`SharedRuntime` (déclaré dans `<Requirements>`) garde la page chargée **volet fermé** : c'est ce
qui maintient la mesure en vie. Il exclut Word 2016/2019, dont le moteur Internet Explorer ne
peut pas exécuter le complément — ne pas abaisser cette exigence pour élargir le support.

Chaque document ouvert a son instance du complément, mais **tous partagent le même
`localStorage`** (même origine). D'où le bail dans `agent.js` : `RUNTIME_ID` + `LEASE_MS`, un
seul draineur de file à la fois, bail renouvelé à chaque envoi. Toute nouvelle écriture partagée
doit passer par ce mécanisme ou être idempotente.

L'identifiant du document vit dans ses **réglages Office** (`DOCUMENT_ID_SETTING`) : il voyage
avec le `.docx`.

## Capteur par différences

Office ne livre pas les frappes. Chaque modification locale (changement de sélection, paragraphe
modifié, WordApi 1.6) déclenche une relecture du texte, et la différence dit ce qui a été inséré
ou effacé. À préserver :

- `MIN_READ_INTERVAL_MS` (250 ms) : une relecture au plus par quart de seconde ;
- `BASELINE_REFRESH_MS` (5 s) : sans événement local depuis la dernière lecture, le texte relu
  devient simplement la nouvelle référence — c'est ainsi que les modifications des **co-auteurs**
  sont ignorées plutôt que comptées comme frappe ;
- `STRUCTURE_CHARS` : les caractères de structure et invisibles de Word ne sont pas du volume.

Ne jamais conserver le texte au-delà de la lecture précédente, ni l'envoyer.

## Tester en local

```bash
npm run build && npm run word:serve   # HTTPS sur localhost:3000, certificat de dev au 1er lancement
npm run lint:word                     # validation Microsoft du manifest (après build, réseau requis)
```

Charger `dist/word-localhost.xml` : sur le web via *Accueil › Compléments › Mes compléments ›
Charger mon complément* ; sur Windows/Mac via
`npx office-addin-debugging start dist/word-localhost.xml desktop`.

**Le volet montre encore l'ancien code ?** C'est le cache avant tout : Pages sert les fichiers
quelques minutes, et Word garde le sien (`%LOCALAPPDATA%\Microsoft\Office\16.0\Wef` sous Windows,
`~/Library/Containers/com.microsoft.Word/Data/Library/Caches` sous macOS). Vérifier ce qui est en
ligne avec un `curl` sur `…/plugins/word/manifest.xml` avant de soupçonner le code.

## Double comptage

Sur Word pour le web, le complément et l'extension navigateur mesurent la même rédaction. Le
volet le rappelle à l'étudiant ; toute évolution de l'un ne doit pas faire disparaître cet
avertissement.
