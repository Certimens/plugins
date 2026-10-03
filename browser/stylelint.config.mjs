// Stylelint for ui.css — the one stylesheet of the four agents. It lives here, and the Word
// task pane and the VS Code panel link to it, so this is the only place it is linted.
//
// stylelint-config-standard, minus the rules that would rewrite the sheet rather than check it:
// it is deliberately written one rule per line, so the "an empty line here, one declaration
// there" family is off. What stays is what catches a real mistake — an unknown property, a
// duplicate selector, a malformed value.
export default {
    extends: ['stylelint-config-standard'],
    rules: {
        // One rule per line, declarations on the same line, comments hugging what they explain.
        'declaration-block-single-line-max-declarations': null,
        'rule-empty-line-before': null,
        'at-rule-empty-line-before': null,
        'comment-empty-line-before': null,
        'declaration-empty-line-before': null,
        'custom-property-empty-line-before': null,
        // rgba(30, 41, 59, 0.08) reads as the brand slate with an opacity; the space-separated
        // form and percentages would only obscure where the color comes from.
        'color-function-notation': null,
        'color-function-alias-notation': null,
        'alpha-value-notation': null,
    },
};
