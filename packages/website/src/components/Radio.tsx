import clsx from 'clsx';

type RadioProps = {
  name: string;
  value: string;
  checked: boolean;
  onChange: () => void;
  className?: string;
  id?: string;
  'data-testid'?: string;
};

export function Radio({ name, value, checked, onChange, className, ...rest }: RadioProps) {
  return (
    <span
      className={clsx(
        'relative inline-flex size-4 shrink-0 items-center justify-center',
        className,
      )}
    >
      <input
        {...rest}
        type="radio"
        name={name}
        value={value}
        checked={checked}
        onChange={onChange}
        className="peer sr-only"
      />
      {/* outer ring — sibling of peer */}
      <span className="absolute inset-0 rounded-full border border-zinc-300 bg-white transition-colors peer-checked:border-brand-600" />
      {/* inner dot — sibling of peer */}
      <span className="relative size-2 scale-0 rounded-full bg-brand-600 transition-transform peer-checked:scale-100" />
    </span>
  );
}
