import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { ApiError, request } from '../../lib/api.js';
import { useI18n } from '../../app/I18nContext.js';
import { useToast } from '../../app/ToastContext.js';
import { useResource } from '../../lib/useResource.js';
import { formatPeriod, formatPricePerKwh, formatNumber } from '../../lib/format.js';
import { Field } from '../../components/Field.js';
import { Spinner } from '../../components/Spinner.js';
import { IssueDialog } from './IssueDialog.js';
import type { BillingCycle, CycleProgress } from '../../../../lib/types.js';

function thisMonth(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
}

export function CycleScreen() {
  const { t, language } = useI18n();
  const toast = useToast();
  const current = useResource<{ cycle: BillingCycle | null }>('/cycles/current');
  const cycle = current.data?.cycle ?? null;
  const progress = useResource<CycleProgress>(
    cycle === null ? '/cycles/current' : `/cycles/${cycle.id}/progress`,
    {},
    `progress:${cycle?.id ?? 'none'}`,
  );

  const [period, setPeriod] = useState(thisMonth());
  const [price, setPrice] = useState('30');
  const [rate, setRate] = useState('89000');
  const [busy, setBusy] = useState(false);

  // The edit fields must start from the cycle that is actually open. Left on their
  // defaults, Save price would quietly overwrite the owner's price with 30 cents.
  const loadedCycleId = useRef<number | null>(null);
  useEffect(() => {
    if (cycle !== null && loadedCycleId.current !== cycle.id) {
      loadedCycleId.current = cycle.id;
      setPrice(String(cycle.usdPerKwhCents));
      setRate(String(cycle.lbpRate));
    }
  }, [cycle]);
  const [error, setError] = useState<string | null>(null);
  const [issuing, setIssuing] = useState(false);

  async function act(run: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await run();
    } catch (err) {
      const message = err instanceof ApiError ? err.localized(language) : String(err);
      setError(message);
      toast.show(message, 'error');
    } finally {
      setBusy(false);
    }
  }

  function onOpen(event: FormEvent) {
    event.preventDefault();
    void act(async () => {
      await request('/cycles', {
        method: 'POST',
        body: { period, usdPerKwhCents: Number(price), lbpRate: Number(rate) },
      });
      toast.show(t('cycle.opened'), 'success');
      current.reload();
    });
  }

  if (current.loading) return <Spinner />;

  const canOpenNew = cycle === null || cycle.status === 'closed';

  return (
    <>
      {cycle !== null ? (
        <section className="card">
          <header className="detail-head">
            <div>
              <h2>{formatPeriod(cycle.period, language)}</h2>
              <p className="list__meta">{t(`cycle.status.${cycle.status}`)}</p>
            </div>
            <p className="amount">{formatPricePerKwh(cycle.usdPerKwhCents, language)}</p>
          </header>

          <dl className="detail-grid">
            <dt>{t('cycle.rate')}</dt>
            <dd>{formatNumber(cycle.lbpRate)}</dd>
            {progress.data !== null ? (
              <>
                <dt>{t('route.title')}</dt>
                <dd>
                  {t('cycle.progress', {
                    done: progress.data.readingsEntered,
                    total: progress.data.activeSubscribers,
                  })}
                </dd>
              </>
            ) : null}
          </dl>

          {cycle.status === 'open' ? (
            <form
              className="inline-form"
              onSubmit={(event) => {
                event.preventDefault();
                void act(async () => {
                  await request(`/cycles/${cycle.id}`, {
                    method: 'PATCH',
                    body: { usdPerKwhCents: Number(price), lbpRate: Number(rate) },
                  });
                  toast.show(t('cycle.priceSaved'), 'success');
                  current.reload();
                });
              }}
            >
              <Field
                label={t('cycle.price')}
                value={price}
                inputMode="numeric"
                onChange={(e) => setPrice(e.target.value.replace(/[^\d]/g, ''))}
              />
              <Field
                label={t('cycle.rate')}
                value={rate}
                inputMode="numeric"
                onChange={(e) => setRate(e.target.value.replace(/[^\d]/g, ''))}
              />
              <button className="button" type="submit" disabled={busy}>
                {t('cycle.savePrice')}
              </button>
            </form>
          ) : null}

          {cycle.status === 'open' ? (
            <div className="form-actions form-actions--wrap">
              <button
                type="button"
                className="button button--primary"
                disabled={busy}
                onClick={() => setIssuing(true)}
              >
                {t('issue.action')}
              </button>
            </div>
          ) : null}

          {cycle.status === 'issued' ? (
            <div className="form-actions form-actions--wrap">
              <button
                type="button"
                className="button button--danger"
                disabled={busy}
                onClick={() =>
                  void act(async () => {
                    if (!window.confirm(t('cycle.closeConfirm'))) return;
                    await request(`/cycles/${cycle.id}/close`, { method: 'POST' });
                    toast.show(t('cycle.closed'), 'success');
                    current.reload();
                  })
                }
              >
                {t('cycle.close')}
              </button>
            </div>
          ) : null}
        </section>
      ) : null}

      {canOpenNew ? (
        <form className="card" onSubmit={onOpen}>
          <h2>{t('cycle.open')}</h2>
          <Field
            label={t('cycle.period')}
            value={period}
            onChange={(e) => setPeriod(e.target.value)}
            placeholder="2026-09"
          />
          <Field
            label={t('cycle.price')}
            value={price}
            inputMode="numeric"
            onChange={(e) => setPrice(e.target.value.replace(/[^\d]/g, ''))}
          />
          <Field
            label={t('cycle.rate')}
            value={rate}
            inputMode="numeric"
            onChange={(e) => setRate(e.target.value.replace(/[^\d]/g, ''))}
            error={error}
          />
          <div className="form-actions">
            <button className="button button--primary" type="submit" disabled={busy}>
              {t('cycle.open')}
            </button>
          </div>
        </form>
      ) : null}

      {issuing && cycle !== null ? (
        <IssueDialog
          cycleId={cycle.id}
          onClose={() => setIssuing(false)}
          onIssued={(result) => {
            setIssuing(false);
            toast.show(result.alreadyIssued ? t('issue.alreadyIssued') : t('issue.done'), 'success');
            current.reload();
            progress.reload();
          }}
        />
      ) : null}
    </>
  );
}
