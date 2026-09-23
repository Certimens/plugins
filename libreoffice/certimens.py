"""UNO component of the Certimens extension for LibreOffice (service fr.certimens.Agent).

- Jobs.xcu runs it when LibreOffice starts (onFirstVisibleTask event): the agent
  starts up and measures every Writer document (pythonpath/certimens_agent/agent.py).
- Writer's Certimens menu (Addons.xcu) and the info bar of an unlinked document
  call it with the service:fr.certimens.Agent?open command.

LibreOffice adds the extension's pythonpath/ folder to sys.path.
"""

import unohelper
from com.sun.star.task import XJob, XJobExecutor

from certimens_agent import agent, dialogs
from certimens_agent.sensor import is_writer

IMPLEMENTATION = 'fr.certimens.Agent'


class Agent(unohelper.Base, XJob, XJobExecutor):
    def __init__(self, ctx):
        self.ctx = ctx

    def execute(self, args):
        agent.get(self.ctx)
        return ()

    def trigger(self, command):
        if command != 'open':
            return
        current = agent.get(self.ctx)
        desktop = self.ctx.ServiceManager.createInstanceWithContext('com.sun.star.frame.Desktop', self.ctx)
        doc = desktop.getCurrentComponent()
        if not is_writer(doc):
            return
        try:
            dialogs.open_window(self.ctx, current, doc)
        except Exception as err:  # a window must never take LibreOffice down with it
            print('Certimens:', err)


g_ImplementationHelper = unohelper.ImplementationHelper()
g_ImplementationHelper.addImplementation(Agent, IMPLEMENTATION, ('com.sun.star.task.Job',))
