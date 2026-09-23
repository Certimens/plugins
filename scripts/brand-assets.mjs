// Regenerates the icons and the store images from the brand mark (store/brand-mark.png, the gold
// shield of certimens.fr, same file as the engine's ui/public/logo.png).
//
// Everything here follows the brand guidelines the engine documents (docs/charte-graphique.md):
// slate #1E293B as the dominant color, brass gold #C5A059 as the single accent, Plus Jakarta Sans
// with headings at 800, flat surfaces on a #E5E5E5 hairline.
//
// It is run by hand, when the mark or the interface changes, and not by the build: it needs sharp
// (~40 MB of binaries) and, for the text of the store images, Plus Jakarta Sans installed for the
// renderer — the repository only ships the woff2 files, which fontconfig doesn't read.
//
//   npx --yes --package sharp -- node scripts/brand-assets.mjs

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const mark = join(root, 'store', 'brand-mark.png');

const SLATE = '#1e293b', SLATE_DARK = '#0f172a', GOLD = '#c5a059', GOLD_TEXT = '#705e3a';
const BG = '#f8fafc', PAPER = '#ffffff', TEXT = '#1a202c', MUTED = '#54595f', LINE = '#e5e5e5';
const F = 'Plus Jakarta Sans';

const transparent = { r: 0, g: 0, b: 0, alpha: 0 };
const shield = (size) => sharp(mark).resize(size, size, { fit: 'contain', background: transparent }).png({ compressionLevel: 9, effort: 10 });
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
const text = (x, y, s, { size = 14, weight = 500, fill = TEXT, anchor = 'start', ls = 0 } = {}) =>
    `<text x="${x}" y="${y}" font-family="${F}" font-size="${size}" font-weight="${weight}" fill="${fill}" text-anchor="${anchor}" letter-spacing="${ls}">${esc(s)}</text>`;
// The word mark: "Certi" then "mens" in gold, in a single run so the two halves stay kerned.
const wordmark = (x, y, size, fill) =>
    `<text x="${x}" y="${y}" font-family="${F}" font-size="${size}" font-weight="800" fill="${fill}" letter-spacing="${-size / 70}">Certi<tspan fill="${GOLD}">mens</tspan></text>`;

// --- 1. ICONS ---
// The bare shield, as the site's favicon is: gold reads on a light toolbar as on a dark one.
async function icons() {
    for (const size of [16, 32, 48, 128]) await shield(size).toFile(join(root, 'extension', 'icons', `icon${size}.png`));
    for (const size of [64, 80]) await shield(size).toFile(join(root, 'word', 'icons', `icon${size}.png`));
}

