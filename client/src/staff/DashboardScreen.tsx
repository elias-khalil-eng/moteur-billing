import { useI18n } from '../app/I18nContext.js';
import { useResource } from '../lib/useResource.js';
import { formatPeriod, formatPricePerKwh, formatUsd } from '../lib/format.js';
import { Spinner } from '../components/Spinner.js';
import { EmptyState } from '../components/EmptyState.js';
import type { BillingCycle, CycleProgress } from '../../../lib/types.js';

interface Profit {
  revenueBilledUsdCents: number;
  revenueCollectedUsdCents: number;
  expensesUsdCents: number;
  netCollectedUsdCents: number;
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: 'owing' | 'good' }) {
  return (
    <div className="stat">
      <span className="stat__label">{label}</span>
      <span className={`stat__value ${tone === 'owing' ? 'stat__value--owing' : ''}`}>{value}</span>
    </div>
  );
}

export function DashboardScreen() {
  const { t, language } = useI18n();
  const current = useResource<{ cycle: BillingCycle | null }>('/cycles/current');
  const cycle = current.data?.cycle ?? null;

  const progress = useResource<CycleProgress>(
    cycle === null ? '/cycles/current' : `/cycles/${cycle.id}/progress`,
    {},
    `dash-progress:${cycle?.id ?? 'none'}`,
  );
  const profit = useResource<Profit>(
    '/reports/profit',
    { query: { period: cycle?.period } },
    `dash-profit:${cycle?.period ?? 'none'}`,
  );
  const arrears = useResource<{ totalOwedUsdCents: number }>('/reports/arrears');

  if (current.loading) return <Spinner />;

  return (
    <>
      <section className="card">
        <h2 className="card__title">{t('dashboard.openCycle')}</h2>
        {cycle === null ? (
          <EmptyState message={t('dashboard.noCycle')} />
        ) : (
          <>
            <header className="detail-head">
              <div>
                <h3>{formatPeriod(cycle.period, language)}</h3>
                <p className="list__meta">{t(`cycle.status.${cycle.status}`)}</p>
              </div>
              <p className="amount">{formatPricePerKwh(cycle.usdPerKwhCents, language)}</p>
            </header>
            {progress.data !== null ? (
              <p className="progress-counter">
                {t('cycle.progress', {
                  done: progress.data.readingsEntered,
                  total: progress.data.activeSubscribers,
                })}
              </p>
            ) : null}
          </>
        )}
      </section>

      <section className="card">
        <div className="stat-grid">
          <Stat
            label={t('dashboard.billed')}
            value={formatUsd(profit.data?.revenueBilledUsdCents ?? 0)}
          />
          <Stat
            label={t('dashboard.collected')}
            value={formatUsd(profit.data?.revenueCollectedUsdCents ?? 0)}
          />
          <Stat
            label={t('dashboard.expenses')}
            value={formatUsd(profit.data?.expensesUsdCents ?? 0)}
          />
          <Stat label={t('dashboard.net')} value={formatUsd(profit.data?.netCollectedUsdCents ?? 0)} />
          <Stat
            label={t('dashboard.outstanding')}
            value={formatUsd(arrears.data?.totalOwedUsdCents ?? 0)}
            tone="owing"
          />
        </div>
      </section>
    </>
  );
}
