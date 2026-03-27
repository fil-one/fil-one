import { CheckCircleIcon, CopyIcon } from '@phosphor-icons/react/dist/ssr';

import { IconButton } from '../IconButton';
import { useCopyToClipboard } from '../../lib/use-copy-to-clipboard';

export type CopyButtonProps = {
  value: string;
  ariaLabel?: string;
  size?: number;
  className?: string;
};

export function CopyButton({ value, ariaLabel, size = 16, className }: CopyButtonProps) {
  const { copied, copy } = useCopyToClipboard();

  return (
    <IconButton
      onClick={() => void copy(value)}
      title={copied ? 'Copied' : 'Copy'}
      aria-label={copied ? 'Copied' : (ariaLabel ?? 'Copy to clipboard')}
      className={className}
    >
      {copied ? (
        <CheckCircleIcon size={size} className="text-green-500" />
      ) : (
        <CopyIcon size={size} />
      )}
    </IconButton>
  );
}
