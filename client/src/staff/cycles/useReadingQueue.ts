import { useEffect, useMemo, useState } from 'react';
import { readingQueue } from '../../lib/readingQueue.js';
import type { QueueEntry } from '../../lib/readingQueue.js';

export interface QueueView {
  bySubscriber: Map<number, QueueEntry>;
  /** Entries waiting or blocked; an entry in flight is not yet a problem. */
  unsentCount: number;
  /** Everything still in the queue, including what is in flight right now. */
  pendingCount: number;
  retryAll: () => void;
}

export function useReadingQueue(cycleId: number | null): QueueView {
  const [entries, setEntries] = useState<QueueEntry[]>([]);

  useEffect(() => readingQueue.subscribe(setEntries), []);

  return useMemo(() => {
    const mine = entries.filter((entry) => entry.cycleId === cycleId);
    return {
      bySubscriber: new Map(mine.map((entry) => [entry.subscriberId, entry])),
      unsentCount: mine.filter((entry) => entry.state !== 'sending').length,
      pendingCount: mine.length,
      retryAll: () => void readingQueue.retryAll(),
    };
  }, [entries, cycleId]);
}
