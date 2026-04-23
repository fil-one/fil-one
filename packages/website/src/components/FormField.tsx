type FormFieldProps = {
  label: string;
  htmlFor?: string;
  description?: string;
  error?: string;
  children: React.ReactNode;
};

export function FormField({ label, htmlFor, description, error, children }: FormFieldProps) {
  return (
    <div className="flex flex-col gap-2.5">
      <label htmlFor={htmlFor} className="text-xs font-medium text-(--color-text-base)">
        {label}
      </label>
      {children}
      {error ? (
        <p className="text-xs text-(--color-brand-error)">{error}</p>
      ) : description ? (
        <p className="text-xs text-(--color-paragraph-text)">{description}</p>
      ) : null}
    </div>
  );
}
