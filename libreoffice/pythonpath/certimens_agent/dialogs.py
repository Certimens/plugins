"""Certimens windows for Writer (the counterpart of extension/popup.js): student login, the
document's engine file, the assignment it is submitted to, and sending the .docx.

LibreOffice has no HTML popup: the windows are built control by control
(com.sun.star.awt.UnoControlDialogModel), laid out in appfont units from top to bottom. Two of
them follow one another, as the popup's two states do — login, then the document window.

The document is sent in one click: Writer exports the open document through its Word filter,
without the student having to save a copy first. Where that export is refused (a filter missing
from the installation, a read-only temporary folder), the window falls back to what the popup
does on Word Online: a button to choose a .docx by hand.

Network calls never run on the UI thread — LibreOffice would freeze for as long as the engine
takes to answer. They go to a worker thread, which updates the controls when it is done.
"""

import os
import shutil
import tempfile
import threading
from datetime import datetime, timezone

import uno
import unohelper
from com.sun.star.awt import XActionListener

from .engine import DEFAULT_ENGINE_URL, HttpError

# Writer's Word filter — what "Enregistrer sous… .docx" uses.
DOCX_FILTER = 'MS Word 2007 XML'
BOLD = uno.getConstantByName('com.sun.star.awt.FontWeight.BOLD')
POS = uno.getConstantByName('com.sun.star.awt.PosSize.POS')
URIS_ONLY = uno.getConstantByName('com.sun.star.system.SystemShellExecuteFlags.URIS_ONLY')


def prop(name, value):
    value_pair = uno.createUnoStruct('com.sun.star.beans.PropertyValue')
    value_pair.Name, value_pair.Value = name, value
    return value_pair


def error_text(err):
    """What a failed call says, in the wording of the browser extension."""
    if err.status == 401:
        return 'Identifiants incorrects ou accès révoqué — reconnectez-vous.'
    if err.status == 0:
        return 'Moteur injoignable (%s).' % (err.message or 'erreur réseau')
    message = err.message or 'erreur inconnue'
    return message[:1].upper() + message[1:] + '.'


def deadline_label(assignment):
    """« Mémoire (avant le 12/05) », the deadline flagged as overdue like in the popup."""
    raw = (assignment.get('deadline') or '').replace('Z', '+00:00')
    try:
        deadline = datetime.fromisoformat(raw)
    except ValueError:
        return assignment.get('title') or 'Devoir'
    if deadline.tzinfo is None:
        deadline = deadline.replace(tzinfo=timezone.utc)
    passed = deadline < datetime.now(timezone.utc)
    return '%s (%s %s)' % (assignment.get('title') or 'Devoir', 'échu le' if passed else 'avant le',
                           deadline.astimezone().strftime('%d/%m'))


def export_docx(doc):
    """The open document exported as .docx bytes.

    storeToURL writes a copy: the document keeps its own URL, its format and its modified flag,
    and the sensor sees no save.
    """
    directory = tempfile.mkdtemp(prefix='certimens-')
    path = os.path.join(directory, 'document.docx')
    try:
        doc.storeToURL(uno.systemPathToFileUrl(path), (prop('FilterName', DOCX_FILTER), prop('Overwrite', True)))
        with open(path, 'rb') as f:
            return f.read()
    finally:
        shutil.rmtree(directory, ignore_errors=True)


def pick_docx(ctx):
    """Bytes of a .docx chosen by the student, or None if the file window was cancelled."""
    picker = ctx.ServiceManager.createInstanceWithContext('com.sun.star.ui.dialogs.FilePicker', ctx)
    picker.setTitle('Choisir le document .docx à envoyer')
    picker.appendFilter('Document Word (.docx)', '*.docx')
    try:
        if not picker.execute():
            return None
        files = picker.getSelectedFiles()
    finally:
        try:
            picker.dispose()
        except Exception:
            pass
    if not files:
        return None
    path = uno.fileUrlToSystemPath(files[0])
    with open(path, 'rb') as f:
        data = f.read()
    # A .docx is a zip archive: "PK" signature, as the popup checks it.
    if not path.lower().endswith('.docx') or data[:2] != b'PK':
        raise HttpError(0, "ce fichier n'est pas un document .docx")
    return data


