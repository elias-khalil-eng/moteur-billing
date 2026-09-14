import { useState } from 'react';
import { useI18n } from '../../app/I18nContext.js';
import { useToast } from '../../app/ToastContext.js';
import { useResource } from '../../lib/useResource.js';
import { ApiError, request } from '../../lib/api.js';
import { formatDateTime } from '../../lib/format.js';
import { Spinner } from '../../components/Spinner.js';
import { EmptyState } from '../../components/EmptyState.js';
import type { ServiceRequestStatus, ServiceRequestWithSubscriber } from '../../../../lib/types.js';
import type { TranslationKey } from '../../lib/i18n.js';

const FILTERS: (ServiceRequestStatus | 'all')[] = [
  'all',
  'open',
  'in_progress',
  'resolved',
  'rejected',
];

/** The three moves the owner can make on a request that is still live. */
const MOVES: { status: ServiceRequestStatus; label: TranslationKey }[] = [
  { status: 'in_progress', label: 'queue.start' },
  { status: 'resolved', label: 'queue.resolve' },
  { status: 'rejected', label: 'queue.reject' },
];

function badgeClass(status: ServiceRequestStatus): string {
  if (status === 'resolved') return 'badge badge--positive';
  if (status === 'rejected') return 'badge badge--danger';
  return 'badge';
}

export function QueueScreen() {
  const { t, language } = useI18n();
  const toast = useToast();
  const [filter, setFilter] = useState<ServiceRequestStatus | 'all'>('open');
  const list = useResource<{ requests: ServiceRequestWithSubscriber[] }>(
    '/requests',
    { query: { status: filter === 'all' ? undefined : filter } },
    `requests:${filter}`,
  );
  // A note is typed against the request being read, so it is keyed by request id.
  const [notes, setNotes] = useState<Record<number, string>>({});
  const [busy, setBusy] = useState(false);

  function move(id: number, status: ServiceRequestStatus) {
    setBusy(true);
    const ownerNote = notes[id]?.trim();
    void request(`/requests/${id}`, {
      method: 'PATCH',
      body: { status, ...(ownerNote ? { ownerNote } : {}) },
    })
      .then(() => {
        toast.show(t('queue.updated'), 'success');
        setNotes((current) => ({ ...current, [id]: '' }));
        list.reload();
      })
      .catch((err: unknown) => {
        toast.show(err instanceof ApiError ? err.localized(language) : String(err), 'error');
      })
      .finally(() => setBusy(false));
  }

  const requests = list.data?.requests ?? [];

  return (
    <>
      <section className="toolbar">
        <div className="segmented" role="group" aria-label={t('queue.title')}>
          {FILTERS.map((option) => (
            <button
              key={option}
              type="button"
              className={`segmented__option ${filter === option ? 'segmented__option--on' : ''}`}
              onClick={() => setFilter(option)}
            >
              {option === 'all' ? t('queue.all') : t(`requests.status.${option}`)}
            </button>
          ))}
        </div>
      </section>

      {list.loading ? <Spinner /> : null}

      {!list.loading && requests.length === 0 ? <EmptyState message={t('queue.empty')} /> : null}

      {requests.length > 0 ? (
        <section className="card">
          <header className="detail-head">
            <h2 className="card__title">{t('queue.title')}</h2>
            <span className="list-count">{t('queue.count', { count: requests.length })}</span>
          </header>

          <ul className="list">
            {requests.map((item) => (
              <li key={item.id} className="list__row">
                <span className="list__main">
                  <strong>{item.subscriberName}</strong>
                  <span className="list__meta">{item.subscriberCode}</span>
                  <span className="list__meta">{t(`requests.kind.${item.kind}`)}</span>
                  <span className="list__meta">{item.body}</span>
                  <span className="list__meta">{formatDateTime(item.createdAt, language)}</span>
                  {item.subscriberPhone === null ? null : (
                    <a className="contact-line__link" href={`tel:${item.subscriberPhone}`}>
                      {item.subscriberPhone}
                    </a>
                  )}
                  {item.ownerNote === null ? null : (
                    <span className="list__meta">
                      {t('queue.note')}: {item.ownerNote}
                    </span>
                  )}

                  {item.status === 'open' || item.status === 'in_progress' ? (
                    <>
                      <textarea
                        className="field__input"
                        rows={2}
                        maxLength={1000}
                        aria-label={t('queue.note')}
                        placeholder={t('queue.note')}
                        value={notes[item.id] ?? ''}
                        onChange={(e) =>
                          setNotes((current) => ({ ...current, [item.id]: e.target.value }))
                        }
                      />
                      <span className="form-actions form-actions--wrap">
                        {MOVES.filter((m) => m.status !== item.status).map((m) => (
                          <button
                            key={m.status}
                            type="button"
                            className={`button ${m.status === 'rejected' ? 'button--danger' : ''}`}
                            disabled={busy}
                            onClick={() => move(item.id, m.status)}
                          >
                            {t(m.label)}
                          </button>
                        ))}
                      </span>
                    </>
                  ) : null}
                </span>
                <span className={badgeClass(item.status)}>
                  {t(`requests.status.${item.status}`)}
                </span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </>
  );
}
