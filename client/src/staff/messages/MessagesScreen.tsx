import { useState } from 'react';
import type { FormEvent } from 'react';
import { useI18n } from '../../app/I18nContext.js';
import { useToast } from '../../app/ToastContext.js';
import { ApiError, request } from '../../lib/api.js';
import { Field } from '../../components/Field.js';
import { SubscriberPicker } from '../../components/SubscriberPicker.js';
import type { SubscriberWithBalance } from '../../../../lib/types.js';

type Audience = 'everyone' | 'one';

/**
 * A broadcast reaches every subscriber at once, so the target is chosen first and
 * the send button stays disabled until one subscriber is actually picked.
 */
export function MessagesScreen() {
  const { t, language } = useI18n();
  const toast = useToast();
  const [audience, setAudience] = useState<Audience>('everyone');
  const [target, setTarget] = useState<SubscriberWithBalance | null>(null);
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const ready =
    title.trim() !== '' && body.trim() !== '' && (audience === 'everyone' || target !== null);

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    void request<{ recipients: number }>('/messages', {
      method: 'POST',
      body: {
        title: title.trim(),
        body: body.trim(),
        ...(audience === 'one' && target !== null ? { subscriberId: target.id } : {}),
      },
    })
      .then((result) => {
        toast.show(t('messages.sent', { count: result.recipients }), 'success');
        setTitle('');
        setBody('');
        setTarget(null);
      })
      .catch((err: unknown) => {
        const message = err instanceof ApiError ? err.localized(language) : String(err);
        setError(message);
        toast.show(message, 'error');
      })
      .finally(() => setBusy(false));
  }

  return (
    <form className="card" onSubmit={onSubmit}>
      <h2 className="card__title">{t('messages.title')}</h2>

      <div className="field">
        <span className="field__label">{t('messages.audience')}</span>
        <div className="segmented" role="group" aria-label={t('messages.audience')}>
          {(['everyone', 'one'] as Audience[]).map((option) => (
            <button
              key={option}
              type="button"
              className={`segmented__option ${audience === option ? 'segmented__option--on' : ''}`}
              onClick={() => {
                setAudience(option);
                setTarget(null);
              }}
            >
              {t(option === 'everyone' ? 'messages.everyone' : 'messages.one')}
            </button>
          ))}
        </div>
      </div>

      {audience === 'one' ? (
        <div className="field">
          <span className="field__label">{t('messages.pick')}</span>
          {target === null ? (
            <SubscriberPicker label={t('messages.pick')} onPick={setTarget} />
          ) : (
            <div className="form-actions">
              <strong>
                {target.name} · {target.code}
              </strong>
              <button
                type="button"
                className="button button--quiet"
                onClick={() => setTarget(null)}
              >
                {t('app.cancel')}
              </button>
            </div>
          )}
        </div>
      ) : null}

      <Field
        label={t('messages.subject')}
        value={title}
        maxLength={120}
        onChange={(e) => setTitle(e.target.value)}
      />

      <div className="field">
        <label className="field__label" htmlFor="message-body">
          {t('messages.body')}
        </label>
        <textarea
          id="message-body"
          className="field__input"
          rows={4}
          maxLength={1000}
          value={body}
          onChange={(e) => setBody(e.target.value)}
        />
        {error === null ? null : <p className="field__error">{error}</p>}
      </div>

      <div className="form-actions">
        <button className="button button--primary" type="submit" disabled={busy || !ready}>
          {t('messages.send')}
        </button>
      </div>
    </form>
  );
}
