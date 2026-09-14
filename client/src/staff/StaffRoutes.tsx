import { Navigate, Route, Routes } from 'react-router-dom';
import { useStaffAuth } from '../app/AuthContext.js';
import { Spinner } from '../components/Spinner.js';
import { StaffLoginScreen } from './StaffLoginScreen.js';
import { StaffLayout } from './StaffLayout.js';

export function StaffRoutes() {
  const { identity, status } = useStaffAuth();

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
        <Route path="login" element={<StaffLoginScreen />} />
        <Route path="*" element={<Navigate to="/staff/login" replace />} />
      </Routes>
    );
  }

  return (
    <Routes>
      <Route path="login" element={<Navigate to="/staff" replace />} />
      <Route path="*" element={<StaffLayout />} />
    </Routes>
  );
}
