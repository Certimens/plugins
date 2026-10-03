"""Dictionnaire d'interface de l'agent LibreOffice (i18n.py).

Les mêmes vérifications que browser/tests/i18n.test.mjs côté JavaScript : ce qui casse une
traduction, c'est une clé oubliée dans une langue, une variable qui change de nom d'une langue
à l'autre, ou une règle de choix de la langue qui dérive de celle du moteur.
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

    def test_no_empty_translation(self):
        for language, messages in i18n.MESSAGES.items():
            for key, text in messages.items():
                self.assertTrue(text.strip(), '%s/%s est vide' % (language, key))

    def test_both_languages_expect_the_same_variables(self):
        names = lambda text: sorted(re.findall(r'\{(\w+)\}', text))  # noqa: E731
        for key, french in i18n.MESSAGES['fr'].items():
            self.assertEqual(names(i18n.MESSAGES['en'][key]), names(french),
                             '%s : les variables diffèrent' % key)

    def test_engine_rule(self):
        """« en » donne l'anglais, tout le reste le français : la règle du moteur."""
        for tag in ('en', 'en-GB', 'EN-us'):
            self.assertEqual(i18n.normalize_language(tag), 'en')
        for tag in ('fr-FR', 'es-ES', '', None):
            self.assertEqual(i18n.normalize_language(tag), 'fr')

    def test_account_wins_over_the_editor(self):
        self.assertEqual(i18n.set_language('en', 'fr-FR'), 'en')
        self.assertEqual(i18n.set_language('fr', 'en-US'), 'fr')
        # Tant que l'étudiant n'est pas connecté, c'est LibreOffice qui décide.
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
        """Une clé commune porte le même message d'un agent à l'autre.

        C'est le seul contrôle qui traverse les deux langages, et il en vaut la peine : un
        étudiant qui passe de l'extension à LibreOffice doit lire la même phrase, et une clé
        réutilisée pour autre chose ne se voit pas autrement. Le dictionnaire JavaScript est lu
        tel qu'il est livré (browser/i18n.js), sans rien y ajouter.
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
        self.assertGreater(len(shared), 10, 'les deux dictionnaires devraient partager des clés')
        for language in ('fr', 'en'):
            for key in sorted(shared):
                self.assertEqual(i18n.MESSAGES[language][key], browser[language][key],
                                 '%s diffère entre LibreOffice et l\'extension en %s' % (key, language))


if __name__ == '__main__':
    unittest.main()
