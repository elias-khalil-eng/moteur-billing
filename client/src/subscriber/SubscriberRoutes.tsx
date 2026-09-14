import { Navigate, Route, Routes } from 'react-router-dom';
import { useSubscriberAuth } from '../app/AuthContext.js';
import { Spinner } from '../components/Spinner.js';
import { SubscriberLoginScreen } from './SubscriberLoginScreen.js';
import { SubscriberLayout } from './SubscriberLayout.js';

export function SubscriberRoutes() {
  const { identity, status } = useSubscriberAuth();

  if (status === 'loading') {
    return (
      <main className="centered-page">
        <Spinner />
      </main>
    );
  }

  if (identity === null) {
    return (
      <Routes>
        <Route path="/login" element={<SubscriberLoginScreen />} />
        <Route path="*" element={<Navigate to="/login" replace />} />
      </Routes>
    );
  }

  return (
    <Routes>
      <Route path="/login" element={<Navigate to="/" replace />} />
      <Route path="/*" element={<SubscriberLayout />} />
    </Routes>
  );
}
