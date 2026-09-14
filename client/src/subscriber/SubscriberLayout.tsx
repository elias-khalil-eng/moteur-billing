import { Navigate, NavLink, Route, Routes } from 'react-router-dom';
import { useI18n } from '../app/I18nContext.js';
import { useSubscriberAuth } from '../app/AuthContext.js';
import { LanguageToggle } from '../components/LanguageToggle.js';
import { HomeScreen } from './screens/HomeScreen.js';
import { HistoryScreen } from './screens/HistoryScreen.js';
import { PaymentsScreen } from './screens/PaymentsScreen.js';
import { InboxScreen } from './screens/InboxScreen.js';
import { RequestsScreen } from './screens/RequestsScreen.js';
import { useResource } from '../lib/useResource.js';
import type { TranslationKey } from '../lib/i18n.js';

const NAV: { to: string; label: TranslationKey }[] = [
  { to: '/', label: 'nav.home' },
  { to: '/history', label: 'nav.history' },
  { to: '/payments', label: 'nav.payments' },
  { to: '/requests', label: 'nav.requests' },
  { to: '/notifications', label: 'nav.inbox' },
];

export function SubscriberLayout() {
  const { t } = useI18n();
  const { identity, signOut } = useSubscriberAuth();
  const inbox = useResource<{ unreadCount: number }>('/me/notifications', {
    audience: 'subscriber',
    query: { unreadOnly: 'true' },
  });
  const unread = inbox.data?.unreadCount ?? 0;

  return (
    <div className="shell">
      <header className="shell__header">
        <div>
          <p className="shell__eyebrow">{t('app.name')}</p>
          <h1 className="shell__title">{identity?.name}</h1>
        </div>
        <div className="shell__header-actions">
          <LanguageToggle />
          <button type="button" className="button button--quiet" onClick={signOut}>
            {t('app.signOut')}
          </button>
        </div>
      </header>

      <main className="shell__main">
        <Routes>
          <Route index element={<HomeScreen />} />
          <Route path="history" element={<HistoryScreen />} />
          <Route path="payments" element={<PaymentsScreen />} />
          <Route path="requests" element={<RequestsScreen />} />
          <Route path="notifications" element={<InboxScreen />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </main>

      <nav className="bottom-nav" aria-label={t('app.name')}>
        {NAV.map((item) => (
          <NavLink key={item.to} to={item.to} end className="bottom-nav__item">
            {t(item.label)}
            {item.to === '/notifications' && unread > 0 ? (
              <span className="bottom-nav__badge" aria-label={t('inbox.unread', { count: unread })}>
                {unread}
              </span>
            ) : null}
          </NavLink>
        ))}
      </nav>
    </div>
  );
}
