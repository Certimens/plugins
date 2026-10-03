// html-validate for this agent's pages.
//
// html-validate:recommended, minus the rules that read an empty element as a mistake. Here it
// is the pattern: a page ships its structure, and i18n.js fills every text at load time from
// the dictionary (data-i18n), sets the accessible name of the icon buttons, and gives the
// engine links their href. The rest of the preset — an unknown element, broken nesting, a label
// pointing nowhere, an input without a type — is what we keep it for.
//
// CommonJS: html-validate loads a .js configuration as CommonJS.
module.exports = {
    root: true,
    extends: ['html-validate:recommended'],
    rules: {
        // Spacing local to one page; colors still come from the ui.css variables.
        'no-inline-style': 'off',
        // Filled by the dictionary at load time.
        'empty-heading': 'off',
        'text-content': 'off',
        // href set at load time; target and rel are written in the page.
        'attribute-misuse': 'off',
    },
};
