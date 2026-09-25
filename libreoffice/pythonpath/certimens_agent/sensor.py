"""Writing sensor inside LibreOffice Writer (the equivalent of extension/content.js).

LibreOffice lets an extension listen to a document's keyboard and mouse
(XUserInputInterception): the definitions are therefore exactly those of the browser extension,
flight times included. Each key is translated into a category (erase, navigation…) for
measure.py, then forgotten. Pastes are seen whatever their origin (shortcut, menu,
right-click) by intercepting the .uno:Paste* commands. Leaving LibreOffice (another application)
counts as leaving the document; switching to a LibreOffice dialog does not.
"""

import os
import threading
import time
import urllib.parse
import uuid

import uno
import unohelper
from com.sun.star.awt import XKeyHandler, XMouseClickHandler, XTopWindowListener
from com.sun.star.beans import StringPair
from com.sun.star.document import XDocumentEventListener
from com.sun.star.frame import XDispatch, XDispatchProviderInterceptor

from . import measure as m

DOCUMENT_ID_PROPERTY = 'CertimensDocumentId'
VOLUME_REFRESH_S = 5
AUTOREPEAT_MAX_S = 0.05     # X11 sends release/press during repeat: same key < 50 ms
HELD_STALE_S = 2.0          # a key believed held that long has had its release missed
PASTE_COMMANDS = {'.uno:Paste', '.uno:PasteUnformatted', '.uno:PasteSpecial', '.uno:ClipboardFormatItems'}
OPEN_COMMAND = 'service:fr.certimens.Agent?open'
INFOBAR_ID = 'certimens'


def _key(name):
    return uno.getConstantByName('com.sun.star.awt.Key.' + name)


ERASE_KEYS = {_key('BACKSPACE'), _key('DELETE')}
NAV_KEYS = {_key(n) for n in ('LEFT', 'RIGHT', 'UP', 'DOWN', 'HOME', 'END', 'PAGEUP', 'PAGEDOWN')}
# 'a' is Ctrl+A (select all), which the measure needs to know a selection now spans the document.
SHORTCUT_LETTERS = {_key(c.upper()): c for c in 'asxz'}
MOD1 = uno.getConstantByName('com.sun.star.awt.KeyModifier.MOD1')  # Ctrl, or Cmd on macOS
# Shift, needed to tell a selection being extended from a plain cursor move.
SHIFT = uno.getConstantByName('com.sun.star.awt.KeyModifier.SHIFT')


def key_char(event):
    """The character a key event carries, '' when it carries none.

    PyUNO surfaces a UNO char as a uno.Char (a .value attribute), not as a str, so reading it
    directly would raise AttributeError and lose the keystroke.
    """
    raw = getattr(event.KeyChar, 'value', event.KeyChar)
    return raw if isinstance(raw, str) else ''


def is_writer(component):
    try:
        return component.supportsService('com.sun.star.text.TextDocument')
    except Exception:
        return False


def document_id(doc, create):
    """Stable identifier of the document, stored in its custom properties (it follows the
    file, .odt as well as .docx). Created on the first keystroke, or when the engine file is created."""
    props = doc.getDocumentProperties().getUserDefinedProperties()
    if props.getPropertySetInfo().hasPropertyByName(DOCUMENT_ID_PROPERTY):
        return props.getPropertyValue(DOCUMENT_ID_PROPERTY)
    if not create:
        return None
    value = str(uuid.uuid4())
    props.addProperty(DOCUMENT_ID_PROPERTY, 0, value)
    return value


def document_name(doc):
    """File name without extension, or the window title ("Sans nom 1") if it has not been
    saved yet."""
    url = doc.getURL()
    if url:
        name = os.path.splitext(urllib.parse.unquote(url.rstrip('/').rsplit('/', 1)[-1]))[0]
        if name:
            return name
    try:
        return doc.getTitle() or 'Document LibreOffice'
    except Exception:
        return 'Document LibreOffice'


def clipboard_text(ctx):
    """Clipboard text (for the size of a paste), '' if there is none."""
    try:
        clip = ctx.ServiceManager.createInstanceWithContext('com.sun.star.datatransfer.clipboard.SystemClipboard', ctx)
        contents = clip.getContents()
        for flavor in contents.getTransferDataFlavors():
            if flavor.MimeType.startswith('text/plain') and 'utf-16' in flavor.MimeType.lower():
                data = contents.getTransferData(flavor)
                return data if isinstance(data, str) else ''
    except Exception:
        pass
    return ''


