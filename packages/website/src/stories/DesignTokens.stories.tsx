import type { Meta, StoryObj } from '@storybook/react-vite';

const meta: Meta = {
  title: 'Design Tokens',
  parameters: {
    layout: 'fullscreen',
  },
};

export default meta;
type Story = StoryObj;

// ─── Helpers ────────────────────────────────────────────────────────────────

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mb-12">
      <h2 className="mb-6 border-b border-zinc-200 pb-3 font-heading text-xl font-semibold text-zinc-900">
        {title}
      </h2>
      {children}
    </section>
  );
}

function TokenLabel({ name, value, dark }: { name: string; value?: string; dark?: boolean }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className={`font-mono text-xs font-medium ${dark ? 'text-zinc-100' : 'text-zinc-800'}`}>
        {name}
      </span>
      {value && (
        <span className={`font-mono text-[11px] ${dark ? 'text-zinc-400' : 'text-zinc-400'}`}>
          {value}
        </span>
      )}
    </div>
  );
}

// ─── Color Swatch ────────────────────────────────────────────────────────────

function ColorSwatch({ variable, hex, label }: { variable: string; hex?: string; label: string }) {
  // Use hex directly when available — Tailwind v4 only emits CSS variables for
  // tokens that are actually referenced in the codebase, so unused brand shades
  // won't have a corresponding var().
  const background = hex ?? `var(${variable})`;
  return (
    <div className="flex flex-col gap-2">
      <div className="h-14 w-full rounded-lg border border-zinc-950/10" style={{ background }} />
      <TokenLabel name={label} value={hex ?? variable} />
    </div>
  );
}

function SemanticSwatch({
  variable,
  label,
  dark,
}: {
  variable: string;
  label: string;
  dark?: boolean;
}) {
  return (
    <div className="flex flex-col gap-2">
      <div
        className="h-14 w-full rounded-lg"
        style={{
          background: `var(${variable})`,
          border: dark ? '1px solid rgba(255,255,255,0.1)' : '1px solid rgba(0,0,0,0.08)',
        }}
      />
      <TokenLabel name={label} value={variable} dark={dark} />
    </div>
  );
}

// ─── Section components ──────────────────────────────────────────────────────

function ColorTokens() {
  return (
    <>
      <Section title="Brand Colors">
        <div className="grid grid-cols-6 gap-4 sm:grid-cols-11">
          {[
            { label: '50', oklch: 'oklch(0.97 0.012 252)' },
            { label: '100', oklch: 'oklch(0.94 0.030 252)' },
            { label: '200', oklch: 'oklch(0.88 0.068 253)' },
            { label: '300', oklch: 'oklch(0.80 0.120 253)' },
            { label: '400', oklch: 'oklch(0.72 0.178 254)' },
            { label: '500', oklch: 'oklch(0.65 0.215 255)' },
            { label: '600', oklch: 'oklch(0.55 0.250 262)' },
            { label: '700', oklch: 'oklch(0.49 0.260 264)' },
            { label: '800', oklch: 'oklch(0.40 0.205 264)' },
            { label: '900', oklch: 'oklch(0.31 0.135 264)' },
            { label: '950', oklch: 'oklch(0.21 0.078 264)' },
          ].map(({ label, oklch }) => (
            <div key={label} className="flex flex-col gap-2">
              <div
                className="h-14 w-full rounded-lg border border-zinc-950/10"
                style={{ background: oklch }}
              />
              <div className="flex flex-col gap-0.5">
                <span className="font-mono text-xs font-medium text-zinc-800">brand-{label}</span>
                <span className="font-mono text-[10px] text-zinc-400 leading-tight">{oklch}</span>
              </div>
            </div>
          ))}
        </div>
      </Section>

      <Section title="Grey Scale">
        <div className="grid grid-cols-6 gap-4 sm:grid-cols-11">
          {[
            { label: '50', hex: '#fafafa' },
            { label: '100', hex: '#f4f4f5' },
            { label: '200', hex: '#e4e4e7' },
            { label: '300', hex: '#d4d4d8' },
            { label: '400', hex: '#a1a1aa' },
            { label: '500', hex: '#71717a' },
            { label: '600', hex: '#52525b' },
            { label: '700', hex: '#3f3f46' },
            { label: '800', hex: '#27272a' },
            { label: '900', hex: '#18181b' },
            { label: '950', hex: '#09090b' },
          ].map(({ label, hex }) => (
            <ColorSwatch
              key={label}
              variable={`--color-zinc-${label}`}
              hex={hex}
              label={`zinc-${label}`}
            />
          ))}
        </div>
      </Section>

      <Section title="Semantic Colors">
        <div className="grid grid-cols-3 gap-4 sm:grid-cols-4">
          <ColorSwatch variable="--color-icon-success" label="icon-success" />
          <ColorSwatch variable="--color-brand-error" label="brand-error" />
          <ColorSwatch variable="--color-brand-error-dark" label="brand-error-dark" />
        </div>
      </Section>

      <Section title="Section-aware Colors">
        <div className="grid grid-cols-1 gap-8 sm:grid-cols-2">
          <div className="light-section rounded-xl border border-zinc-200 bg-white p-6">
            <p className="mb-4 text-sm font-semibold text-zinc-500 uppercase tracking-wide">
              .light-section
            </p>
            <div className="grid grid-cols-2 gap-3">
              <SemanticSwatch variable="--color-text-base" label="text-base" />
              <SemanticSwatch variable="--color-border-base" label="border-base" />
              <SemanticSwatch variable="--color-border-muted" label="border-muted" />
              <SemanticSwatch variable="--color-subheading-text" label="subheading-text" />
              <SemanticSwatch variable="--color-paragraph-text" label="paragraph-text" />
              <SemanticSwatch
                variable="--color-paragraph-text-subtle"
                label="paragraph-text-subtle"
              />
              <SemanticSwatch
                variable="--color-paragraph-text-strong"
                label="paragraph-text-strong"
              />
              <SemanticSwatch variable="--color-card-background" label="card-background" />
              <SemanticSwatch
                variable="--color-card-background-hover"
                label="card-background-hover"
              />
              <SemanticSwatch variable="--color-card-heading-hover" label="card-heading-hover" />
            </div>
          </div>
          <div className="dark-section rounded-xl border border-zinc-700 bg-zinc-900 p-6">
            <p className="mb-4 text-sm font-semibold text-zinc-400 uppercase tracking-wide">
              .dark-section
            </p>
            <div className="grid grid-cols-2 gap-3">
              <SemanticSwatch variable="--color-text-base" label="text-base" dark />
              <SemanticSwatch variable="--color-border-base" label="border-base" dark />
              <SemanticSwatch variable="--color-border-muted" label="border-muted" dark />
              <SemanticSwatch variable="--color-subheading-text" label="subheading-text" dark />
              <SemanticSwatch variable="--color-paragraph-text" label="paragraph-text" dark />
              <SemanticSwatch
                variable="--color-paragraph-text-subtle"
                label="paragraph-text-subtle"
                dark
              />
              <SemanticSwatch
                variable="--color-paragraph-text-strong"
                label="paragraph-text-strong"
                dark
              />
              <SemanticSwatch variable="--color-card-background" label="card-background" dark />
              <SemanticSwatch
                variable="--color-card-background-hover"
                label="card-background-hover"
                dark
              />
              <SemanticSwatch
                variable="--color-card-heading-hover"
                label="card-heading-hover"
                dark
              />
            </div>
          </div>
        </div>
      </Section>
    </>
  );
}

