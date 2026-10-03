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
//
// `engineUrlAllowed` below is the one exception, and it is one for the reason this file exists
// rather than against it: it touches no API at all, it is live in both scopes, and a page that
// offered an address the worker then refused — or the other way round — is exactly the silent
// drift the paragraph above is about. A second pure rule would belong here too; anything
// reaching for an API still would not.

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

// --- WHERE THE TOKEN MAY TRAVEL ---
//
// The student can point an agent at another engine — an institution hosting its own — and the
// address they type decides where an API token **that never expires** is sent. Over `http:` it
// crosses the network in the clear, and a token read once is a token kept: of the four promises
// `SECURITY.md` makes, this is the second.
//
// Refusing `http:` outright would break the deployment it exists for: an establishment serving
// its engine on its own intranet, where there is no certificate and no public name. So the rule
// is about the **host**, not the scheme — plain `http:` is accepted exactly where the request
// cannot leave the building:
//
//   - a single label (`moteur`, `certimens-srv`), which only an internal resolver answers, but
//     not an all-digit one: `http://134744072/` is 8.8.8.8 written to look like a hostname;
//   - `localhost`, anything under it, and `127.0.0.0/8` or `::1`;
//   - `*.local`, which is mDNS;
//   - the private ranges — `10/8`, `172.16/12`, `192.168/16` — and IPv6 unique local, `fc00::/7`.
//
// Everything else must be `https:`. **The four agents hold this same pattern**, character for
// character, and `make check` compares them: a rule loosened in one agent and not the three
// others would be a hole nobody reads about anywhere.
//
// This is about the engine, and only the engine. The sites the student adds for measuring
// (`siteMatch`, options page) stay free to be `http:`: no token goes there — what travels is a
// content script reading a page the student chose, and an intranet Moodle on plain http is a
// real place where students write.
const LOCAL_ENGINE_HOST = /^(?:(?!\d+$)[^.:]+|(?:.+\.)?local|(?:.+\.)?localhost|127\.\d+\.\d+\.\d+|::1|10\.\d+\.\d+\.\d+|172\.(?:1[6-9]|2\d|3[01])\.\d+\.\d+|192\.168\.\d+\.\d+|f[cd][0-9a-f]{2}:.*)$/i;

// Whether an engine address may be used at all: https anywhere, http only on a host the rule
// above names. An address that is not a URL is refused here too — the caller has one refusal to
// word, not two.
function engineUrlAllowed(rawUrl) {
    let url;
    try {
        url = new URL(String(rawUrl).trim());
    } catch (_) {
        return false;
    }
    if (url.protocol === 'https:') return true;
    if (url.protocol !== 'http:') return false;
    // `new URL('http://[::1]/')` keeps the brackets in `hostname`; Python's urlparse does not,
    // and the pattern is shared with it.
    return LOCAL_ENGINE_HOST.test(url.hostname.replace(/^\[|\]$/g, ''));
}
