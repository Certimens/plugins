# Complément Office pour Word (Office.js), servi par GitHub Pages.
#
# Les commandes sont déclarées dans package.json ; ce Makefile les appelle, et c'est tout —
# `npm run` seul liste ce que l'agent sait faire.
#
#   make install          npm ci
#   make lint             ESLint, html-validate (volet et page d'accueil)
#   make test             les règles de comptage du capteur
#   make build            dist/word/ (le site) et dist/word-localhost.xml
#   make lint-manifest    validation Microsoft du manifest (après make build, réseau requis)
#   make serve            le complément sur https://localhost:3000 (après make build)
#   make clean            efface dist/
#
# Pas de cible publish : le complément se publie en déposant dist/word/ sur GitHub Pages, ce que
# fait le workflow (actions/deploy-pages), et la fiche AppSource se soumet à la main
# (docs/publication.md).
#
# ui.css, ui.js, i18n.js, fonts/, les icônes 16/32/128 et tests/helpers/ sont des liens vers
# browser/ : ils sont lintés et testés là-bas, et ESLint les ignore ici.

.PHONY: install lint test build lint-manifest serve clean

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

lint-manifest: node_modules
	npm run lint:manifest

serve: node_modules
	npm run serve

clean:
	npm run clean
