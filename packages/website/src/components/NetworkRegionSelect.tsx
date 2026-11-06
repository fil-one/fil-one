import { Listbox, ListboxButton, ListboxOption, ListboxOptions } from '@headlessui/react';
import { CaretDownIcon, CheckIcon } from '@phosphor-icons/react/dist/ssr';
import type { S3Region } from '@filone/shared';
import { formatRegion, getAvailableNetworks } from '@filone/shared';

import { FILONE_STAGE } from '../env.js';
import type { InputSize } from './Input';
import { RegionFlag } from './RegionFlag';

type NetworkRegionSelectProps = {
  id?: string;
  value: S3Region;
  onChange: (region: S3Region) => void;
  disabled?: boolean;
  size?: InputSize;
  className?: string;
};

// The same heights and insets as `RegionSelect`, which this sits beside.
const SIZES: Record<InputSize, { control: string; caret: { inset: string; size: number } }> = {
  sm: {
    control: 'h-(--control-height-sm) pr-7 pl-2.5 text-ui',
    caret: { inset: 'right-2', size: 12 },
  },
  md: {
    control: 'h-(--control-height-md) pr-9 pl-3 text-sm',
    caret: { inset: 'right-3', size: 14 },
  },
  lg: {
    control: 'h-(--control-height-lg) pr-10 pl-4 text-sm',
    caret: { inset: 'right-4', size: 14 },
  },
};

/** The regions one network serves, read as a list: "eu-central-3, pilot-mad". */
function networkRegions(regions: readonly S3Region[]): string {
  return regions.join(', ');
}

/** A network's flags and the regions it serves. */
function NetworkLine({
  regions,
  isCodeInColumn,
}: {
  regions: readonly S3Region[];
  isCodeInColumn: boolean;
}) {
  return (
    <>
      {/* The codes beside the flags already say where the network reaches, so
          the flags stay out of the accessible name. */}
      <span aria-hidden="true" className="flex gap-1 group-data-disabled:opacity-50">
        {regions.map((region) => (
          <RegionFlag key={region} region={region} />
        ))}
      </span>
      <span
        className={`truncate text-zinc-500 group-data-disabled:text-zinc-400 ${isCodeInColumn ? 'ml-auto pl-3' : ''}`}
      >
        {networkRegions(regions)}
      </span>
    </>
  );
}

/**
 * The regions an access key will work in, chosen one network at a time.
 *
 * A key belongs to a network, not to a region: its tenant is region-free, so
 * the key works at every region that network serves. The field is labelled for
 * the regions because that is what the user is choosing between, and it carries
 * a region as its value so callers keep naming one; every region of a network
 * selects that network.
 */
export function NetworkRegionSelect({
  id,
  value,
  onChange,
  disabled,
  size = 'md',
  className,
}: NetworkRegionSelectProps) {
  const networks = getAvailableNetworks(FILONE_STAGE);
  // Found by the region it holds rather than by a lookup elsewhere: this list
  // is what the field offers, so it is also what decides which option is on.
  const selected = networks.find((n) => n.regions.includes(value)) ?? networks[0];
  const onlyOne = networks.length === 1;

  return (
    <Listbox
      value={selected?.regions[0] ?? value}
      onChange={onChange}
      disabled={disabled || onlyOne}
    >
      {/* A button takes its name from its label alone, which would leave the
          chosen regions unannounced, so the name carries both. */}
      <ListboxButton
        id={id}
        aria-label={`Regions, ${selected ? networkRegions(selected.regions) : formatRegion(value)}`}
        className={`group relative flex w-full items-center gap-2 rounded-md border border-(--input-border-color) bg-white text-left ${SIZES[size].control} text-(--color-text-base) transition-colors duration-150 focus-visible:brand-outline data-disabled:cursor-not-allowed data-disabled:bg-zinc-100 data-disabled:text-zinc-400 ${className ?? ''}`}
      >
        <NetworkLine regions={selected?.regions ?? [value]} isCodeInColumn={false} />
        <span
          className={`pointer-events-none absolute inset-y-0 flex items-center text-zinc-400 ${SIZES[size].caret.inset}`}
        >
          <CaretDownIcon size={SIZES[size].caret.size} weight="bold" />
        </span>
      </ListboxButton>
      <ListboxOptions
        anchor={{ to: 'bottom start', gap: 4 }}
        transition
        className="z-50 w-(--button-width) rounded-lg border border-zinc-200 bg-white p-1 shadow-md outline-none transition-opacity duration-200 ease-out data-closed:opacity-0 data-leave:ease-in"
      >
        {networks.map((network) => (
          <ListboxOption
            key={network.id}
            value={network.regions[0]}
            aria-label={networkRegions(network.regions)}
            data-testid="network-option"
            data-network={network.id}
            className="group flex cursor-pointer items-center gap-2 rounded-md px-3 py-1.5 text-ui text-zinc-900 select-none data-focus:bg-zinc-100"
          >
            <NetworkLine regions={network.regions} isCodeInColumn />
            <CheckIcon
              size={13}
              weight="bold"
              aria-hidden="true"
              className="shrink-0 text-brand-600 invisible group-data-selected:visible"
            />
          </ListboxOption>
        ))}
      </ListboxOptions>
    </Listbox>
  );
}
