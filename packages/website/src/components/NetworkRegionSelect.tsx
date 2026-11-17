import { Fragment } from 'react';
import { Listbox, ListboxButton, ListboxOption, ListboxOptions } from '@headlessui/react';
import { CaretDownIcon, CheckIcon } from '@phosphor-icons/react/dist/ssr';
import type { S3Region } from '@filone/shared';
import { formatRegion, getAvailableNetworks } from '@filone/shared';

import { FILONE_STAGE } from '../env.js';
import type { InputSize } from './Input';
import { RegionLine } from './RegionLine';

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
    control: 'min-h-(--control-height-sm) py-1 pr-7 pl-2.5 text-ui',
    caret: { inset: 'right-2', size: 12 },
  },
  md: {
    control: 'min-h-(--control-height-md) py-1.5 pr-9 pl-3 text-sm',
    caret: { inset: 'right-3', size: 14 },
  },
  lg: {
    control: 'min-h-(--control-height-lg) py-2 pr-10 pl-4 text-sm',
    caret: { inset: 'right-4', size: 14 },
  },
};

/** The regions one network serves, read as a list: "eu-central-3, us-east-9". */
function networkRegions(regions: readonly S3Region[]): string {
  return regions.join(', ');
}

/**
 * The closed field: the rows of the network that was chosen, as the list drew
 * them. A network serving several regions is several lines, and the control
 * grows to hold them, because the regions are the answer to what the field
 * asks and abbreviating them to codes loses the names.
 */
function SelectedNetwork({ regions }: { regions: readonly S3Region[] }) {
  return (
    <>
      {regions.map((region) => (
        <span key={region} className="flex w-full items-center gap-2">
          <RegionLine region={region} isCodeInColumn />
        </span>
      ))}
    </>
  );
}

/**
 * The regions an access key will work in, chosen one network at a time.
 *
 * A key belongs to a network, not to a region: its tenant is region-free, so
 * the key works at every region that network serves. The list is a row per
 * region, which is what the user recognises, divided into the networks they
 * sit on; picking any row takes the whole network, and every region on it is
 * ticked. The field carries a region as its value so callers keep naming one.
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
    <Listbox value={value} onChange={onChange} disabled={disabled || onlyOne}>
      {/* A button takes its name from its label alone, which would leave the
          chosen regions unannounced, so the name carries both. */}
      <ListboxButton
        id={id}
        aria-label={`Regions, ${selected ? networkRegions(selected.regions) : formatRegion(value)}`}
        className={`group relative flex w-full flex-col justify-center gap-3 rounded-md border border-(--input-border-color) bg-white text-left ${SIZES[size].control} text-(--color-text-base) transition-colors duration-150 focus-visible:brand-outline data-disabled:cursor-not-allowed data-disabled:bg-zinc-100 data-disabled:text-zinc-400 ${className ?? ''}`}
      >
        <SelectedNetwork regions={selected?.regions ?? [value]} />
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
        {networks.map((network, index) => (
          <Fragment key={network.id}>
            {/* The rule is decoration: the field's description says the key
                works in the regions it names, and choosing one announces the
                whole set, so nothing rests on seeing the divider. */}
            {index > 0 && <hr aria-hidden="true" className="my-1 border-zinc-200" />}
            {/* The highlight is on the group, not the row under the pointer:
                picking any row takes the whole network, so the rows it would
                take are what lights up.
                The pointer lights it with a plain hover, which holds while the
                pointer is anywhere in the group; driving it from the active
                option instead would blink at every row boundary, where the
                option being left drops `data-focus` before the one being
                entered takes it. Keyboard focus moves one option at a time and
                has no such gap, so it reads the group off that option. */}
            <div className="relative rounded-md hover:bg-zinc-100 has-[[data-focus]]:bg-zinc-100">
              {network.regions.map((region) => (
                // Named outright: built from its parts, the name would run
                // "Europe (France)eu-west-1".
                <ListboxOption
                  key={region}
                  value={region}
                  aria-label={formatRegion(region)}
                  data-testid="network-region-option"
                  data-network={network.id}
                  data-region={region}
                  // The right padding is the tick's column, left clear on
                  // every network so the codes line up down the list whether
                  // or not a network is the chosen one.
                  className="group flex cursor-pointer items-center gap-2 rounded-md py-1.5 pr-8 pl-3 text-ui text-zinc-900 select-none"
                >
                  <RegionLine region={region} isCodeInColumn />
                </ListboxOption>
              ))}
              {/* One tick for the network, centred on its rows: what the key
                  reaches is the network, and a tick per region would read as
                  several separate choices. */}
              {network.id === selected?.id && (
                <CheckIcon
                  size={13}
                  weight="bold"
                  aria-hidden="true"
                  data-testid="network-tick"
                  className="pointer-events-none absolute top-1/2 right-3 -translate-y-1/2 text-brand-600"
                />
              )}
            </div>
          </Fragment>
        ))}
      </ListboxOptions>
    </Listbox>
  );
}
