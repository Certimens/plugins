import js from '@eslint/js';
import globals from 'globals';

// The extension scripts are classic scripts (not modules): popup.js and options.js use the
// functions declared by ui.js, which is loaded before them.
const uiGlobals = {
    $: 'readonly',
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
            globals: { ...globals.browser, ...globals.webextensions },
        },
        rules: {
            'no-unused-vars': ['error', { caughtErrors: 'none' }],
        },
    },
    {
        files: ['extension/ui.js'],
        rules: { 'no-unused-vars': ['error', { vars: 'local', caughtErrors: 'none' }] },
    },
    {
        files: ['extension/popup.js', 'extension/options.js'],
        languageOptions: { globals: uiGlobals },
    },
    {
        files: ['word/**/*.js'],
        languageOptions: {
            sourceType: 'script',
            globals: { ...globals.browser, ...officeGlobals, ...uiGlobals, ...agentGlobals, startSensor: 'readonly' },
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
        files: ['eslint.config.js', 'scripts/**/*.mjs'],
        languageOptions: { globals: globals.node },
    },
];
