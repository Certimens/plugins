#!/usr/bin/env python3
"""The extension in a **real LibreOffice**: installed, then exercised through UNO.

The tests of `libreoffice/tests/` run *without* LibreOffice — they replace `uno` and the
`com.sun.star.*` interfaces with objects of our own. They hold the measurement rules, and can
say nothing about what only happens once the extension is installed: an `.oxt` that `unopkg`
refuses, a component the office suite does not register, a `from com.sun.star.X import Y` that
does not exist in that version. That is the class of failure where the extension installs and
does nothing — and where extensions.libreoffice.org, which reviews nothing, will say nothing
either.

Run inside the container of `make test-host` (tests/host/Dockerfile): LibreOffice is there, and
the environment is thrown away with one command.
"""

import json
import os
import pathlib
import subprocess
import sys
import tempfile
import time

# A fresh LibreOffice profile per run: that of an installation that has just happened, never
# the previous one's. The container takes it away with it when it closes.
PROFILE_DIR = tempfile.mkdtemp(prefix='certimens-profile-')
PROFILE = pathlib.Path(PROFILE_DIR).as_uri()
PORT = 2002
OXT = '/agent/dist/libreoffice.oxt'
IDENTIFIER = 'fr.certimens.agent'
SERVICE = 'fr.certimens.Agent'
# What the agent puts in a document's properties to recognise it later
# (`sensor.DOCUMENT_ID_PROPERTY`), and an identifier of our own for this test's document.
#
# The shape is not free: the property travels inside the file, so the agent adopts back only a
# value it could itself have minted — a UUID, and nothing else (`sensor.minted_here`). A
# readable label of our own here would be refused exactly as a stranger's would, the agent would
# mint a fresh identity for the document, and this suite would be left asserting on an
# identifier it cannot know.
DOCUMENT_ID_PROPERTY = 'CertimensDocumentId'
DOCUMENT_ID = '7b3f1a2c-5d6e-4f80-9a1b-2c3d4e5f6071'
# The second half of the suite types. A --headless office suite opens no document window, and
# the sensor hears the keyboard of a document window only: Writer is started again on a virtual
# screen, and xdotool sends it real X events — the path a student's keyboard takes.
DISPLAY = ':99'
# Between two keys: well under the idle delay (measure.IDLE_FLUSH_S, 2 s), so a scenario is one
# window; and long enough for Writer to have handled the key before the next one.
KEY_PAUSE_S = 0.4
# Long enough for the idle delay to seal the window.
SEAL_WAIT_S = 3.5
# An engine that answers nothing: the agent believes it is paired, measures, and keeps every
# window in its queue — which is where this suite reads them.
UNREACHABLE_ENGINE = 'http://127.0.0.1:9'
ENGINE_DOCUMENT = 'eng1'


def read_state():
    """What the agent wrote into the LibreOffice profile, or None if there is nothing."""
    path = os.path.join(PROFILE_DIR, 'user', 'certimens.json')
    if not os.path.exists(path):
        return None
    try:
        with open(path, encoding='utf-8') as handle:
            return json.load(handle)
    except ValueError:
        # Written under a lock then moved into place: a half-read file does not happen, but a
        # file absent a millisecond earlier does. On the next round.
        return None


def wait_for_state(ready, timeout=15):
    """The profile, once `ready` is satisfied with it.

    The agent writes its state from a **background thread** (`Engine.start`): reading it once,
    right after starting it, is a race. It would be won almost always, and lost one morning in
    the CI — which is the usual way a suite stops being believed.
    """
    deadline = time.monotonic() + timeout
    state = None
    while time.monotonic() < deadline:
        state = read_state()
        if state is not None and ready(state):
            return state
        time.sleep(0.2)
    return state

results = []


def check(name, fn):
    try:
        fn()
        results.append('  ✔ %s' % name)
        return True
    except Exception as err:  # a suite says all its failures, not just the first
        results.append('  ✖ %s\n      %s: %s' % (name, type(err).__name__, err))
        return False


def office(*args):
    """unopkg or soffice, always on the throwaway profile."""
    return subprocess.run([*args, '-env:UserInstallation=%s' % PROFILE],
                          capture_output=True, text=True, timeout=180)


