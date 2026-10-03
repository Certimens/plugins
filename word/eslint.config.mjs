// ESLint for the Word add-in.
//
// Classic scripts, loaded in the order ui.js, agent.js, sensor.js, taskpane.js; each uses what
// the previous ones declare. src/ui.js and src/i18n.js are symbolic links into the browser
// extension, which lints them: they are ignored here.
//
// This agent is self-contained: it declares its own tooling and carries its own rules. The
// three other agents hold the same rule set — a change decided for all four is applied in the
// four configurations.
import js from '@eslint/js';
import globals from 'globals';

// Declared by the linked i18n.js.
const i18nGlobals = {
    t: 'readonly',
    setLanguage: 'readonly',
    currentLanguage: 'readonly',
    normalizeLanguage: 'readonly',
    dateLocale: 'readonly',
    applyTranslations: 'readonly',
};

// Declared by the linked ui.js. What the extension's pages alone have — anything reaching for
// `chrome.*` — lives in its pages.js, which the pane does not load.
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

const officeGlobals = { Office: 'readonly', Word: 'readonly' };

// Declared by agent.js and sensor.js, used by the task pane.
const agentGlobals = {
    DEFAULT_ENGINE_URL: 'readonly', RELEASE_NOTES_URL: 'readonly',
    updatedVersion: 'readonly',
    getConfig: 'readonly', getState: 'readonly', onStatusChange: 'readonly', documentId: 'readonly',
    documentName: 'readonly', isWordOnline: 'readonly', trimUrl: 'readonly', noteTitle: 'readonly',
    engineUrlAllowed: 'readonly',
    startPairing: 'readonly', pollPairing: 'readonly', adoptToken: 'readonly',
    logout: 'readonly', createFileFor: 'readonly', docInfo: 'readonly',
    isPaused: 'readonly', setPaused: 'readonly', measuring: 'readonly', documentSource: 'readonly',
    listAssignments: 'readonly', uploadDocx: 'readonly', submitDocument: 'readonly', enqueue: 'readonly',
    startAgent: 'readonly', startSensor: 'readonly', flush: 'readonly',
};

export default [
    // Symbolic links into the browser extension, where they are linted.
    { ignores: ['dist/', 'src/ui.js', 'src/i18n.js', 'check-install-scripts.mjs'] },
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
        // Everything the add-in serves. The tooling around it is Node, further down.
        files: ['src/**/*.js'],
        languageOptions: {
            sourceType: 'script',
            globals: { ...globals.browser, ...officeGlobals, ...uiGlobals, ...agentGlobals, ...i18nGlobals },
        },
        rules: {
            'no-unused-vars': ['error', { caughtErrors: 'none' }],
            // the globals above are declared by these same files
            'no-redeclare': ['error', { builtinGlobals: false }],
        },
    },
    {
        // These two declare what the task pane uses.
        files: ['src/agent.js', 'src/sensor.js'],
        rules: { 'no-unused-vars': ['error', { vars: 'local', caughtErrors: 'none' }] },
    },
    {
        // The build, the local HTTPS server (make serve) and the tests are Node, not the pane.
        files: ['build.mjs', 'serve.mjs', 'tests/**/*.mjs'],
        languageOptions: { globals: globals.node },
    },
];
