import { useContext } from 'react';

import { ToastContext } from './ToastProvider';

export function useToast() {
  const context = useContext(ToastContext);

  if (!context) {
    throw new Error('useToast must be used within a ToastProvider');
  }

  return { toast: context.toast };
}
