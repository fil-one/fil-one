export function SettingRow({
  label,
  description,
  action,
}: {
  label: string;
  description: React.ReactNode;
  action: React.ReactNode;
}) {
  return (
    // Stacked on a phone: side by side, a long action such as "Add
    // authenticator or key" squeezed the description to a word per line.
    <div className="flex flex-col items-start gap-3 py-1 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
      <div>
        <p className="text-sm font-medium text-zinc-900">{label}</p>
        <p className="max-w-md text-xs text-zinc-500">{description}</p>
      </div>
      {action}
    </div>
  );
}
