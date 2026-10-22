import { useRef } from 'react';
import { MagnifyingGlassIcon, XIcon } from '@phosphor-icons/react/dist/ssr';
import { clsx } from 'clsx';

import { IconButton } from './IconButton';
import { Input, type InputSize } from './Input';

type SearchInputProps = {
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  /** Names the field for a screen reader, which the placeholder does not. */
  'aria-label': string;
  inputSize?: InputSize;
  /** Width and placement in the surrounding toolbar. */
  className?: string;
};

/**
 * A search field: a magnifier at the start and, once there is text, a clear
 * button at the end. The browser's own clear control is hidden, because each
 * engine draws it in its own colour and none of them match the console; ours
 * is an `IconButton`, so it hovers and focuses like every other icon control.
 * Escape still clears, as the native field does.
 */
export function SearchInput({
  value,
  onChange,
  placeholder,
  'aria-label': ariaLabel,
  inputSize = 'sm',
  className,
}: SearchInputProps) {
  const inputRef = useRef<HTMLElement>(null);

  return (
    <div className={clsx('relative', className)}>
      <span className="pointer-events-none absolute inset-y-0 left-2.5 flex items-center text-zinc-400">
        <MagnifyingGlassIcon size={14} aria-hidden="true" />
      </span>
      <Input
        ref={inputRef}
        type="search"
        value={value}
        onChange={onChange}
        placeholder={placeholder}
        aria-label={ariaLabel}
        inputSize={inputSize}
        // Room for the magnifier, and for the clear button while it shows.
        className={clsx(
          'pl-8 [&::-webkit-search-cancel-button]:appearance-none',
          value !== '' && 'pr-8',
        )}
      />
      {value !== '' && (
        <span className="absolute inset-y-0 right-1.5 flex items-center">
          <IconButton
            icon={XIcon}
            size="sm"
            aria-label="Clear search"
            // Back to the field, so the next search starts where the last ended.
            onClick={() => {
              onChange('');
              inputRef.current?.focus();
            }}
            className="rounded-md text-zinc-400 focus-visible:brand-outline"
          />
        </span>
      )}
    </div>
  );
}
