import type { Icon as PhosphorIcon } from '@phosphor-icons/react';

import { Heading } from './Heading/Heading';

export function SectionCard({
  icon: IconComp,
  title,
  description,
  danger,
  children,
}: {
  icon: PhosphorIcon;
  title: string;
  description: string;
  danger?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div
      className={`rounded-lg border bg-white shadow-sm ${
        danger ? 'border-red-200' : 'border-[#e1e4ea]'
      }`}
    >
      <div className="flex items-center gap-2.5 p-5 pb-0">
        <div
          className={`flex size-8 items-center justify-center rounded-lg ${
            danger ? 'bg-red-50' : 'bg-zinc-100'
          }`}
        >
          <IconComp size={16} className={danger ? 'text-red-600' : 'text-zinc-500'} />
        </div>
        <div>
          <Heading tag="h2" size="sm" className={danger ? 'text-red-600' : undefined}>
            {title}
          </Heading>
          <p className="text-[13px] text-zinc-500">{description}</p>
        </div>
      </div>
      <div className="p-5">{children}</div>
    </div>
  );
}
