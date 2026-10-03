#!/usr/bin/env python3
"""Builds the documentation site published at https://certimens.github.io/plugins/.

**What it is for.** The four agents are installed by students and by the people who equip them,
and nothing in this repository told either of them how. Each agent's page under `docs/` is
written for whoever works on the code; this site is written for whoever installs it — the
ordinary path through a store, and the manual one underneath, folded away.

**Where it sits.** The repository publishes one GitHub Pages site and three things live on it:
this documentation at the root, the Word add-in at `/word/`, and the LibreOffice update feed at
`/libreoffice/update.xml`. A deployment replaces the site whole, so `.github/workflows/pages.yml`
is the only thing that deploys, and it carries all three every time (docs/publication.md).

**Two languages, the repository's rule.** Every page exists in French and in English, and the
build **fails** when one of them is missing a page or a block: a page added in one language only
is exactly how the two start to diverge, and nothing else would notice (docs/langues.md).

**The style is the website's, linked live.** The Certimens website is served at `/` and this
documentation at `/plugins/`, on the same host: its stylesheet, its word mark and its pages are
all one root-absolute link away. Nothing is copied and nothing is redistributed — which is what
keeps an all-rights-reserved sheet out of an AGPL repository — and the day the website changes,
these pages change with it. `scripts/site.css` holds what that costs, at length.

**Nothing comes from a third origin.** No CDN, no remote font, no analytics, and no script of
ours: this site shares its origin with the Word task pane, which keeps the student's API token
in that origin's `localStorage` — an origin indexed by host, never by path. The page's one
script is the website's own, from that same host, and it is what opens the folded menu.

**The illustrations are not screenshots.** They are the agents' own markup, styled by the very
stylesheet the agents ship (`browser/src/ui.css`), with their text read out of the agents' own
dictionary (`browser/src/i18n.js`). They cannot show a window the agents do not have, they
follow the theme, and a renamed key fails this build instead of leaving a lie on a page. Screens
belonging to the stores — Chrome's, Microsoft's, LibreOffice's, VS Code's — are described in
words and never drawn: a convincing imitation of somebody else's interface is a lie whatever it
is captioned, and those interfaces are redesigned without warning anyway.

    python3 scripts/build-site.py [--out dist/site]     # or: make site
"""

import argparse
import html
import re
import shutil
import sys
from html.parser import HTMLParser
from pathlib import Path

import site_content

ROOT = Path(__file__).resolve().parent.parent
HERE = Path(__file__).resolve().parent
UI = ROOT / 'browser' / 'src'

LANGUAGES = ('fr', 'en')

# Where a language's pages live. French is the default language of the product, so it holds the
# root — the address somebody is given is `…/plugins/`, not `…/plugins/fr/`.
HOME_PATH = {'fr': '', 'en': 'en/'}

def page_path(language, slug):
    """Where a page sits under the site root, trailing slash included.

    An agent's page sits at that agent's own address — `/plugins/word/`, `/plugins/libreoffice/`
    — **which the agent's own files also use**: the add-in is served from `/word/`, and the
    update feed is `/libreoffice/update.xml`. They share the directory, and only one name is
    disputed: `index.html`. The documentation wins it, which is the point — the add-in shipped
    one for the single reason that GitHub Pages serves no directory listing, and a bilingual
    page explaining how to install the thing does that job better.

    What makes this safe is the order the site is assembled in (.github/workflows/pages.yml):
    the agents' files first, the documentation over them.
    """
    return HOME_PATH[language] + (slug + '/' if slug else '')


# --- 1. THE AGENTS' OWN WORDS -------------------------------------------------------------

MESSAGE_LINE = re.compile(r"^\s*'([^']+)':\s*(['\"])(.*)\2,\s*$")


def ui_strings():
    """The interface dictionary of the agents, read from the file they ship.

    The illustrations below show the pairing window, and the words in it are the words the
    student will read in their own agent. Copying them here would make this site the fifth place
    a sentence lives, and the first to go stale.
    """
    source = (UI / 'i18n.js').read_text(encoding='utf-8')
    found = {}
    for language in LANGUAGES:
        start = source.index(f'\n    {language}: {{')
        end = source.index('\n    },', start)
        found[language] = {}
        for line in source[start:end].splitlines():
            match = MESSAGE_LINE.match(line)
            if match:
                found[language][match.group(1)] = match.group(3)
    return found


def message(strings, language, key):
    try:
        return strings[language][key]
    except KeyError:
        sys.exit(f'browser/src/i18n.js: no key {key!r} in {language} — '
                 f'an illustration of this site names it.')


