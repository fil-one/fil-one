import { CheckIcon, CopySimpleIcon } from '@phosphor-icons/react/dist/ssr';

import { useCopyToClipboard } from '../lib/use-copy-to-clipboard.js';
import { IconButton } from './IconButton.js';

type CopyButtonProps = {
  value: string;
  size?: 'sm' | 'md';
  id?: string;
  'data-testid'?: string;
};

export function CopyButton({ value, size = 'sm', ...rest }: CopyButtonProps) {
  const { copied, copy } = useCopyToClipboard();
  return (
    <IconButton
      {...rest}
      icon={copied ? CheckIcon : CopySimpleIcon}
      size={size}
      aria-label={copied ? 'Copied to clipboard' : 'Copy to clipboard'}
      onClick={() => void copy(value)}
    />
  );
}
