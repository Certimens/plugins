# Langues

Les agents parlent **français et anglais**. Le français est la langue par défaut : le produit
est vendu à l'enseignement supérieur français, et une locale inconnue y atterrit plutôt que dans
une langue que l'établissement n'utilise pas.

## La règle

Celle du moteur : **une étiquette qui commence par `en` donne l'anglais, tout le reste donne le
français.** Elle est réimplémentée dans chaque agent plutôt que demandée au moteur — un agent
doit choisir sa langue avant d'avoir jamais joint le moteur.

La langue vient, dans cet ordre :

1. **le compte Certimens**, dont la langue arrive avec la réponse de connexion (`me.language`)
   et est conservée dans la configuration de l'agent ;
2. **la langue de l'hôte** — le navigateur, Word, LibreOffice, l'éditeur ;
3. **le français**.

Le compte l'emporte parce que c'est la langue que l'étudiant a choisie dans son espace, et celle
de ses e-mails.

## Où vivent les textes

| Agent | Textes de l'interface | Fiche et manifest |
| --- | --- | --- |
| Navigateur | `browser/src/i18n.js` | `browser/src/_locales/{fr,en}/messages.json` (`__MSG_…__` dans le manifest) |
| Word | `browser/src/i18n.js`, partagé et copié par le build | `<Override Locale="en-us">` dans `word/src/manifest.xml` |
| LibreOffice | `libreoffice/src/pythonpath/certimens_agent/i18n.py` | `description.xml` et `description/description-{fr,en}.txt` |
| VS Code | `vscode/src/i18n.js` | `vscode/package.nls.json` (français, le repli) et `package.nls.en.json` |

Aucune page ne porte de texte en dur : `data-i18n="clé"` côté extension et Word, injection à la
construction côté VS Code.

## Un refus est un texte d'interface

Les pages ne sont pas les seules à parler. Ce qu'un agent **formule lui-même** quand il refuse —
un document trop volumineux, un devoir auquel l'étudiant n'est pas rattaché, un export Google
Docs bloqué, une lecture de document impossible — finit dans le même bandeau que le reste et
vient donc du dictionnaire, comme n'importe quelle étiquette. Ce qui vient du **moteur**, lui,
est repris tel quel : il répond déjà dans la langue du compte.

Ces phrases-là se rédigent comme des **fragments**, en minuscule et sans point final : elles
s'insèrent dans `upload.failed`, `submit.refused` ou `error.prefix`, qui portent la ponctuation.

## La langue se choisit avant le premier envoi

Un agent envoie avant d'afficher : la file part dès le démarrage, et le premier message qu'il
formule peut être celui d'un envoi refusé, sans qu'aucune page ait été rendue. `setLanguage` va
donc au **démarrage de l'agent**, pas au premier rendu — et, dans le service worker de
l'extension, au chargement du script plutôt que depuis `onInstalled` ou `onStartup` : un worker
est réveillé par une alarme ou un message bien plus souvent qu'il n'est installé.

## Le manifest est lu avant notre code

C'est l'hôte qui le traduit, d'après sa **propre** langue d'interface. Le nom dans la barre
d'outils peut donc être anglais pendant que le volet est français, si le compte dit l'anglais et
le navigateur le français. Rien d'autre n'est possible pour un texte que l'hôte lit avant nous.

## Vérifier

Chaque agent vérifie **son** dictionnaire : parité des clés, variables (`{title}`, `{count}`),
règle de choix de la langue — `browser/tests/i18n.test.mjs`, `vscode/tests/i18n.test.mjs`,
`libreoffice/tests/test_i18n.py`.

Le dictionnaire du navigateur est la **référence** : le volet Word pointe sur ce fichier par un
lien symbolique, et les deux autres en tiennent une copie. Ce sont donc **les copies** qui
vérifient leur accord avec lui — une clé commune doit porter le même message des deux côtés,
sinon l'étudiant lira deux phrases différentes pour un même état.

## Ajouter une langue

Cela commence **côté moteur** : il n'en connaît que deux, et l'étudiant choisirait sinon dans
son espace une langue que le moteur refuse d'enregistrer. Les quatre dictionnaires, les
manifests et les fiches des boutiques suivent — ces dernières se remplissent langue par langue
dans chaque tableau de bord, aucune boutique ne les déduit du paquet (textes dans
`<agent>/store/<boutique>/`).
