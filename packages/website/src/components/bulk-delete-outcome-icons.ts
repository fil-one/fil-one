import { CheckCircleIcon, WarningCircleIcon, WarningIcon } from '@phosphor-icons/react/dist/ssr';

import type { IconBoxColor } from './IconBox';
import type { BulkDeleteTone } from '../lib/bulk-delete-outcome.js';

/** The icon and its colour for each way a finished bulk deletion can go. */
export const OUTCOME_ICONS: Record<
  BulkDeleteTone,
  { icon: typeof WarningCircleIcon; color: IconBoxColor }
> = {
  success: { icon: CheckCircleIcon, color: 'green' },
  warning: { icon: WarningIcon, color: 'amber' },
  error: { icon: WarningCircleIcon, color: 'red' },
};
