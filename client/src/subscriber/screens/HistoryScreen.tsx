import { useI18n } from '../../app/I18nContext.js';
import { useResource } from '../../lib/useResource.js';
import { formatKwh, formatLbp, formatPeriod, formatUsd } from '../../lib/format.js';
import { Spinner } from '../../components/Spinner.js';
import { EmptyState } from '../../components/EmptyState.js';
import { KwhBarChart } from '../../components/KwhBarChart.js';
import type { Bill } from '../../../../lib/types.js';

export function HistoryScreen() {
  const { t, language } = useI18n();
  const history = useResource<{ bills: Bill[] }>('/me/bills', { audience: 'subscriber' });

  if (history.loading) return <Spinner />;
  if (history.error !== null) return <EmptyState message={history.error.localized(language)} />;

  const bills = history.data?.bills ?? [];
  if (bills.length === 0) return <EmptyState message={t('history.empty')} />;

  const points = [...bills]
    .reverse()
    .map((bill) => ({ label: bill.period.slice(5), kwh: bill.kwh }));

  return (
    <>
      <section className="card">
        <KwhBarChart points={points} title={t('history.chart')} />
      </section>

      <section className="card">
        <h2 className="card__title">{t('history.title')}</h2>
        <ul className="list">
          {bills.map((bill) => (
            <li key={bill.id} className="list__row">
              <span className="list__main">
                <strong>{formatPeriod(bill.period, language)}</strong>
                <span className="list__meta">{formatKwh(bill.kwh, language)}</span>
              </span>
              <span className="list__amount">
                {formatUsd(bill.amountUsdCents)}
                <span className="list__meta">{formatLbp(bill.amountLbp, language)}</span>
              </span>
            </li>
          ))}
        </ul>
      </section>
    </>
  );
}
