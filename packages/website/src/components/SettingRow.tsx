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
    <div className="flex items-center justify-between gap-4 py-1">
      <div>
        <p className="text-sm font-medium text-zinc-900">{label}</p>
        <p className="max-w-md text-xs text-zinc-500">{description}</p>
      </div>
      {action}
    </div>
  );
}
