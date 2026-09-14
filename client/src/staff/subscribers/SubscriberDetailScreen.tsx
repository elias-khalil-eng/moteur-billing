import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { ApiError, request } from '../../lib/api.js';
import { useI18n } from '../../app/I18nContext.js';
import { useToast } from '../../app/ToastContext.js';
import { useStaffAuth } from '../../app/AuthContext.js';
import { useResource } from '../../lib/useResource.js';
import { formatDate, formatKwh, formatLbp, formatPeriod, formatUsd } from '../../lib/format.js';
import { Spinner } from '../../components/Spinner.js';
import { EmptyState } from '../../components/EmptyState.js';
import { PinDialog } from '../../components/PinDialog.js';
import type { SubscriberStatus } from '../../../../lib/types.js';

interface Detail {
  subscriber: {
    id: number;
    code: string;
    name: string;
    phone: string | null;
    zone: string | null;
    address: string | null;
    meterSerial: string | null;
    status: SubscriberStatus;
    notes: string | null;
  };
  balanceUsdCents: number;
  bills: { id: number; period: string; kwh: number; amountUsdCents: number; amountLbp: number }[];
  payments: {
    id: number;
    amountUsdCents: number;
    paidCurrency: string;
    paidAt: string;
    receivedByName: string;
    voidedAt: string | null;
  }[];
}

export function SubscriberDetailScreen() {
  const { t, language } = useI18n();
  const toast = useToast();
  const navigate = useNavigate();
  const { identity } = useStaffAuth();
  const { id } = useParams<{ id: string }>();
  const detail = useResource<Detail>(`/subscribers/${id}`, {}, `subscriber:${id}`);
  const [pin, setPin] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const isOwner = identity?.role === 'owner';

  async function act(run: () => Promise<void>) {
    setBusy(true);
    try {
      await run();
    } catch (err) {
      toast.show(err instanceof ApiError ? err.localized(language) : String(err), 'error');
    } finally {
      setBusy(false);
    }
  }

  if (detail.loading) return <Spinner />;
  if (detail.error !== null) return <EmptyState message={detail.error.localized(language)} />;
  if (detail.data === null) return null;

  const { subscriber, balanceUsdCents, bills, payments } = detail.data;

  return (
    <>
      <section className="card">
        <header className="detail-head">
          <div>
            <h2>{subscriber.name}</h2>
            <p className="list__meta">
              {subscriber.code}
              {subscriber.zone ? ` · ${t('subscribers.zone')} ${subscriber.zone}` : ''}
              {` · ${t(`subscriber.status.${subscriber.status}`)}`}
            </p>
          </div>
          <p className={balanceUsdCents > 0 ? 'amount amount--owing' : 'amount'}>
            {formatUsd(balanceUsdCents)}
          </p>
        </header>

        <dl className="detail-grid">
          {subscriber.phone ? (
            <>
              <dt>{t('subscriber.phone')}</dt>
              <dd>{subscriber.phone}</dd>
            </>
          ) : null}
          {subscriber.address ? (
            <>
              <dt>{t('subscriber.address')}</dt>
              <dd>{subscriber.address}</dd>
            </>
          ) : null}
          {subscriber.meterSerial ? (
            <>
              <dt>{t('subscriber.meterSerial')}</dt>
              <dd>{subscriber.meterSerial}</dd>
            </>
          ) : null}
          {subscriber.notes ? (
            <>
              <dt>{t('subscriber.notes')}</dt>
              <dd>{subscriber.notes}</dd>
            </>
          ) : null}
        </dl>

        {isOwner ? (
          <div className="form-actions form-actions--wrap">
            <Link className="button" to={`/staff/subscribers/${subscriber.id}/edit`}>
              {t('subscriber.edit')}
            </Link>
            <button
              type="button"
              className="button"
              disabled={busy}
              onClick={() =>
                act(async () => {
                  const result = await request<{ pin: string }>(
                    `/subscribers/${subscriber.id}/pin-reset`,
                    { method: 'POST' },
                  );
                  setPin(result.pin);
                })
              }
            >
              {t('subscriber.resetPin')}
            </button>
            <select
              className="field__input"
              value={subscriber.status}
              aria-label={t('subscriber.status')}
              disabled={busy}
              onChange={(e) =>
                act(async () => {
                  await request(`/subscribers/${subscriber.id}/status`, {
                    method: 'POST',
                    body: { status: e.target.value },
                  });
                  toast.show(t('subscriber.statusChanged'), 'success');
                  detail.reload();
                })
              }
            >
              <option value="active">{t('subscriber.status.active')}</option>
              <option value="suspended">{t('subscriber.status.suspended')}</option>
              <option value="disconnected">{t('subscriber.status.disconnected')}</option>
            </select>
            <button
              type="button"
              className="button button--danger"
              disabled={busy}
              onClick={() =>
                act(async () => {
                  if (!window.confirm(t('subscriber.deleteConfirm'))) return;
                  await request(`/subscribers/${subscriber.id}`, { method: 'DELETE' });
                  toast.show(t('subscriber.deleted'), 'success');
                  navigate('/staff/subscribers');
                })
              }
            >
              {t('subscriber.delete')}
            </button>
          </div>
        ) : null}
      </section>

      <section className="card">
        <h3>{t('subscriber.bills')}</h3>
        {bills.length === 0 ? (
          <EmptyState message={t('subscriber.noBills')} />
        ) : (
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
        )}
      </section>

      <section className="card">
        <h3>{t('subscriber.payments')}</h3>
        {payments.length === 0 ? (
          <EmptyState message={t('subscriber.noPayments')} />
        ) : (
          <ul className="list">
            {payments.map((payment) => (
              <li key={payment.id} className="list__row">
                <span className="list__main">
                  <strong>{formatDate(payment.paidAt, language)}</strong>
                  <span className="list__meta">
                    {payment.receivedByName}
                    {payment.voidedAt === null ? '' : ` · ${t('subscriber.voided')}`}
                  </span>
                </span>
                <span
                  className={
                    payment.voidedAt === null
                      ? 'list__amount'
                      : 'list__amount list__amount--voided'
                  }
                >
                  {formatUsd(payment.amountUsdCents)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      {pin !== null ? (
        <PinDialog
          pin={pin}
          subscriberName={subscriber.name}
          subscriberCode={subscriber.code}
          onClose={() => setPin(null)}
        />
      ) : null}
    </>
  );
}
