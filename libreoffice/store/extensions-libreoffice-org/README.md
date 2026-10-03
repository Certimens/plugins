# extensions.libreoffice.org — fiche de l'extension

Le site des extensions LibreOffice n'a **pas d'API** : la publication se fait à la main, à
chaque version, sur [extensions.libreoffice.org](https://extensions.libreoffice.org) (compte
nécessaire, le même que pour les autres services de la fondation). Paquet :
`dist/libreoffice.oxt`, construit par `make build`.

L'extension s'installe aussi très bien **sans passer par le site** — *Outils › Gestionnaire des
extensions › Ajouter*, à partir du `.oxt` joint à la release GitHub. Une fiche ici n'est utile
que pour être trouvé.

## Ce que le paquet porte déjà

`description.xml` contient le nom, l'éditeur, l'icône et la description, en français et en
anglais ; LibreOffice affiche l'entrée qui correspond à la langue de son interface. La fiche du
site reprend ces textes, elle ne les lit pas dans le paquet.

| Champ | Valeur | Où |
| --- | --- | --- |
| Identifiant | `fr.certimens.agent` | `description.xml` — **ne change plus** une fois publié |
| Nom | Certimens — Agent de rédaction / Writing Agent | `<display-name>` |
| Version minimale | LibreOffice 7.0 | `<dependencies>` (barres d'info et Python 3 fournis) |
| Description | `src/description/description-fr.txt`, `description-en.txt` | `<extension-description>` |

## Description de la fiche

Celle du paquet, mot pour mot — c'est le même texte que l'utilisateur lira dans le gestionnaire
d'extensions :

> Mesure la rédaction dans LibreOffice Writer (rythme de frappe, pauses, corrections, collages)
> et envoie les compteurs à votre espace Certimens. Aucun texte ni aucune touche n'est
> enregistré : seulement des compteurs. Un compte Certimens, fourni par l'établissement, est
> nécessaire. Depuis le menu Certimens de Writer, l'étudiant associe son document à un document
> Certimens, le rend sur un devoir de sa classe et envoie sa version .docx en un clic.

> Measures how you write in LibreOffice Writer (typing rhythm, pauses, corrections, pastes) and
> sends the counters to your Certimens space. No text and no keystroke is ever recorded:
> counters only. A Certimens account, provided by your institution, is required. From Writer's
> Certimens menu, the student links their document to a Certimens document, submits it to an
> assignment of their class, and sends its .docx version in one click.

Un texte modifié ici doit l'être **dans `src/description/` d'abord** : c'est le paquet qui fait
foi.

## Champs du formulaire

| Champ | Valeur |
| --- | --- |
| Catégorie | Writer extensions |
| Compatibilité | LibreOffice 7.0 et au-delà |
| Plateformes | toutes (Python/UNO, rien de compilé) |
| Site du projet | https://certimens.fr |
| Assistance | contact@certimens.fr |
| Confidentialité | https://certimens.fr/politique-de-confidentialite/ |

## Licence

**AGPL-3.0** : à choisir dans la liste du formulaire. Le texte voyage dans le `.oxt`
(`LICENSE`, un lien vers celui de la racine), avec `NOTICE`, qui rappelle que la licence ne
concède aucun droit sur la marque « Certimens » et que tout dérivé reste sous la même licence.

Le `.oxt` n'affiche **pas** d'écran d'acceptation à l'installation : `description.xml` ne
déclare pas de `<simple-license>`. L'AGPL n'impose pas non plus d'acceptation pour *installer*
une extension — elle ne s'applique qu'à la copie, la modification et la redistribution (clause
9) : l'écran reste inutile.

## Ce que la fiche doit dire sur les données

Mêmes faits que pour les autres agents : e-mail Certimens et jeton d'accès (le mot de passe
n'est pas conservé), compteurs de rédaction, titre et nombre de caractères du document, et le
`.docx` **uniquement** quand l'étudiant le dépose. Destination unique : le moteur Certimens de
l'établissement.
