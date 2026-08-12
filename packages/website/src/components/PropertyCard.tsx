import { QuestionIcon } from '@phosphor-icons/react/dist/ssr';

import { Tooltip } from './Tooltip';

export type PropertyCardProps = {
  label: string;
  value: string;
  enabled?: boolean;
  tooltip: string;
};

/**
 * One bucket property: quiet label, value beneath.
 *
 * No icon. A 40px tile carrying a generic glyph doubled the card's height
 * without telling you anything the label didn't, and two of the glyphs (Object
 * Lock, Default Retention) were near-identical locks that read as the same
 * property at a glance.
 *
 * The property name leads and its state follows beneath, quieter: the name is
 * what you scan for, and "Enabled" means nothing until you know what it belongs
 * to.
 */
export function PropertyCard({ label, value, enabled, tooltip }: PropertyCardProps) {
  return (
    <div className="rounded-lg border border-zinc-200 bg-white px-4 py-3">
      <div className="flex items-center gap-1">
        <p className="text-sm font-medium text-zinc-900">{label}</p>
        {/* Hover-only, as Tooltip is on main today. It gains focus and Escape
            handling in #557; this call site picks that up for free.

            14px in zinc-500, not 12px in zinc-400: this glyph is the only signal
            that help exists, so WCAG 1.4.11 wants 3:1 against the card and
            zinc-400 is 2.56:1 on white. zinc-500 is 4.83:1. */}
        <Tooltip content={tooltip} side="bottom">
          <QuestionIcon size={14} className="text-zinc-500 hover:text-zinc-700" aria-hidden />
        </Tooltip>
      </div>
      {/* zinc-500 for "Disabled", not zinc-400: it's the value of the property, so
          it needs 4.5:1 as text, and zinc-400 is 2.56:1 on white. */}
      <p
        className={`mt-0.5 text-xs font-medium ${
          enabled === true
            ? 'text-green-700'
            : enabled === false
              ? 'text-zinc-500'
              : 'text-zinc-900'
        }`}
      >
        {value}
      </p>
    </div>
  );
}
