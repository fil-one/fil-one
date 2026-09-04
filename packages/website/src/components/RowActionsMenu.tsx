import type { SVGProps } from 'react';
import type { Icon as PhosphorIcon } from '@phosphor-icons/react';
import { DotsThreeIcon } from '@phosphor-icons/react/dist/ssr';
import { Menu, MenuButton, MenuItem, MenuItems } from '@headlessui/react';
import { clsx } from 'clsx';

import { Icon } from './Icon';
import { IconButton } from './IconButton';

/**
 * The trigger glyph, at `bold`.
 *
 * Three regular-weight dots are the lightest mark in a table row, and at
 * `zinc-500` they read as decoration rather than a control. `IconButton` takes
 * a component rather than a weight, so the weight is bound here.
 */
function DotsTrigger(props: SVGProps<SVGSVGElement>) {
  return <DotsThreeIcon {...props} weight="bold" />;
}

export type RowAction = {
  label: string;
  onSelect: () => void;
  icon?: PhosphorIcon;
  /** Renders in red, for an action that takes something away. */
  destructive?: boolean;
  disabled?: boolean;
  /**
   * A handle for tests, as `BucketAction` carries one. The panel is portalled
   * out of the row it belongs to, so an E2E selector reaches the item from the
   * page — and the label is copy, which moves.
   */
  testId?: string;
};

export type RowActionsMenuProps = {
  actions: RowAction[];
  /** Names the menu for the row it belongs to — "Actions for Ada Lovelace". */
  'aria-label': string;
  disabled?: boolean;
};

/**
 * The overflow menu at the end of a table row.
 *
 * Built on Headless UI's `Menu`, like `SplitButton`, rather than the hand-rolled
 * popover pattern: that one manages its own open state, position and outside
 * clicks, and gets Escape and focus return wrong (FIL-990). `Menu` carries the
 * roving focus, the `aria-expanded`/`aria-haspopup` wiring, Escape-to-close and
 * focus-back-to-trigger that a row menu needs, and `anchor` positions the panel
 * without measuring anything by hand.
 *
 * One row action does not need a menu — a single visible button says what it
 * does without a click to find out. This is for the point where a row has
 * enough verbs that spelling them all out turns the column into noise.
 */
export function RowActionsMenu({
  actions,
  'aria-label': ariaLabel,
  disabled = false,
}: RowActionsMenuProps) {
  if (actions.length === 0) return null;

  return (
    <Menu as="div" className="relative inline-block">
      <MenuButton
        as={IconButton}
        icon={DotsTrigger}
        aria-label={ariaLabel}
        disabled={disabled}
        className="text-zinc-600 data-open:bg-zinc-100 data-open:text-zinc-900"
      />
      <MenuItems
        anchor="bottom end"
        // Sized to match `BucketActionMenu` — the console's canonical
        // dropdown size (DESIGN.md rule 4a).
        className="z-50 mt-1 min-w-36 rounded-lg border border-zinc-200 bg-white py-1 shadow-lg focus:outline-none"
      >
        {actions.map((action) => (
          <MenuItem key={action.label} disabled={action.disabled}>
            <button
              type="button"
              data-testid={action.testId}
              onClick={action.onSelect}
              disabled={action.disabled}
              className={clsx(
                'flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs whitespace-nowrap',
                // `data-focus` rather than `hover`: the menu moves focus with
                // the arrow keys, and a hover-only highlight leaves a keyboard
                // caller with no idea which item they are on.
                action.destructive
                  ? 'text-red-600 data-focus:bg-red-50'
                  : 'text-zinc-700 data-focus:bg-zinc-50',
                'disabled:cursor-not-allowed disabled:opacity-50',
              )}
            >
              {action.icon && <Icon component={action.icon} size={13} />}
              {action.label}
            </button>
          </MenuItem>
        ))}
      </MenuItems>
    </Menu>
  );
}
