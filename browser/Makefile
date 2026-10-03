# Extension navigateur MV3 — Chrome, Firefox, Safari, Edge, Opera.
#
# Les commandes sont déclarées dans package.json ; ce Makefile les appelle, et c'est tout. Un
# développeur JavaScript peut donc ignorer make et lancer `npm run lint`, `npm test`,
# `npm run build` — `npm run` seul liste ce que l'agent sait faire. Le Makefile existe pour que
# les quatre agents, dont un en Python, répondent aux mêmes cibles.
#
#   make install     npm ci
#   make lint        ESLint, Stylelint (ui.css), html-validate (popup, options), ShellCheck
#   make test        les règles de comptage du capteur
#   make build       dist/{chrome,firefox,safari}.zip et les dossiers dépaquetés
#   make lint-amo    validation addons.mozilla.org du paquet Firefox (après make build)
#   make safari      projet Xcode macOS + iOS (macOS seulement, après make build)
#   make clean       efface dist/
#
# Publication, une boutique par cible (après make build) :
#   make publish-chrome | publish-firefox | publish-edge | publish-opera
# Les identifiants viennent de l'environnement — voir docs/publication.md pour la liste.
# La release les appelle une par une ; sans identifiants, la cible échoue, elle n'invente rien.
# Safari se publie à la main depuis Xcode.
#
# ui.css, ui.js, i18n.js, fonts/, icons/ et tests/helpers/ vivent ici : les trois autres agents
# y pointent par des liens symboliques, et c'est donc ici qu'ils sont vérifiés.

STORES := chrome firefox edge opera
PUBLISH := $(addprefix publish-,$(STORES))

.PHONY: install lint test build lint-amo safari clean $(PUBLISH)

node_modules: package-lock.json
	npm ci
	@touch node_modules

install: node_modules

lint: node_modules
	npm run lint

test: node_modules
	npm test

build: node_modules
	npm run build $(if $(RELEASE),-- --release $(RELEASE))

lint-amo: node_modules
	npm run lint:amo

safari: node_modules
	npm run safari

clean:
	npm run clean

# Une règle, quatre cibles : $@ dit laquelle.
$(PUBLISH): node_modules
	npm run publish:$(@:publish-%=%)
