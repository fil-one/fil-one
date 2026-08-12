import { QuestionIcon } from '@phosphor-icons/react/dist/ssr';

import type { IconProps } from './Icon';
import { Tooltip } from './Tooltip';

export type PropertyCardProps = {
  icon: IconProps['component'];
  label: string;
  value: string;
  enabled?: boolean;
  tooltip: string;
};

/**
 * One bucket property: icon tile, name, and state beneath.
 *
 * The glyph sits in a soft zinc-100 tile so each card has a distinct silhouette
 * to recognise. IconBox's neutral token is zinc-200, which read too heavy here
 * against the quiet card, so the tile is rendered inline at the same geometry
 * with a softer background. The card padding is symmetric (p-3), so the tile is
 * inset equally from the top, bottom, and left edges.
 *
 * The property name leads and its state follows beneath, quieter: the name is
 * what you scan for, and "Enabled" means nothing until you know what it belongs
 * to.
 */
export function PropertyCard({ icon: Icon, label, value, enabled, tooltip }: PropertyCardProps) {
  return (
    <div className="flex items-center gap-3 rounded-xl border border-zinc-200 bg-white p-3">
      <span className="inline-flex shrink-0 items-center justify-center rounded-lg bg-zinc-100 p-2.5">
        <Icon size={18} className="text-zinc-500" aria-hidden />
      </span>
      <div className="min-w-0">
        <div className="flex items-center gap-1">
          <p className="text-sm font-medium text-zinc-900">{label}</p>
          {/* Hover-only, as Tooltip is on main today. It gains focus and Escape
              handling in #557; this call site picks that up for free. */}
          <Tooltip content={tooltip} side="bottom">
            <QuestionIcon size={14} className="text-zinc-500 hover:text-zinc-700" aria-hidden />
          </Tooltip>
        </div>
        {/* zinc-500 for "Disabled", not zinc-400: it's the value of the property,
            so it needs 4.5:1 as text, and zinc-400 is 2.56:1 on white. */}
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
    </div>
  );
}
