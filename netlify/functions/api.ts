/**
 * The whole HTTP surface. This file owns path matching, method, status codes,
 * authentication and the role gate. It contains no SQL and no business rules:
 * every rule lives in a lib/* domain module that never sees an HTTP object.
 */

import { toErrorBody, statusOf, NotFoundError, HttpError, ForbiddenError } from '../../lib/errors.js';
import { query } from '../../lib/db.js';
import {
  authenticate,
  clientIp,
  loginStaff,
  loginSubscriber,
  requireRole,
  requireStaff,
  requireSubscriber,
} from '../../lib/auth.js';
import {
  createSubscriber,
  resetPin,
  setSubscriberStatus,
  softDeleteSubscriber,
  updateSubscriber,
} from '../../lib/subscribers.js';
import { getSubscriberDetail, listSubscribers } from '../../lib/subscriber-queries.js';
import {
  closeCycle,
  getCurrentCycle,
  getCycleProgress,
  listCycles,
  openCycle,
  updateCycle,
} from '../../lib/cycles.js';
import { getRoute, removeReading, upsertReading } from '../../lib/reading-entry.js';
import { issueCycle } from '../../lib/billing.js';
import {
  listPayments,
  recordPayment,
  subscriberPayments,
  voidPayment,
} from '../../lib/payments.js';
import { arrearsReport, collectionReport } from '../../lib/reports.js';
import { consumptionReport, profitReport } from '../../lib/reports-financial.js';
import {
  createStaffAccount,
  listStaff,
  setStaffPassword,
  updateStaffAccount,
} from '../../lib/staff.js';
import {
  createExpense,
  listExpenses,
  softDeleteExpense,
  updateExpense,
} from '../../lib/expenses.js';
import {
  listNotifications,
  markAllRead,
  markRead,
  removePushSubscription,
  savePushSubscription,
} from '../../lib/notify.js';
import {
  getBill,
  listBills,
  previewIssue,
  subscriberBills,
  subscriberCurrentBill,
} from '../../lib/bill-queries.js';
import {
  createRequest,
  listRequests,
  subscriberRequests,
  updateRequest,
} from '../../lib/service-requests.js';
import { sendOwnerMessage } from '../../lib/messages.js';
import {
  ingestReading,
  listDevices,
  liveUsage,
  registerDevice,
  rotateSecret,
  setDeviceStatus,
} from '../../lib/devices.js';
import type { Actor } from '../../lib/types.js';

export const config = { path: '/api/*' };

export type AuthRequirement = 'public' | 'staff' | 'owner' | 'subscriber';

export interface RouteContext {
  req: Request;
  url: URL;
  params: string[];
  body: unknown;
  actor: Actor | null;
  requestId: string;
}

/** A handler returns the JSON body to send, or a Sent value to control the status. */
export interface Sent {
  __sent: true;
  status: number;
  body: unknown;
}

export function sent(status: number, body: unknown): Sent {
  return { __sent: true, status, body };
}

export type RouteHandler = (ctx: RouteContext) => Promise<unknown> | unknown;

export interface Route {
  method: string;
  pattern: RegExp;
  auth: AuthRequirement;
  handler: RouteHandler;
}

function route(
  method: string,
  pattern: RegExp,
  auth: AuthRequirement,
  handler: RouteHandler,
): Route {
  return { method, pattern, auth, handler };
}

/**
 * Owner-only paths, checked before routing. The matching routes also declare
 * auth: 'owner'. Two independent checks by design: a route added with the wrong
 * auth flag is still stopped here, and a path missed here is still stopped by
 * the route's own gate.
 */
