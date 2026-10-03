# Visual Studio Code extension, .vsix package.
#
# The commands are declared in package.json; this Makefile calls them, and that is all —
# `npm run` alone lists what the agent can do. That package.json is also the extension's
# manifest: it is never rewritten, the version is passed to vsce on the command line.
#
# Packaging is vsce's job: build.mjs only resolves the version. What stays out of the .vsix is
# listed in .vscodeignore.
#
#   make install  npm ci
#   make lint     ESLint (CommonJS modules, extension host)
#   make test     sensor, panel and dictionary
#   make test-host   in a real VS Code, in a container: activation, commands, panel
#   make test-host-clean  throws away the image and the downloaded editors
#   make coverage    what these tests cover (report and floor, not a CI target)
#   make update      raises the pinned versions of the dependencies (then run `make`)
#   make build    dist/certimens-vscode.vsix
#   make dev      opens a VS Code window on this folder (no build needed)
#   make clean    erases dist/
#   make publish  publishes to the Visual Studio Marketplace (after make build)
#
# make publish needs VSCE_PAT in the environment. Open VSX (VSCodium, Cursor, Gitpod) has no
# free API for a verified publisher: publishing there stays manual.
#
# media/ui.css, media/fonts, media/icon128.png and tests/helpers/ are links into browser/.

.PHONY: install update lint test test-host test-host-clean coverage build dev clean publish

node_modules: package-lock.json
	npm ci
	@touch node_modules

install: node_modules

lint: node_modules
	npm run lint

test: node_modules
	npm test

# What no stub can tell: does the extension really activate, do its commands really exist, does
# its webview really render. In a throwaway container, which brings the display an Electron
# application needs without installing anything on the machine; the agent is mounted
# **read-only** there and the downloaded editor lives in a volume, so it is not fetched again
# every time — a throwaway test does not leave root-owned files behind. Outside `make test`,
# which stays instant and offline.
#
# The version downloaded is the **minimum** declared by engines.vscode: the one of the student
# whose editor has not moved. VSCODE_VERSION=stable for the latest.
HOST_IMAGE := certimens-vscode-host
HOST_CACHE := certimens-vscode-editors

test-host: node_modules
	docker build --quiet --tag $(HOST_IMAGE) tests/host
	docker run --rm --init \
		--volume "$(CURDIR)":/agent:ro --volume $(HOST_CACHE):/cache \
		$(if $(VSCODE_VERSION),--env VSCODE_VERSION=$(VSCODE_VERSION),) \
		$(HOST_IMAGE)

# The test environment, erased: the image and the downloaded editors. Nothing else was put on
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

dev: node_modules
	npm run dev

clean:
	npm run clean
	rm -rf .vscode-test

publish: node_modules
	npm run publish
