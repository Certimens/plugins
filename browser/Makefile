# MV3 browser extension — Chrome, Firefox, Safari, Edge, Opera.
#
# The commands are declared in package.json; this Makefile calls them, and that is all. A
# JavaScript developer can therefore ignore make and run `npm run lint`, `npm test`,
# `npm run build` — `npm run` alone lists what the agent can do. The Makefile exists so that the
# four agents, one of them in Python, answer to the same targets.
#
#   make install     npm ci
#   make install-publish  npm ci --ignore-scripts, what a publish job installs
#   make lint        ESLint, Stylelint (ui.css), html-validate (popup, options), ShellCheck
#   make test        the sensor's counting rules
#   make test-host   in a real Chromium, in a container: manifest, worker, pages, sensor
#   make test-host-clean  throws away the image and the downloaded browser
#   make coverage    what these tests cover (report and floor, not a CI target)
#   make update      raises the pinned versions of the dependencies (then run `make`)
#   make build       dist/{chrome,firefox,safari}.zip and the unpacked folders
#   make lint-amo    addons.mozilla.org validation of the Firefox package (after make build)
#   make safari      Xcode project, macOS + iOS (macOS only, after make build)
#   make clean       erases dist/
#
# Publishing, one store per target (after make build):
#   make publish-chrome | publish-firefox | publish-edge | publish-opera
# The credentials come from the environment — see docs/publication.md for the list.
# The release calls them one by one; without credentials the target fails, it invents nothing.
# Safari is published by hand from Xcode.
#
# ui.css, ui.js, i18n.js, fonts/, icons/ and tests/helpers/ live here: the three other agents
# point at them through symlinks, and this is therefore where they are checked.

STORES := chrome firefox edge opera
PUBLISH := $(addprefix publish-,$(STORES))

.PHONY: install install-publish update lint test test-host test-host-clean coverage build lint-amo safari clean $(PUBLISH)

node_modules: package-lock.json
	npm ci
	@touch node_modules

install: node_modules

# What a job that publishes installs: the same tree, with **no install script run at all**.
# These jobs are the only ones holding credentials — the stores', the Marketplace's, the Pages
# deployment's — and a plain `npm ci` would run whatever the hundreds of packages of the lint
# and test tooling declare, right beside them. Nothing declares one today, and that is checked
# rather than hoped: `npm run lint:deps` names what is allowed to, and fails on anything else.
install-publish:
	npm ci --ignore-scripts
	@touch node_modules

lint: node_modules
	npm run lint

test: node_modules
	npm test

# What no `chrome.*` stub can tell: does the browser really accept this manifest, does the
# service worker really start, do the pages really render, does the sensor really inject itself
# into a page the manifest names. In a throwaway container, which brings the display an
# extension needs to load without installing anything on the machine; the agent is mounted
# **read-only** there, and the downloaded browser lives in a volume. Outside `make test`, which
# stays instant and offline.
#
# The unpacked package is built beforehand, on the machine: the container cannot write.
HOST_IMAGE := certimens-browser-host
HOST_CACHE := certimens-browser-browsers

test-host: node_modules build
	docker build --quiet --tag $(HOST_IMAGE) tests/host
	docker run --rm --init \
		--volume "$(CURDIR)":/agent:ro --volume $(HOST_CACHE):/browsers \
		$(HOST_IMAGE)

# The test environment, erased: the image and the downloaded Chromium. Nothing else was put on
# the machine, which was the point.
test-host-clean:
	-docker image rm $(HOST_IMAGE)
	-docker volume rm $(HOST_CACHE)

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

lint-amo: node_modules
	npm run lint:amo

safari: node_modules
	npm run safari

clean:
	npm run clean

# One rule, four targets: $@ says which one.
$(PUBLISH): node_modules
	npm run publish:$(@:publish-%=%)