const OWNER_ONLY: { method: RegExp; path: RegExp }[] = [
  { method: /^(GET|POST|PATCH|DELETE)$/, path: /^\/api\/expenses(\/|$)/ },
  { method: /^GET$/, path: /^\/api\/reports\/profit$/ },
  { method: /^GET$/, path: /^\/api\/reports\/consumption$/ },
  { method: /^GET$/, path: /^\/api\/reports\/arrears$/ },
  { method: /^(POST|PATCH)$/, path: /^\/api\/cycles(\/|$)/ },
  { method: /^POST$/, path: /^\/api\/payments\/\d+\/void$/ },
  { method: /^(POST|PATCH|DELETE)$/, path: /^\/api\/subscribers(\/|$)/ },
  { method: /^(GET|POST|PATCH)$/, path: /^\/api\/staff(\/|$)/ },
  { method: /^DELETE$/, path: /^\/api\/cycles\/\d+\/readings\/\d+$/ },
  { method: /^GET$/, path: /^\/api\/cycles\/\d+\/issue-preview$/ },
  { method: /^(GET|PATCH)$/, path: /^\/api\/requests(\/|$)/ },
  { method: /^POST$/, path: /^\/api\/messages$/ },
  { method: /^(GET|POST|PATCH)$/, path: /^\/api\/devices(\/|$)/ },
];

