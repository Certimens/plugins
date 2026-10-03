"""What dialogs.py adds for « Signaler un problème », without LibreOffice.

dialogs.py is UNO glue: its windows only mean something on a screen, and what they look like is
TESTING.md's to check by hand. Three things in it are rules all the same, held here against
doubles of `uno`: where the report button sits (right under the message, in both windows,
since both are built by `Window.run`), what it opens and how (SystemShellExecute, URIS_ONLY),
and how LibreOffice's version is read. The block itself is engine.py's, tested in
test_engine.py.
"""

import os
import sys
import types
import unittest
import urllib.parse

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'src', 'pythonpath'))

URIS_ONLY = 1


def _import_dialogs():
    """dialogs.py imported against doubles of `uno` of its own, and whatever stood in their place
    put back afterwards: test_sensor.py installs other doubles, and keeps those it finds."""
    names = ('uno', 'unohelper', 'com', 'com.sun', 'com.sun.star', 'com.sun.star.awt')
    saved = {name: sys.modules.get(name) for name in names}
    doubles = {name: types.ModuleType(name) for name in names}
    constants = {'com.sun.star.system.SystemShellExecuteFlags.URIS_ONLY': URIS_ONLY}
    doubles['uno'].getConstantByName = lambda name: constants.get(name, 1000)
    doubles['uno'].createUnoStruct = lambda name: types.SimpleNamespace()
    doubles['unohelper'].Base = type('Base', (), {})
    for name in ('XActionListener', 'XItemListener'):
        setattr(doubles['com.sun.star.awt'], name, type(name, (), {}))
    sys.modules.update(doubles)
    try:
        from certimens_agent import dialogs
    finally:
        for name, previous in saved.items():
            if previous is None:
                del sys.modules[name]
            else:
                sys.modules[name] = previous
    return dialogs


dialogs = _import_dialogs()


class ControlModel:
    def __init__(self, kind):
        self.kind = kind
        self.props = {}

    def setPropertyValue(self, name, value):
        self.props[name] = value

    def getPropertyValue(self, name):
        return self.props[name]


class DialogModel(ControlModel):
    def __init__(self):
        super().__init__('Dialog')
        self.order = []
        self.controls = {}

    def createInstance(self, service):
        return ControlModel(service.rsplit('.', 1)[1])

    def insertByName(self, name, model):
        model.props['Name'] = name
        self.order.append(name)
        self.controls[name] = model

    def getByName(self, name):
        return self.controls[name]


class Control:
    def __init__(self):
        self.listeners = []

    def addActionListener(self, listener):
        self.listeners.append(listener)

    addItemListener = addActionListener


class Dialog:
    def __init__(self):
        self.controls = {}

    def setModel(self, model):
        self.model = model

    def createPeer(self, toolkit, parent):
        pass

    def getControl(self, name):
        return self.controls.setdefault(name, Control())

    def execute(self):
        pass

    def dispose(self):
        pass


class Shell:
    def __init__(self):
        self.opened = []

    def execute(self, url, arguments, flags):
        self.opened.append((url, arguments, flags))


class Context:
    """createInstanceWithContext for the services the windows ask for, and nothing else."""

    def __init__(self, product=None, broken=False):
        self.shell = Shell()
        self.product = {'ooSetupVersionAboutBox': '7.4.7.2', 'ooSetupVersion': '7.4'} if product is None else product
        self.broken = broken
        self.ServiceManager = self

    def createInstanceWithContext(self, service, ctx):
        if service == 'com.sun.star.awt.UnoControlDialogModel':
            return DialogModel()
        if service == 'com.sun.star.awt.UnoControlDialog':
            return Dialog()
        if service == 'com.sun.star.system.SystemShellExecute':
            return self.shell
        if service == 'com.sun.star.configuration.ConfigurationProvider':
            if self.broken:
                raise RuntimeError('no configuration')
            return self
        return types.SimpleNamespace()

    def createInstanceWithArguments(self, service, arguments):
        # The product's node, and no other: an absent one would read as an unknown version.
        product = self.product if arguments[0].Value == '/org.openoffice.Setup/Product' else {}
        return types.SimpleNamespace(hasByName=lambda name: name in product, getByName=product.__getitem__)


class Engine:
    def __init__(self):
        self.asked = []

    def report_url(self, office_version='', engine_url=None):
        self.asked.append((office_version, engine_url))
        return 'https://monespace.certimens.fr/#report?kind=problem&details=' + urllib.parse.quote(
            'host: LibreOffice %s' % office_version, safe='')


class ReportButtonTest(unittest.TestCase):
    def window(self, ctx=None, cls=None):
        window = (cls or dialogs.Window)(ctx or Context(), None, 'Certimens')
        window.engine = Engine()
        return window

    def test_right_under_the_message_in_every_window(self):
        window = self.window()
        window.button('close', 'Fermer', window.close, blocking=False)
        window.run()
        self.assertEqual(window.model.order[-2:], ['message', 'report'])
        report = window.model.getByName('report')
        self.assertEqual(report.kind, 'UnoControlButtonModel')
        self.assertEqual(report.props['Label'], dialogs.t('report.problem'))
        self.assertEqual(report.props['HelpText'], dialogs.t('report.problemTipWriter'))
        # Wired like every button, and usable while a call is on its way.
        self.assertIn(window, window.dialog.getControl('report').listeners)
        self.assertNotIn('report', window.busy)

    def test_opens_the_report_through_the_system_shell_and_only_as_an_address(self):
        ctx = Context()
        window = self.window(ctx)
        window.run()
        window.actionPerformed(types.SimpleNamespace(Source=types.SimpleNamespace(
            getModel=lambda: types.SimpleNamespace(Name='report'))))
        self.assertEqual(window.engine.asked, [('7.4.7.2', None)])
        self.assertEqual(ctx.shell.opened, [(
            'https://monespace.certimens.fr/#report?kind=problem&details=host%3A%20LibreOffice%207.4.7.2',
            '', URIS_ONLY)])

    def test_the_login_window_reports_to_the_address_typed_in_it(self):
        window = dialogs.LoginWindow.__new__(dialogs.LoginWindow)
        window.ctx, window.engine = Context(), Engine()
        window.value = lambda name: {'engineUrl': 'https://moteur.univ.fr'}[name]
        window.report_problem()
        self.assertEqual(window.engine.asked, [('7.4.7.2', 'https://moteur.univ.fr')])
        window.value = lambda name: ''
        window.report_problem()
        self.assertEqual(window.engine.asked[-1], ('7.4.7.2', None))


class OfficeVersionTest(unittest.TestCase):
    def test_the_about_box_version_first(self):
        self.assertEqual(dialogs.office_version(Context()), '7.4.7.2')

    def test_the_short_version_when_the_long_one_is_missing(self):
        self.assertEqual(dialogs.office_version(Context({'ooSetupVersion': '7.4'})), '7.4')
        self.assertEqual(dialogs.office_version(Context({'ooSetupVersionAboutBox': '', 'ooSetupVersion': '7.4'})),
                         '7.4')

    def test_nothing_readable_is_empty_never_an_exception(self):
        self.assertEqual(dialogs.office_version(Context({})), '')
        self.assertEqual(dialogs.office_version(Context(broken=True)), '')


if __name__ == '__main__':
    unittest.main()
