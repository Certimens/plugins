// ESLint for the browser extension.
//
// Classic scripts, not modules: the pages share globals instead of importing. popup.js and
// options.js use what ui.js declares, which is loaded before them, and i18n.js is loaded first
// of all. The tables below say what each shared file declares, so the others may use it.
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

// Declared by ui.js, used by popup.js and options.js (and by the Word task pane, which links
// to the same file).
const uiGlobals = {
    $: 'readonly',
    startLanguage: 'readonly',
    renderIconActions: 'readonly',
    showIcon: 'readonly',
    DEFAULT_ENGINE_URL: 'readonly',
    showAccount: 'readonly',
    showMessage: 'readonly',
    clearMessage: 'readonly',
    errorText: 'readonly',
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
        // These two declare what the pages use; they are the only files that may leave a
        // declaration apparently unused.
        files: ['src/ui.js', 'src/i18n.js'],
        rules: { 'no-unused-vars': ['error', { vars: 'local', caughtErrors: 'none' }] },
    },
    { files: ['src/ui.js'], languageOptions: { globals: i18nGlobals } },
    { files: ['src/background.js'], languageOptions: { globals: i18nGlobals } },
    { files: ['src/popup.js', 'src/options.js'], languageOptions: { globals: { ...uiGlobals, ...i18nGlobals } } },
    {
        // The build and the tests are Node, not the extension.
        files: ['build.mjs', 'tests/**/*.mjs'],
        languageOptions: { globals: globals.node },
    },
];
