/**
 * The only module in the client that calls fetch. Everything else asks this.
 * Two token slots, because a staff member and a subscriber can be signed in on
 * the same device without evicting each other.
 */

export type Audience = 'staff' | 'subscriber';

const TOKEN_KEYS: Record<Audience, string> = {
  staff: 'moteur.staff.token',
  subscriber: 'moteur.subscriber.token',
};

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly messageAr: string | undefined;
  readonly details: Record<string, unknown> | undefined;

  constructor(
    status: number,
    code: string,
    message: string,
    messageAr?: string,
    details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.messageAr = messageAr;
    this.details = details;
  }

  /** The server sends both languages for anything a person is meant to read. */
  localized(language: 'ar' | 'en'): string {
    return language === 'ar' && this.messageAr ? this.messageAr : this.message;
  }
}

export function getToken(audience: Audience): string | null {
  try {
    return localStorage.getItem(TOKEN_KEYS[audience]);
  } catch {
    return null;
  }
}

export function setToken(audience: Audience, token: string | null): void {
  try {
    if (token === null) localStorage.removeItem(TOKEN_KEYS[audience]);
    else localStorage.setItem(TOKEN_KEYS[audience], token);
  } catch {
    // A browser with site data blocked still works for the length of the session.
  }
}

type SessionExpiredListener = (audience: Audience) => void;
const sessionExpiredListeners = new Set<SessionExpiredListener>();

export function onSessionExpired(listener: SessionExpiredListener): () => void {
  sessionExpiredListeners.add(listener);
  return () => sessionExpiredListeners.delete(listener);
}

export interface RequestOptions {
  method?: string;
  body?: unknown;
  query?: Record<string, string | number | boolean | undefined | null>;
  audience?: Audience;
  signal?: AbortSignal;
}

function buildUrl(path: string, params: RequestOptions['query']): string {
  if (!params) return path;
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== '') {
      search.set(key, String(value));
    }
  }
  const qs = search.toString();
  return qs === '' ? path : `${path}?${qs}`;
}

export async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const audience = options.audience ?? 'staff';
  const headers = new Headers();
  const token = getToken(audience);
  if (token !== null) headers.set('authorization', `Bearer ${token}`);

  const init: RequestInit = { method: options.method ?? 'GET', headers };
  if (options.signal) init.signal = options.signal;
  if (options.body !== undefined) {
    headers.set('content-type', 'application/json');
    init.body = JSON.stringify(options.body);
  }

  const response = await fetch(buildUrl(`/api${path}`, options.query), init);
  const text = await response.text();
  const payload: unknown = text === '' ? null : JSON.parse(text);

  if (!response.ok) {
    const shape = payload as {
      error?: {
        code?: string;
        message?: string;
        messageAr?: string;
        details?: Record<string, unknown>;
      };
    } | null;
    const error = new ApiError(
      response.status,
      shape?.error?.code ?? 'unknown_error',
      shape?.error?.message ?? 'Something went wrong',
      shape?.error?.messageAr,
      shape?.error?.details,
    );
    if (response.status === 401) {
      setToken(audience, null);
      for (const listener of sessionExpiredListeners) listener(audience);
    }
    throw error;
  }

  return payload as T;
}
