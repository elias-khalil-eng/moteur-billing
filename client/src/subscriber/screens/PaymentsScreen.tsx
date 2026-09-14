import { useI18n } from '../../app/I18nContext.js';
import { useResource } from '../../lib/useResource.js';
import { formatDate, formatLbp, formatUsd } from '../../lib/format.js';
import { Spinner } from '../../components/Spinner.js';
import { EmptyState } from '../../components/EmptyState.js';
import type { Payment } from '../../../../lib/types.js';

export function PaymentsScreen() {
  const { t, language } = useI18n();
  const list = useResource<{ payments: Payment[] }>('/me/payments', { audience: 'subscriber' });

  if (list.loading) return <Spinner />;
  if (list.error !== null) return <EmptyState message={list.error.localized(language)} />;

  const payments = list.data?.payments ?? [];
  if (payments.length === 0) return <EmptyState message={t('payments.empty')} />;

  return (
    <section className="card">
      <h2 className="card__title">{t('payments.title')}</h2>
      <ul className="list">
        {payments.map((payment) => (
          <li key={payment.id} className="list__row">
            <span className="list__main">
              <strong>{formatDate(payment.paidAt, language)}</strong>
              <span className="list__meta">
                {t('payments.receivedBy')} {payment.receivedByName ?? ''}
                {payment.voidedAt === null ? '' : ` · ${t('subscriber.voided')}`}
              </span>
            </span>
            <span
              className={
                payment.voidedAt === null ? 'list__amount' : 'list__amount list__amount--voided'
              }
            >
              {formatUsd(payment.amountUsdCents)}
              {payment.amountLbp === null ? null : (
                <span className="list__meta">{formatLbp(payment.amountLbp, language)}</span>
              )}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}
