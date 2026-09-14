import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { I18nProvider } from './I18nContext.js';
import { ToastProvider } from './ToastContext.js';
import { StaffAuthProvider, SubscriberAuthProvider } from './AuthContext.js';
import { SubscriberRoutes } from '../subscriber/SubscriberRoutes.js';
import { StaffRoutes } from '../staff/StaffRoutes.js';

export function App() {
  return (
    <I18nProvider>
      <ToastProvider>
        <BrowserRouter>
          <Routes>
            <Route
              path="/staff/*"
              element={
                <StaffAuthProvider>
                  <StaffRoutes />
                </StaffAuthProvider>
              }
            />
            <Route
              path="/*"
              element={
                <SubscriberAuthProvider>
                  <SubscriberRoutes />
                </SubscriberAuthProvider>
              }
            />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </BrowserRouter>
      </ToastProvider>
    </I18nProvider>
  );
}
