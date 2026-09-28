import js from '@eslint/js';
import globals from 'globals';

// The extension scripts are classic scripts (not modules): popup.js and options.js use the
// functions declared by ui.js, which is loaded before them.
// i18n.js declares these, and every page and worker loads it first.
const i18nGlobals = {
    t: 'readonly',
    setLanguage: 'readonly',
    currentLanguage: 'readonly',
    normalizeLanguage: 'readonly',
    dateLocale: 'readonly',
    applyTranslations: 'readonly',
};

const uiGlobals = {
    $: 'readonly',
    startLanguage: 'readonly',
    DEFAULT_ENGINE_URL: 'readonly',
    showMessage: 'readonly',
    clearMessage: 'readonly',
    errorText: 'readonly',
    requestEngineAccess: 'readonly',
};

// Word add-in: classic scripts too, loaded in the order ui.js, agent.js, sensor.js,
// taskpane.js; each uses the functions declared by the previous ones.
const officeGlobals = { Office: 'readonly', Word: 'readonly' };
const agentGlobals = {
    getConfig: 'readonly', getState: 'readonly', onStatusChange: 'readonly', documentId: 'readonly',
    documentName: 'readonly', isWordOnline: 'readonly', trimUrl: 'readonly', noteTitle: 'readonly',
    login: 'readonly', logout: 'readonly', createFileFor: 'readonly', docInfo: 'readonly',
    isPaused: 'readonly', setPaused: 'readonly',
    listAssignments: 'readonly', uploadDocx: 'readonly', submitFile: 'readonly', enqueue: 'readonly',
    startAgent: 'readonly',
};

export default [
    { ignores: ['node_modules/', 'dist/', 'legacy/'] },
    js.configs.recommended,
    {
        files: ['extension/**/*.js'],
        languageOptions: {
            sourceType: 'script',
            // importScripts: the Chrome service worker loads i18n.js with it (Firefox uses the
            // manifest's background.scripts instead).
            globals: { ...globals.browser, ...globals.webextensions, importScripts: 'readonly' },
        },
        rules: {
            'no-unused-vars': ['error', { caughtErrors: 'none' }],
        },
    },
    {
        // These two declare what the pages use; they are the only files that may leave a
        // declaration apparently unused.
        files: ['extension/ui.js', 'extension/i18n.js'],
        rules: { 'no-unused-vars': ['error', { vars: 'local', caughtErrors: 'none' }] },
    },
    {
        files: ['extension/ui.js'],
        languageOptions: { globals: i18nGlobals },
    },
    {
        files: ['extension/background.js'],
        languageOptions: { globals: i18nGlobals },
    },
    {
        files: ['extension/popup.js', 'extension/options.js'],
        languageOptions: { globals: { ...uiGlobals, ...i18nGlobals } },
    },
    {
        files: ['word/**/*.js'],
        languageOptions: {
            sourceType: 'script',
            globals: { ...globals.browser, ...officeGlobals, ...uiGlobals, ...agentGlobals, ...i18nGlobals, startSensor: 'readonly', flush: 'readonly' },
        },
        rules: {
            'no-unused-vars': ['error', { caughtErrors: 'none' }],
            // the globals above are declared by these same files
            'no-redeclare': ['error', { builtinGlobals: false }],
        },
    },
    {
        files: ['word/agent.js', 'word/sensor.js'],
        rules: { 'no-unused-vars': ['error', { vars: 'local', caughtErrors: 'none' }] },
    },
    {
        // VS Code extension: CommonJS modules loaded by the editor's own extension host, so Node
        // globals and `require` rather than the browser's.
        files: ['vscode/**/*.js'],
        languageOptions: {
            sourceType: 'commonjs',
            globals: globals.node,
        },
        rules: {
            'no-unused-vars': ['error', { caughtErrors: 'none' }],
        },
    },
    {
        files: ['eslint.config.js', 'scripts/**/*.mjs', 'tests/**/*.mjs'],
        languageOptions: { globals: globals.node },
    },
];
