import { useI18n } from '../../app/I18nContext.js';
import { useResource } from '../../lib/useResource.js';
import { request } from '../../lib/api.js';
import { formatDateTime } from '../../lib/format.js';
import { Spinner } from '../../components/Spinner.js';
import { EmptyState } from '../../components/EmptyState.js';
import { PushOptIn } from './PushOptIn.js';
import type { NotificationItem } from '../../../../lib/types.js';

interface Inbox {
  notifications: NotificationItem[];
  unreadCount: number;
}

export function InboxScreen() {
  const { t, language } = useI18n();
  const inbox = useResource<Inbox>('/me/notifications', { audience: 'subscriber' });

  async function markRead(id: number) {
    await request(`/me/notifications/${id}/read`, { method: 'POST', audience: 'subscriber' });
    inbox.reload();
  }

  return (
    <>
      <PushOptIn />

      {inbox.loading ? <Spinner /> : null}

      {inbox.data !== null ? (
        <section className="card">
          <header className="detail-head">
            <h2 className="card__title">{t('inbox.title')}</h2>
            {inbox.data.unreadCount > 0 ? (
              <button
                type="button"
                className="button button--quiet"
                onClick={() => {
                  void request('/me/notifications/read-all', {
                    method: 'POST',
                    audience: 'subscriber',
                  }).then(() => inbox.reload());
                }}
              >
                {t('inbox.markAllRead')}
              </button>
            ) : null}
          </header>

          {inbox.data.notifications.length === 0 ? (
            <EmptyState message={t('inbox.empty')} />
          ) : (
            <ul className="list">
              {inbox.data.notifications.map((item) => (
                <li key={item.id}>
                  <button
                    type="button"
                    className={`list__row notification ${
                      item.readAt === null ? 'notification--unread' : ''
                    }`}
                    onClick={() => void markRead(item.id)}
                  >
                    <span className="list__main">
                      <strong>{language === 'ar' ? item.titleAr : item.titleEn}</strong>
                      <span className="list__meta">
                        {language === 'ar' ? item.bodyAr : item.bodyEn}
                      </span>
                      <span className="list__meta">{formatDateTime(item.createdAt, language)}</span>
                    </span>
                    {item.readAt === null ? <span className="notification__dot" /> : null}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>
      ) : null}
    </>
  );
}
