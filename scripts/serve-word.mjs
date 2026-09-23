// Serves dist/word/ on https://localhost:3000 to test the Word add-in locally, with the
// dist/word-localhost.xml manifest (run npm run build first). The HTTPS development certificate
// is created and trusted by office-addin-dev-certs on first launch.

import { createServer } from 'node:https';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getHttpsServerOptions } from 'office-addin-dev-certs';

const root = join(fileURLToPath(import.meta.url), '../../dist/word');
const TYPES = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.png': 'image/png',
    '.woff2': 'font/woff2',
    '.xml': 'application/xml',
};

const server = createServer(await getHttpsServerOptions(), async (req, res) => {
    const path = normalize(decodeURIComponent(new URL(req.url, 'https://localhost').pathname)).replace(/^(\.\.[/\\])+/, '');
    try {
        const body = await readFile(join(root, path === '/' ? 'index.html' : path));
        res.writeHead(200, { 'Content-Type': TYPES[extname(path)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
        res.end(body);
    } catch {
        res.writeHead(404).end();
    }
});
server.listen(3000, () => console.log('Complément Word servi sur https://localhost:3000 (manifest : dist/word-localhost.xml)'));
