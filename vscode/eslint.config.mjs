// ESLint for the VS Code extension: CommonJS modules loaded by the editor's own extension host,
// so Node globals and `require` rather than the browser's.
//
// This agent is self-contained: it declares its own tooling and carries its own rules. The
// three other agents hold the same rule set — a change decided for all four is applied in the
// four configurations.
import js from '@eslint/js';
import globals from 'globals';

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
        // Everything the extension ships. The tooling around it is further down.
        files: ['src/**/*.js'],
        languageOptions: { sourceType: 'commonjs', globals: globals.node },
        // An agent catches what it cannot recover from and names the error; an unused `err` is
        // the rule there, not an oversight.
        rules: { 'no-unused-vars': ['error', { caughtErrors: 'none' }] },
    },
    {
        files: ['build.mjs', 'tests/**/*.mjs'],
        languageOptions: { globals: globals.node },
    },
];
