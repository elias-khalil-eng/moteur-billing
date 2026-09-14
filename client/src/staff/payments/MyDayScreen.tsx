import { useI18n } from '../../app/I18nContext.js';
import { useStaffAuth } from '../../app/AuthContext.js';
import { useResource } from '../../lib/useResource.js';
import { beirutDayKey, formatDateTime, formatUsd } from '../../lib/format.js';
import { Spinner } from '../../components/Spinner.js';
import { EmptyState } from '../../components/EmptyState.js';
import type { Payment } from '../../../../lib/types.js';

interface CollectionReport {
  rows: { key: string; amountUsdCents: number; paymentCount: number }[];
}

/** What this collector took in today, so cash can be counted at handover. */
export function MyDayScreen() {
  const { t, language } = useI18n();
  const { identity } = useStaffAuth();
  const today = beirutDayKey(new Date());

  const collection = useResource<CollectionReport>(
    '/reports/collection',
    { query: { groupBy: 'day' } },
    `myday-total:${identity?.id ?? 0}`,
  );
  const payments = useResource<{ payments: Payment[] }>(
    '/payments',
    { query: { receivedBy: identity?.id } },
    `myday-list:${identity?.id ?? 0}`,
  );

  if (collection.loading || payments.loading) return <Spinner />;

  const todayRow = collection.data?.rows.find((row) => row.key === today);
  const todayPayments = (payments.data?.payments ?? []).filter(
    (payment) => payment.voidedAt === null && beirutDayKey(payment.paidAt) === today,
  );

  return (
    <>
      <section className="card bill-hero">
        <p className="bill-hero__eyebrow">{t('myDay.total')}</p>
        <p className="bill-hero__amount">{formatUsd(todayRow?.amountUsdCents ?? 0)}</p>
        <p className="bill-hero__lbp">
          {t('myDay.count', { count: todayRow?.paymentCount ?? 0 })}
        </p>
      </section>

      {todayPayments.length === 0 ? (
        <EmptyState message={t('myDay.empty')} />
      ) : (
        <ul className="list">
          {todayPayments.map((payment) => (
            <li key={payment.id} className="list__row">
              <span className="list__main">
                <strong>{formatDateTime(payment.paidAt, language)}</strong>
                <span className="list__meta">
                  {payment.paidCurrency}
                  {payment.note === null ? '' : ` · ${payment.note}`}
                </span>
              </span>
              <span className="list__amount">{formatUsd(payment.amountUsdCents)}</span>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
