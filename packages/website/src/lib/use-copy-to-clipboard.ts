import { useCallback, useEffect, useRef, useState } from 'react';
import { useToast } from '../components/Toast/index.js';

const COPY_RESET_DELAY_MS = 2000;

/**
 * Hook that wraps navigator.clipboard.writeText with copied state and an
 * error toast when the clipboard API is unavailable or denied.
 */
export function useCopyToClipboard() {
  const { toast } = useToast();
  const [copied, setCopied] = useState(false);
  const timeoutRef = useRef<ReturnType<typeof setTimeout>>(undefined);

  useEffect(() => {
    return () => clearTimeout(timeoutRef.current);
  }, []);

  const copy = useCallback(
    async (value: string) => {
      try {
        await navigator.clipboard.writeText(value);
        setCopied(true);
        clearTimeout(timeoutRef.current);
        timeoutRef.current = setTimeout(() => setCopied(false), COPY_RESET_DELAY_MS);
      } catch (err) {
        console.error('Failed to copy to clipboard:', err);
        toast.error('Failed to copy to clipboard');
      }
    },
    [toast],
  );

  return { copied, copy };
}
