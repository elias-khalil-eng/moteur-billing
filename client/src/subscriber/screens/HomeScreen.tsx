import { useI18n } from '../../app/I18nContext.js';
import { useResource } from '../../lib/useResource.js';
import {
  formatDateTime,
  formatKwh,
  formatLbp,
  formatPeriod,
  formatPricePerKwh,
  formatUsd,
} from '../../lib/format.js';
import { Spinner } from '../../components/Spinner.js';
import { EmptyState } from '../../components/EmptyState.js';
import type { Bill, LiveUsage } from '../../../../lib/types.js';

interface CurrentBill {
  bill: Bill | null;
  balanceUsdCents: number;
}

interface AppConfig {
  ownerContactName: string | null;
  ownerContactPhone: string | null;
}

export function HomeScreen() {
  const { t, language } = useI18n();
  const current = useResource<CurrentBill>('/me/bills/current', { audience: 'subscriber' });
  const config = useResource<AppConfig>('/config', { audience: 'subscriber' });
  const usage = useResource<LiveUsage>('/me/usage', { audience: 'subscriber' });

  if (current.loading) return <Spinner />;
  if (current.error !== null) return <EmptyState message={current.error.localized(language)} />;
  if (current.data === null) return null;

  const { bill, balanceUsdCents } = current.data;
  const paid = bill !== null && balanceUsdCents <= 0;

  return (
    <>
      {bill === null ? (
        <EmptyState message={t('home.noBill')} />
      ) : (
        <section className="card bill-hero">
          <p className="bill-hero__eyebrow">
            {/* Separate elements, not one string: a middot between Arabic and a month
                name reorders unpredictably under bidi. */}
            <span>{t('home.currentBill')}</span>
            <span className="bill-hero__period">{formatPeriod(bill.period, language)}</span>
          </p>
          <p className="bill-hero__amount">{formatUsd(bill.amountUsdCents)}</p>
          <p className="bill-hero__lbp">{formatLbp(bill.amountLbp, language)}</p>

          <dl className="detail-grid">
            <dt>{t('home.consumption')}</dt>
            <dd>{formatKwh(bill.kwh, language)}</dd>
            <dt>{t('home.price')}</dt>
            <dd>{formatPricePerKwh(bill.usdPerKwhCents, language)}</dd>
          </dl>

          {paid ? <p className="badge badge--positive">{t('home.settled')}</p> : null}
        </section>
      )}

      {usage.data !== null && usage.data.period !== null ? (
        <section className="card">
          <header className="detail-head">
            <h2 className="card__title">{t('home.live.title')}</h2>
            <span className="list__meta">{formatPeriod(usage.data.period, language)}</span>
          </header>

          {usage.data.live !== null && usage.data.live.kwh !== null ? (
            <>
              <p className="amount">{formatKwh(usage.data.live.kwh, language)}</p>
              <p className="bill-hero__amount">{formatUsd(usage.data.live.amountUsdCents ?? 0)}</p>
              <p className="bill-hero__lbp">
                {formatLbp(usage.data.live.amountLbp ?? 0, language)}
              </p>
              {/* Said plainly: the collector's reading is what a bill is made from. */}
              <p className="field__hint">{t('home.live.estimate')}</p>
              <p className="list__meta">
                {t('home.live.reading')}: {formatDateTime(usage.data.live.takenAt, language)}
              </p>
            </>
          ) : (
            <p className="list__meta">
              {!usage.data.hasDevice
                ? t('home.live.noDevice')
                : usage.data.live === null
                  ? t('home.live.waiting')
                  : t('home.live.unavailable')}
            </p>
          )}

          <dl className="detail-grid">
            <dt>{t('home.openPrice')}</dt>
            <dd>{formatPricePerKwh(usage.data.usdPerKwhCents ?? 0, language)}</dd>
          </dl>
        </section>
      ) : null}

      {balanceUsdCents > 0 && (bill === null || balanceUsdCents !== bill.amountUsdCents) ? (
        <section className="card">
          <h2 className="card__title">{t('home.balance')}</h2>
          <p className="amount amount--owing">{formatUsd(balanceUsdCents)}</p>
        </section>
      ) : null}

      {config.data?.ownerContactPhone ? (
        <section className="card contact-line">
          <span>{t('home.contact')}</span>
          <a href={`tel:${config.data.ownerContactPhone}`} className="contact-line__link">
            {config.data.ownerContactName ?? ''} {config.data.ownerContactPhone}
          </a>
        </section>
      ) : null}
    </>
  );
}
