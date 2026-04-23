type InfoItem = {
  title: string;
  description: string;
};

type InfoSidebarProps = {
  heading: string;
  items: InfoItem[];
};

export function InfoSidebar({ heading, items }: InfoSidebarProps) {
  return (
    <div>
      <p className="text-[10px] font-semibold uppercase tracking-[1px] text-(--color-paragraph-text-subtle)">
        {heading}
      </p>
      <div className="mt-3 flex flex-col">
        {items.map((item, i) => (
          <div
            key={item.title}
            className={`flex flex-col gap-0.5 py-3 ${i > 0 ? 'border-t border-(--color-border-muted)' : ''}`}
          >
            <span className="text-xs font-semibold text-(--color-text-base)">{item.title}</span>
            <p className="text-xs leading-relaxed text-(--color-paragraph-text)">
              {item.description}
            </p>
          </div>
        ))}
      </div>
    </div>
  );
}
