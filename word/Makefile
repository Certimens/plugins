# Office add-in for Word (Office.js), served by GitHub Pages.
#
# The commands are declared in package.json; this Makefile calls them, and that is all —
# `npm run` alone lists what the agent can do.
#
#   make install          npm ci
#   make lint             ESLint, html-validate (task pane and landing page)
#   make test             the sensor's counting rules
#   make coverage         what these tests cover (report and floor, not a CI target)
#   make update           raises the pinned versions of the dependencies (then run `make`)
#   make build            dist/word/ (the site) and dist/word-localhost.xml
#   make lint-manifest    Microsoft validation of the manifest (after make build, network needed)
#   make serve            the add-in on https://localhost:3000 (after make build)
#   make clean            erases dist/
#
# No publish target: the add-in is published by putting dist/word/ on GitHub Pages, which the
# workflow does (actions/deploy-pages), and the AppSource listing is submitted by hand
# (docs/publication.md).
#
# ui.css, ui.js, i18n.js, fonts/, the 16/32/128 icons and tests/helpers/ are links into
# browser/: they are linted and tested there, and ESLint ignores them here.

.PHONY: install update lint test coverage build lint-manifest serve clean

node_modules: package-lock.json
	npm ci
	@touch node_modules

install: node_modules

lint: node_modules
	npm run lint

test: node_modules
	npm test

# A report, and a floor that does not drop: the goal is not the number but that a tested part
# stops being tested without anyone seeing it. Files no test loads do not appear there — that is
# the limit of this measurement.
coverage: node_modules
	npm run coverage

build: node_modules
	npm run build $(if $(RELEASE),-- --release $(RELEASE))

# Raises the **pinned** versions of package.json, then reinstalls. Every dependency of this
# agent is a development one: nothing raised here travels in a package. Versions are exact
# rather than ranges — "what has been verified" rather than "what will be installed" — so
# raising them is a command, not a side effect of an `npm install`. npm-check-updates is called
# through npx, without entering the project's dependencies.
#
# **Run `make` right after**: a version just raised is a version not yet verified, and what says
# so is usually a new linter rule or a stricter type.
update: node_modules
	npm run update
	@npm outdated || true

lint-manifest: node_modules
	npm run lint:manifest

serve: node_modules
	npm run serve

clean:
	npm run clean
