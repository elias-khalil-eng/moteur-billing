import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { ApiError, request } from '../../lib/api.js';
import { useI18n } from '../../app/I18nContext.js';
import { useToast } from '../../app/ToastContext.js';
import { Field } from '../../components/Field.js';
import { PinDialog } from '../../components/PinDialog.js';
import { Spinner } from '../../components/Spinner.js';
import type { Subscriber } from '../../../../lib/types.js';

interface FormState {
  code: string;
  name: string;
  phone: string;
  zone: string;
  address: string;
  meterSerial: string;
  notes: string;
}

const EMPTY: FormState = {
  code: '',
  name: '',
  phone: '',
  zone: '',
  address: '',
  meterSerial: '',
  notes: '',
};

export function SubscriberFormScreen() {
  const { t, language } = useI18n();
  const toast = useToast();
  const navigate = useNavigate();
  const { id } = useParams<{ id: string }>();
  const editing = id !== undefined;

  const [form, setForm] = useState<FormState>(EMPTY);
  const [loading, setLoading] = useState(editing);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [errorField, setErrorField] = useState<string | null>(null);
  const [issuedPin, setIssuedPin] = useState<{ pin: string; subscriber: Subscriber } | null>(null);

  useEffect(() => {
    if (!editing) return;
    request<{ subscriber: Subscriber }>(`/subscribers/${id}`)
      .then(({ subscriber }) =>
        setForm({
          code: subscriber.code,
          name: subscriber.name,
          phone: subscriber.phone ?? '',
          zone: subscriber.zone ?? '',
          address: subscriber.address ?? '',
          meterSerial: subscriber.meterSerial ?? '',
          notes: subscriber.notes ?? '',
        }),
      )
      .catch((err: unknown) => setError(err instanceof ApiError ? err.localized(language) : String(err)))
      .finally(() => setLoading(false));
  }, [editing, id]);

  function update(field: keyof FormState, value: string) {
    setForm((current) => ({ ...current, [field]: value }));
  }

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setErrorField(null);
    const body = {
      code: form.code.trim(),
      name: form.name.trim(),
      phone: form.phone.trim(),
      zone: form.zone.trim(),
      address: form.address.trim(),
      meterSerial: form.meterSerial.trim(),
      notes: form.notes.trim(),
    };
    try {
      if (editing) {
        await request<{ subscriber: Subscriber }>(`/subscribers/${id}`, { method: 'PATCH', body });
        toast.show(t('subscriber.updated'), 'success');
        navigate(`/staff/subscribers/${id}`);
      } else {
        const created = await request<{ subscriber: Subscriber; pin: string }>('/subscribers', {
          method: 'POST',
          body,
        });
        toast.show(t('subscriber.created'), 'success');
        setIssuedPin({ pin: created.pin, subscriber: created.subscriber });
      }
    } catch (err) {
      if (err instanceof ApiError) {
        setError(err.message);
        setErrorField((err.details?.field as string | undefined) ?? null);
      } else {
        setError(String(err));
      }
    } finally {
      setBusy(false);
    }
  }

  if (loading) return <Spinner />;

  return (
    <>
      <form className="card" onSubmit={onSubmit}>
        <h2>{editing ? t('subscriber.edit') : t('subscriber.create')}</h2>

        <Field
          label={t('subscriber.code')}
          value={form.code}
          onChange={(e) => update('code', e.target.value)}
          inputMode="numeric"
          required
          error={errorField === 'code' ? error : null}
        />
        <Field
          label={t('subscriber.name')}
          value={form.name}
          onChange={(e) => update('name', e.target.value)}
          required
          error={errorField === 'name' ? error : null}
        />
        <Field
          label={t('subscriber.phone')}
          value={form.phone}
          onChange={(e) => update('phone', e.target.value)}
          inputMode="tel"
        />
        <Field
          label={t('subscribers.zone')}
          value={form.zone}
          onChange={(e) => update('zone', e.target.value)}
        />
        <Field
          label={t('subscriber.address')}
          value={form.address}
          onChange={(e) => update('address', e.target.value)}
        />
        <Field
          label={t('subscriber.meterSerial')}
          value={form.meterSerial}
          onChange={(e) => update('meterSerial', e.target.value)}
        />
        <Field
          label={t('subscriber.notes')}
          value={form.notes}
          onChange={(e) => update('notes', e.target.value)}
        />

        {error !== null && errorField === null ? <p className="field__error">{error}</p> : null}

        <div className="form-actions">
          <button type="button" className="button" onClick={() => navigate(-1)}>
            {t('app.cancel')}
          </button>
          <button type="submit" className="button button--primary" disabled={busy}>
            {t('app.save')}
          </button>
        </div>
      </form>

      {issuedPin !== null ? (
        <PinDialog
          pin={issuedPin.pin}
          subscriberName={issuedPin.subscriber.name}
          subscriberCode={issuedPin.subscriber.code}
          onClose={() => navigate(`/staff/subscribers/${issuedPin.subscriber.id}`)}
        />
      ) : null}
    </>
  );
}
