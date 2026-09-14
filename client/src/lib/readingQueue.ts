/**
 * Reading entries survive a bad connection. Every entry is written here first,
 * kept in localStorage, and retried until the server accepts it. A collector who
 * walks out of signal must never lose a number they already typed.
 */

import { ApiError, request } from './api.js';

export interface ReadingDraft {
  cycleId: number;
  subscriberId: number;
  currentValue: number;
  meterReset?: boolean;
  note?: string | null;
  confirmOutlier?: boolean;
}

export type EntryState = 'sending' | 'queued' | 'blocked';

export interface QueueEntry extends ReadingDraft {
  state: EntryState;
  attempts: number;
  error: { code: string; message: string; details?: Record<string, unknown> } | null;
}

type Listener = (entries: QueueEntry[]) => void;

const STORAGE_KEY = 'moteur.readingQueue';
const RETRY_MS = 15_000;

function keyOf(entry: ReadingDraft): string {
  return `${entry.cycleId}:${entry.subscriberId}`;
}

/** A 4xx other than a timeout or a rate limit will never succeed on retry. */
function isPermanent(error: unknown): boolean {
  return (
    error instanceof ApiError &&
    error.status >= 400 &&
    error.status < 500 &&
    error.status !== 408 &&
    error.status !== 429
  );
}

class ReadingQueue {
  private entries = new Map<string, QueueEntry>();
  private listeners = new Set<Listener>();
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor() {
    this.restore();
  }

  private restore(): void {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw === null) return;
      const saved = JSON.parse(raw) as QueueEntry[];
      for (const entry of saved) {
        this.entries.set(keyOf(entry), { ...entry, state: 'queued' });
      }
    } catch {
      // A corrupt or unavailable store must not stop the app from opening.
    }
  }

  private persist(): void {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify([...this.entries.values()]));
    } catch {
      // Entries still live in memory for this session.
    }
  }

  private emit(): void {
    this.persist();
    const snapshot = [...this.entries.values()];
    for (const listener of this.listeners) listener(snapshot);
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    listener([...this.entries.values()]);
    if (this.timer === null) {
      this.timer = setInterval(() => void this.retryAll(), RETRY_MS);
      window.addEventListener('online', this.onOnline);
    }
    return () => {
      this.listeners.delete(listener);
      if (this.listeners.size === 0 && this.timer !== null) {
        clearInterval(this.timer);
        this.timer = null;
        window.removeEventListener('online', this.onOnline);
      }
    };
  }

  private onOnline = (): void => {
    void this.retryAll();
  };

  entriesFor(cycleId: number): QueueEntry[] {
    return [...this.entries.values()].filter((entry) => entry.cycleId === cycleId);
  }

  async submit(draft: ReadingDraft): Promise<void> {
    const key = keyOf(draft);
    this.entries.set(key, { ...draft, state: 'sending', attempts: 0, error: null });
    this.emit();
    await this.send(key);
  }

  /** Re-send an entry the server refused, with the collector's confirmation attached. */
  async confirm(draft: ReadingDraft): Promise<void> {
    await this.submit({ ...draft, confirmOutlier: true });
  }

  discard(cycleId: number, subscriberId: number): void {
    this.entries.delete(keyOf({ cycleId, subscriberId, currentValue: 0 }));
    this.emit();
  }

  private async send(key: string): Promise<void> {
    const entry = this.entries.get(key);
    if (entry === undefined) return;
    this.entries.set(key, { ...entry, state: 'sending' });
    this.emit();

    try {
      await request(`/cycles/${entry.cycleId}/readings/${entry.subscriberId}`, {
        method: 'PUT',
        body: {
          currentValue: entry.currentValue,
          meterReset: entry.meterReset ?? false,
          note: entry.note ?? null,
          confirmOutlier: entry.confirmOutlier ?? false,
        },
      });
      this.entries.delete(key);
      this.emit();
    } catch (err) {
      const current = this.entries.get(key);
      if (current === undefined) return;
      this.entries.set(key, {
        ...current,
        state: isPermanent(err) ? 'blocked' : 'queued',
        attempts: current.attempts + 1,
        error:
          err instanceof ApiError
            ? { code: err.code, message: err.message, details: err.details }
            : { code: 'network_error', message: String(err) },
      });
      this.emit();
    }
  }

  async retryAll(): Promise<void> {
    for (const [key, entry] of this.entries) {
      if (entry.state === 'queued') {
        // Sequential: a phone on a weak connection does better with one request at a time.
        // eslint-disable-next-line no-await-in-loop
        await this.send(key);
      }
    }
  }
}

export const readingQueue = new ReadingQueue();
