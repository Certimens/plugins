// `src/ui.js` and `src/i18n.js` are symbolic links into the browser extension: the agents share
// one stylesheet, one dictionary and one window — the header, the messages, the assignment
// picker. Nothing in them reaches for `chrome.*` any more: what does is the extension's
// `pages.js`, which the pane does not load, and `DEFAULT_ENGINE_URL` is declared here by
// `agent.js`, as every other agent declares it in its own engine client.
//
// Nothing is left to declare for the type checker, and this file says so rather than being
// deleted: the next function added to the shared ui.js will be read in a task pane too, and the
// day one of them asks for a browser API, this is where the question comes back.
//
// It is not shipped: a package is `src/` plus the licence, and this file sits outside it.
export {};
