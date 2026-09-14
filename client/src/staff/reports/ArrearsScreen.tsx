import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useI18n } from '../../app/I18nContext.js';
import { useResource } from '../../lib/useResource.js';
import { formatUsd } from '../../lib/format.js';
import { Spinner } from '../../components/Spinner.js';
import { EmptyState } from '../../components/EmptyState.js';

const BUCKETS = ['0-30', '31-60', '61-90', '90+'] as const;

interface ArrearsReport {
  totals: Record<string, number>;
  totalOwedUsdCents: number;
  entries: {
    subscriberId: number;
    code: string;
    name: string;
    zone: string | null;
    balanceUsdCents: number;
    unpaidCycles: number;
    oldestUnpaidDays: number | null;
    disconnectCandidate: boolean;
  }[];
}

export function ArrearsScreen() {
  const { t, language } = useI18n();
  const [candidatesOnly, setCandidatesOnly] = useState(false);
  const report = useResource<ArrearsReport>('/reports/arrears');

  if (report.loading) return <Spinner />;
  if (report.error !== null) return <EmptyState message={report.error.localized(language)} />;
  if (report.data === null) return null;

  const data = report.data;
  const entries = candidatesOnly
    ? data.entries.filter((entry) => entry.disconnectCandidate)
    : data.entries;

  return (
    <>
      <section className="card">
        <h2 className="card__title">{t('arrears.total')}</h2>
        <p className="amount amount--owing">{formatUsd(data.totalOwedUsdCents)}</p>

        <div className="bucket-grid">
          {BUCKETS.map((bucket) => (
            <div className="bucket" key={bucket}>
              <span className="bucket__label">{bucket}</span>
              <span className="bucket__amount">{formatUsd(data.totals[bucket] ?? 0)}</span>
            </div>
          ))}
        </div>
      </section>

      <label className="toolbar__check">
        <input
          type="checkbox"
          checked={candidatesOnly}
          onChange={(e) => setCandidatesOnly(e.target.checked)}
        />
        {t('arrears.candidates')}
      </label>

      {entries.length === 0 ? (
        <EmptyState message={t('arrears.empty')} />
      ) : (
        <ul className="list">
          {entries.map((entry) => (
            <li key={entry.subscriberId}>
              <Link className="list__row" to={`/staff/subscribers/${entry.subscriberId}`}>
                <span className="list__main">
                  <strong>{entry.name}</strong>
                  <span className="list__meta">
                    {entry.code}
                    {` · ${t('arrears.cycles', { count: entry.unpaidCycles })}`}
                    {entry.oldestUnpaidDays === null
                      ? ''
                      : ` · ${entry.oldestUnpaidDays} ${t('arrears.bucket')}`}
                  </span>
                  {entry.disconnectCandidate ? (
                    <span className="badge badge--danger">{t('arrears.candidate')}</span>
                  ) : null}
                </span>
                <span className="list__amount list__amount--owing">
                  {formatUsd(entry.balanceUsdCents)}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
