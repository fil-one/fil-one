import { createContext, useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { XIcon } from '@phosphor-icons/react/dist/ssr';

export type ToastVariant = 'success' | 'error' | 'info';

export type ToastItem = {
  id: string;
  message: string;
  variant: ToastVariant;
  duration: number;
};

type ToastOptions = {
  duration?: number;
};

type ToastAPI = {
  success: (message: string, options?: ToastOptions) => void;
  error: (message: string, options?: ToastOptions) => void;
  info: (message: string, options?: ToastOptions) => void;
};

type ToastContextValue = {
  toast: ToastAPI;
};

export const ToastContext = createContext<ToastContextValue | null>(null);

const DEFAULT_DURATION = 4000;

const variantBorderClass: Record<ToastVariant, string> = {
  success: 'toast-item--success',
  error: 'toast-item--error',
  info: 'toast-item--info',
};

// Individual toast item — handles its own auto-dismiss timer
function ToastEntry({ item, onDismiss }: { item: ToastItem; onDismiss: (id: string) => void }) {
  useEffect(() => {
    const timer = setTimeout(() => {
      onDismiss(item.id);
    }, item.duration);

    return () => clearTimeout(timer);
  }, [item.id, item.duration, onDismiss]);

  return (
    <div className={`toast-item ${variantBorderClass[item.variant]}`}>
      <p className="toast-message">{item.message}</p>
      <button
        type="button"
        className="toast-close"
        onClick={() => onDismiss(item.id)}
        aria-label="Dismiss notification"
      >
        <XIcon width={16} height={16} />
      </button>
    </div>
  );
}

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  // Use a ref for incrementing IDs to avoid stale closures in the toast API
  const counterRef = useRef(0);

  const dismiss = useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const addToast = useCallback((message: string, variant: ToastVariant, options?: ToastOptions) => {
    counterRef.current += 1;
    const id = `toast-${counterRef.current}`;
    const duration = options?.duration ?? DEFAULT_DURATION;

    setToasts((prev) => [...prev, { id, message, variant, duration }]);
  }, []);

  const toast: ToastAPI = useMemo(
    () => ({
      success: (message, options) => addToast(message, 'success', options),
      error: (message, options) => addToast(message, 'error', options),
      info: (message, options) => addToast(message, 'info', options),
    }),
    [addToast],
  );

  const contextValue = useMemo(() => ({ toast }), [toast]);

  return (
    <ToastContext.Provider value={contextValue}>
      {children}
      <div className="toast-container" aria-live="polite" aria-atomic="false">
        {toasts.map((item) => (
          <ToastEntry key={item.id} item={item} onDismiss={dismiss} />
        ))}
      </div>
    </ToastContext.Provider>
  );
}
