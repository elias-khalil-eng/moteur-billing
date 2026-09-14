import { useState } from 'react';
import { useI18n } from '../../app/I18nContext.js';
import { useResource } from '../../lib/useResource.js';
import {
  formatBasisPoints,
  formatCentis,
  formatKwh,
  formatNumber,
  formatUsd,
} from '../../lib/format.js';
import { Spinner } from '../../components/Spinner.js';
import { EmptyState } from '../../components/EmptyState.js';
import type { ExpenseCategory } from '../../../../lib/types.js';

interface Profit {
  revenueBilledUsdCents: number;
  revenueCollectedUsdCents: number;
  expensesUsdCents: number;
  expensesByCategory: Record<ExpenseCategory, number>;
  netCollectedUsdCents: number;
  kwhSold: number;
  costPerKwhCentis: number | null;
  collectionRateBasisPoints: number | null;
}

interface Consumption {
  totalKwh: number;
  subscriberCount: number;
  meanKwh: number | null;
  medianKwh: number | null;
  estimatedCount: number;
  topConsumers: { subscriberId: number; code: string; name: string; kwh: number }[];
}

interface Collection {
  rows: { key: string; label: string; amountUsdCents: number; paymentCount: number }[];
  totalUsdCents: number;
}

function thisMonth(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
}

export function ReportsScreen() {
  const { t, language } = useI18n();
  const [period, setPeriod] = useState(thisMonth());

  const profit = useResource<Profit>('/reports/profit', { query: { period } }, `profit:${period}`);
  const consumption = useResource<Consumption>(
    '/reports/consumption',
    { query: { period } },
    `consumption:${period}`,
  );
  const collection = useResource<Collection>(
    '/reports/collection',
    { query: { groupBy: 'collector' } },
    'collection:collector',
  );

  return (
    <>
      <section className="toolbar">
        <input
          className="field__input"
          type="month"
          value={period}
          aria-label={t('reports.period')}
          onChange={(e) => setPeriod(e.target.value)}
        />
      </section>

      {profit.loading ? <Spinner /> : null}

      {profit.data !== null ? (
        <section className="card">
          <h2 className="card__title">{t('reports.profit')}</h2>
          <div className="stat-grid">
            <div className="stat">
              <span className="stat__label">{t('reports.billed')}</span>
              <span className="stat__value">{formatUsd(profit.data.revenueBilledUsdCents)}</span>
            </div>
            <div className="stat">
              <span className="stat__label">{t('reports.collected')}</span>
              <span className="stat__value">{formatUsd(profit.data.revenueCollectedUsdCents)}</span>
            </div>
            <div className="stat">
              <span className="stat__label">{t('reports.expenses')}</span>
              <span className="stat__value">{formatUsd(profit.data.expensesUsdCents)}</span>
            </div>
            <div className="stat">
              <span className="stat__label">{t('reports.net')}</span>
              <span className="stat__value">{formatUsd(profit.data.netCollectedUsdCents)}</span>
            </div>
            <div className="stat">
              <span className="stat__label">{t('reports.kwhSold')}</span>
              <span className="stat__value">{formatKwh(profit.data.kwhSold, language)}</span>
            </div>
            <div className="stat">
              <span className="stat__label">{t('reports.costPerKwh')}</span>
              <span className="stat__value">
                {formatCentis(profit.data.costPerKwhCentis, language)}
              </span>
            </div>
            <div className="stat">
              <span className="stat__label">{t('reports.collectionRate')}</span>
              <span className="stat__value">
                {formatBasisPoints(profit.data.collectionRateBasisPoints)}
              </span>
            </div>
          </div>

          <dl className="detail-grid">
            {(Object.keys(profit.data.expensesByCategory) as ExpenseCategory[]).map((category) => (
              <div key={category} className="detail-grid__pair">
                <dt>{t(`expenses.category.${category}`)}</dt>
                <dd>{formatUsd(profit.data!.expensesByCategory[category])}</dd>
              </div>
            ))}
          </dl>
        </section>
      ) : null}

      {consumption.data !== null ? (
        <section className="card">
          <h2 className="card__title">{t('reports.consumption')}</h2>
          <div className="stat-grid">
            <div className="stat">
              <span className="stat__label">{t('reports.kwhSold')}</span>
              <span className="stat__value">{formatKwh(consumption.data.totalKwh, language)}</span>
            </div>
            <div className="stat">
              <span className="stat__label">{t('reports.mean')}</span>
              <span className="stat__value">
                {consumption.data.meanKwh === null
                  ? '—'
                  : formatKwh(consumption.data.meanKwh, language)}
              </span>
            </div>
            <div className="stat">
              <span className="stat__label">{t('reports.median')}</span>
              <span className="stat__value">
                {consumption.data.medianKwh === null
                  ? '—'
                  : formatKwh(consumption.data.medianKwh, language)}
              </span>
            </div>
            <div className="stat">
              <span className="stat__label">{t('reports.estimated')}</span>
              <span className="stat__value">{formatNumber(consumption.data.estimatedCount)}</span>
            </div>
          </div>

          <h3 className="card__title">{t('reports.topConsumers')}</h3>
          {consumption.data.topConsumers.length === 0 ? (
            <EmptyState message={t('history.empty')} />
          ) : (
            <ul className="list">
              {consumption.data.topConsumers.map((entry) => (
                <li key={entry.subscriberId} className="list__row">
                  <span className="list__main">
                    <strong>{entry.name}</strong>
                    <span className="list__meta">{entry.code}</span>
                  </span>
                  <span className="list__amount">{formatKwh(entry.kwh, language)}</span>
                </li>
              ))}
            </ul>
          )}
        </section>
      ) : null}

      {collection.data !== null ? (
        <section className="card">
          <h2 className="card__title">{t('reports.byCollector')}</h2>
          <ul className="list">
            {collection.data.rows.map((row) => (
              <li key={row.key} className="list__row">
                <span className="list__main">
                  <strong>{row.label}</strong>
                  <span className="list__meta">{formatNumber(row.paymentCount)}</span>
                </span>
                <span className="list__amount">{formatUsd(row.amountUsdCents)}</span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </>
  );
}
