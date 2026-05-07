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
      <label htmlFor={htmlFor} className="text-xs font-medium text-zinc-900">
        {label}
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
