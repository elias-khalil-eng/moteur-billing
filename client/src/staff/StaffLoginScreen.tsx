import { useState } from 'react';
import type { FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { ApiError, request } from '../lib/api.js';
import { useI18n } from '../app/I18nContext.js';
import { useStaffAuth } from '../app/AuthContext.js';
import type { StaffIdentity } from '../app/AuthContext.js';
import { LanguageToggle } from '../components/LanguageToggle.js';
import { Field } from '../components/Field.js';
import type { Role } from '../../../lib/types.js';

interface LoginResponse {
  token: string;
  staff: { id: number; username: string; name: string; role: Role };
}

export function StaffLoginScreen() {
  const { t } = useI18n();
  const { signIn } = useStaffAuth();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const result = await request<LoginResponse>('/auth/staff/login', {
        method: 'POST',
        audience: 'staff',
        body: { username: username.trim(), password },
      });
      const identity: StaffIdentity = { kind: 'staff', ...result.staff };
      signIn(result.token, identity);
    } catch (err) {
      setError(
        err instanceof ApiError && err.code === 'rate_limited'
          ? t('login.error.rateLimited')
          : t('login.error.staffCredentials'),
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
        <h2>{t('login.staff.title')}</h2>

        <Field
          label={t('login.staff.username')}
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          autoComplete="username"
          enterKeyHint="next"
          required
        />
        <Field
          label={t('login.staff.password')}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          type="password"
          autoComplete="current-password"
          enterKeyHint="go"
          required
          error={error}
        />

        <button className="button button--primary button--block" type="submit" disabled={busy}>
          {busy ? t('app.loading') : t('login.staff.submit')}
        </button>

        <Link className="login__switch" to="/login">
          {t('login.staff.toSubscriber')}
        </Link>
      </form>
    </main>
  );
}