def connect(context):
    """Waits for the office suite to answer on the socket, then returns its context."""
    resolver = context.ServiceManager.createInstanceWithContext(
        'com.sun.star.bridge.UnoUrlResolver', context)
    url = 'uno:socket,host=127.0.0.1,port=%d;urp;StarOffice.ComponentContext' % PORT
    last = None
    for _ in range(120):
        try:
            return resolver.resolve(url)
        except Exception as err:
            last = err
            time.sleep(0.5)
    raise RuntimeError('LibreOffice did not answer on the socket: %s' % last)


def start_office(env=None, headless=True):
    """soffice on the throwaway profile, listening on the socket."""
    return subprocess.Popen(
        ['soffice', *(['--headless'] if headless else []), '--norestore', '--nologo', '--nodefault',
         '--accept=socket,host=127.0.0.1,port=%d;urp;' % PORT,
         '-env:UserInstallation=%s' % PROFILE],
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, env=env)


def stop_office(context, soffice):
    if context is not None:
        try:
            context.ServiceManager.createInstanceWithContext(
                'com.sun.star.frame.Desktop', context).terminate()
        except Exception:
            pass
    try:
        soffice.wait(timeout=30)
    except subprocess.TimeoutExpired:
        soffice.kill()


def main():
    import uno  # provided by python3-uno, inside the container

    installed = office('unopkg', 'add', '--force', OXT)
    check('the .oxt package installs into a real LibreOffice',
          lambda: _assert(installed.returncode == 0,
                          'unopkg add refused the package:\n%s%s' % (installed.stdout, installed.stderr)))

    listed = office('unopkg', 'list')
    check('and the office suite lists it under its identifier',
          lambda: _assert(IDENTIFIER in listed.stdout,
                          'identifier "%s" absent from unopkg list:\n%s' % (IDENTIFIER, listed.stdout)))

    soffice = start_office()
    context = None
    try:
        context = connect(uno.getComponentContext())
        check('the office suite starts with the extension installed and answers',
              lambda: _assert(context.ServiceManager is not None, 'no ServiceManager'))

        agent = [None]

        def instantiate():
            # What `Jobs.xcu` does when LibreOffice starts. A component whose Python throws on
            # import does not get this far: it is the real registry that answers.
            agent[0] = context.ServiceManager.createInstanceWithContext(SERVICE, context)
            _assert(agent[0] is not None, 'the "%s" service is not registered' % SERVICE)

        if check('the "%s" component is registered by the office suite' % SERVICE, instantiate):
            check('it starts as it would when LibreOffice launches (XJob.execute)',
                  lambda: agent[0].execute(()))

        # « Signaler un problème » says which LibreOffice it runs in, read from the configuration
        # (`dialogs.office_version`). The node and its names are LibreOffice's, and whether this
        # version still has them is what no double can say. The window's own function, called
        # over the bridge.
        def version_is_read():
            sys.path.insert(0, '/agent/src/pythonpath')
            from certimens_agent.dialogs import office_version
            version = office_version(context)
            _assert(version[:1].isdigit() and '.' in version, 'version read: %r' % version)
        check('the report reads the LibreOffice version from its configuration', version_is_read)

        document = [None]
        # A document the student has already opened once carries the identifier the agent put
        # there, in its user-defined properties — it follows the file, .odt as well as .docx. We
        # make one: it is the only way, without a display, to prove the agent really hooked onto
        # the view, since that is when it reads it back and keeps its title.
        written = os.path.join(PROFILE_DIR, 'memoire.odt')

        def write_a_document():
            desktop = context.ServiceManager.createInstanceWithContext(
                'com.sun.star.frame.Desktop', context)
            doc = desktop.loadComponentFromURL('private:factory/swriter', '_blank', 0, ())
            _assert(doc is not None, 'no Writer document')
            doc.getText().setString('Dans ce mémoire, nous étudions la rédaction.')
            props = doc.getDocumentProperties().getUserDefinedProperties()
            props.addProperty(DOCUMENT_ID_PROPERTY, 0, DOCUMENT_ID)
            doc.storeToURL(uno.systemPathToFileUrl(written), ())
            doc.close(False)

        if check('a Writer document opens, is written and is saved', write_a_document):
            def reopen():
                desktop = context.ServiceManager.createInstanceWithContext(
                    'com.sun.star.frame.Desktop', context)
                document[0] = desktop.loadComponentFromURL(uno.systemPathToFileUrl(written), '_blank', 0, ())
                _assert(document[0] is not None, 'the document does not reopen')
                _assert(document[0].getText().getString().startswith('Dans ce mémoire'),
                        'the text was not read back')
            check('and it reopens with what was written in it', reopen)

            # The span of a modification is computed on the body text and said beside Writer's
            # own count: the agent only says it when the two agree (`measure.take`). Whether
            # they do, on plain paragraphs, is a fact about Writer that no double can assert.
            def reading_agrees():
                text = document[0].getText()
                text.insertControlCharacter(text.getEnd(), uno.getConstantByName(
                    'com.sun.star.text.ControlCharacter.PARAGRAPH_BREAK'), False)
                text.insertString(text.getEnd(), 'Un second paragraphe, écrit à la suite.', False)
                read = text.getString().replace('\r', '').replace('\n', '')
                count = document[0].getPropertyValue('CharacterCount')
                _assert(len(read) == count,
                        'body text of %d characters, CharacterCount %r' % (len(read), count))
            if document[0] is not None:
                check('Writer counts exactly the body text the agent reads', reading_agrees)

            # What the agent kept of the document, read from its profile: had it not been hooked
            # onto the view at opening, that title would be nowhere.
            def noticed():
                state = wait_for_state(lambda st: st.get('titles'))
                _assert(state is not None, 'the agent did not write its profile')
                titles = state.get('titles', {})
                _assert(titles.get(DOCUMENT_ID) == 'memoire',
                        'titles kept by the agent: %r' % (titles,))
            check('the agent hooked onto it: it kept its title', noticed)

            if document[0] is not None:
                document[0].close(False)

        # The agent really started, and its state says so: without a token, "unconfigured".
        def started():
            state = wait_for_state(lambda st: st.get('status', {}).get('state'))
            _assert(state is not None, 'the agent did not write its profile')
            _assert(state['status']['state'] == 'unconfigured',
                    'unexpected state: %r' % (state['status'],))
        check('and it wrote its state into the LibreOffice profile', started)
    finally:
        stop_office(context, soffice)

    typing(uno, os.path.join(PROFILE_DIR, 'memoire.odt'))

    removed = office('unopkg', 'remove', IDENTIFIER)
    check('and it uninstalls cleanly',
          lambda: _assert(removed.returncode == 0,
                          'unopkg remove failed:\n%s%s' % (removed.stdout, removed.stderr)))

    failed = [line for line in results if line.startswith('  ✖')]
    version = office('soffice', '--version').stdout.strip().splitlines()[:1]
    print('\nCertimens in %s:\n%s\n' % (version[0] if version else 'LibreOffice', '\n'.join(results)))
    return 1 if failed else 0


