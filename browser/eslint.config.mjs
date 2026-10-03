// ESLint for the browser extension.
//
// Classic scripts, not modules: the pages share globals instead of importing. popup.js and
// options.js use what constants.js, i18n.js, ui.js and pages.js declare, loaded before them in
// that order. The tables below say what each shared file declares, so the others may use it —
// and which scopes each one reaches: constants.js is the worker's as well, ui.js is the Word
// task pane's as well, pages.js belongs to these two pages alone.
//
// This agent is self-contained: it declares its own tooling and carries its own rules. The
// three other agents hold the same rule set — a change decided for all four is applied in the
// four configurations.
import js from '@eslint/js';
import globals from 'globals';

// Declared by i18n.js, used by every page and by the service worker.
const i18nGlobals = {
    t: 'readonly',
    setLanguage: 'readonly',
    currentLanguage: 'readonly',
    normalizeLanguage: 'readonly',
    dateLocale: 'readonly',
    applyTranslations: 'readonly',
};

// Declared by constants.js, the one file loaded both by the service worker and by the pages.
const constantsGlobals = {
    DEFAULT_ENGINE_URL: 'readonly',
    GOOGLE_EXPORT_ORIGINS: 'readonly',
    RELEASE_NOTES_URL: 'readonly',
};

// Declared by ui.js, used by popup.js and options.js — and by the Word task pane, which links
// to the same file: nothing in there may touch `chrome.*`.
const uiGlobals = {
    $: 'readonly',
    renderIconActions: 'readonly',
    showIcon: 'readonly',
    showAccount: 'readonly',
    showMessage: 'readonly',
    showUpdateNotice: 'readonly',
    clearMessage: 'readonly',
    errorText: 'readonly',
    fillEngineUrl: 'readonly',
    engineUrlValue: 'readonly',
    deadlinePassed: 'readonly',
    formatDeadline: 'readonly',
    renderAssignments: 'readonly',
    updateSubmitButton: 'readonly',
};

// Declared by pages.js: what the popup and the options page share and the task pane must not
// have, because it reaches for `chrome.*`.
const pagesGlobals = {
    startLanguage: 'readonly',
    showUpdateIfNew: 'readonly',
    requestEngineAccess: 'readonly',
};

export default [
    { ignores: ['dist/'] },
    js.configs.recommended,
    {
        // What the recommended set leaves out and this code base already follows: the point is
        // that it keeps following it. No formatting rule — nothing reindents the agents.
        rules: {
            eqeqeq: ['error', 'smart'],
            'no-var': 'error',
            'prefer-const': 'error',
            'no-throw-literal': 'error',
            'no-else-return': 'error',
            'no-lonely-if': 'error',
            'object-shorthand': ['error', 'properties'],
        },
    },
    {
        // Everything the extension ships. The tooling around it is Node, further down.
        files: ['src/**/*.js'],
        languageOptions: {
            sourceType: 'script',
            // importScripts: the Chrome service worker loads i18n.js with it (Firefox uses the
            // manifest's background.scripts instead).
            globals: { ...globals.browser, ...globals.webextensions, importScripts: 'readonly' },
        },
        // An agent catches what it cannot recover from and names the error; an unused `err` is
        // the rule there, not an oversight.
        rules: { 'no-unused-vars': ['error', { caughtErrors: 'none' }] },
    },
    {
        // These four declare what the pages use; they are the only files that may leave a
        // declaration apparently unused.
        files: ['src/ui.js', 'src/i18n.js', 'src/constants.js', 'src/pages.js'],
        rules: { 'no-unused-vars': ['error', { vars: 'local', caughtErrors: 'none' }] },
    },
    { files: ['src/ui.js'], languageOptions: { globals: { ...i18nGlobals, ...constantsGlobals } } },
    { files: ['src/pages.js'], languageOptions: { globals: { ...i18nGlobals, ...uiGlobals } } },
    { files: ['src/background.js'], languageOptions: { globals: { ...i18nGlobals, ...constantsGlobals } } },
    {
        files: ['src/popup.js', 'src/options.js'],
        languageOptions: { globals: { ...constantsGlobals, ...uiGlobals, ...pagesGlobals, ...i18nGlobals } },
    },
    {
        // The build and the tests are Node, not the extension.
        files: ['build.mjs', 'tests/**/*.mjs'],
        languageOptions: { globals: globals.node },
    },
];
