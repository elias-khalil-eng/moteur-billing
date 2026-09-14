import { useEffect, useState } from 'react';
import { useI18n } from '../../app/I18nContext.js';
import { useResource } from '../../lib/useResource.js';
import { currentPushState, disablePush, enablePush } from '../../lib/push.js';
import type { PushState } from '../../lib/push.js';

/**
 * The permission prompt only ever follows a tap. A prompt on page load is denied
 * permanently and can never be asked again, which would cost the owner the channel.
 */
export function PushOptIn() {
  const { t } = useI18n();
  const [state, setState] = useState<PushState | null>(null);
  const [busy, setBusy] = useState(false);
  const config = useResource<{ vapidPublicKey: string | null }>('/config', {
    audience: 'subscriber',
  });

  useEffect(() => {
    void currentPushState().then(setState);
  }, []);

  if (state === null) return null;
  if (state === 'unsupported') {
    return (
      <section className="card">
        <p className="list__meta">{t('push.unsupported')}</p>
      </section>
    );
  }

  if (state === 'ios-needs-install') {
    return (
      <section className="card">
        <h2 className="card__title">{t('push.iosTitle')}</h2>
        <ol className="steps">
          <li>{t('push.iosStep1')}</li>
          <li>{t('push.iosStep2')}</li>
          <li>{t('push.iosStep3')}</li>
        </ol>
      </section>
    );
  }

  const key = config.data?.vapidPublicKey ?? null;

  return (
    <section className="card">
      <h2 className="card__title">{t('push.title')}</h2>
      {state === 'denied' ? (
        <p className="list__meta">{t('push.denied')}</p>
      ) : (
        <>
          <p className="list__meta">{state === 'on' ? t('push.on') : t('push.explain')}</p>
          <div className="form-actions form-actions--wrap">
            <button
              type="button"
              className={state === 'on' ? 'button' : 'button button--primary'}
              disabled={busy || (state === 'off' && key === null)}
              onClick={() => {
                setBusy(true);
                const action = state === 'on' ? disablePush() : enablePush(key ?? '');
                void action
                  .then(setState)
                  .catch(() => setState('off'))
                  .finally(() => setBusy(false));
              }}
            >
              {state === 'on' ? t('push.disable') : t('push.enable')}
            </button>
          </div>
        </>
      )}
    </section>
  );
}