class DocumentSensor:
    """Measurement of a Writer document; one or more views (windows) are attached to it."""

    def __init__(self, ctx, engine, doc):
        self.ctx = ctx
        self.engine = engine
        self.doc = doc
        self.lock = threading.RLock()
        self.measure = m.Measure()
        self.idle_timer = None
        self.pressed = {}
        self.volume = None
        self.volume_at = 0
        self.doc_id = document_id(doc, create=False)
        self.name = document_name(doc)
        self.views = []
        self.prompted = False
        self.events = DocumentEvents(self)
        doc.addDocumentEventListener(self.events)
        if self.doc_id:
            engine.note_title(self.doc_id, self.name)

    # --- views ---
    def attach_view(self, controller):
        if any(v[0] == controller for v in self.views):
            return
        keys, mouse = KeyHandler(self), MouseHandler(self)
        controller.addKeyHandler(keys)
        controller.addMouseClickHandler(mouse)
        frame = controller.getFrame()
        interceptor = PasteInterceptor(self)
        frame.registerDispatchProviderInterceptor(interceptor)
        window = frame.getContainerWindow()
        focus = FocusListener(self)
        window.addTopWindowListener(focus)
        self.views.append((controller, keys, mouse, frame, interceptor, window, focus))
        self.prompt_unlinked(controller)

    def detach(self):
        self.flush('pagehide')
        for controller, keys, mouse, frame, interceptor, window, focus in self.views:
            for undo in (lambda: controller.removeKeyHandler(keys),
                         lambda: controller.removeMouseClickHandler(mouse),
                         lambda: frame.releaseDispatchProviderInterceptor(interceptor),
                         lambda: window.removeTopWindowListener(focus)):
                try:
                    undo()
                except Exception:
                    pass  # view already destroyed
        self.views = []
        try:
            self.doc.removeDocumentEventListener(self.events)
        except Exception:
            pass

    def prompt_unlinked(self, controller):
        """Document with no Certimens file: an info bar offers to link it (once
        per document and per session, LibreOffice 7.0+)."""
        if self.prompted or not self.engine.logged_in() or (self.doc_id and self.engine.file_id(self.doc_id)):
            return
        self.prompted = True
        try:
            info = uno.getConstantByName('com.sun.star.frame.InfobarType.INFO')
            controller.appendInfobar(INFOBAR_ID, 'Certimens',
                                     "Ce document n'est pas encore associé à votre espace Certimens.",
                                     info, (StringPair('Associer…', OPEN_COMMAND),), True)
        except Exception:
            pass  # LibreOffice too old

    def clear_infobar(self):
        """Removes the info bar once the document has its Certimens file (the window calls this
        right after creating it)."""
        for view in self.views:
            try:
                view[0].removeInfobar(INFOBAR_ID)
            except Exception:
                pass  # no info bar, or LibreOffice too old

    def refresh_name(self):
        self.name = document_name(self.doc)
        if self.doc_id:
            self.engine.note_title(self.doc_id, self.name)

    def ensure_id(self):
        if not self.doc_id:
            self.doc_id = document_id(self.doc, create=True)
            self.engine.note_title(self.doc_id, self.name)
        return self.doc_id

    # --- measurement (UI thread) ---
    def _read_volume(self, force=False):
        """Characters of the document, spaces included, without paragraph breaks (Writer's
        statistics). Re-read at most every 5 s while typing."""
        now = time.time()
        if not force and now - self.volume_at < VOLUME_REFRESH_S:
            return
        try:
            self.volume = self.doc.getPropertyValue('CharacterCount')
            self.volume_at = now
        except Exception:
            pass

    def _arm_idle(self):
        if self.idle_timer:
            self.idle_timer.cancel()
        self.idle_timer = threading.Timer(m.IDLE_FLUSH_S, self.flush, ('idle',))
        self.idle_timer.daemon = True
        self.idle_timer.start()

    def on_key(self, event):
        now = time.time()
        code = event.KeyCode
        # Auto-repeat: the key is held (no release seen yet) and keeps firing, or it comes
        # back within AUTOREPEAT_MAX_S. A release can be swallowed by a dialog opening on
        # key-down (Ctrl+S) or by switching apps while held, so a "held" state older than
        # HELD_STALE_S is treated as stale rather than muting the key for the whole session.
        previous = self.pressed.get(code)
        self.pressed[code] = [now, True]
        if previous and now - previous[0] < (HELD_STALE_S if previous[1] else AUTOREPEAT_MAX_S):
            return
        if code == 0 and not key_char(event).strip('\x00'):
            category = m.MODIFIER
        elif code in ERASE_KEYS:
            category = m.ERASE
        elif code in NAV_KEYS:
            category = m.NAVIGATION
        else:
            category = m.OTHER
        ctrl = bool(event.Modifiers & MOD1)
        shift = bool(event.Modifiers & SHIFT)
        self.ensure_id()
        self._read_volume()
        with self.lock:
            reason = self.measure.on_key(now, category, ctrl, SHORTCUT_LETTERS.get(code), shift)
        if reason:
            self.flush(reason)
        else:
            self._arm_idle()

    def on_key_released(self, event):
        state = self.pressed.get(event.KeyCode)
        if state:
            state[1] = False

    def on_click(self):
        with self.lock:
            self.measure.on_click(time.time())
        self._arm_idle()

    def on_paste(self):
        text = clipboard_text(self.ctx)
        self.ensure_id()
        with self.lock:
            self.measure.on_paste(time.time(), text)
        self._arm_idle()

    def on_deactivated(self):
        # Keys held while the focus leaves never deliver their release here.
        self.pressed.clear()
        # Just after deactivation, the active window is known: a LibreOffice dialog
        # does not count, another application (null active window) does.
        def check():
            try:
                toolkit = self.ctx.ServiceManager.createInstanceWithContext('com.sun.star.awt.Toolkit', self.ctx)
                if toolkit.getActiveTopWindow() is not None:
                    return
            except Exception:
                pass
            with self.lock:
                self.measure.on_focus_lost()
            self.flush('blur')
        timer = threading.Timer(0.1, check)
        timer.daemon = True
        timer.start()

    # --- flush to the queue ---
    def flush(self, reason):
        if self.idle_timer:
            self.idle_timer.cancel()
        if reason in ('save', 'pagehide'):
            self._read_volume(force=True)
        with self.lock:
            done = self.measure.take(self.volume)
        if done and self.doc_id:
            self.engine.enqueue(self.doc_id, self.name, done[0], done[1])


