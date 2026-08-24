# Fil One console

This package is the **console**: the authenticated Fil One product. The directory name
`website` is legacy and does not refer to the marketing site.

## Before changing any UI, read [DESIGN.md](DESIGN.md)

The bar is Linear, Stripe, Vercel, Resend. Match it.

The rules broken most often, so check these first:

- **Do not invent components or tokens.** Search `src/components` (174 files) and
  `src/styles/globals.css` first. If nothing fits, say so and ask before building.
- **No raw colour values.** No hex, `rgb()`, or `oklch()` in components. Use a token or a
  semantic variable.
- **No arbitrary type sizes.** No `text-[13px]`, no `leading-[...]`. Use `text-meta` (11px),
  `text-xs` (12px), `text-ui` (13px, the default), `text-sm` (14px).
- **`focus-visible`, never `focus`.** Including in the `src/styles/*.css` files.
- **Four radii only:** `rounded-md` for controls, `rounded-lg` for toasts and table
  containers, `rounded-xl` for cards and modals, `rounded-full` for pills.
- **Shadows only on overlays.** Resting surfaces get a border plus at most `shadow-xs`.
- **No `transition-all`.** Durations are `150` or `200`.
- **Control heights come from `--control-height-*`**, never computed from padding.
- **Build every state:** hover, focus-visible, active, disabled, loading, empty, error.
- **375px is a supported width.** Verify it.
- **Sentence case, no em dashes.** Buttons name their action.

Run the checklist at the end of `DESIGN.md` before saying a UI change is done.
