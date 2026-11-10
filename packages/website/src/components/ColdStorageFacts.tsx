export interface Fact {
  label: string;
  value: string;
  /** A quieter line under the value, such as the rate it replaces. */
  detail?: string;
}

/**
 * What a cold storage action does, as label and value pairs, followed in the
 * dialog by any footnote. The markup is ToggleConfirmModal's fact list, so a
 * confirmation reads the same across the console.
 */
export function FactList({ facts }: { facts: Fact[] }) {
  return (
    <dl className="divide-y divide-(--color-border-muted) border-y border-(--color-border-muted)">
      {facts.map((fact) => (
        <div key={fact.label} className="flex gap-4 py-2.5 text-sm leading-relaxed">
          <dt className="w-28 flex-shrink-0 text-(--color-paragraph-text-subtle)">{fact.label}</dt>
          {/* The detail takes its own line: run on after the value, its
              separator ended up alone at the end of a line at 375px. */}
          <dd className="flex flex-col text-(--color-paragraph-text-strong)">
            {fact.value}
            {fact.detail && (
              <span className="text-xs text-(--color-paragraph-text-subtle)">{fact.detail}</span>
            )}
          </dd>
        </div>
      ))}
    </dl>
  );
}
