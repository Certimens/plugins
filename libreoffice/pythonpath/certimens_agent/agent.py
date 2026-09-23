"""Agent startup inside LibreOffice: one per session, regardless of how many documents are
open. At launch (Jobs.xcu) it starts the thread that sends to the engine and attaches to every
Writer document, already open or opened later, via LibreOffice's global event broadcaster.
"""

import os
import threading

import uno
import unohelper
from com.sun.star.document import XDocumentEventListener

from .engine import Engine
from .sensor import DocumentSensor, is_writer

_lock = threading.Lock()
_agent = None


class Agent(unohelper.Base, XDocumentEventListener):
    def __init__(self, ctx):
        self.ctx = ctx
        subst = ctx.ServiceManager.createInstanceWithContext('com.sun.star.util.PathSubstitution', ctx)
        profile = uno.fileUrlToSystemPath(subst.substituteVariables('$(user)', True))
        self.engine = Engine(os.path.join(profile, 'certimens.json'))
        self.sensors = {}

    def start(self):
        self.engine.start()
        broadcaster = self.ctx.getValueByName('/singletons/com.sun.star.frame.theGlobalEventBroadcaster')
        broadcaster.addDocumentEventListener(self)
        # documents already open before the agent started
        desktop = self.ctx.ServiceManager.createInstanceWithContext('com.sun.star.frame.Desktop', self.ctx)
        components = desktop.getComponents().createEnumeration()
        while components.hasMoreElements():
            doc = components.nextElement()
            if is_writer(doc) and doc.getCurrentController():
                self.sensor(doc).attach_view(doc.getCurrentController())

    def sensor(self, doc):
        key = doc.getPropertyValue('RuntimeUID')
        if key not in self.sensors:
            self.sensors[key] = DocumentSensor(self.ctx, self.engine, doc)
        return self.sensors[key]

    def documentEventOccured(self, event):
        doc = event.Source
        if not is_writer(doc):
            return
        try:
            if event.EventName == 'OnViewCreated' and event.ViewController:
                self.sensor(doc).attach_view(event.ViewController)
            elif event.EventName == 'OnUnload':
                sensor = self.sensors.pop(doc.getPropertyValue('RuntimeUID'), None)
                if sensor:
                    sensor.detach()
        except Exception as err:
            print('Certimens:', err)

    def disposing(self, source):
        pass


def get(ctx):
    """The session's agent, started on the first call."""
    global _agent
    with _lock:
        if _agent is None:
            _agent = Agent(ctx)
            _agent.start()
        return _agent
