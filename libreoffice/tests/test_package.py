"""The XML of the package, parsed — the one class of mistake only a real office suite caught.

An `.oxt` is read by LibreOffice's own deployment code, which is stricter than it looks. A
comment holding a double hyphen is **forbidden by XML itself**, and `unopkg add` refuses the
whole package over it: the extension does not install at all, and nothing says why until
somebody runs a real office suite.

Nothing else here would have seen it. `build.py` substitutes a version into `description.xml`
with a string replacement and never parses it, ruff reads Python and not XML, and the four-agent
check compares values rather than syntax. It took the container job to find a comment — and that
job is minutes of CI behind every unit test of this agent.

So: every XML file the package ships is parsed here, in milliseconds, with the standard library.

The `# noqa: S318` below answer ruff, which wants `defusedxml` for anything parsing XML. The
rule guards against hostile input — entity expansion, external entities — and what is parsed
here is **this repository's own files**, written by us and by `build.py`. `defusedxml` is a
third-party package, and this agent ships the standard library and nothing else: taking a
dependency to parse four files we wrote ourselves would be the real mistake.
"""

import os
import shutil
import sys
import tempfile
import unittest
import xml.dom.minidom
from xml.parsers.expat import ExpatError

HERE = os.path.dirname(os.path.abspath(__file__))
AGENT = os.path.join(HERE, '..')
SOURCE = os.path.join(AGENT, 'src')

# build.py sits at the agent's root, beside src/: it is the tool, not the package.
sys.path.insert(0, AGENT)

import build  # noqa: E402


def xml_files():
    """Every XML file of the package, by path relative to src/."""
    found = []
    for directory, _, names in os.walk(SOURCE):
        for name in sorted(names):
            if name.endswith(('.xml', '.xcu')):
                path = os.path.join(directory, name)
                found.append((os.path.relpath(path, SOURCE), path))
    return sorted(found)


class PackageXmlTest(unittest.TestCase):
    def test_every_shipped_xml_file_parses(self):
        files = xml_files()
        # A guard on the guard: a walk that found nothing would pass silently for ever.
        self.assertGreaterEqual(len(files), 4, 'src/ should hold description.xml, the two .xcu and the manifest')
        for relative, path in files:
            with self.subTest(file=relative):
                try:
                    xml.dom.minidom.parse(path)  # noqa: S318 — our own package file
                except ExpatError as error:
                    self.fail(f'src/{relative} is not well-formed XML: {error}\n'
                              f'A comment holding a double hyphen is the usual cause, and '
                              f'LibreOffice refuses the whole package over it.')

    def test_the_built_description_still_parses(self):
        """The version is substituted by a string replacement, not by an XML writer."""
        with open(os.path.join(SOURCE, 'description.xml'), encoding='utf-8') as f:
            built = f.read().replace('{{VERSION}}', '1.4.2-a9085f3')
        xml.dom.minidom.parseString(built)  # noqa: S318 — our own package file


class UpdateFeedTest(unittest.TestCase):
    """The feed LibreOffice reads to learn that a newer version exists.

    It is generated, so nobody reads it before it is served; and it is served to every installed
    extension. A feed that does not parse, or that names another extension, is a silence —
    LibreOffice simply never offers the update.
    """

    def setUp(self):
        self.dir = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.dir, ignore_errors=True)
        original = build.DIST
        build.DIST = __import__('pathlib').Path(self.dir)
        self.addCleanup(setattr, build, 'DIST', original)

    def feed(self, version='1.4.2'):
        build.write_feed(version)
        return xml.dom.minidom.parse(os.path.join(self.dir, 'update.xml'))  # noqa: S318 — written just above

    def test_the_feed_is_well_formed(self):
        self.feed()

    def test_it_names_the_extension_the_package_names(self):
        """An identifier that differs is a feed LibreOffice reads and then ignores."""
        identifier, _ = build.description_parts()
        found = self.feed().getElementsByTagName('identifier')[0].getAttribute('value')
        self.assertEqual(found, identifier)

    def test_it_announces_the_version_it_was_given(self):
        found = self.feed('1.5.0').getElementsByTagName('version')[0].getAttribute('value')
        self.assertEqual(found, '1.5.0')

    def test_it_points_at_the_oxt_of_that_release(self):
        """The download address is built from the tag: a wrong one is a 404 for every student."""
        source = self.feed('1.5.0').getElementsByTagName('update-download')[0]
        href = source.getElementsByTagName('src')[0].getAttribute('xlink:href')
        self.assertTrue(href.startswith('https://'), href)
        self.assertIn('libreoffice-v1.5.0/', href)
        self.assertTrue(href.endswith('certimens-libreoffice-1.5.0.oxt'), href)

    def test_it_carries_the_dependencies_of_the_package(self):
        """A version that raised the minimum LibreOffice must not be offered to an older one."""
        minimum = self.feed().getElementsByTagName('l:LibreOffice-minimal-version')
        self.assertTrue(minimum, 'the feed dropped the dependencies of description.xml')
