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
DOCUMENT_ID_PROPERTY = 'CertimensDocumentId'
DOCUMENT_ID = 'host-suite-0001'


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

    soffice = subprocess.Popen(
        ['soffice', '--headless', '--norestore', '--nologo', '--nodefault',
         '--accept=socket,host=127.0.0.1,port=%d;urp;' % PORT,
         '-env:UserInstallation=%s' % PROFILE],
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
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

    removed = office('unopkg', 'remove', IDENTIFIER)
    check('and it uninstalls cleanly',
          lambda: _assert(removed.returncode == 0,
                          'unopkg remove failed:\n%s%s' % (removed.stdout, removed.stderr)))

    failed = [line for line in results if line.startswith('  ✖')]
    version = office('soffice', '--version').stdout.strip().splitlines()[:1]
    print('\nCertimens in %s:\n%s\n' % (version[0] if version else 'LibreOffice', '\n'.join(results)))
    return 1 if failed else 0


def _assert(condition, message):
    if not condition:
        raise AssertionError(message)


if __name__ == '__main__':
    sys.exit(main())
