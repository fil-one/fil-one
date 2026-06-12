import { QuestionIcon } from '@phosphor-icons/react/dist/ssr';

import { Tooltip } from './Tooltip';

export type PropertyCardProps = {
  icon: React.ComponentType<{ size: number; className?: string; 'aria-hidden'?: boolean }>;
  label: string;
  value: string;
  enabled?: boolean;
  tooltip: string;
};

export function PropertyCard({ icon: Icon, label, value, enabled, tooltip }: PropertyCardProps) {
  return (
    <div className="flex items-center gap-4 rounded-lg border border-zinc-200 bg-white px-5 py-4">
      <div className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-zinc-100">
        <Icon size={20} className="text-zinc-500" aria-hidden />
      </div>
      <div>
        <div className="flex items-center gap-1">
          <p className="text-sm font-medium text-zinc-900">{label}</p>
          <Tooltip content={tooltip} side="bottom">
            <QuestionIcon size={13} className="text-zinc-500 hover:text-zinc-700" aria-hidden />
          </Tooltip>
        </div>
        <p
          className={`text-xs font-medium ${
            enabled === true
              ? 'text-green-700'
              : enabled === false
                ? 'text-zinc-400'
                : 'text-zinc-600'
          }`}
        >
          {value}
        </p>
      </div>
    </div>
  );
}
