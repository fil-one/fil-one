type FormFieldProps = {
  label: string;
  optional?: boolean;
  htmlFor?: string;
  description?: string;
  error?: string;
  children: React.ReactNode;
};

export function FormField({
  label,
  optional,
  htmlFor,
  description,
  error,
  children,
}: FormFieldProps) {
  return (
    <div className="flex flex-col gap-2.5">
      <label htmlFor={htmlFor} className="text-sm font-medium text-zinc-700">
        {label}
        {optional && (
          <span className="ml-1 text-xs font-normal text-(--color-paragraph-text-subtle)">
            (optional)
          </span>
        )}
      </label>
      {children}
      {error ? (
        <p className="text-xs text-red-600">{error}</p>
      ) : description ? (
        <p className="text-xs text-zinc-600">{description}</p>
      ) : null}
    </div>
  );
}
