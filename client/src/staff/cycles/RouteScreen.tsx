import { useEffect, useMemo, useRef, useState } from 'react';
import { useI18n } from '../../app/I18nContext.js';
import { useResource } from '../../lib/useResource.js';
import { Spinner } from '../../components/Spinner.js';
import { EmptyState } from '../../components/EmptyState.js';
import { RouteRowItem } from './RouteRowItem.js';
import { useReadingQueue } from './useReadingQueue.js';
import type { BillingCycle, CycleProgress, RouteRow } from '../../../../lib/types.js';

export function RouteScreen() {
  const { t } = useI18n();
  const [search, setSearch] = useState('');
  const [pendingOnly, setPendingOnly] = useState(false);

  const current = useResource<{ cycle: BillingCycle | null }>('/cycles/current');
  const cycle = current.data?.cycle ?? null;
  const cycleId = cycle?.id ?? null;

  const query = useMemo(
    () => ({ q: search || undefined, pending: pendingOnly ? 'true' : undefined }),
    [search, pendingOnly],
  );
  const route = useResource<{ rows: RouteRow[] }>(
    cycleId === null ? '/cycles/current' : `/cycles/${cycleId}/route`,
    { query },
    `route:${cycleId}:${search}:${pendingOnly}`,
  );
  const progress = useResource<CycleProgress>(
    cycleId === null ? '/cycles/current' : `/cycles/${cycleId}/progress`,
    {},
    `progress:${cycleId}`,
  );

  const queue = useReadingQueue(cycleId);

  // When the queue drains, the server holds values this list does not show yet.
  // Watching the transition, not the value, keeps this from firing on every render.
  const previousPending = useRef(queue.pendingCount);
  useEffect(() => {
    if (previousPending.current > 0 && queue.pendingCount === 0) {
      route.reload();
      progress.reload();
    }
    previousPending.current = queue.pendingCount;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queue.pendingCount]);

  if (current.loading) return <Spinner />;
  if (cycle === null || cycle.status !== 'open') {
    return <EmptyState message={t('route.noOpenCycle')} />;
  }

  return (
    <>
      <section className="toolbar">
        <input
          className="field__input toolbar__search"
          type="search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder={t('subscribers.searchPlaceholder')}
          aria-label={t('app.search')}
          inputMode="search"
        />
        <label className="toolbar__check">
          <input
            type="checkbox"
            checked={pendingOnly}
            onChange={(e) => setPendingOnly(e.target.checked)}
          />
          {t('route.pendingOnly')}
        </label>
      </section>

      {progress.data !== null ? (
        <p className="progress-counter">
          {t('cycle.progress', {
            done: progress.data.readingsEntered,
            total: progress.data.activeSubscribers,
          })}
        </p>
      ) : null}

      {queue.unsentCount > 0 ? (
        <div className="banner banner--warning" role="status">
          <span>{t('route.unsent', { count: queue.unsentCount })}</span>
          <button type="button" className="button button--quiet" onClick={queue.retryAll}>
            {t('route.retry')}
          </button>
        </div>
      ) : null}

      {route.loading && route.data === null ? <Spinner /> : null}

      {route.data !== null && route.data.rows.length === 0 ? (
        <EmptyState message={t('route.empty')} />
      ) : null}

      {route.data !== null && route.data.rows.length > 0 ? (
        <ul className="list route-list">
          {route.data.rows.map((row) => (
            <RouteRowItem
              key={row.subscriberId}
              cycleId={cycle.id}
              row={row}
              queued={queue.bySubscriber.get(row.subscriberId)}
            />
          ))}
        </ul>
      ) : null}
    </>
  );
}
