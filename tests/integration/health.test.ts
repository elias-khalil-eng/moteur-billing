import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { ensureSchema, resetTables, shutdown, call } from './helpers.js';

describe('GET /api/health', () => {
  beforeAll(async () => {
    await ensureSchema();
    await resetTables();
  });

  afterAll(async () => {
    await shutdown();
  });

  it('reports the service and a live database', async () => {
    const res = await call<{ status: string; database: string }>({ path: '/api/health' });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(res.body.database).toBe('ok');
  });

  it('returns 404 with an error body for an unknown route', async () => {
    const res = await call<{ error: { code: string } }>({ path: '/api/nope' });
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('not_found');
  });

  it('returns 405 when the method does not match a known path', async () => {
    const res = await call<{ error: { code: string } }>({ method: 'POST', path: '/api/health' });
    expect(res.status).toBe(405);
    expect(res.body.error.code).toBe('method_not_allowed');
  });
});