# --- the second half: a Writer window, real keys ---------------------------------------------

def xdotool(*args, pause=KEY_PAUSE_S):
    subprocess.run(['xdotool', *args], env={**os.environ, 'DISPLAY': DISPLAY},
                   capture_output=True, timeout=30)
    time.sleep(pause)


def keys(*names):
    for name in names:
        xdotool('key', name)


def queue_of(document_id, count, timeout=15):
    """The windows the agent queued for this document, once there are `count` of them."""
    state = wait_for_state(lambda st: len([item for item in st.get('queue', [])
                                           if item.get('documentId') == document_id]) >= count,
                           timeout)
    return [item for item in (state or {}).get('queue', []) if item.get('documentId') == document_id]


def typing(uno, bound_file):
    """What only a keyboard shows: where the caret is when a key reaches the sensor, the end of
    the text, a copy pasted back, and Save As — measured by the installed agent and read back
    from the queue it keeps in the profile.

    The agent is told it is paired, with an engine that answers nothing: it measures, and every
    window stays in its queue. The file the first half saved is bound to an engine document, as
    if one had been created for it.
    """
    import unohelper
    from com.sun.star.awt import XKeyHandler
    from com.sun.star.beans import PropertyValue
    from com.sun.star.document import XDocumentEventListener

    state_path = os.path.join(PROFILE_DIR, 'user', 'certimens.json')
    bound_url = uno.systemPathToFileUrl(bound_file)
    with open(state_path, 'w', encoding='utf-8') as handle:
        json.dump({'config': {'token': 'host-test', 'tokenId': 'host-test', 'email': 'etudiant@example.org',
                              'engineUrl': UNREACHABLE_ENGINE},
                   'engineIds': {DOCUMENT_ID: ENGINE_DOCUMENT},
                   'engineSources': {DOCUMENT_ID: bound_url}}, handle)

    xvfb = subprocess.Popen(['Xvfb', DISPLAY, '-screen', '0', '1280x1024x24', '-nolisten', 'tcp'],
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    time.sleep(1)
    soffice = start_office({**os.environ, 'DISPLAY': DISPLAY}, headless=False)
    context = None
    try:
        context = connect(uno.getComponentContext())
        context.ServiceManager.createInstanceWithContext(SERVICE, context).execute(())
        desktop = context.ServiceManager.createInstanceWithContext('com.sun.star.frame.Desktop', context)

        def hidden():
            prop = PropertyValue()
            prop.Name, prop.Value = 'Hidden', True
            return (prop,)

        def load(path, visible=True):
            return desktop.loadComponentFromURL(uno.systemPathToFileUrl(path), '_blank', 0,
                                                () if visible else hidden())

        written = os.path.join(PROFILE_DIR, 'fin.odt')
        draft = desktop.loadComponentFromURL('private:factory/swriter', '_blank', 0, hidden())
        text = draft.getText()
        text.setString('Premier paragraphe du texte.')
        text.insertControlCharacter(text.getEnd(), uno.getConstantByName(
            'com.sun.star.text.ControlCharacter.PARAGRAPH_BREAK'), False)
        text.insertString(text.getEnd(), 'Second paragraphe du texte.', False)
        draft.storeToURL(uno.systemPathToFileUrl(written), ())
        draft.close(True)

        doc = load(written)
        controller = doc.getCurrentController()
        body = doc.getText()
        caret = controller.getViewCursor()
        controller.getFrame().getContainerWindow().setFocus()
        time.sleep(1.5)
        caret.gotoStart(False)

        def at_end():
            return body.compareRegionEnds(caret, body.getEnd()) == 0

        # Why the sensor settles a move at the next event, in Writer's own words: a key handler
        # placed beside the agent's reads the caret as the key arrives.
        seen = []

        class Reader(unohelper.Base, XKeyHandler):
            def keyPressed(self, event):
                seen.append(at_end())
                return False

            def keyReleased(self, event):
                return False

            def disposing(self, source):
                pass

        reader = Reader()
        controller.addKeyHandler(reader)
        keys('ctrl+End')
        controller.removeKeyHandler(reader)

        def before_the_caret_moves():
            _assert(seen == [False], 'caret read in keyPressed of Ctrl+End: at the end %r' % (seen,))
            _assert(at_end(), 'Ctrl+End did not take the caret to the end')
        check('Writer hands a key to its handlers before the caret moves', before_the_caret_moves)

        # Ctrl+End (already pressed): to the end, no jump; Ctrl+Home then Ctrl+End: a trip up,
        # over once back at the end; Up then End: the end of the first paragraph, not of the
        # text — two jumps, and what is typed there is a reformulation.
        keys('x', 'ctrl+Home', 'ctrl+End', 'y', 'Up', 'End', 'z')
        time.sleep(SEAL_WAIT_S)
        identity = doc.getDocumentProperties().getUserDefinedProperties().getPropertyValue(DOCUMENT_ID_PROPERTY)
        windows = [item['window'] for item in queue_of(identity, 1)]

        def end_of_text():
            _assert(len(windows) == 1, 'windows queued: %d' % len(windows))
            window = windows[0]
            kinds = [(run[0], run[1]) for run in window['runs']]
            _assert(kinds == [('nav', 1), ('type', 1), ('nav', 2), ('type', 1), ('nav', 2), ('type', 1)],
                    'runs %r' % window['runs'])
            # Before the rule: 5 jumps and 3 reformulations.
            _assert(window['counts']['jumps'] == 3 and window['counts']['reformulations'] == 1,
                    'counts %r' % window['counts'])
        check('a key that leaves the caret at the end of the text is no jump, and stays a keystroke',
              end_of_text)

        # A click on the page below a short text puts the caret at its end: in the middle of the
        # document view, three fifths of the way down.
        caret.gotoStart(False)
        frame = controller.getFrame()
        outer, inner = frame.getContainerWindow().getPosSize(), frame.getComponentWindow().getPosSize()
        x, y = outer.X + inner.X + inner.Width // 2, outer.Y + inner.Y + inner.Height * 3 // 5
        xdotool('mousemove', str(x), str(y), pause=0.2)
        xdotool('click', '1', pause=0.8)
        landed = at_end()

        def where():
            before = body.createTextCursorByRange(caret.getStart())
            before.gotoStart(True)
            return 'clicked at %d,%d; caret after %d characters, collapsed %s' % (
                x, y, len(before.getString()), caret.isCollapsed())
        landing = where()
        keys('w')
        time.sleep(SEAL_WAIT_S)
        windows = [item['window'] for item in queue_of(identity, 2)]

        def clicked_to_the_end():
            _assert(landed, 'the click did not put the caret at the end (%s): the check says nothing' % landing)
            _assert(len(windows) == 2, 'windows queued: %d' % len(windows))
            window = windows[1]
            _assert('click' in [run[0] for run in window['runs']], 'runs %r' % window['runs'])
            _assert(window['counts']['jumps'] == 0 and window['counts']['reformulations'] == 0,
                    'counts %r' % window['counts'])
        check('a click that leaves the caret at the end of the text is no jump', clicked_to_the_end)

        # Ctrl+A, Ctrl+C, then pasted back at the end: hashed off the UI thread, recognised.
        keys('ctrl+a', 'ctrl+c', 'ctrl+End', 'ctrl+v')
        time.sleep(SEAL_WAIT_S)
        windows = [item['window'] for item in queue_of(identity, 3)]

        def pasted_back():
            _assert(len(windows) == 3, 'windows queued: %d' % len(windows))
            kinds = [run[0] for run in windows[2]['runs']]
            _assert('copy' in kinds and 'self' in kinds and 'paste' not in kinds, 'runs %r' % windows[2]['runs'])
        check('a copy pasted back is the student\'s own text, hashed off the UI thread', pasted_back)

        # Save As: the document goes on in the new file, and so do the windows waiting for it.
        moved = os.path.join(PROFILE_DIR, 'fin-v2.odt')
        events = []

        class Events(unohelper.Base, XDocumentEventListener):
            def documentEventOccured(self, event):
                events.append(event.EventName)

            def disposing(self, source):
                pass

        doc.addDocumentEventListener(Events())
        doc.storeAsURL(uno.systemPathToFileUrl(moved), ())
        moved_url = uno.systemPathToFileUrl(moved)

        def waiting_windows_follow():
            _assert('OnSaveAs' in events and 'OnSaveAsDone' in events, 'events %r' % events)
            state = wait_for_state(lambda st: all(item.get('documentSource') == moved_url
                                                  for item in st['queue'] if item['documentId'] == identity)
                                   and st['titles'].get(identity) == 'fin-v2')
            sources = {item['documentSource'] for item in state['queue'] if item['documentId'] == identity}
            _assert(sources == {moved_url}, 'files named by the waiting windows: %r' % sources)
            _assert(state['titles'].get(identity) == 'fin-v2', 'title %r' % state['titles'].get(identity))
        check('Save As: Writer raises OnSaveAsDone, and the waiting windows follow the new file',
              waiting_windows_follow)
        doc.close(True)

        # What `caret_at_end` answers in a real Writer, on what a dissertation holds: blank
        # paragraphs at the end, a table, a footnote, a frame. The sensor's own function, called
        # over the bridge: UNO answers it the same way it answers the agent inside the office.
        sys.path.insert(0, '/agent/src/pythonpath')
        from certimens_agent.sensor import caret_at_end
        layout = desktop.loadComponentFromURL('private:factory/swriter', '_blank', 0, ())
        page = layout.getText()
        page.setString('Introduction.')

        def paragraph(content):
            page.insertControlCharacter(page.getEnd(), uno.getConstantByName(
                'com.sun.star.text.ControlCharacter.PARAGRAPH_BREAK'), False)
            page.insertString(page.getEnd(), content, False)
        paragraph('Avant le tableau.')
        table = layout.createInstance('com.sun.star.text.TextTable')
        table.initialize(2, 2)
        page.insertTextContent(page.getEnd(), table, False)
        table.getCellByName('A1').setString('cellule')
        paragraph('Après le tableau.')
        note = layout.createInstance('com.sun.star.text.Footnote')
        page.insertTextContent(page.getEnd(), note, False)
        note.setString('Une note.')
        frame_content = layout.createInstance('com.sun.star.text.TextFrame')
        page.insertTextContent(page.getEnd(), frame_content, False)
        frame_content.getText().setString('Un cadre.')
        paragraph('Fin du texte.   ')
        paragraph('')
        paragraph('  ')
        view = layout.getCurrentController()
        cursor = view.getViewCursor()
        paragraphs = []
        enumeration = page.createEnumeration()
        while enumeration.hasMoreElements():
            paragraphs.append(enumeration.nextElement())
        def paragraph_starting(words):
            return next(p for p in paragraphs if p.supportsService('com.sun.star.text.Paragraph')
                        and p.getString().startswith(words))
        last_words = paragraph_starting('Fin du texte')
        before_table = paragraph_starting('Avant le tableau')

        def answer(place, select=False):
            place()
            if select:
                cursor.goLeft(1, True)
            return caret_at_end(layout, view)

        def end_as_writer_says():
            cases = {
                'the very end': (lambda: cursor.gotoEnd(False), True),
                'in the blank paragraphs that end it': (lambda: (cursor.gotoEnd(False), cursor.goUp(1, False)), True),
                'after the last words, blanks only after': (lambda: cursor.gotoRange(last_words.getEnd(), False), True),
                'before the last words': (lambda: cursor.gotoRange(last_words.getStart(), False), False),
                'the start': (lambda: cursor.gotoStart(False), False),
                'before a table, then text': (lambda: cursor.gotoRange(before_table.getEnd(), False), False),
                'in a table cell': (lambda: cursor.gotoRange(table.getCellByName('B2').getText().getStart(), False),
                                    False),
                'in a footnote': (lambda: cursor.gotoRange(note.getText().getEnd(), False), False),
                'in a frame': (lambda: cursor.gotoRange(frame_content.getText().getEnd(), False), False),
            }
            wrong = ['%s: %s' % (name, not expected) for name, (place, expected) in cases.items()
                     if answer(place) is not expected]
            if answer(lambda: cursor.gotoEnd(False), select=True):
                wrong.append('a selection ending at the end: True')
            _assert(not wrong, 'caret_at_end said ' + '; '.join(wrong))
        check('the end of the text as the sensor reads it: blanks after it, never a table, a note or a frame',
              end_as_writer_says)
        layout.close(True)

        # The same with an engine document already bound to the file, then both files opened
        # again: the new one is the document, the one left behind a version of its own.
        version = os.path.join(PROFILE_DIR, 'memoire-v2.odt')
        version_url = uno.systemPathToFileUrl(version)

        def identity_of(document, wanted=None):
            props = document.getDocumentProperties().getUserDefinedProperties()
            deadline = time.monotonic() + 10
            value = props.getPropertyValue(DOCUMENT_ID_PROPERTY)
            while wanted is not None and value == wanted and time.monotonic() < deadline:
                time.sleep(0.2)     # the agent attaches to the view a moment after it opens
                value = props.getPropertyValue(DOCUMENT_ID_PROPERTY)
            return value

        def record_follows():
            original = load(bound_file, visible=False)
            time.sleep(1.5)
            original.storeAsURL(version_url, ())
            original.close(True)
            state = wait_for_state(lambda st: st['engineSources'].get(DOCUMENT_ID) == version_url)
            _assert(state['engineSources'].get(DOCUMENT_ID) == version_url,
                    'record bound to %r' % state['engineSources'].get(DOCUMENT_ID))
            again = load(version, visible=False)
            time.sleep(2)
            kept = identity_of(again)
            again.close(True)
            _assert(kept == DOCUMENT_ID, 'the saved-as file was given another identity: %r' % kept)
            behind = load(bound_file, visible=False)
            other = identity_of(behind, wanted=DOCUMENT_ID)
            behind.close(True)
            _assert(other != DOCUMENT_ID, 'the file left behind kept the identity of the record')
        check('Save As of a linked file: the record follows it, the file left behind is a version',
              record_follows)
    except Exception as err:  # a failure outside a check is still a failure of the suite
        results.append('  ✖ typing in a Writer window\n      %s: %s' % (type(err).__name__, err))
    finally:
        stop_office(context, soffice)
        xvfb.kill()


def _assert(condition, message):
    if not condition:
        raise AssertionError(message)


if __name__ == '__main__':
    sys.exit(main())