const ROUTES: Route[] = [
  route('GET', /^\/api\/health$/, 'public', async () => {
    await query('select 1');
    return { status: 'ok', database: 'ok' };
  }),

  route('POST', /^\/api\/auth\/staff\/login$/, 'public', (ctx) =>
    loginStaff(ctx.body, clientIp(ctx.req.headers)),
  ),

  route('POST', /^\/api\/auth\/subscriber\/login$/, 'public', (ctx) =>
    loginSubscriber(ctx.body, clientIp(ctx.req.headers)),
  ),

  route('GET', /^\/api\/me$/, 'staff', (ctx) => {
    const actor = ctx.actor!;
    return actor.kind === 'staff'
      ? { kind: 'staff', id: actor.id, name: actor.name, username: actor.username, role: actor.role }
      : { kind: 'subscriber', id: actor.id, name: actor.name, code: actor.code };
  }),

  route('GET', /^\/api\/subscribers$/, 'staff', (ctx) => listSubscribers(searchParams(ctx))),

  route('POST', /^\/api\/subscribers$/, 'owner', async (ctx) =>
    sent(201, await createSubscriber(ctx.body, ctx.actor!)),
  ),

  route('GET', /^\/api\/subscribers\/(\d+)$/, 'staff', (ctx) =>
    getSubscriberDetail(idParam(ctx)),
  ),

  route('PATCH', /^\/api\/subscribers\/(\d+)$/, 'owner', async (ctx) => ({
    subscriber: await updateSubscriber(idParam(ctx), ctx.body, ctx.actor!),
  })),

  route('POST', /^\/api\/subscribers\/(\d+)\/pin-reset$/, 'owner', (ctx) =>
    resetPin(idParam(ctx), ctx.actor!),
  ),

  route('POST', /^\/api\/subscribers\/(\d+)\/status$/, 'owner', async (ctx) => ({
    subscriber: await setSubscriberStatus(idParam(ctx), ctx.body, ctx.actor!),
  })),

  route('DELETE', /^\/api\/subscribers\/(\d+)$/, 'owner', async (ctx) => {
    await softDeleteSubscriber(idParam(ctx), ctx.actor!);
    return sent(204, null);
  }),

  route('GET', /^\/api\/cycles$/, 'staff', async () => ({ cycles: await listCycles() })),

  route('GET', /^\/api\/cycles\/current$/, 'staff', async () => ({
    cycle: await getCurrentCycle(),
  })),

  route('POST', /^\/api\/cycles$/, 'owner', async (ctx) =>
    sent(201, { cycle: await openCycle(ctx.body, ctx.actor!) }),
  ),

  route('PATCH', /^\/api\/cycles\/(\d+)$/, 'owner', async (ctx) => ({
    cycle: await updateCycle(idParam(ctx), ctx.body, ctx.actor!),
  })),

  route('POST', /^\/api\/cycles\/(\d+)\/close$/, 'owner', async (ctx) => ({
    cycle: await closeCycle(idParam(ctx), ctx.actor!),
  })),

  route('GET', /^\/api\/cycles\/(\d+)\/progress$/, 'staff', (ctx) =>
    getCycleProgress(idParam(ctx)),
  ),

  route('GET', /^\/api\/cycles\/(\d+)\/route$/, 'staff', async (ctx) => ({
    rows: await getRoute(idParam(ctx), searchParams(ctx)),
  })),

  route('PUT', /^\/api\/cycles\/(\d+)\/readings\/(\d+)$/, 'staff', (ctx) =>
    upsertReading(idParam(ctx, 0), idParam(ctx, 1), ctx.body, ctx.actor!),
  ),

  route('DELETE', /^\/api\/cycles\/(\d+)\/readings\/(\d+)$/, 'owner', async (ctx) => {
    await removeReading(idParam(ctx, 0), idParam(ctx, 1), ctx.actor!);
    return sent(204, null);
  }),

  route('POST', /^\/api\/cycles\/(\d+)\/issue$/, 'owner', (ctx) =>
    issueCycle(idParam(ctx), ctx.body, ctx.actor!),
  ),

  route('GET', /^\/api\/bills$/, 'staff', async (ctx) => ({
    bills: await listBills(searchParams(ctx)),
  })),

  route('GET', /^\/api\/bills\/(\d+)$/, 'staff', async (ctx) => ({
    bill: await getBill(idParam(ctx)),
  })),

  route('GET', /^\/api\/me\/bills$/, 'subscriber', async (ctx) => ({
    bills: await subscriberBills(ctx.actor!.id),
  })),

  route('GET', /^\/api\/me\/bills\/current$/, 'subscriber', (ctx) =>
    subscriberCurrentBill(ctx.actor!.id),
  ),

  route('GET', /^\/api\/config$/, 'public', () => ({
    ownerContactName: process.env.OWNER_CONTACT_NAME ?? null,
    ownerContactPhone: process.env.OWNER_CONTACT_PHONE ?? null,
    vapidPublicKey: process.env.VAPID_PUBLIC_KEY ?? null,
  })),

  route('GET', /^\/api\/cycles\/(\d+)\/issue-preview$/, 'owner', (ctx) =>
    previewIssue(idParam(ctx)),
  ),

  route('POST', /^\/api\/payments$/, 'staff', async (ctx) =>
    sent(201, await recordPayment(ctx.body, ctx.actor!)),
  ),

  route('GET', /^\/api\/payments$/, 'staff', async (ctx) => ({
    payments: await listPayments(searchParams(ctx)),
  })),

  route('POST', /^\/api\/payments\/(\d+)\/void$/, 'owner', (ctx) =>
    voidPayment(idParam(ctx), ctx.body, ctx.actor!),
  ),

  route('GET', /^\/api\/me\/payments$/, 'subscriber', async (ctx) => ({
    payments: await subscriberPayments(ctx.actor!.id),
  })),

  route('GET', /^\/api\/reports\/arrears$/, 'owner', () => arrearsReport()),

  route('GET', /^\/api\/reports\/collection$/, 'staff', (ctx) => {
    const actor = ctx.actor!;
    // A collector may read this report, but only their own collections.
    const scoped =
      actor.kind === 'staff' && actor.role === 'collector' ? { receivedBy: actor.id } : {};
    return collectionReport({ ...searchParams(ctx), ...scoped });
  }),

  route('GET', /^\/api\/me\/notifications$/, 'subscriber', (ctx) =>
    listNotifications(ctx.actor!.id, ctx.url.searchParams.get('unreadOnly') === 'true'),
  ),

  route('POST', /^\/api\/me\/notifications\/(\d+)\/read$/, 'subscriber', (ctx) =>
    markRead(ctx.actor!.id, idParam(ctx)),
  ),

  route('POST', /^\/api\/me\/notifications\/read-all$/, 'subscriber', (ctx) =>
    markAllRead(ctx.actor!.id),
  ),

  route('POST', /^\/api\/me\/push\/subscribe$/, 'subscriber', async (ctx) =>
    sent(201, await savePushSubscription(ctx.actor!.id, ctx.body)),
  ),

  route('DELETE', /^\/api\/me\/push\/subscribe$/, 'subscriber', async (ctx) => {
    await removePushSubscription(ctx.actor!.id, ctx.body);
    return sent(204, null);
  }),

  // The device path takes a device secret, not a person's token, so it is not
  // 'subscriber' or 'staff': devices.ts authenticates the serial itself.
  route('POST', /^\/api\/ingest\/([A-Za-z0-9._-]{4,64})\/readings$/, 'public', async (ctx) =>
    sent(202, await ingestReading(ctx.params[0]!, ctx.req.headers, ctx.body)),
  ),

  route('GET', /^\/api\/me\/usage$/, 'subscriber', (ctx) => liveUsage(ctx.actor!.id)),

  route('POST', /^\/api\/subscribers\/(\d+)\/device$/, 'owner', async (ctx) =>
    sent(201, await registerDevice(idParam(ctx), ctx.body, ctx.actor!)),
  ),

  route('GET', /^\/api\/devices$/, 'owner', async () => ({ devices: await listDevices() })),

  route('POST', /^\/api\/devices\/(\d+)\/rotate$/, 'owner', (ctx) =>
    rotateSecret(idParam(ctx), ctx.actor!),
  ),

  route('PATCH', /^\/api\/devices\/(\d+)$/, 'owner', async (ctx) => ({
    device: await setDeviceStatus(idParam(ctx), ctx.body, ctx.actor!),
  })),

  route('GET', /^\/api\/me\/requests$/, 'subscriber', async (ctx) => ({
    requests: await subscriberRequests(ctx.actor!.id),
  })),

  route('POST', /^\/api\/me\/requests$/, 'subscriber', async (ctx) =>
    sent(201, { request: await createRequest(ctx.actor!.id, ctx.body, ctx.actor!) }),
  ),

  route('GET', /^\/api\/requests$/, 'owner', async (ctx) => ({
    requests: await listRequests({ status: ctx.url.searchParams.get('status') }),
  })),

  route('PATCH', /^\/api\/requests\/(\d+)$/, 'owner', async (ctx) => ({
    request: await updateRequest(idParam(ctx), ctx.body, ctx.actor!),
  })),

  route('POST', /^\/api\/messages$/, 'owner', async (ctx) =>
    sent(201, await sendOwnerMessage(ctx.body, ctx.actor!)),
  ),

  route('GET', /^\/api\/expenses$/, 'owner', async (ctx) => ({
    expenses: await listExpenses(searchParams(ctx)),
  })),

  route('POST', /^\/api\/expenses$/, 'owner', async (ctx) =>
    sent(201, { expense: await createExpense(ctx.body, ctx.actor!) }),
  ),

  route('PATCH', /^\/api\/expenses\/(\d+)$/, 'owner', async (ctx) => ({
    expense: await updateExpense(idParam(ctx), ctx.body, ctx.actor!),
  })),

  route('DELETE', /^\/api\/expenses\/(\d+)$/, 'owner', async (ctx) => {
    await softDeleteExpense(idParam(ctx), ctx.actor!);
    return sent(204, null);
  }),

  route('GET', /^\/api\/reports\/profit$/, 'owner', (ctx) => profitReport(searchParams(ctx))),

  route('GET', /^\/api\/reports\/consumption$/, 'owner', (ctx) =>
    consumptionReport(searchParams(ctx)),
  ),

  route('GET', /^\/api\/staff$/, 'owner', async () => ({ staff: await listStaff() })),

  route('POST', /^\/api\/staff$/, 'owner', async (ctx) =>
    sent(201, { staff: await createStaffAccount(ctx.body, ctx.actor!) }),
  ),

  route('PATCH', /^\/api\/staff\/(\d+)$/, 'owner', async (ctx) => ({
    staff: await updateStaffAccount(idParam(ctx), ctx.body, ctx.actor!),
  })),

  route('POST', /^\/api\/staff\/(\d+)\/password$/, 'owner', async (ctx) => {
    await setStaffPassword(idParam(ctx), ctx.body, ctx.actor!);
    return sent(204, null);
  }),
];

