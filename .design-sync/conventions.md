# Fil One console — build conventions

## Setup: wrap the app once

Components assume a themed section, a toast context, and (for data-driven components) a
react-query client. Wrap your whole app in `PreviewProviders` — it composes all three
(QueryClientProvider + ToastProvider + a `light-section` frame) and ships in the bundle:

```jsx
<PreviewProviders>
  <YourScreens />
</PreviewProviders>
```

If you compose providers yourself instead: `QueryClientProvider` and `ToastProvider` are
both exports, and the root element needs the `light-section` class — the theme's CSS
variables (text, border, and card colors) are defined on `.light-section` /
`.dark-section`, so unwrapped components render un-themed. Trigger toasts with the
`useToast()` hook, never by rendering toast markup yourself.

## Styling idiom: Tailwind utilities + brand tokens

Layout glue is Tailwind v4 utility classes (`flex`, `gap-4`, `p-8`, `text-sm`,
`bg-white`, `rounded-lg`, ...). The brand palette is the `brand` color scale —
`bg-brand-600`, `text-brand-700`, `border-brand-200`, backed by tokens
`--color-brand-50` ... `--color-brand-950` (600/700 pass WCAG AA with white text).
Section-scoped semantic variables are available as `var(--color-text-base)`,
`var(--color-paragraph-text)`, `var(--color-border-base)`, `var(--color-card-background)`,
`var(--color-row-selected)` — they flip automatically inside `.dark-section`.
The typeface is `Inter Variable` (loaded by `styles.css`); never set another font.
A `brand-outline` utility class renders the standard 2px brand focus outline.

Component chrome (buttons, modals, tabs, tables, toasts, inputs) is delivered by the
components themselves — use `Button`, `Modal`, `Tabs` etc. with their props (`variant`,
`size`, `open`, ...) rather than hand-writing `.button--primary` / `.modal-panel` /
`.tabs-list` class markup; those classes exist in the stylesheet but the components are
the API.

## Where the truth lives

- `styles.css` (imports `_ds_bundle.css` + `fonts/fonts.css`) — the complete compiled
  stylesheet: every utility, token, and component class that exists. Read it before
  inventing a class name.
- `components/<group>/<Name>/<Name>.d.ts` — the exact prop contract;
  `<Name>.prompt.md` — verified usage examples mirrored from the product's own stories.

## Known limits

- The product logo (`/fil-one-logo.svg` inside AuthCard, LoginErrorPage, VerifyEmailPage,
  RouteErrorPage) resolves only inside the Fil One app — in designs it shows a
  broken-image glyph. Don't rely on it; place your own logo/img instead.
- `PaymentForm`'s card-number/expiry/CVC bodies are Stripe-hosted and stay empty without
  a live Stripe key; the surrounding form chrome renders fully.

## Idiomatic example

```jsx
<PreviewProviders>
  <div className="mx-auto max-w-3xl flex flex-col gap-6 p-8">
    <Heading level={1}>Buckets</Heading>
    <Card>
      <div className="flex items-center justify-between gap-4">
        <StatusIndicator status="active" label="Active" />
        <Button variant="primary" size="md">
          Create bucket
        </Button>
      </div>
    </Card>
  </div>
</PreviewProviders>
```
