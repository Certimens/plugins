// "Signaler un problème": the link every agent carries to the help form of the Certimens space,
// prefilled with a block that describes the agent (docs/moteur.md, "Signaler un problème").
//
// Shared by the extension's service worker and the Word task pane — the two places that hold
// the agent's state and open the link. They load no other file in common but the dictionary:
// the worker imports this one beside constants.js and i18n.js, the pane loads it through a
// symbolic link (word/src/report.js), like i18n.js and ui.js. Written twice, the block would
// drift from one agent to the other, and the support reads the two side by side.
//
// Nothing here touches `chrome.*`, `Office.*` or the DOM: what each host knows of itself — its
// browser, its Word, its storage — it gathers, and hands over as plain values. `DEFAULT_ENGINE_URL`
// and `engineUrlAllowed` come from the host (constants.js there, agent.js here), and are only
// read while a function below runs, never as this file loads.
//
// **What never goes in**: the token, a device code, the e-mail (the form has its own field), the
// name, id or address of a document or a site, and anything the student wrote. The block is made
// of the same things as the telemetry — states, numbers, words of a closed vocabulary — and the
// student sees all of it before sending. The link itself sends nothing.

// Everything after the `#` stays in the browser: the block reaches neither the engine's logs
// nor a proxy's. The four agents declare these two under these names; `make check` compares them.
const REPORT_FRAGMENT = '#report';
const REPORT_KEYS = ['agent', 'host', 'os', 'language', 'engine', 'signed_in', 'paused', 'status',
    'queued', 'counters', 'at'];

// The engine bounds the whole message at 5,000 characters, and the rest is the student's.
const REPORT_MAX_CHARS = 1500;
// One value never takes the block over by itself: a line cut short still says which key it was.
const REPORT_VALUE_MAX = 200;

// A value as one line: whatever would break the `key: value` layout — a newline, a control
// character — becomes a space. Missing or empty is `unknown`, so that two reports still read line
// by line against each other.
function reportValue(value) {
    if (value === undefined || value === null) return 'unknown';
    const line = String(value).replace(/[\p{Cc}\u2028\u2029]+/gu, ' ').trim();
    return line ? line.slice(0, REPORT_VALUE_MAX) : 'unknown';
}

// The block: one `key: value` line per key, in REPORT_KEYS order, none ever omitted — except
// past the cap, where the block stops at the last line that fits rather than mid-line.
function reportBlock(values) {
    let block = '';
    for (const key of REPORT_KEYS) {
        const line = `${key}: ${reportValue(values?.[key])}`;
        const next = block ? `${block}\n${line}` : line;
        if (next.length > REPORT_MAX_CHARS) break;
        block = next;
    }
    return block;
}

// The link. The address is the configured engine's, or the default one when the rule on where
// the token may travel refuses it: a link does not open in clear text towards a public host.
function reportUrl(engineUrl, values) {
    const base = engineUrlAllowed(engineUrl) ? String(engineUrl).trim() : DEFAULT_ENGINE_URL;
    return `${new URL(base).origin}/${REPORT_FRAGMENT}?kind=problem&details=${encodeURIComponent(reportBlock(values))}`;
}

// --- THE VALUES BOTH HOSTS WORD THE SAME WAY ---

// The engine's origin, and nothing of its path: `unknown` for what is not an http(s) address.
function reportEngine(engineUrl) {
    try {
        const url = new URL(String(engineUrl).trim());
        return url.protocol === 'https:' || url.protocol === 'http:' ? url.origin : null;
    } catch (_) {
        return null;
    }
}

function reportFlag(value) {
    return value ? 'yes' : 'no';
}

// The send state, one word of the agent's own vocabulary, and — offline — whether the engine
// answered at all: an engine that refuses is not an engine out of reach. Never the status
// message, which may carry an engine's sentence or a network error's.
function reportStatus(status) {
    const state = /^[a-z_]{1,32}$/.test(status?.state || '') ? status.state : null;
    if (!state) return null;
    if (state !== 'offline') return state;
    return `offline (${status.reached ? 'reached' : 'unreachable'})`;
}

// The telemetry counters not yet sent, as the host's `telemetryEvents` lays them out (known
// words, in the vocabulary's order, whole positive counts): `name=n`, space-separated.
function reportCounters(events) {
    const pairs = Object.entries(events || {}).map(([name, n]) => `${name}=${n}`);
    return pairs.length ? pairs.join(' ') : 'none';
}

// The machine's clock, in UTC, to the second.
function reportTime(date) {
    return date.toISOString().replace(/\.\d{3}Z$/, 'Z');
}
