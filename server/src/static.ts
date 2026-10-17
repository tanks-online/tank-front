import { createReadStream, realpathSync, statSync } from 'node:fs';
import { realpath, stat } from 'node:fs/promises';
import { extname, isAbsolute, relative, resolve, sep } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.webp': 'image/webp', '.avif': 'image/avif', '.gif': 'image/gif', '.ico': 'image/x-icon',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.otf': 'font/otf',
  '.glb': 'model/gltf-binary', '.gltf': 'model/gltf+json', '.bin': 'application/octet-stream',
  '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.wav': 'audio/wav', '.mp4': 'video/mp4', '.webm': 'video/webm',
  '.json': 'application/json; charset=utf-8', '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
};
const PRIVATE_NAMES = /^(?:package(?:-lock)?\.json|npm-shrinkwrap\.json|tsconfig(?:\.[^.]+)?\.json|(?:dockerfile|compose\.ya?ml)|(?:id_rsa|id_ed25519)(?:\.pub)?|(?:credentials|secrets?)\.[^.]+)$/i;

function inside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

export function securityHeaders(allowedOrigins: string[]): Record<string, string> {
  const endpoints = allowedOrigins.flatMap(origin => [origin, origin.replace(/^http/, 'ws')]);
  return {
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=()',
    'Content-Security-Policy': [
      "default-src 'self'", "script-src 'self'", "style-src 'self' 'unsafe-inline'", "img-src 'self' data: blob:",
      `connect-src 'self' ${endpoints.join(' ')}`, "font-src 'self'", "media-src 'self'", "worker-src 'self' blob:",
      "object-src 'none'", "base-uri 'self'", "frame-ancestors 'none'", "form-action 'self'",
    ].join('; '),
  };
}

// The root is trusted deployment configuration; requests never select a root or expose directory listings.
export function createStaticHandler(directory: string) {
  let root: string;
  try {
    root = realpathSync(resolve(directory));
    const index = realpathSync(resolve(root, 'index.html'));
    if (!statSync(root).isDirectory() || !inside(root, index) || !statSync(index).isFile()) throw new Error('Missing index.html');
  } catch {
    throw new Error(`STATIC_DIR: каталог собранного клиента с index.html не найден: ${resolve(directory)}`);
  }

  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const missing = () => { res.writeHead(404); res.end(); };
    const raw = (req.url ?? '').split('?')[0]!;
    let pathname: string;
    try { pathname = decodeURIComponent(raw); } catch { res.writeHead(400); res.end(); return; }
    if (!pathname.startsWith('/') || /[\\:\x00-\x1f\x7f]/.test(pathname)) { missing(); return; }
    const segments = pathname.split('/').slice(1);
    if (segments.some(segment => segment.startsWith('.') || PRIVATE_NAMES.test(segment))) { missing(); return; }
    const asset = pathname === '/' ? 'index.html' : pathname.slice(1);
    const extension = extname(asset).toLowerCase();
    if (!MIME[extension] || (extension === '.html' && asset !== 'index.html')) { missing(); return; }
    const candidate = resolve(root, asset);
    if (!inside(root, candidate)) { missing(); return; }
    let path: string;
    let size: number;
    try {
      path = await realpath(candidate);
      if (!inside(root, path)) { missing(); return; }
      const info = await stat(path);
      if (!info.isFile()) { missing(); return; }
      size = info.size;
    } catch { missing(); return; }
    // Vite uses a content hash in asset filenames; unchanged files can be cached across releases.
    const immutable = /^assets\/.+-[A-Za-z0-9_-]{8,}\.[A-Za-z0-9]+$/.test(asset);
    res.writeHead(200, {
      'Content-Type': MIME[extension]!, 'Content-Length': size,
      'Cache-Control': asset === 'index.html' ? 'no-cache' : immutable ? 'public, max-age=31536000, immutable' : 'public, max-age=3600',
    });
    if (req.method === 'HEAD') { res.end(); return; }
    const stream = createReadStream(path);
    stream.on('error', () => res.destroy());
    res.on('close', () => stream.destroy());
    stream.pipe(res);
  };
}