# --- 2. ILLUSTRATIONS ---------------------------------------------------------------------
#
# The agents' markup, in a frame that says it is a picture. Nothing here is interactive, and
# `figure.window` in site.css makes sure of it.

def pairing_window(strings, language, caption, depth):
    """The window every agent shows while waiting for the student to confirm the code.

    It is the same in the four agents, which is the point: whatever they installed, this is what
    they will see, and there is no password field in it anywhere.
    """
    return f"""<figure class="window">
  <div class="frame">
    <div class="stack">
      <div class="brand"><img class="mark" src="{depth}assets/icon128.png" alt=""><h1>Certi<span class="mens">mens</span></h1></div>
      <div class="card stack">
        <p class="muted small">{html.escape(message(strings, language, 'pair.intro'))}</p>
        <p class="code">CDFH-JKMN</p>
        <p class="btn block">{html.escape(message(strings, language, 'pair.open'))}</p>
        <p class="muted small">{html.escape(message(strings, language, 'pair.waiting'))}</p>
      </div>
    </div>
  </div>
  <figcaption>{html.escape(caption)}</figcaption>
</figure>"""


def advanced_window(strings, language, caption, depth):
    """The engine address, folded away where the student never has to look for it."""
    return f"""<figure class="window">
  <div class="frame">
    <details class="advanced" open>
      <summary>{html.escape(message(strings, language, 'login.advanced'))}</summary>
      <div class="field">
        <label>{html.escape(message(strings, language, 'login.engineUrl'))}</label>
        <input type="url" value="https://monespace.certimens.fr" readonly tabindex="-1">
        <p class="muted small">{html.escape(message(strings, language, 'login.engineUrlHelp'))}</p>
      </div>
    </details>
  </div>
  <figcaption>{html.escape(caption)}</figcaption>
</figure>"""


FIGURES = {'pairing': pairing_window, 'advanced': advanced_window}


# --- 3. BLOCKS ----------------------------------------------------------------------------
#
# A page is a list of blocks, and the vocabulary is deliberately short: what cannot be said with
# these cannot be said on this site, which is what keeps eight pages looking like one.

def render(block, strings, language, depth):
    kind = block[0]
    if kind == 'h2':
        return f'<h2>{block[1]}</h2>'
    if kind == 'h3':
        return f'<h3>{block[1]}</h3>'
    if kind == 'p':
        return f'<p>{block[1]}</p>'
    if kind == 'steps':
        items = ''.join(f'\n  <li>{step}</li>' for step in block[1])
        return f'<ol class="steps">{items}\n</ol>'
    if kind == 'note':
        # No `small`: that class is ui.css's 12 px, which is a panel's size. These notes carry
        # the sentence about never being asked for a password, among others.
        return f'<p class="alert {block[1]}">{block[2]}</p>'
    if kind == 'figure':
        return FIGURES[block[1]](strings, language, block[2], depth)
    if kind == 'advanced':
        inner = '\n'.join(render(child, strings, language, depth) for child in block[2])
        return f'<details class="advanced">\n<summary>{block[1]}</summary>\n<div class="stack">\n{inner}\n</div>\n</details>'
    if kind == 'agents':
        cards = ''.join(
            f'\n  <a class="card" href="{(depth or "./") + page_path(language, slug)}">'
            f'<span class="card__icon">{site_content.AGENT_ICONS[slug]}</span>'
            f'<strong>{title}</strong><span>{summary}</span></a>'
            for slug, title, summary in block[1])
        return f'<div class="agents">{cards}\n</div>'
    raise SystemExit(f'build-site: unknown block {kind!r}')


# --- 4. THE PAGE ---------------------------------------------------------------------------

