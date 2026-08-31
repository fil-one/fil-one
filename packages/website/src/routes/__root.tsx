import { createRootRoute, Outlet } from '@tanstack/react-router';
import { ActiveOrgNotice } from '../components/ActiveOrgNotice';
import { ToastProvider } from '../components/Toast/ToastProvider';

function RootLayout() {
  return (
    <ToastProvider>
      <ActiveOrgNotice />
      <Outlet />
    </ToastProvider>
  );
}

export const Route = createRootRoute({ component: RootLayout });
