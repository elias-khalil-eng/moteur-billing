import { useState } from 'react';
import type { FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { ApiError, request } from '../lib/api.js';
import { useI18n } from '../app/I18nContext.js';
import { useSubscriberAuth } from '../app/AuthContext.js';
import type { SubscriberIdentity } from '../app/AuthContext.js';
import { LanguageToggle } from '../components/LanguageToggle.js';
import { Field } from '../components/Field.js';

interface LoginResponse {
  token: string;
  subscriber: { id: number; code: string; name: string };
}

export function SubscriberLoginScreen() {
  const { t } = useI18n();
  const { signIn } = useSubscriberAuth();
  const [code, setCode] = useState('');
  const [pin, setPin] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const result = await request<LoginResponse>('/auth/subscriber/login', {
        method: 'POST',
        audience: 'subscriber',
        body: { code: code.trim(), pin: pin.trim() },
      });
      const identity: SubscriberIdentity = { kind: 'subscriber', ...result.subscriber };
      signIn(result.token, identity);
    } catch (err) {
      setError(
        err instanceof ApiError && err.code === 'rate_limited'
          ? t('login.error.rateLimited')
          : t('login.error.credentials'),
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="login">
      <header className="login__header">
        <h1>{t('app.name')}</h1>
        <LanguageToggle />
      </header>

      <form className="login__form card" onSubmit={onSubmit}>
        <h2>{t('login.subscriber.title')}</h2>

        <Field
          label={t('login.subscriber.code')}
          value={code}
          onChange={(e) => setCode(e.target.value)}
          inputMode="numeric"
          autoComplete="username"
          enterKeyHint="next"
          required
        />
        <Field
          label={t('login.subscriber.pin')}
          value={pin}
          onChange={(e) => setPin(e.target.value)}
          inputMode="numeric"
          type="password"
          autoComplete="current-password"
          enterKeyHint="go"
          maxLength={6}
          required
          hint={t('login.subscriber.help')}
          error={error}
        />

        <button className="button button--primary button--block" type="submit" disabled={busy}>
          {busy ? t('app.loading') : t('login.subscriber.submit')}
        </button>

        <Link className="login__switch" to="/staff/login">
          {t('login.subscriber.toStaff')}
        </Link>
      </form>
    </main>
  );
}
