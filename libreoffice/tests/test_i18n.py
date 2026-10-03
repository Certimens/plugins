"""Interface dictionary of the LibreOffice agent (i18n.py).

The same checks as browser/tests/i18n.test.mjs on the JavaScript side: what breaks a
translation is a key forgotten in one language, a variable that changes name from one language
to the other, or a language-choice rule drifting from the engine's.
"""

import json
import os
import re
import subprocess
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'src', 'pythonpath'))

from certimens_agent import i18n


class DictionaryTest(unittest.TestCase):
    def test_both_languages_carry_the_same_keys(self):
        self.assertEqual(set(i18n.MESSAGES['fr']), set(i18n.MESSAGES['en']))

    def test_no_key_nobody_displays(self):
        """The same check as in the three other agents.

        A sentence removed from the interface leaves its key behind, and the dictionary starts
        describing a window that no longer exists. Here nothing is built at run time: every key
        is written out in full where it is displayed.
        """
        source = ''
        root = os.path.join(os.path.dirname(__file__), '..', 'src')
        for folder, _, names in os.walk(root):
            for name in names:
                if name.endswith('.py') and name != 'i18n.py':
                    with open(os.path.join(folder, name), encoding='utf-8') as handle:
                        source += handle.read()
        unused = sorted(key for key in i18n.MESSAGES['fr'] if key not in source)
        self.assertEqual(unused, [], 'keys no dialog displays')

    def test_no_empty_translation(self):
        for language, messages in i18n.MESSAGES.items():
            for key, text in messages.items():
                self.assertTrue(text.strip(), '%s/%s est vide' % (language, key))

    def test_both_languages_expect_the_same_variables(self):
        names = lambda text: sorted(re.findall(r'\{(\w+)\}', text))  # noqa: E731
        for key, french in i18n.MESSAGES['fr'].items():
            self.assertEqual(names(i18n.MESSAGES['en'][key]), names(french),
                             '%s: the variables differ' % key)

    def test_engine_rule(self):
        """"en" gives English, everything else French: the engine's rule."""
        for tag in ('en', 'en-GB', 'EN-us'):
            self.assertEqual(i18n.normalize_language(tag), 'en')
        for tag in ('fr-FR', 'es-ES', '', None):
            self.assertEqual(i18n.normalize_language(tag), 'fr')

    def test_account_wins_over_the_editor(self):
        self.assertEqual(i18n.set_language('en', 'fr-FR'), 'en')
        self.assertEqual(i18n.set_language('fr', 'en-US'), 'fr')
        # As long as the student is not connected, LibreOffice decides.
        self.assertEqual(i18n.set_language('', 'en-US'), 'en')
        self.assertEqual(i18n.set_language(None, None), 'fr')

    def test_unknown_key_is_visible(self):
        i18n.set_language('fr')
        self.assertEqual(i18n.t('cle.inexistante'), 'cle.inexistante')

    def test_variables_are_substituted(self):
        i18n.set_language('en')
        self.assertEqual(i18n.t('doc.submittedTo', title='TP 3'), 'Submitted to: TP 3')
        i18n.set_language('fr')
        self.assertEqual(i18n.t('doc.submittedTo', title='TP 3'), 'Rendu sur : TP 3')

    def test_keys_shared_with_the_browser_agent_say_the_same_thing(self):
        """A shared key carries the same message from one agent to the other.

        This is the only check that crosses both languages, and it is worth it: a student moving
        from the extension to LibreOffice must read the same sentence, and a key reused for
        something else does not show up otherwise. The JavaScript dictionary is read as it
        ships (browser/i18n.js), without adding anything to it.
        """
        script = ("const vm=require('vm'),fs=require('fs');const c=vm.createContext({});"
                  "vm.runInContext(fs.readFileSync(process.argv[1],'utf8')+';globalThis.M=MESSAGES;',c);"
                  "console.log(JSON.stringify(c.M));")
        source = os.path.join(os.path.dirname(__file__), '..', '..', 'browser', 'src', 'i18n.js')
        try:
            output = subprocess.check_output(['node', '-e', script, source])
        except (OSError, subprocess.CalledProcessError):
            self.skipTest('node indisponible')
        browser = json.loads(output.decode('utf-8'))

        shared = set(browser['fr']) & set(i18n.MESSAGES['fr'])
        self.assertGreater(len(shared), 10, 'both dictionaries should share keys')
        for language in ('fr', 'en'):
            for key in sorted(shared):
                self.assertEqual(i18n.MESSAGES[language][key], browser[language][key],
                                 '%s differs between LibreOffice and the extension in %s' % (key, language))


if __name__ == '__main__':
    unittest.main()