function TypographyTokens() {
  return (
    <Section title="Typography">
      <div className="mb-8">
        <h3 className="mb-4 text-sm font-semibold text-zinc-500 uppercase tracking-wide">
          Font Families
        </h3>
        <div className="grid grid-cols-1 gap-4">
          <div className="rounded-xl border border-zinc-200 p-6">
            <p className="mb-1 font-mono text-xs text-zinc-400">--font-sans (Inter)</p>
            <p className="font-sans text-2xl text-zinc-900">
              The quick brown fox jumps over the lazy dog
            </p>
          </div>
        </div>
      </div>
      <div className="mb-8">
        <h3 className="mb-4 text-sm font-semibold text-zinc-500 uppercase tracking-wide">
          Type Scale
        </h3>
        <div className="divide-y divide-zinc-100 rounded-xl border border-zinc-200 overflow-hidden">
          {[
            { label: 'text-xs', size: 'text-xs', value: '12px / 0.75rem' },
            { label: 'text-sm', size: 'text-sm', value: '14px / 0.875rem' },
            { label: 'text-base', size: 'text-base', value: '16px / 1rem' },
            { label: 'text-lg', size: 'text-lg', value: '18px / 1.125rem' },
            { label: 'text-xl', size: 'text-xl', value: '20px / 1.25rem' },
            { label: 'text-2xl', size: 'text-2xl', value: '24px / 1.5rem' },
            { label: 'text-3xl', size: 'text-3xl', value: '30px / 1.875rem' },
            { label: 'text-4xl', size: 'text-4xl', value: '36px / 2.25rem' },
          ].map(({ label, size, value }) => (
            <div key={label} className="flex items-baseline gap-6 px-5 py-3">
              <span className="w-24 shrink-0 font-mono text-xs text-zinc-400">{label}</span>
              <span className="w-32 shrink-0 font-mono text-xs text-zinc-400">{value}</span>
              <span className={`${size} text-zinc-900`}>Fil One Design System</span>
            </div>
          ))}
        </div>
      </div>
      <div className="mb-8">
        <h3 className="mb-4 text-sm font-semibold text-zinc-500 uppercase tracking-wide">
          Font Weights
        </h3>
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
          {[
            { label: 'font-normal', weight: 'font-normal', value: '400' },
            { label: 'font-medium', weight: 'font-medium', value: '500' },
            { label: 'font-semibold', weight: 'font-semibold', value: '600' },
            { label: 'font-bold', weight: 'font-bold', value: '700' },
          ].map(({ label, weight, value }) => (
            <div key={label} className="rounded-xl border border-zinc-200 p-4">
              <p className="mb-1 font-mono text-xs text-zinc-400">
                {label} ({value})
              </p>
              <p className={`${weight} text-lg text-zinc-900`}>Aa</p>
            </div>
          ))}
        </div>
      </div>
      <div>
        <h3 className="mb-4 text-sm font-semibold text-zinc-500 uppercase tracking-wide">
          Letter Spacing
        </h3>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div className="rounded-xl border border-zinc-200 p-4">
            <p className="mb-1 font-mono text-xs text-zinc-400">--tracking-tight (-1%)</p>
            <p className="text-lg text-zinc-900" style={{ letterSpacing: '-1%' }}>
              Tight letter spacing
            </p>
          </div>
          <div className="rounded-xl border border-zinc-200 p-4">
            <p className="mb-1 font-mono text-xs text-zinc-400">default (0)</p>
            <p className="text-lg text-zinc-900">Default letter spacing</p>
          </div>
        </div>
      </div>
    </Section>
  );
}

