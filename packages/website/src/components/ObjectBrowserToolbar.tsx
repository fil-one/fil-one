export function PrefixBreadcrumb({
  bucketName,
  currentPrefix,
  onPrefixChange,
}: {
  bucketName: string;
  currentPrefix: string;
  onPrefixChange: (prefix: string) => void;
}) {
  const segments = currentPrefix.split('/').filter(Boolean);
  const crumbs = [
    { label: bucketName, prefix: '' },
    ...segments.map((segment, idx) => ({
      label: segment,
      prefix: segments.slice(0, idx + 1).join('/') + '/',
    })),
  ];

  // Styled as the page's own `Breadcrumb`: a crumb that leads somewhere is muted
  // and darkens on hover, the folder you are in is near-black, and nothing takes
  // the accent colour. Buttons rather than links, since a folder is a search
  // param on this page and changing it replaces the history entry.
  return (
    <nav aria-label="Folder" className="mb-4">
      <ol className="flex flex-wrap items-center gap-2 text-sm">
        {crumbs.map((crumb, idx) => {
          const isLast = idx === crumbs.length - 1;
          return (
            <li key={crumb.prefix} className="flex min-w-0 items-center gap-2">
              {idx > 0 && (
                <span aria-hidden="true" className="text-zinc-400 select-none">
                  /
                </span>
              )}
              {isLast ? (
                <span className="truncate font-medium text-zinc-950" aria-current="location">
                  {crumb.label}
                </span>
              ) : (
                <button
                  type="button"
                  onClick={() => onPrefixChange(crumb.prefix)}
                  className="truncate rounded-md text-zinc-500 transition-colors duration-150 hover:text-zinc-950 focus-visible:brand-outline"
                >
                  {crumb.label}
                </button>
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
