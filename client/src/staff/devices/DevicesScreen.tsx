import { useState } from 'react';
import type { FormEvent } from 'react';
import { useI18n } from '../../app/I18nContext.js';
import { useToast } from '../../app/ToastContext.js';
import { useResource } from '../../lib/useResource.js';
import { ApiError, request } from '../../lib/api.js';
import { formatDateTime } from '../../lib/format.js';
import { Field } from '../../components/Field.js';
import { Spinner } from '../../components/Spinner.js';
import { EmptyState } from '../../components/EmptyState.js';
import { SubscriberPicker } from '../../components/SubscriberPicker.js';
import type { MeterDeviceWithSubscriber, SubscriberWithBalance } from '../../../../lib/types.js';

/**
 * The secret is returned once, by registration or by a rotation, and lives only in
 * this component's state until the owner leaves the screen. It is never stored.
 */
export function DevicesScreen() {
  const { t, language } = useI18n();
  const toast = useToast();
  const list = useResource<{ devices: MeterDeviceWithSubscriber[] }>('/devices');
  const [target, setTarget] = useState<SubscriberWithBalance | null>(null);
  const [serial, setSerial] = useState('');
  const [secret, setSecret] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function run(work: Promise<{ secret?: string }>, message: string) {
    setBusy(true);
    setError(null);
    void work
      .then((result) => {
        if (result.secret) setSecret(result.secret);
        toast.show(message, 'success');
        list.reload();
      })
      .catch((err: unknown) => {
        const text = err instanceof ApiError ? err.localized(language) : String(err);
        setError(text);
        toast.show(text, 'error');
      })
      .finally(() => setBusy(false));
  }

  function onRegister(event: FormEvent) {
    event.preventDefault();
    if (target === null) return;
    run(
      request<{ secret: string }>(`/subscribers/${target.id}/device`, {
        method: 'POST',
        body: { serial: serial.trim() },
      }).then((result) => {
        setSerial('');
        setTarget(null);
        return result;
      }),
      t('devices.registered'),
    );
  }

  const devices = list.data?.devices ?? [];

  return (
    <>
      <form className="card" onSubmit={onRegister}>
        <h2 className="card__title">{t('devices.register')}</h2>

        {target === null ? (
          <SubscriberPicker label={t('messages.pick')} onPick={setTarget} />
        ) : (
          <div className="form-actions">
            <strong>
              {target.name} · {target.code}
            </strong>
            <button type="button" className="button button--quiet" onClick={() => setTarget(null)}>
              {t('app.cancel')}
            </button>
          </div>
        )}

        <Field
          label={t('devices.serial')}
          value={serial}
          maxLength={64}
          error={error}
          onChange={(e) => setSerial(e.target.value)}
        />

        <div className="form-actions">
          <button
            className="button button--primary"
            type="submit"
            disabled={busy || target === null || serial.trim() === ''}
          >
            {t('devices.register')}
          </button>
        </div>
      </form>

      {secret === null ? null : (
        <section className="card banner banner--warning">
          <p>{t('devices.secretOnce')}</p>
          <p className="amount">
            <code>{secret}</code>
          </p>
          <div className="form-actions">
            <button type="button" className="button" onClick={() => setSecret(null)}>
              {t('app.close')}
            </button>
          </div>
        </section>
      )}

      {list.loading ? <Spinner /> : null}

      {!list.loading && devices.length === 0 ? <EmptyState message={t('devices.empty')} /> : null}

      {devices.length > 0 ? (
        <section className="card">
          <h2 className="card__title">{t('devices.title')}</h2>
          <ul className="list">
            {devices.map((device) => (
              <li key={device.id} className="list__row">
                <span className="list__main">
                  <strong>{device.subscriberName}</strong>
                  <span className="list__meta">
                    {device.subscriberCode} · {device.serial}
                  </span>
                  <span className="list__meta">
                    {t('devices.lastSeen')}:{' '}
                    {device.lastSeenAt === null
                      ? t('devices.never')
                      : formatDateTime(device.lastSeenAt, language)}
                  </span>
                  <span className="list__meta">
                    {t('devices.lastValue')}: {device.lastValue ?? t('app.none')}
                  </span>

                  <span className="form-actions form-actions--wrap">
                    <button
                      type="button"
                      className="button"
                      disabled={busy}
                      onClick={() =>
                        run(
                          request<{ secret: string }>(`/devices/${device.id}/rotate`, {
                            method: 'POST',
                          }),
                          t('devices.registered'),
                        )
                      }
                    >
                      {t('devices.rotate')}
                    </button>
                    <button
                      type="button"
                      className={`button ${device.status === 'active' ? 'button--danger' : ''}`}
                      disabled={busy}
                      onClick={() =>
                        run(
                          request(`/devices/${device.id}`, {
                            method: 'PATCH',
                            body: { status: device.status === 'active' ? 'disabled' : 'active' },
                          }),
                          t('queue.updated'),
                        )
                      }
                    >
                      {t(device.status === 'active' ? 'devices.disable' : 'devices.enable')}
                    </button>
                  </span>
                </span>
                <span className={`badge ${device.status === 'active' ? 'badge--positive' : ''}`}>
                  {t(`devices.status.${device.status}`)}
                </span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </>
  );
}