// /api/me answers for either audience, so it opts out of the staff-only gate above.
const ANY_IDENTITY = /^\/api\/me$/;

/** Route parameters arrive as strings; every :id in this API is a positive integer. */
function idParam(ctx: RouteContext, index = 0): number {
  const raw = ctx.params[index];
  const id = Number(raw);
  if (!Number.isSafeInteger(id) || id < 1) {
    throw new HttpError(400, 'validation_error', 'That id is not valid');
  }
  return id;
}

function searchParams(ctx: RouteContext): Record<string, string | null> {
  return Object.fromEntries(ctx.url.searchParams.entries());
}

// Every response carries someone's balance or identity. Nothing here is cacheable,
// by a browser or by anything sitting in front of it.
const JSON_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
};

function jsonResponse(status: number, body: unknown): Response {
  return new Response(status === 204 ? null : JSON.stringify(body), {
    status,
    headers: status === 204 ? { 'cache-control': 'no-store' } : JSON_HEADERS,
  });
}

async function readBody(req: Request): Promise<unknown> {
  if (req.method === 'GET' || req.method === 'HEAD') return undefined;
  const text = await req.text();
  if (text === '') return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new HttpError(400, 'invalid_json', 'Request body is not valid JSON');
  }
}

function enforce(auth: AuthRequirement, actor: Actor | null, path: string): void {
  if (auth === 'public') return;
  if (ANY_IDENTITY.test(path)) {
    if (actor === null) throw new HttpError(401, 'unauthorized', 'Authentication required');
    return;
  }
  if (auth === 'owner') requireRole(actor, 'owner');
  else if (auth === 'staff') requireStaff(actor);
  else requireSubscriber(actor);
}

