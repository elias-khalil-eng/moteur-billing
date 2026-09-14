import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { ApiError, request } from '../../lib/api.js';
import { useI18n } from '../../app/I18nContext.js';
import { useToast } from '../../app/ToastContext.js';
import { formatLbp, formatPeriod, formatUsd, parseUsdToCents } from '../../lib/format.js';
import { Field } from '../../components/Field.js';
import { SubscriberPicker } from '../../components/SubscriberPicker.js';
import { EmptyState } from '../../components/EmptyState.js';
import type { PaidCurrency, SubscriberWithBalance } from '../../../../lib/types.js';

interface Detail {
  subscriber: { id: number; code: string; name: string };
  balanceUsdCents: number;
  balanceLbp: number | null;
  lbpRate: number | null;
  bills: { id: number; period: string; amountUsdCents: number; amountLbp: number }[];
}

/** Cents to a plain editable string, without dividing a monetary value by 100 as a float. */
function formatUsdInput(amountUsdCents: number): string {
  const dollars = Math.trunc(amountUsdCents / 100);
  return `${dollars}.${String(amountUsdCents % 100).padStart(2, '0')}`;
}

export function CollectScreen() {
  const { t, language } = useI18n();
  const toast = useToast();
  const [picked, setPicked] = useState<SubscriberWithBalance | null>(null);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [currency, setCurrency] = useState<PaidCurrency>('USD');
  const [amountUsd, setAmountUsd] = useState('');
  const [amountLbp, setAmountLbp] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (picked === null) {
      setDetail(null);
      return;
    }
    request<Detail>(`/subscribers/${picked.id}`)
      .then((loaded) => {
        setDetail(loaded);
        // The LBP figure is what the server converted, not a browser calculation.
        setAmountUsd(loaded.balanceUsdCents > 0 ? formatUsdInput(loaded.balanceUsdCents) : '');
        setAmountLbp(loaded.balanceLbp !== null && loaded.balanceLbp > 0 ? String(loaded.balanceLbp) : '');
      })
      .catch((err: unknown) => setError(err instanceof ApiError ? err.localized(language) : String(err)));
  }, [picked]);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    if (detail === null) return;
    const amountUsdCents = parseUsdToCents(amountUsd);
    if (currency === 'USD' && amountUsdCents === null) {
      setError(t('collect.amountUsd'));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const body =
        currency === 'USD'
          ? {
              subscriberId: detail.subscriber.id,
              paidCurrency: 'USD',
              amountUsdCents,
            }
          : {
              subscriberId: detail.subscriber.id,
              paidCurrency: 'LBP',
              amountLbp: Number(amountLbp),
              lbpRateUsed: detail.lbpRate,
            };
      await request('/payments', {
        method: 'POST',
        body: { ...body, ...(note.trim() === '' ? {} : { note: note.trim() }) },
      });
      toast.show(t('collect.done'), 'success');
      setPicked(null);
      setNote('');
    } catch (err) {
      const message = err instanceof ApiError ? err.localized(language) : String(err);
      setError(message);
      toast.show(message, 'error');
    } finally {
      setBusy(false);
    }
  }

  const currentBill = detail?.bills[0];

  return (
    <>
      <section className="card">
        <h2 className="card__title">{t('collect.find')}</h2>
        <SubscriberPicker label={t('collect.find')} onPick={setPicked} />
      </section>

      {detail === null ? (
        <EmptyState message={t('collect.pickSubscriber')} />
      ) : (
        <form className="card" onSubmit={onSubmit}>
          <header className="detail-head">
            <div>
              <h2>{detail.subscriber.name}</h2>
              <p className="list__meta">{detail.subscriber.code}</p>
            </div>
            <p className={detail.balanceUsdCents > 0 ? 'amount amount--owing' : 'amount'}>
              {formatUsd(detail.balanceUsdCents)}
            </p>
          </header>

          {currentBill !== undefined ? (
            <dl className="detail-grid">
              <dt>{t('collect.currentBill')}</dt>
              <dd>
                {formatPeriod(currentBill.period, language)} · {formatUsd(currentBill.amountUsdCents)}
              </dd>
              {detail.balanceLbp !== null ? (
                <>
                  <dt>{t('collect.balance')}</dt>
                  <dd>{formatLbp(detail.balanceLbp, language)}</dd>
                </>
              ) : null}
            </dl>
          ) : null}

          <div className="segmented" role="group" aria-label={t('collect.currency')}>
            {(['USD', 'LBP'] as const).map((option) => (
              <button
                key={option}
                type="button"
                className={`segmented__option ${currency === option ? 'segmented__option--on' : ''}`}
                onClick={() => setCurrency(option)}
                disabled={option === 'LBP' && detail.lbpRate === null}
              >
                {option}
              </button>
            ))}
          </div>

          {currency === 'USD' ? (
            <Field
              label={t('collect.amountUsd')}
              value={amountUsd}
              inputMode="decimal"
              onChange={(e) => setAmountUsd(e.target.value.replace(/[^\d.]/g, ''))}
              error={error}
            />
          ) : (
            <Field
              label={t('collect.amountLbp')}
              value={amountLbp}
              inputMode="numeric"
              onChange={(e) => setAmountLbp(e.target.value.replace(/[^\d]/g, ''))}
              error={error}
            />
          )}

          <Field
            label={t('collect.note')}
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />

          <div className="form-actions">
            <button className="button button--primary" type="submit" disabled={busy}>
              {t('collect.submit')}
            </button>
          </div>
        </form>
      )}
    </>
  );
}