// --- 2. STORE TILES ---
// The mark on the slate of the site's dark sections, alone for AppSource and with the word mark
// for the Opera tile.
async function tiles() {
    await sharp({ create: { width: 300, height: 300, channels: 4, background: SLATE } })
        .composite([{ input: await shield(168).toBuffer(), gravity: 'centre' }])
        .png()
        .toFile(join(root, 'store', 'appsource-logo-300x300.png'));

    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="300" height="188">
  <rect width="300" height="188" fill="${SLATE}"/>
  ${wordmark(112, 92, 30, '#ffffff')}
  ${text(112, 116, 'Agent de rédaction', { size: 14, weight: 600, fill: '#a8b3c2' })}
</svg>`;
    await sharp(Buffer.from(svg))
        .composite([{ input: await shield(72).toBuffer(), left: 28, top: 58 }])
        .png()
        .toFile(join(root, 'store', 'opera-300x188.png'));
}

// --- 3. CHROME WEB STORE SCREENSHOT ---
// A mock-up rather than a capture: the popup over Google Docs, drawn with the styles of
// extension/ui.css so the listing shows what the extension actually looks like.
async function screenshot() {
    const bullets = [
        ['Fonctionne directement dans', 'Google Docs et Word Online'],
        ['Aucun texte ni aucune frappe', 'enregistrés : seulement des compteurs'],
        ['Rendu sur un devoir et envoi', 'du .docx en un clic'],
    ];
    let panel = `<rect width="400" height="800" fill="${SLATE}"/>`;
    panel += wordmark(116, 202, 27, '#ffffff');
    ['La rédaction', 'mesurée, pas le', 'texte.'].forEach((line, i) => {
        panel += text(44, 300 + i * 52, line, { size: 42, weight: 800, fill: '#ffffff', ls: -0.9 });
    });
    bullets.forEach(([first, second], i) => {
        const y = 466 + i * 90;
        // Gold as a surface carries dark text, never the other way round.
        panel += `<circle cx="55" cy="${y - 5}" r="11" fill="${GOLD}"/>`;
        panel += `<path d="M50 ${y - 5} l3.5 3.5 L61 ${y - 11}" fill="none" stroke="${SLATE_DARK}" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/>`;
        panel += text(78, y, first, { size: 15.5, weight: 600, fill: '#cbd5e1' });
        panel += text(78, y + 24, second, { size: 15.5, weight: 600, fill: '#cbd5e1' });
    });

    let scene = `<rect x="400" width="880" height="800" fill="${BG}"/>`;
    scene += `<rect x="444" y="44" width="792" height="760" rx="14" fill="${PAPER}" stroke="${LINE}"/>`;
    for (const cx of [466, 486, 506]) scene += `<circle cx="${cx}" cy="74" r="5" fill="#dfe3e8"/>`;
    scene += `<rect x="524" y="58" width="652" height="32" rx="16" fill="#f1f5f9"/>`;
    scene += text(542, 79, 'docs.google.com/document/d/…/edit', { size: 13, fill: MUTED });
    // the extension in the toolbar, with its "ON" badge
    scene += `<rect x="1189" y="59" width="30" height="30" rx="8" fill="#f1f5f9"/>`;
    scene += `<rect x="1197" y="79" width="26" height="14" rx="7" fill="#137333"/>`;
    scene += text(1210, 90, 'ON', { size: 9, weight: 700, fill: '#ffffff', anchor: 'middle' });
    scene += `<line x1="444" y1="104" x2="1236" y2="104" stroke="${LINE}"/>`;
    for (const [x, w] of [[462, 64], [538, 78], [628, 40], [680, 120], [812, 96]]) {
        scene += `<rect x="${x}" y="114" width="${w}" height="10" rx="5" fill="#eef2f6"/>`;
    }
    scene += `<rect x="444" y="136" width="792" height="668" fill="${BG}"/>`;
    // the document being written
    scene += `<rect x="475" y="168" width="402" height="636" fill="${PAPER}" stroke="${LINE}"/>`;
    scene += text(519, 236, 'Chapitre 2 — Cadre', { size: 21, weight: 800, ls: -0.3 });
    scene += text(519, 264, 'théorique', { size: 21, weight: 800, ls: -0.3 });
    const paragraphs = [
        ["La notion d'apprentissage autorégulé s'est", 'imposée dans la recherche en éducation', 'comme un cadre permettant de décrire la', "manière dont l'étudiant planifie, contrôle et", 'évalue son propre travail.'],
        ["Dans le cas particulier de l'écriture", 'académique, ces processus se traduisent par', 'des allers-retours constants entre la', 'production du texte et sa révision : pauses', 'de réflexion, reformulations, déplacements', 'dans le document.'],
        ["Ce chapitre présente d'abord les principaux", 'modèles du processus rédactionnel, puis', "discute leur apport pour l'analyse des traces", 'laissées'],
    ];
    let y = 306;
    for (const lines of paragraphs) {
        for (const line of lines) {
            scene += text(519, y, line, { size: 13.5 });
            y += 22;
        }
        y += 14;
    }
    scene += `<rect x="573" y="${y - 47}" width="1.5" height="15" fill="${TEXT}"/>`; // the caret

    // the popup, in the styles of extension/ui.css
    const P = 880, W = 340;
    scene += `<rect x="${P}" y="100" width="${W}" height="516" rx="14" fill="${PAPER}" stroke="${LINE}"/>`;
    scene += wordmark(P + 48, 141, 19, TEXT);
    scene += text(P + 16, 172, 'Connecté :', { size: 12, fill: MUTED });
    scene += text(P + 76, 172, 'c.martin@exemple.fr', { size: 12, weight: 700 });
    scene += text(P + W - 16, 172, 'Se déconnecter', { size: 12, weight: 600, fill: GOLD_TEXT, anchor: 'end' });
    scene += `<rect x="${P + 16}" y="188" width="${W - 32}" height="368" rx="12" fill="${PAPER}" stroke="${LINE}"/>`;
    scene += text(P + 32, 214, 'Document ouvert', { size: 12, fill: MUTED });
    scene += text(P + 32, 243, 'Mémoire — Chapitre 2', { size: 17, weight: 800, ls: -0.2 });
    scene += `<rect x="${P + 32}" y="256" width="${W - 64}" height="48" rx="12" fill="#edf7ed"/>`;
    scene += text(P + 48, 276, 'Fichier Certimens associé : les mesures y', { size: 12, fill: '#1e4620' });
    scene += text(P + 48, 293, 'sont envoyées.', { size: 12, fill: '#1e4620' });
    scene += text(P + 32, 326, 'Rendu sur : Mémoire — Chapitre 2', { size: 12, fill: MUTED });
    scene += text(P + 32, 350, 'Ouvrir dans Certimens', { size: 12, weight: 600, fill: GOLD_TEXT });
    scene += `<rect x="${P + 32}" y="372" width="${W - 64}" height="40" rx="12" fill="none" stroke="${SLATE}" stroke-opacity="0.5"/>`;
    scene += text(P + W / 2, 397, 'Envoyer le .docx', { size: 15, weight: 700, fill: SLATE, anchor: 'middle' });
    scene += text(P + 32, 434, 'Un document est déjà envoyé : un nouvel', { size: 12, fill: MUTED });
    scene += text(P + 32, 451, 'envoi le remplace.', { size: 12, fill: MUTED });
    scene += text(P + 32, 481, 'Devoir', { size: 13, weight: 600, fill: MUTED });
    scene += `<rect x="${P + 32}" y="492" width="${W - 64}" height="44" rx="12" fill="${PAPER}" stroke="#b9bdc2"/>`;
    scene += text(P + 46, 520, 'Mémoire — Chapitre 2 (avant le 1', { size: 14 });
    scene += `<path d="M${P + W - 58} 511 l6 7 6-7" fill="none" stroke="${MUTED}" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>`;
    scene += text(P + 16, 590, 'Paramètres et état de synchronisation', { size: 12, weight: 600, fill: GOLD_TEXT });

    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="800">
  <rect width="1280" height="800" fill="${BG}"/>
  ${panel}
  ${scene}
</svg>`;
    await sharp(Buffer.from(svg))
        .composite([
            { input: await shield(58).toBuffer(), left: 44, top: 154 },
            { input: await shield(24).toBuffer(), left: P + 16, top: 122 },
            { input: await shield(20).toBuffer(), left: 1194, top: 62 },
        ])
        .png()
        .toFile(join(root, 'store', 'chrome-screenshot-1280x800.png'));
}

await icons();
await tiles();
await screenshot();
console.log('Icônes et visuels de boutique régénérés depuis store/brand-mark.png.');
