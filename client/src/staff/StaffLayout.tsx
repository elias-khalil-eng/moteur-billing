import { Navigate, NavLink, Route, Routes } from 'react-router-dom';
import { useI18n } from '../app/I18nContext.js';
import { useStaffAuth } from '../app/AuthContext.js';
import { LanguageToggle } from '../components/LanguageToggle.js';
import { SubscribersScreen } from './subscribers/SubscribersScreen.js';
import { SubscriberDetailScreen } from './subscribers/SubscriberDetailScreen.js';
import { SubscriberFormScreen } from './subscribers/SubscriberFormScreen.js';
import { RouteScreen } from './cycles/RouteScreen.js';
import { CycleScreen } from './cycles/CycleScreen.js';
import { CollectScreen } from './payments/CollectScreen.js';
import { MyDayScreen } from './payments/MyDayScreen.js';
import { ArrearsScreen } from './reports/ArrearsScreen.js';
import { ReportsScreen } from './reports/ReportsScreen.js';
import { ExpensesScreen } from './expenses/ExpensesScreen.js';
import { DashboardScreen } from './DashboardScreen.js';
import { StaffScreen } from './team/StaffScreen.js';
import { QueueScreen } from './requests/QueueScreen.js';
import { MessagesScreen } from './messages/MessagesScreen.js';
import { DevicesScreen } from './devices/DevicesScreen.js';
import { MoreScreen } from './MoreScreen.js';
import type { TranslationKey } from '../lib/i18n.js';
import type { Role } from '../../../lib/types.js';

interface NavItem {
  to: string;
  label: TranslationKey;
  roles: Role[];
}

/**
 * Four items is what a phone's bottom bar holds before Arabic labels start to
 * collide, so an owner gets four plus More, and a collector's four are all they need.
 */
const PRIMARY: NavItem[] = [
  { to: '/staff/dashboard', label: 'nav.dashboard', roles: ['owner'] },
  { to: '/staff/route', label: 'nav.route', roles: ['owner', 'collector'] },
  { to: '/staff/collect', label: 'nav.collect', roles: ['owner', 'collector'] },
  { to: '/staff/subscribers', label: 'nav.subscribers', roles: ['collector'] },
  { to: '/staff/cycle', label: 'nav.cycle', roles: ['owner'] },
  { to: '/staff/my-day', label: 'nav.myDay', roles: ['collector'] },
];

const SECONDARY: NavItem[] = [
  { to: '/staff/subscribers', label: 'nav.subscribers', roles: ['owner'] },
  { to: '/staff/requests', label: 'nav.queue', roles: ['owner'] },
  { to: '/staff/messages', label: 'nav.messages', roles: ['owner'] },
  { to: '/staff/devices', label: 'nav.devices', roles: ['owner'] },
  { to: '/staff/arrears', label: 'nav.arrears', roles: ['owner'] },
  { to: '/staff/expenses', label: 'nav.expenses', roles: ['owner'] },
  { to: '/staff/reports', label: 'nav.reports', roles: ['owner'] },
  { to: '/staff/my-day', label: 'nav.myDay', roles: ['owner'] },
  { to: '/staff/team', label: 'nav.staff', roles: ['owner'] },
];

export function StaffLayout() {
  const { t } = useI18n();
  const { identity, signOut } = useStaffAuth();
  const role = identity?.role ?? 'collector';
  const primary = PRIMARY.filter((item) => item.roles.includes(role));
  const secondary = SECONDARY.filter((item) => item.roles.includes(role));

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
          <Route
            index
            element={<Navigate to={role === 'owner' ? '/staff/dashboard' : '/staff/route'} replace />}
          />
          <Route path="dashboard" element={<DashboardScreen />} />
          <Route path="expenses" element={<ExpensesScreen />} />
          <Route path="reports" element={<ReportsScreen />} />
          <Route path="team" element={<StaffScreen />} />
          <Route path="requests" element={<QueueScreen />} />
          <Route path="messages" element={<MessagesScreen />} />
          <Route path="devices" element={<DevicesScreen />} />
          <Route path="more" element={<MoreScreen items={secondary} />} />
          <Route path="route" element={<RouteScreen />} />
          <Route path="cycle" element={<CycleScreen />} />
          <Route path="collect" element={<CollectScreen />} />
          <Route path="my-day" element={<MyDayScreen />} />
          <Route path="arrears" element={<ArrearsScreen />} />
          <Route path="subscribers" element={<SubscribersScreen />} />
          <Route path="subscribers/new" element={<SubscriberFormScreen />} />
          <Route path="subscribers/:id" element={<SubscriberDetailScreen />} />
          <Route path="subscribers/:id/edit" element={<SubscriberFormScreen />} />
          <Route path="*" element={<Navigate to="/staff" replace />} />
        </Routes>
      </main>

      <nav className="bottom-nav" aria-label={t('app.name')}>
        {primary.map((item) => (
          <NavLink key={item.to} to={item.to} className="bottom-nav__item">
            {t(item.label)}
          </NavLink>
        ))}
        {secondary.length > 0 ? (
          <NavLink to="/staff/more" className="bottom-nav__item">
            {t('nav.more')}
          </NavLink>
        ) : null}
      </nav>
    </div>
  );
}
