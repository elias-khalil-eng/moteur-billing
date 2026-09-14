/**
 * One origin, locally: the built client from client/dist plus the API function at
 * /api/*, with an SPA fallback last. This is what Netlify does in production, and
 * what the Playwright suite drives so the smoke tests exercise real routing rather
 * than a test harness.
 */

import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import apiHandler from '../netlify/functions/api.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'client', 'dist');

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.map': 'application/json; charset=utf-8',
};

async function readIfFile(filePath: string): Promise<Buffer | null> {
  try {
    const info = await stat(filePath);
    return info.isFile() ? await readFile(filePath) : null;
  } catch {
    return null;
  }
}

export function startServer(port: number): ReturnType<typeof createServer> {
  const server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);

      if (url.pathname.startsWith('/api/')) {
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(chunk as Buffer);
        const headers = new Headers();
        for (const [key, value] of Object.entries(req.headers)) {
          if (typeof value === 'string') headers.set(key, value);
        }
        const request = new Request(url, {
          method: req.method,
          headers,
          ...(chunks.length > 0 ? { body: Buffer.concat(chunks) } : {}),
        });
        const response = await apiHandler(request);
        res.writeHead(response.status, Object.fromEntries(response.headers.entries()));
        res.end(Buffer.from(await response.arrayBuffer()));
        return;
      }

      // Static file, then the SPA fallback, which must stay last.
      // Traversal cannot survive dropping every empty, dot and dot-dot segment.
      const safePath = url.pathname
        .split('/')
        .filter((part) => part !== '' && part !== '.' && part !== '..')
        .join('/');
      const requested = path.join(DIST, safePath);
      const file = (await readIfFile(requested)) ?? (await readIfFile(path.join(DIST, 'index.html')));
      if (file === null) {
        res.writeHead(404).end('not found');
        return;
      }
      const extension = path.extname(requested) || '.html';
      res.writeHead(200, {
        'content-type': CONTENT_TYPES[extension] ?? 'application/octet-stream',
      });
      res.end(file);
    })().catch((err: unknown) => {
      console.error(err);
      if (!res.headersSent) res.writeHead(500);
      res.end('server error');
    });
  });

  server.listen(port, () => console.log(`serving on http://localhost:${port}`));
  return server;
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  startServer(Number(process.env.PORT ?? 8888));
}