class Window(unohelper.Base, XActionListener):
    """A window built control by control. Controls are added from top to bottom (self.y is the
    layout cursor) and buttons are wired to a method by name."""

    WIDTH = 240
    MARGIN = 8

    def __init__(self, ctx, parent, title):
        self.ctx = ctx
        self.parent = parent
        self.closed = False
        self.result = None
        self.actions = {}
        self.busy = []
        self.y = self.MARGIN
        smgr = ctx.ServiceManager
        self.model = smgr.createInstanceWithContext('com.sun.star.awt.UnoControlDialogModel', ctx)
        self.model.setPropertyValue('Title', title)
        self.model.setPropertyValue('Width', self.WIDTH)
        self.dialog = smgr.createInstanceWithContext('com.sun.star.awt.UnoControlDialog', ctx)
        self.dialog.setModel(self.model)

    # --- controls ---
    def _add(self, kind, name, height, **props):
        model = self.model.createInstance('com.sun.star.awt.UnoControl%sModel' % kind)
        model.setPropertyValue('PositionX', self.MARGIN)
        model.setPropertyValue('PositionY', self.y)
        model.setPropertyValue('Width', self.WIDTH - 2 * self.MARGIN)
        model.setPropertyValue('Height', height)
        for key, value in props.items():
            model.setPropertyValue(key, value)
        self.model.insertByName(name, model)
        self.y += height
        return model

    def gap(self, height=4):
        self.y += height

    def text(self, name, label, height=10, bold=False, lines=1):
        model = self._add('FixedText', name, height * lines, Label=label, MultiLine=lines > 1)
        if bold:
            model.setPropertyValue('FontWeight', BOLD)
        return model

    def field(self, name, label, value='', password=False):
        self.text(name + 'Label', label, height=9)
        model = self._add('Edit', name, 13, Text=value)
        if password:
            model.setPropertyValue('EchoChar', ord('*'))
        return model

    def choice(self, name, label):
        self.text(name + 'Label', label, height=9)
        return self._add('ListBox', name, 13, Dropdown=True)

    def button(self, name, label, action, default=False, blocking=True):
        model = self._add('Button', name, 14, Label=label)
        if default:
            model.setPropertyValue('DefaultButton', True)
        self.actions[name] = action
        if blocking:  # a button that only closes the window stays usable during a call
            self.busy.append(name)
        return model

    def line(self):
        self._add('FixedLine', 'line%d' % self.y, 6)

    # --- state of the controls ---
    def control(self, name):
        return self.dialog.getControl(name)

    def value(self, name):
        return self.model.getByName(name).getPropertyValue('Text').strip()

    def label(self, name, text):
        self.model.getByName(name).setPropertyValue('Label', text)

    def show(self, name, visible):
        self.control(name).setVisible(visible)

    def enable(self, name, enabled):
        self.model.getByName(name).setPropertyValue('Enabled', enabled)

    def message(self, text):
        self.label('message', text)

    def set_busy(self, busy):
        for name in self.busy:
            try:
                self.enable(name, not busy)
            except Exception:
                pass  # control removed with the window

    # --- running ---
    def run(self):
        self.text('message', '', lines=2)
        self.model.setPropertyValue('Height', self.y + self.MARGIN)
        toolkit = self.ctx.ServiceManager.createInstanceWithContext('com.sun.star.awt.Toolkit', self.ctx)
        self.dialog.createPeer(toolkit, self.parent)
        for name in self.actions:
            self.control(name).addActionListener(self)
        self._center()
        self.ready()
        self.dialog.execute()
        self.closed = True
        self.dialog.dispose()
        return self.result

    def _center(self):
        try:
            parent = self.parent.getPosSize()
            here = self.dialog.getPosSize()
            self.dialog.setPosSize(parent.X + (parent.Width - here.Width) // 2,
                                   parent.Y + (parent.Height - here.Height) // 3, 0, 0, POS)
        except Exception:
            pass  # no parent window: LibreOffice places the window itself

    def close(self, result=None):
        self.result = result
        self.dialog.endExecute()

    def ready(self):
        """Called once the window is on screen (loading of what comes from the engine)."""

    def actionPerformed(self, event):
        action = self.actions.get(event.Source.getModel().Name)
        if not action:
            return
        try:
            action()
        except HttpError as err:
            self.message(error_text(err))
        except Exception as err:
            self.message('Erreur : %s' % err)

    def call(self, work, done, busy=None):
        """Runs an engine call off the UI thread, then hands the result to done(result, error)."""
        if busy:
            self.message(busy)
        self.set_busy(True)

        def task():
            error = None
            result = None
            try:
                result = work()
            except HttpError as err:
                error = err
            except Exception as err:  # unexpected: shown rather than swallowed
                error = HttpError(0, str(err))
            if self.closed:
                return
            try:
                self.set_busy(False)
                done(result, error)
            except Exception as err:
                print('Certimens:', err)

        threading.Thread(target=task, name='certimens-window', daemon=True).start()


class LoginWindow(Window):
    """Student login (the popup's login form)."""

    def __init__(self, ctx, parent, engine):
        super().__init__(ctx, parent, 'Certimens — Connexion')
        self.engine = engine
        config = engine.config()
        self.text('intro', 'Connectez-vous à votre espace Certimens.', lines=1)
        self.gap()
        self.field('email', 'E-mail', config.get('email', ''))
        self.field('password', 'Mot de passe', password=True)
        self.field('engineUrl', 'Adresse du moteur', config.get('engineUrl') or DEFAULT_ENGINE_URL)
        self.gap()
        self.button('login', 'Se connecter', self.login, default=True)
        self.button('cancel', 'Fermer', self.close, blocking=False)

    def login(self):
        email, password = self.value('email'), self.model.getByName('password').getPropertyValue('Text')
        engine_url = self.value('engineUrl') or DEFAULT_ENGINE_URL
        if not email or not password:
            self.message('Renseignez votre e-mail et votre mot de passe.')
            return

        def done(me, error):
            if error:
                self.message(error_text(error))
                return
            self.close('logged-in')

        self.call(lambda: self.engine.login(engine_url, email, password), done, busy='Connexion…')


class DocumentWindow(Window):
    """The open document: its Certimens file, its assignment and sending the .docx.

    The layout is decided from what is known locally (does the document already have a file?);
    what comes from the engine — the file, the assignments — fills in afterwards.
    """

    def __init__(self, ctx, parent, agent, doc, note=''):
        super().__init__(ctx, parent, 'Certimens')
        self.note = note
        self.engine = agent.engine
        self.doc = doc
        self.sensor = agent.sensor(doc)
        self.doc_id = self.sensor.doc_id
        self.file_id = self.engine.file_id(self.doc_id) if self.doc_id else None
        self.file = None
        self.assignments = []

        self.text('who', 'Connecté : %s' % (self.engine.config().get('email') or ''), height=9)
        self.line()
        if self.file_id:
            self._linked_controls()
        else:
            self._create_controls()
        self.line()
        self.button('logout', 'Se déconnecter', self.logout)
        self.button('close', 'Fermer', self.close, default=True, blocking=False)

    def _create_controls(self):
        self.text('docLabel', "Ce document n'a pas encore de fichier Certimens.", lines=1)
        self.gap()
        self.field('name', 'Nom du fichier', self.sensor.name)
        self.choice('assignment', 'Devoir')
        self.gap()
        self.button('create', 'Créer le fichier', self.create)

    def _linked_controls(self):
        self.text('name', self.sensor.name, bold=True)
        self.text('linked', 'Fichier Certimens associé : les mesures y sont envoyées.', lines=1)
        self.text('submitted', '', height=9)
        self.gap()
        self.choice('assignment', 'Devoir')
        self.button('submit', 'Rendre sur ce devoir', self.submit)
        self.gap()
        self.button('upload', 'Envoyer le document', self.upload)
        # Shown only where Writer's export is refused: the student picks the .docx himself.
        self.button('pick', 'Choisir un fichier .docx…', self.pick)
        self.text('uploadHint', '', height=9, lines=2)
        self.gap()
        self.button('open', 'Ouvrir dans Certimens', self.open_in_browser)

    def ready(self):
        if self.file_id:
            self.show('pick', False)
        if self.note:
            self.message(self.note)
        self.load()

    # --- loading ---
    def load(self):
        def work():
            file = self.engine.doc_info(self.doc_id) if self.doc_id else None
            return file, self.engine.assignments()

        def done(result, error):
            if error:
                self.message(error_text(error))
                return
            file, assignments = result
            self.assignments = assignments
            self.fill_assignments()
            if file:
                self.show_file(file)
            elif self.file_id:
                # the file was deleted on the engine side: the window reopens on creation
                self.message("Le fichier Certimens de ce document n'existe plus : recréez-le.")
                self.close('reopen')

        self.call(work, done, busy='Chargement…')

    def fill_assignments(self):
        control = self.control('assignment')
        control.removeItems(0, control.getItemCount())
        first = '— Choisir un devoir —' if self.assignments else "— Aucun devoir pour l'instant —"
        control.addItems(tuple([first] + [deadline_label(a) for a in self.assignments]), 0)
        current = (self.file or {}).get('assignment_id')
        position = next((i + 1 for i, a in enumerate(self.assignments) if a['id'] == current), 0)
        control.selectItemPos(position, True)

    def show_file(self, file):
        self.file = file
        self.file_id = file['id']
        self.label('name', file.get('document_name') or self.sensor.name)
        self.label('submitted', ('Rendu sur : %s' % file['assignment_title'])
                   if file.get('assignment_title') else 'Pas encore rendu sur un devoir.')
        self.label('uploadHint', 'Un document est déjà envoyé : un nouvel envoi le remplace.'
                   if file.get('content_type') else '')
        self.label('submit', 'Changer de devoir' if file.get('assignment_id') else 'Rendre sur ce devoir')

    def chosen_assignment(self):
        position = self.control('assignment').getSelectedItemPos()
        return self.assignments[position - 1]['id'] if position > 0 else None

    # --- actions ---
    def create(self):
        name = self.value('name') or self.sensor.name
        assignment_id = self.chosen_assignment()
        document_id = self.sensor.ensure_id()

        def work():
            file_id, existed = self.engine.create_file(document_id, name, self.sensor.name)
            if assignment_id:
                return self.engine.submit(file_id, assignment_id), existed
            return self.engine.doc_info(document_id), existed

        def done(result, error):
            if error:
                self.message(error_text(error))
                return
            file, existed = result
            self.sensor.clear_infobar()
            if file:
                self.file_id = file['id']
            self.close(('reopen', 'Ce document avait déjà un fichier.' if existed else 'Fichier créé.'))

        self.call(work, done, busy='Création du fichier…')

    def submit(self):
        assignment_id = self.chosen_assignment()
        if not assignment_id:
            self.message('Choisissez un devoir.')
            return

        def done(file, error):
            if error:
                self.message(('Rendu impossible : %s.' % error.message) if error.status == 403
                             else error_text(error))
                return
            self.show_file({**(self.file or {}), **file})
            self.message('Fichier rendu.')

        self.call(lambda: self.engine.submit(self.file_id, assignment_id), done, busy='Rendu en cours…')

    def upload(self):
        """One click: Writer exports the open document, and it goes to the engine."""
        try:
            document = export_docx(self.doc)
        except Exception as err:
            # Export refused: the student sends a .docx saved by hand instead.
            self.show('pick', True)
            self.message('Export automatique impossible (%s). Enregistrez le document en .docx, '
                         'puis choisissez-le ci-dessous.' % err)
            return
        self.send(document)

    def pick(self):
        document = pick_docx(self.ctx)
        if document:
            self.send(document)

    def send(self, document):
        def done(file, error):
            if error:
                self.message(error_text(error))
                return
            self.show_file({**(self.file or {}), **file})
            self.message('Document envoyé (%d Ko).' % (len(document) // 1024))

        self.call(lambda: self.engine.upload_docx(self.doc_id, document), done, busy='Envoi du document…')

    def open_in_browser(self):
        url = '%s/file/%s' % (self.engine.config()['engineUrl'].rstrip('/'), self.file_id)
        shell = self.ctx.ServiceManager.createInstanceWithContext('com.sun.star.system.SystemShellExecute', self.ctx)
        shell.execute(url, '', URIS_ONLY)

    def logout(self):
        self.call(self.engine.logout, lambda result, error: self.close('logged-out'), busy='Déconnexion…')


def open_window(ctx, agent, doc):
    """The Certimens menu and the info bar of an unlinked document both land here."""
    try:
        parent = doc.getCurrentController().getFrame().getContainerWindow()
    except Exception:
        parent = None
    note = ''
    while True:
        if not agent.engine.logged_in():
            if LoginWindow(ctx, parent, agent.engine).run() != 'logged-in':
                return
        # The window is rebuilt when the document gains its file (the layout changes) and when
        # the student logs out (the login window comes back).
        result = DocumentWindow(ctx, parent, agent, doc, note).run()
        note = ''
        if isinstance(result, tuple):
            result, note = result
        if result not in ('reopen', 'logged-out'):
            return