# --- UNO listeners ---
class KeyHandler(unohelper.Base, XKeyHandler):
    def __init__(self, sensor):
        self.sensor = sensor

    def keyPressed(self, event):
        try:
            self.sensor.on_key(event)
        except Exception as err:
            print('Certimens:', err)
        return False  # the key continues on to the document

    def keyReleased(self, event):
        self.sensor.on_key_released(event)
        return False

    def disposing(self, source):
        pass


class MouseHandler(unohelper.Base, XMouseClickHandler):
    """Clicks in the document view only (not in the menus or the toolbars)."""

    def __init__(self, sensor):
        self.sensor = sensor

    def mousePressed(self, event):
        try:
            self.sensor.on_click()
        except Exception as err:
            print('Certimens:', err)
        return False

    def mouseReleased(self, event):
        return False

    def disposing(self, source):
        pass


class PasteDispatch(unohelper.Base, XDispatch):
    """Paste command: counts the paste then forwards it as-is."""

    def __init__(self, sensor, slave):
        self.sensor = sensor
        self.slave = slave

    def dispatch(self, url, args):
        try:
            self.sensor.on_paste()
        except Exception as err:
            print('Certimens:', err)
        self.slave.dispatch(url, args)

    def addStatusListener(self, listener, url):
        self.slave.addStatusListener(listener, url)

    def removeStatusListener(self, listener, url):
        self.slave.removeStatusListener(listener, url)


class PasteInterceptor(unohelper.Base, XDispatchProviderInterceptor):
    def __init__(self, sensor):
        self.sensor = sensor
        self.slave = None
        self.master = None

    def getSlaveDispatchProvider(self):
        return self.slave

    def setSlaveDispatchProvider(self, provider):
        self.slave = provider

    def getMasterDispatchProvider(self):
        return self.master

    def setMasterDispatchProvider(self, provider):
        self.master = provider

    def queryDispatch(self, url, target, flags):
        dispatch = self.slave.queryDispatch(url, target, flags) if self.slave else None
        if dispatch is not None and url.Complete.split('?')[0] in PASTE_COMMANDS:
            return PasteDispatch(self.sensor, dispatch)
        return dispatch

    def queryDispatches(self, requests):
        return tuple(self.queryDispatch(r.FeatureURL, r.FrameName, r.SearchFlags) for r in requests)


class FocusListener(unohelper.Base, XTopWindowListener):
    def __init__(self, sensor):
        self.sensor = sensor

    def windowDeactivated(self, event):
        self.sensor.on_deactivated()

    def windowOpened(self, event):
        pass

    def windowClosing(self, event):
        pass

    def windowClosed(self, event):
        pass

    def windowMinimized(self, event):
        pass

    def windowNormalized(self, event):
        pass

    def windowActivated(self, event):
        pass

    def disposing(self, event):
        pass


class DocumentEvents(unohelper.Base, XDocumentEventListener):
    """Saving (flush, and the new name after "Save As") and closing."""

    def __init__(self, sensor):
        self.sensor = sensor

    def documentEventOccured(self, event):
        name = event.EventName
        try:
            if name in ('OnSave', 'OnSaveAs'):
                self.sensor.flush('save')
            elif name in ('OnSaveAsDone', 'OnTitleChanged'):
                self.sensor.refresh_name()
            elif name == 'OnPrepareUnload':
                self.sensor.flush('pagehide')
        except Exception as err:
            print('Certimens:', err)

    def disposing(self, source):
        pass
