import { Listbox, ListboxButton, ListboxOption, ListboxOptions } from '@headlessui/react';
import { CaretDownIcon, CheckIcon } from '@phosphor-icons/react/dist/ssr';
import type { S3Region } from '@filone/shared';
import { formatRegion, getRegionLabel } from '@filone/shared';

import { useAvailableRegions } from '../lib/use-available-regions.js';
import type { InputSize } from './Input';
import { RegionFlag } from './RegionFlag';

type RegionSelectProps = {
  id?: string;
  value: S3Region;
  onChange: (region: S3Region) => void;
  disabled?: boolean;
  /** Matches `Input`'s sizes, so the field lines up with the inputs beside it. */
  size?: Exclude<InputSize, 'sm'>;
  /**
   * Width for a picker set in a row beside other content. The default fills its container,
   * as a form field does; Headless UI renders the listbox with no wrapper element, so the
   * button itself is what the row lays out.
   */
  className?: string;
};

// The same heights and insets as `Select`, which this replaces for regions.
const SIZES: Record<NonNullable<RegionSelectProps['size']>, { control: string; caret: string }> = {
  md: { control: 'h-(--control-height-md) pr-9 pl-3', caret: 'right-3' },
  lg: { control: 'h-(--control-height-lg) pr-10 pl-4', caret: 'right-4' },
};

/**
 * A region's flag, name and code. In the list the codes are right-aligned into a
 * column; in the closed field the code stays beside the name it belongs to.
 */
function RegionLine({ region, isCodeInColumn }: { region: S3Region; isCodeInColumn: boolean }) {
  return (
    <>
      {/* The name beside the flag already says where it is, so the flag stays out of the accessible name */}
      <span aria-hidden="true" className="flex group-data-disabled:opacity-50">
        <RegionFlag region={region} />
      </span>
      <span className="truncate">{getRegionLabel(region)}</span>
      <span
        className={`shrink-0 text-zinc-500 group-data-disabled:text-zinc-400 ${isCodeInColumn ? 'ml-auto pl-3' : ''}`}
      >
        {region}
      </span>
    </>
  );
}

/**
 * A listbox rather than a native select, because an `<option>` can hold only
 * text and each region is shown with its flag, as in the buckets table.
 */
export function RegionSelect({
  id,
  value,
  onChange,
  disabled,
  size = 'md',
  className,
}: RegionSelectProps) {
  const regions = useAvailableRegions();
  const onlyOne = regions.length === 1;

  return (
    <Listbox value={value} onChange={onChange} disabled={disabled || onlyOne}>
      {/* A button takes its name from its label alone, which would leave the chosen region
          unannounced, so the name carries both. Every caller labels this field "Region". */}
      <ListboxButton
        id={id}
        aria-label={`Region, ${formatRegion(value)}`}
        className={`group relative flex w-full items-center gap-2 rounded-md border border-(--input-border-color) bg-white text-left text-sm ${SIZES[size].control} text-(--color-text-base) transition-colors duration-150 focus-visible:brand-outline data-disabled:cursor-not-allowed data-disabled:bg-zinc-100 data-disabled:text-zinc-400 ${className ?? ''}`}
      >
        <RegionLine region={value} isCodeInColumn={false} />
        <span
          className={`pointer-events-none absolute inset-y-0 flex items-center text-zinc-400 ${SIZES[size].caret}`}
        >
          <CaretDownIcon size={14} weight="bold" />
        </span>
      </ListboxButton>
      <ListboxOptions
        anchor={{ to: 'bottom start', gap: 4 }}
        transition
        className="z-50 w-(--button-width) rounded-lg border border-zinc-200 bg-white p-1 shadow-md outline-none transition-opacity duration-200 ease-out data-closed:opacity-0 data-leave:ease-in"
      >
        {regions.map((region) => (
          // Named outright: built from its parts, the name would run "Europe (France)eu-west-1"
          <ListboxOption
            key={region}
            value={region}
            aria-label={formatRegion(region)}
            data-testid="region-option"
            data-region={region}
            className="group flex cursor-pointer items-center gap-2 rounded-md px-3 py-1.5 text-ui text-zinc-900 select-none data-focus:bg-zinc-100"
          >
            <RegionLine region={region} isCodeInColumn />
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
