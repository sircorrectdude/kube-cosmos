// Liefert das gebaute Frontend aus (Container-Betrieb: ein Image, ein Port). Ohne Abhängigkeiten.
import { createReadStream, statSync } from 'node:fs';
import path from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.map': 'application/json',
};

export function serveStatic(root: string) {
  const base = path.resolve(root);
  return (req: IncomingMessage, res: ServerResponse): boolean => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return false;
    const urlPath = decodeURIComponent((req.url ?? '/').split('?')[0]);
    let file = path.resolve(base, '.' + urlPath);
    if (file !== base && !file.startsWith(base + path.sep)) return false; // kein Zugriff außerhalb von root
    try { if (statSync(file).isDirectory()) file = path.join(file, 'index.html'); }
    catch { file = path.join(base, 'index.html'); } // SPA-Fallback
    try { statSync(file); } catch { return false; }
    const ext = path.extname(file);
    res.setHeader('Content-Type', TYPES[ext] ?? 'application/octet-stream');
    // Vite-Assets haben Hash im Namen → lange cachen; index.html nie
    res.setHeader('Cache-Control', file.includes(`${path.sep}assets${path.sep}`) ? 'public, max-age=31536000, immutable' : 'no-cache');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    if (req.method === 'HEAD') { res.end(); return true; }
    createReadStream(file).pipe(res);
    return true;
  };
}