// ─── Story ───────────────────────────────────────────────────────────────────

export const AllTokens: Story = {
  name: 'All Tokens',
  render: () => (
    <div className="light-section min-h-screen bg-white px-10 py-12">
      <div className="mx-auto max-w-5xl">
        <div className="mb-12">
          <h1 className="font-heading text-3xl font-bold text-zinc-900">Design Tokens</h1>
          <p className="mt-2 text-zinc-500">
            All design tokens defined in the Fil One design system.
          </p>
        </div>

        <ColorTokens />
        <TypographyTokens />

        <Section title="Spacing">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div className="rounded-xl border border-zinc-200 p-5">
              <p className="mb-3 font-mono text-xs text-zinc-400">--spacing-readable (60ch)</p>
              <div
                className="rounded bg-brand-100 px-4 py-3 text-sm text-brand-800"
                style={{ maxWidth: '60ch' }}
              >
                This container is capped at 60ch — the readable line length used for text-heavy
                content across the product.
              </div>
            </div>
          </div>
        </Section>

        <Section title="Border Radius">
          <div className="grid grid-cols-3 gap-4 sm:grid-cols-6">
            {[
              { label: 'rounded-sm', cls: 'rounded-sm', value: '2px' },
              { label: 'rounded', cls: 'rounded', value: '4px' },
              { label: 'rounded-md', cls: 'rounded-md', value: '6px' },
              { label: 'rounded-lg', cls: 'rounded-lg', value: '8px' },
              { label: 'rounded-xl', cls: 'rounded-xl', value: '12px' },
              { label: 'rounded-2xl', cls: 'rounded-2xl', value: '16px' },
              { label: 'rounded-3xl', cls: 'rounded-3xl', value: '24px' },
              { label: 'rounded-full', cls: 'rounded-full', value: '9999px' },
            ].map(({ label, cls, value }) => (
              <div key={label} className="flex flex-col gap-2">
                <div className={`h-14 w-full bg-brand-200 border-2 border-brand-400 ${cls}`} />
                <TokenLabel name={label} value={value} />
              </div>
            ))}
          </div>
        </Section>

        <Section title="Shadows">
          <div className="grid grid-cols-2 gap-6 sm:grid-cols-4">
            {[
              { label: 'shadow-sm', cls: 'shadow-sm' },
              { label: 'shadow', cls: 'shadow' },
              { label: 'shadow-md', cls: 'shadow-md' },
              { label: 'shadow-lg', cls: 'shadow-lg' },
              { label: 'shadow-xl', cls: 'shadow-xl' },
              { label: 'shadow-2xl', cls: 'shadow-2xl' },
            ].map(({ label, cls }) => (
              <div key={label} className="flex flex-col gap-3">
                <div className={`h-16 w-full rounded-xl bg-white ${cls}`} />
                <TokenLabel name={label} />
              </div>
            ))}
          </div>
        </Section>

        <Section title="Focus & Outline Utilities">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div className="flex flex-col gap-2">
              <div className="brand-outline flex h-14 w-full items-center justify-center rounded-lg bg-white text-sm text-zinc-600">
                .brand-outline
              </div>
              <TokenLabel
                name="brand-outline"
                value="outline: 2px solid var(--color-brand-600); outline-offset: 0"
              />
            </div>
          </div>
        </Section>

        <Section title="Animations">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div className="rounded-xl border border-zinc-200 p-5">
              <p className="mb-3 font-mono text-xs text-zinc-400">toast-slide-in</p>
              <p className="text-sm text-zinc-600">
                Used by <code className="rounded bg-zinc-100 px-1 py-0.5 text-xs">.toast-item</code>{' '}
                — slides in from the right with a fade (0.2s ease-out).
              </p>
              <div className="mt-3 font-mono text-xs text-zinc-400">
                from: opacity 0, translateX(100%) → to: opacity 1, translateX(0)
              </div>
            </div>
          </div>
        </Section>
      </div>
    </div>
  ),
};