SHELL = """<!DOCTYPE html>
<!-- Built by scripts/build-site.py — do not edit: it is rewritten at every deployment. -->
<!-- data-theme="light": ui.css carries a dark scheme and follows the system by default, and
     `data-theme` is the escape hatch it documents for a host that knows better. The Certimens
     website has one scheme, and this site is served beside it, on the same host. -->
<html lang="{language}" data-theme="light">
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>{page_title}</title>
    <meta name="description" content="{description}">
    <link rel="icon" href="{depth}assets/icon32.png">
    <!-- Three sheets, and **the order is the design** (scripts/site.css says why at length):
         the agents' stylesheet, then the website's own — same origin, so it is linked and never
         copied — then ours, which has the last word. -->
    <link rel="stylesheet" href="{depth}assets/ui.css">
    <link rel="stylesheet" href="/assets/css/style.css">
    <link rel="stylesheet" href="{depth}assets/site.css">
{alternates}
</head>
<body>
    <a class="skip-link" href="#content">{skip}</a>
    <header class="site-header">
        <div class="container site-header__inner">
            <a class="site-logo" href="{site_home}" aria-label="Certimens">
                <img src="/assets/img/logo.png" alt="Certimens" width="300" height="300">
            </a>
            <button class="nav-toggle" type="button" aria-label="{menu_label}" aria-expanded="false" aria-controls="site-nav">
                <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true">
                    <line x1="3" y1="6" x2="21" y2="6"/>
                    <line x1="3" y1="12" x2="21" y2="12"/>
                    <line x1="3" y1="18" x2="21" y2="18"/>
                </svg>
            </button>
            <nav class="site-nav" id="site-nav" aria-label="{nav_label}">
                <ul>{nav_items}
                    <li class="nav-lang"><a href="{other_href}" lang="{other}" hreflang="{other}" aria-label="{other_aria}">{other_label}</a></li>
                    <li class="nav-login"><a href="https://monespace.certimens.fr/">{login}</a></li>
                </ul>
            </nav>
        </div>
    </header>
    <main id="content">
        <section class="page-hero">
            <div class="container">
                <h1>{title}</h1>
                <p>{description_text}</p>
            </div>
        </section>
        <section class="section">
            <div class="container container--narrow doc stack">
{body}
            </div>
        </section>
    </main>
    <footer class="site-footer">
        <div class="container">
            <div class="site-footer__grid">
                <div>
                    <img src="/assets/img/logo-footer.png" alt="Certimens" width="500" height="143">
                    <p>{tagline}</p>
                </div>
                <div>
                    <h2>{plugins}</h2>
                    <ul>{footer_agents}</ul>
                </div>
                <div>
                    <h2>Certimens</h2>
                    <ul>{footer_about}</ul>
                </div>
            </div>
            <div class="site-footer__bottom">{bottom}</div>
        </div>
    </footer>
    <!-- The website's own script, on the website's own host: it is what opens the menu that the
         burger above folds away. Both of the things it does guard on an element being there, and
         the contact form it also handles does not exist here. -->
    <script src="/assets/js/site.js" defer></script>
</body>
</html>
"""


def page_html(page, slug, language, strings, pages):
    here = page_path(language, slug)
    depth = '../' * len([part for part in here.split('/') if part])
    root = depth or './'
    other = next(code for code in LANGUAGES if code != language)
    alternates = '\n'.join(
        f'    <link rel="alternate" hreflang="{code}" href="/plugins/{page_path(code, slug)}">'
        for code in LANGUAGES)
    body = '\n'.join(render(block, strings, language, depth) for block in page['blocks'])

    # The website's menu, with ours in it. `None` is this documentation's home, which is the
    # only item of the six that is not an address on the website.
    nav_items = ''.join(
        f'\n                    <li><a href="{href or (root + HOME_PATH[language])}">{html.escape(label)}</a></li>'
        for label, href in pages['nav_items'])

    # The agents in the footer, and the website's own pages beside them: same host, so these are
    # ordinary links to pages that are really there.
    footer_agents = ''.join(
        f'<li><a href="{root + page_path(language, agent)}">{html.escape(title)}</a></li>'
        for agent, title, _ in pages['agents'])
    footer_about = ''.join(
        f'<li><a href="{href}">{html.escape(label)}</a></li>' for label, href in pages['about'])

    # The brand is in the home page's own title already: "Installer Certimens — Certimens" is
    # what a template writes and nobody says.
    title = page['title']
    return SHELL.format(
        language=language,
        page_title=html.escape(title if 'Certimens' in title else f'{title} — Certimens'),
        title=html.escape(title),
        description=html.escape(page['description']),
        # In a paragraph, not in an attribute: escaping the apostrophes would print them.
        description_text=html.escape(page['description'], quote=False),
        depth=depth or './',
        site_home=pages['site_home'],
        home=root + HOME_PATH[language],
        other=other,
        other_href=root + page_path(other, slug),
        other_label=pages['lang_switch'][0],
        other_aria=html.escape(pages['lang_switch'][1]),
        nav_items=nav_items,
        nav_label=html.escape(pages['nav']),
        menu_label=html.escape(pages['menu']),
        login=html.escape(pages['login']),
        alternates=alternates,
        skip=html.escape(pages['skip']),
        plugins=html.escape(pages['plugins']),
        tagline=html.escape(pages['tagline']),
        footer_agents=footer_agents,
        footer_about=footer_about,
        body=body,
        bottom=html.escape(pages['bottom']),
    )


# --- 5. BUILD -------------------------------------------------------------------------------

