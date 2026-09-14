import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useI18n } from '../../app/I18nContext.js';
import { useStaffAuth } from '../../app/AuthContext.js';
import { useResource } from '../../lib/useResource.js';
import { formatUsd } from '../../lib/format.js';
import { Spinner } from '../../components/Spinner.js';
import { EmptyState } from '../../components/EmptyState.js';
import type { Paged, SubscriberWithBalance } from '../../../../lib/types.js';

export function SubscribersScreen() {
  const { t, language } = useI18n();
  const { identity } = useStaffAuth();
  const [search, setSearch] = useState('');
  const [onlyDebt, setOnlyDebt] = useState(false);
  const [status, setStatus] = useState('');

  const query = useMemo(
    () => ({
      q: search || undefined,
      hasDebt: onlyDebt ? 'true' : undefined,
      status: status || undefined,
      pageSize: 200,
    }),
    [search, onlyDebt, status],
  );
  const list = useResource<Paged<SubscriberWithBalance>>(
    '/subscribers',
    { query },
    `subscribers:${search}:${onlyDebt}:${status}`,
  );

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
        <select
          className="field__input"
          value={status}
          onChange={(e) => setStatus(e.target.value)}
          aria-label={t('subscriber.status')}
        >
          <option value="">{t('subscribers.allStatuses')}</option>
          <option value="active">{t('subscriber.status.active')}</option>
          <option value="suspended">{t('subscriber.status.suspended')}</option>
          <option value="disconnected">{t('subscriber.status.disconnected')}</option>
        </select>
        <label className="toolbar__check">
          <input
            type="checkbox"
            checked={onlyDebt}
            onChange={(e) => setOnlyDebt(e.target.checked)}
          />
          {t('subscribers.onlyDebt')}
        </label>
        {identity?.role === 'owner' ? (
          <Link className="button button--primary" to="/staff/subscribers/new">
            {t('subscribers.add')}
          </Link>
        ) : null}
      </section>

      {list.loading ? <Spinner /> : null}
      {list.error ? <EmptyState message={list.error.localized(language)} /> : null}

      {list.data !== null && list.data.items.length === 0 ? (
        <EmptyState message={t('subscribers.empty')} />
      ) : null}

      {list.data !== null && list.data.items.length > 0 ? (
        <>
          <p className="list-count">{t('subscribers.count', { count: list.data.total })}</p>
          <ul className="list">
            {list.data.items.map((subscriber) => (
              <li key={subscriber.id}>
                <Link className="list__row" to={`/staff/subscribers/${subscriber.id}`}>
                  <span className="list__main">
                    <strong>{subscriber.name}</strong>
                    <span className="list__meta">
                      {subscriber.code}
                      {subscriber.zone ? ` · ${t('subscribers.zone')} ${subscriber.zone}` : ''}
                      {subscriber.status === 'active'
                        ? ''
                        : ` · ${t(`subscriber.status.${subscriber.status}`)}`}
                    </span>
                  </span>
                  <span
                    className={
                      subscriber.balanceUsdCents > 0
                        ? 'list__amount list__amount--owing'
                        : 'list__amount'
                    }
                  >
                    {subscriber.balanceUsdCents === 0
                      ? t('subscribers.settled')
                      : formatUsd(subscriber.balanceUsdCents)}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </>
      ) : null}
    </>
  );
}
