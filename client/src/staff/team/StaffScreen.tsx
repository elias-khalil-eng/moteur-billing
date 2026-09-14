import { useState } from 'react';
import type { FormEvent } from 'react';
import { ApiError, request } from '../../lib/api.js';
import { useI18n } from '../../app/I18nContext.js';
import { useToast } from '../../app/ToastContext.js';
import { useResource } from '../../lib/useResource.js';
import { Field } from '../../components/Field.js';
import { Spinner } from '../../components/Spinner.js';
import type { Role, Staff } from '../../../../lib/types.js';

export function StaffScreen() {
  const { t, language } = useI18n();
  const toast = useToast();
  const list = useResource<{ staff: Staff[] }>('/staff');
  const [username, setUsername] = useState('');
  const [name, setName] = useState('');
  const [role, setRole] = useState<Role>('collector');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

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

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    void act(async () => {
      await request('/staff', {
        method: 'POST',
        body: { username: username.trim(), name: name.trim(), role, password },
      });
      toast.show(t('staff.created'), 'success');
      setUsername('');
      setName('');
      setPassword('');
      list.reload();
    });
  }

  return (
    <>
      <form className="card" onSubmit={onSubmit}>
        <h2 className="card__title">{t('staff.add')}</h2>

        <Field
          label={t('staff.username')}
          value={username}
          autoComplete="off"
          onChange={(e) => setUsername(e.target.value.toLowerCase())}
        />
        <Field label={t('staff.name')} value={name} onChange={(e) => setName(e.target.value)} />

        <div className="segmented" role="group" aria-label={t('staff.role')}>
          {(['collector', 'owner'] as const).map((option) => (
            <button
              key={option}
              type="button"
              className={`segmented__option ${role === option ? 'segmented__option--on' : ''}`}
              onClick={() => setRole(option)}
            >
              {t(`staff.role.${option}`)}
            </button>
          ))}
        </div>

        <Field
          label={t('staff.password')}
          type="password"
          value={password}
          autoComplete="new-password"
          onChange={(e) => setPassword(e.target.value)}
          error={error}
        />

        <div className="form-actions">
          <button className="button button--primary" type="submit" disabled={busy}>
            {t('app.save')}
          </button>
        </div>
      </form>

      {list.loading ? <Spinner /> : null}

      {list.data !== null ? (
        <ul className="list">
          {list.data.staff.map((member) => (
            <li key={member.id} className="list__row">
              <span className="list__main">
                <strong>{member.name}</strong>
                <span className="list__meta">
                  {member.username} · {t(`staff.role.${member.role}`)} ·{' '}
                  {member.isActive ? t('staff.active') : t('staff.inactive')}
                </span>
              </span>
              <span className="list__amount staff-actions">
                <button
                  type="button"
                  className="link-button"
                  disabled={busy}
                  onClick={() =>
                    void act(async () => {
                      await request(`/staff/${member.id}`, {
                        method: 'PATCH',
                        body: { isActive: !member.isActive },
                      });
                      toast.show(t('staff.updated'), 'success');
                      list.reload();
                    })
                  }
                >
                  {member.isActive ? t('staff.deactivate') : t('staff.activate')}
                </button>
                <button
                  type="button"
                  className="link-button"
                  disabled={busy}
                  onClick={() =>
                    void act(async () => {
                      const next = window.prompt(t('staff.newPassword'));
                      if (next === null || next.trim() === '') return;
                      await request(`/staff/${member.id}/password`, {
                        method: 'POST',
                        body: { password: next },
                      });
                      toast.show(t('staff.passwordSet'), 'success');
                    })
                  }
                >
                  {t('staff.newPassword')}
                </button>
              </span>
            </li>
          ))}
        </ul>
      ) : null}
    </>
  );
}