# What the pages are made of, taken from the agents rather than copied: one stylesheet, one set
# of fonts, one mark.
ASSETS = ('ui.css', 'icons/icon32.png', 'icons/icon128.png')


def copy_assets(out):
    assets = out / 'assets'
    assets.mkdir(parents=True, exist_ok=True)
    for name in ASSETS:
        shutil.copy(UI / name, assets / Path(name).name)
    shutil.copy(HERE / 'site.css', assets / 'site.css')
    # ui.css asks for the fonts beside itself, and no font is fetched from anywhere else.
    fonts = assets / 'fonts'
    fonts.mkdir(exist_ok=True)
    for font in sorted((UI / 'fonts').iterdir()):
        if font.is_file():
            shutil.copy(font, fonts / font.name)


def shape_of(blocks):
    """What a page is made of, down to the number of steps: two languages must say the same
    thing, and a step written in one of them alone is what this catches."""
    shape = []
    for block in blocks:
        if block[0] == 'advanced':
            shape.append('advanced(' + ' '.join(shape_of(block[2])) + ')')
        elif block[0] in ('steps', 'agents'):
            shape.append(f'{block[0]}[{len(block[1])}]')
        else:
            shape.append(block[0])
    return shape


VOID = {'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source',
        'track', 'wbr'}


class TagBalance(HTMLParser):
    """Every element opened in a page is closed, in order.

    The prose of this site carries inline markup — <strong>, <em>, <code>, <a> — written by
    hand. A tag left open there swallows the rest of the page, and nothing else here would
    notice: there is no linter at the root, and the agents' own html-validate belongs to them.
    """

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.stack = []
        self.problems = []

    def handle_starttag(self, tag, attrs):
        if tag not in VOID:
            self.stack.append(tag)

    def handle_endtag(self, tag):
        if tag in VOID:
            return
        if not self.stack:
            self.problems.append(f'</{tag}> closes nothing')
        elif self.stack[-1] != tag:
            self.problems.append(f'</{tag}> closes a <{self.stack[-1]}>')
            self.stack.pop()
        else:
            self.stack.pop()


def check_markup(name, markup):
    parser = TagBalance()
    parser.feed(markup)
    problems = [f'{name}: {problem}' for problem in parser.problems]
    if parser.stack:
        problems.append(f'{name}: <{parser.stack[-1]}> is never closed')
    return problems


def check_parity(content):
    """The two languages describe the same site, page for page and block for block.

    A page written in one language only, or a step added to one and not the other, is how the
    two start to drift — and the drift is invisible to everyone who reads a single language.
    """
    problems = []
    slugs = {language: set(content[language]['pages']) for language in LANGUAGES}
    for language in LANGUAGES:
        for other in LANGUAGES:
            for missing in sorted(slugs[other] - slugs[language]):
                problems.append(f'page {missing!r} exists in {other} and not in {language}')
    for slug in sorted(set.intersection(*slugs.values())):
        shapes = {language: shape_of(content[language]['pages'][slug]['blocks'])
                  for language in LANGUAGES}
        if len({tuple(shape) for shape in shapes.values()}) > 1:
            detail = '; '.join(f'{language}: {len(shape)} blocks' for language, shape in shapes.items())
            problems.append(f'page {slug!r}: the two languages are not built the same way ({detail})')
    return problems


def main():
    parser = argparse.ArgumentParser(description='Builds the documentation site.')
    parser.add_argument('--out', default=str(ROOT / 'dist' / 'site'),
                        help='where to write the site (default: dist/site)')
    out = Path(parser.parse_args().out)

    content = site_content.CONTENT
    problems = check_parity(content)
    if problems:
        print('Documentation site: the two languages diverge.\n', file=sys.stderr)
        for problem in problems:
            print(f'  - {problem}', file=sys.stderr)
        return 1

    strings = ui_strings()
    shutil.rmtree(out, ignore_errors=True)
    out.mkdir(parents=True)
    copy_assets(out)

    written = 0
    for language in LANGUAGES:
        for slug, page in content[language]['pages'].items():
            directory = out / page_path(language, slug)
            directory.mkdir(parents=True, exist_ok=True)
            markup = page_html(page, slug, language, strings, content[language])
            broken = check_markup(page_path(language, slug) or 'index', markup)
            if broken:
                print('Documentation site: broken markup.\n', file=sys.stderr)
                for problem in broken:
                    print(f'  - {problem}', file=sys.stderr)
                return 1
            (directory / 'index.html').write_text(markup, encoding='utf-8')
            written += 1

    print(f'{out}: {written} pages in {len(LANGUAGES)} languages.')
    return 0


if __name__ == '__main__':
    sys.exit(main())
