// What the service worker and the pages must agree on.
//
// The extension has two global scopes that never load each other's code: the worker, and the
// popup / options pages. A value written in both drifts in silence — the popup asking for a
// permission the worker does not use, a page offering an engine address the worker never calls
// — and no linter, no test and no store review would see it. One declaration, loaded in both:
// popup.html and options.html load this file first, the worker imports it below (Firefox loads
// it from the manifest's background.scripts, where importScripts does not exist).
//
// Values only, never behaviour: the two scopes share almost no API — `document`,
// `chrome.i18n` and `chrome.permissions.request` each live in one of them — so a function here
// would be dead in one of the two. What the pages share is in ui.js and pages.js.

// The engine every agent talks to unless the student names another (an institution hosting its
// own). The four agents each declare it — `word/src/agent.js`, `vscode/src/engine.js`,
// `libreoffice/.../engine.py` — and `make check` compares the four.
const DEFAULT_ENGINE_URL = 'https://monespace.certimens.fr';

// What changed, for the student who finds the agent different from yesterday. A store updates
// an extension without a word: the window that opens afterwards is the only place that can say
// so, and this is where it sends them. The four agents each declare it — `word/src/agent.js`,
// `vscode/src/engine.js`, `libreoffice/.../engine.py` — and `make check` compares the four.
//
// The list, not a version's own page: the four agents have four version lines and a build of a
// branch carries a commit, so a per-version address would be right three times out of four.
const RELEASE_NOTES_URL = 'https://github.com/certimens/plugins/releases';

// Google Docs export hosts: docs.google.com redirects to googleusercontent.com. The popup is
// what asks for them — a permission needs a gesture, which a worker has not — and the worker
// checks them before exporting: a list that differed by one host would have the student grant
// an access the export then declares missing.
const GOOGLE_EXPORT_ORIGINS = ['https://docs.google.com/document/*', 'https://*.googleusercontent.com/*'];
