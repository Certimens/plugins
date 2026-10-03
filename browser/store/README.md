# Boutiques — extension navigateur

Un dossier par boutique : la fiche à copier, et les visuels qu'elle demande. Les étapes de
**mise en place** d'un compte développeur et des identifiants d'API sont ailleurs, dans
[`docs/publication.md`](../../docs/publication.md) ; ici, c'est le contenu de la fiche.

| Boutique | Paquet | Fiche |
| --- | --- | --- |
| Chrome Web Store | `dist/chrome.zip` | [`chrome/`](chrome/) |
| addons.mozilla.org | `dist/firefox.zip` | [`firefox/`](firefox/) |
| Edge Add-ons | `dist/chrome.zip` | [`edge/`](edge/) |
| Opera Add-ons | `dist/chrome.zip` | [`opera/`](opera/) |
| App Store (Safari) | `dist/safari-xcode/` | [`safari/`](safari/) |

Le **nom** et la **description courte** sont les mêmes partout, et viennent du paquet
(`src/_locales/{fr,en}/messages.json`) :

| | Français | English |
| --- | --- | --- |
| Nom | Certimens — Agent de rédaction | Certimens — Writing Agent |
| Description | Mesure la rédaction dans Google Docs et Word Online : seulement des compteurs. Votre document n'est envoyé que si vous le déposez. | Measures how you write in Google Docs and Word Online: counters, never your text. The document is sent only when you submit it. |

**Aucune boutique ne traduit la fiche à partir du paquet** : chacune a un onglet par langue, à
remplir à la main dans les deux.

Partout : site `https://certimens.fr`, assistance `contact@certimens.fr`, confidentialité
`https://certimens.fr/politique-de-confidentialite/`. Les visuels se régénèrent avec
`npx --yes --package sharp -- node ../../scripts/brand-assets.mjs`.
