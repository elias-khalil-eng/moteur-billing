import { useState } from 'react';
import type { FormEvent } from 'react';
import { useI18n } from '../../app/I18nContext.js';
import { useToast } from '../../app/ToastContext.js';
import { useResource } from '../../lib/useResource.js';
import { ApiError, request } from '../../lib/api.js';
import { formatDateTime } from '../../lib/format.js';
import { Spinner } from '../../components/Spinner.js';
import { EmptyState } from '../../components/EmptyState.js';
import type { ServiceRequest, ServiceRequestKind } from '../../../../lib/types.js';

const KINDS: ServiceRequestKind[] = [
  'meter_issue',
  'billing_question',
  'new_connection',
  'disconnect',
  'other',
];

/** Waiting and in progress read as neutral; only a decision earns a colour. */
function badgeClass(status: ServiceRequest['status']): string {
  if (status === 'resolved') return 'badge badge--positive';
  if (status === 'rejected') return 'badge badge--danger';
  return 'badge';
}

export function RequestsScreen() {
  const { t, language } = useI18n();
  const toast = useToast();
  const list = useResource<{ requests: ServiceRequest[] }>('/me/requests', {
    audience: 'subscriber',
  });
  const [kind, setKind] = useState<ServiceRequestKind>('meter_issue');
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    void request('/me/requests', {
      method: 'POST',
      audience: 'subscriber',
      body: { kind, body: body.trim() },
    })
      .then(() => {
        toast.show(t('requests.sent'), 'success');
        setBody('');
        list.reload();
      })
      .catch((err: unknown) => {
        const message = err instanceof ApiError ? err.localized(language) : String(err);
        setError(message);
        toast.show(message, 'error');
      })
      .finally(() => setBusy(false));
  }

  return (
    <>
      <form className="card" onSubmit={onSubmit}>
        <h2 className="card__title">{t('requests.new')}</h2>

        <div className="field">
          <label className="field__label" htmlFor="request-kind">
            {t('requests.kind')}
          </label>
          <select
            id="request-kind"
            className="field__input"
            value={kind}
            onChange={(e) => setKind(e.target.value as ServiceRequestKind)}
          >
            {KINDS.map((option) => (
              <option key={option} value={option}>
                {t(`requests.kind.${option}`)}
              </option>
            ))}
          </select>
        </div>

        <div className="field">
          <label className="field__label" htmlFor="request-body">
            {t('requests.body')}
          </label>
          <textarea
            id="request-body"
            className="field__input"
            rows={4}
            maxLength={1000}
            value={body}
            placeholder={t('requests.bodyPlaceholder')}
            onChange={(e) => setBody(e.target.value)}
          />
          {error === null ? null : <p className="field__error">{error}</p>}
        </div>

        <div className="form-actions">
          <button
            className="button button--primary"
            type="submit"
            disabled={busy || body.trim() === ''}
          >
            {t('requests.send')}
          </button>
        </div>
      </form>

      {list.loading ? <Spinner /> : null}

      {list.data !== null && list.data.requests.length === 0 ? (
        <EmptyState message={t('requests.empty')} />
      ) : null}

      {list.data !== null && list.data.requests.length > 0 ? (
        <section className="card">
          <h2 className="card__title">{t('requests.title')}</h2>
          <ul className="list">
            {list.data.requests.map((item) => (
              <li key={item.id} className="list__row">
                <span className="list__main">
                  <strong>{t(`requests.kind.${item.kind}`)}</strong>
                  <span className="list__meta">{item.body}</span>
                  <span className="list__meta">{formatDateTime(item.createdAt, language)}</span>
                  {item.ownerNote === null ? null : (
                    <span className="list__meta">
                      {t('requests.ownerNote')}: {item.ownerNote}
                    </span>
                  )}
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