export default async function handler(req: Request): Promise<Response> {
  const requestId = crypto.randomUUID();
  const url = new URL(req.url);
  const path = url.pathname.replace(/\/+$/, '') || '/api';
  let actor: Actor | null = null;

  try {
    const matchesPath = ROUTES.filter((r) => r.pattern.test(path));
    if (matchesPath.length === 0) {
      throw new NotFoundError('route');
    }
    const match = matchesPath.find((r) => r.method === req.method);
    if (!match) {
      throw new HttpError(405, 'method_not_allowed', `${req.method} is not allowed on this path`);
    }

    if (match.auth !== 'public' || req.headers.has('authorization')) {
      actor = await authenticate(req.headers);
    }

    const ownerOnly = OWNER_ONLY.some((d) => d.path.test(path) && d.method.test(req.method));
    if (ownerOnly && (actor === null || actor.kind !== 'staff' || actor.role !== 'owner')) {
      throw actor === null
        ? new HttpError(401, 'unauthorized', 'Authentication required')
        : new ForbiddenError('Only the owner can do that');
    }

    enforce(match.auth, actor, path);

    const params = match.pattern.exec(path)?.slice(1) ?? [];
    const body = await readBody(req);
    const result = await match.handler({ req, url, params, body, actor, requestId });

    if (result !== null && typeof result === 'object' && '__sent' in result) {
      const s = result as Sent;
      return jsonResponse(s.status, s.body);
    }
    return jsonResponse(200, result);
  } catch (err) {
    const status = statusOf(err);
    if (status >= 500) {
      console.error(
        JSON.stringify({
          requestId,
          method: req.method,
          path,
          actor: actor === null ? null : `${actor.kind}:${actor.id}`,
          message: err instanceof Error ? err.message : String(err),
        }),
      );
    }
    return jsonResponse(status, toErrorBody(err));
  }
}
