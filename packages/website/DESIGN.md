# Fil One Console Design System

## Scope

This document governs the **console**: the authenticated Fil One product that lives in
`packages/website`. The directory name is legacy. Nothing here applies to the marketing
site, which is a separate codebase with different goals (a marketing page optimises for a
first impression; the console optimises for density, legibility, and repeat daily use).

Token _values_ live in code and are not restated here:

- [`src/styles/globals.css`](src/styles/globals.css) for the brand scale, semantic colours, and shared utilities
- `src/styles/*.css` for per-component styling (`button`, `modal`, `state-card`, `table`, `tabs`, `text-input`, `toast`)
- [`src/stories/DesignTokens.stories.tsx`](src/stories/DesignTokens.stories.tsx) renders all of it in Storybook

If this document and the CSS disagree, the CSS is wrong or this document is stale. Fix one
of them in the same pull request that found the conflict.

## What craft means here

The bar is Linear, Stripe, Vercel, Resend. Concretely, that means:

- **Attention to detail is care.** A misaligned icon or a focus ring that appears on mouse
  click tells the user nobody looked. They will not name it, but they will feel it.
- **Delight is not decoration.** It comes from the interface answering before you ask: the
  empty state that explains the next step, the error that says what to do, the table that
  keeps its column widths when data loads.
- **Pixel perfect is a real standard, not a slogan.** Values come from the scale. When
  something looks off by a pixel, it usually is, and it is worth fixing.
- **Consistency beats local cleverness.** A slightly worse pattern used everywhere reads as
  more polished than a better pattern used once.

## How to use this document

Every rule below has the same shape:

- **The rule**, as an imperative heading. It applies unless a rule explicitly grants an exception.
- **Why**, where the reason is non-obvious or where someone would otherwise reasonably override it.
- **Check**, a thing you can look at to verify compliance.

The checklist at the end is harvested from the `Check` lines. Use it before opening a pull
request.

---

## 1. Do not invent tokens or components

Use what exists. Before adding a component, search `src/components` (there are 174 files);
before adding a token, read `globals.css`. If nothing fits, say so explicitly in the pull
request description with the reason no existing option works, and get agreement before
building it.

**Why:** The console already has `Badge`, `StateCard`, `EmptyStateCard`, `Alert`, `Banner`,
`Spinner`, and `Card`. Almost every "we need a new component" turns out to be one of these
with a prop added. Inconsistency arrives one reasonable-looking new component at a time,
and it is far cheaper to prevent than to consolidate later.

**Check:** No new file in `src/components` and no new `@theme` entry without a sentence in
the pull request justifying it.

## 2. Never write a raw colour value

No hex, `rgb()`, or `oklch()` literals in components. Every colour comes from a Tailwind
token (`brand-*`, `zinc-*`, `red-*`, and so on) or a semantic CSS variable.

**Why:** Raw hex cannot respond to context and cannot be audited for contrast. It is how the
current drift happened. Seven raw values are in `src` today: `#e1e4ea`, `#14181f`,
`#f9fafb`, `#677183`, and `#99a0ae` are near-misses for existing zinc steps, so the console
renders several slightly different greys that were all meant to be the same grey. Worse,
`#0080ff` and `#0066ff` bypass the brand scale entirely, which means they skip the contrast
work already done: `brand-600` and `brand-700` are the shades documented as passing WCAG AA
with white text, and a hand-picked blue is not.

**Check:** `grep -rE '\-\[#[0-9a-fA-F]{3,8}\]' src --include="*.tsx"` returns nothing.

## 3. Reach for a semantic colour variable before a raw scale step

Use `brand-*` and `zinc-*` directly only when no semantic variable covers the role. When
you find yourself wanting a semantic name that does not exist, add it to `globals.css`
rather than hardcoding the scale step at the call site.

**Why:** The existing semantic layer (`--color-text-base`, `--color-border-base`,
`--color-paragraph-text`, `--color-card-background`) was written for marketing section
variants, so it has no name for console-specific roles like page surface, table divider,
or row hover. That missing vocabulary is what pushes people to raw values. Growing the
semantic layer is the intended path, not a workaround.

**Check:** New semantic variables are defined once in `globals.css` under both the
`:root, .light-section` and `.dark-section` blocks, never inline.

## 4. Use the console type scale

The console runs denser than Tailwind's default scale allows. Tailwind's steps jump 12, 14,
16, which leaves no room for the sizes a data-dense product actually needs, so two extra
steps are part of the system:

| Token                   | Size      | Line height | Use for                                                                                   |
| ----------------------- | --------- | ----------- | ----------------------------------------------------------------------------------------- |
| `text-meta`             | 11px      | 16px        | Table column meta, timestamps, badge text, dense helper text                              |
| `text-xs`               | 12px      | 16px        | Uppercase micro-labels, footnotes, legal text                                             |
| `text-ui`               | 13px      | 19.5px      | **Default.** Table cells, menu items, buttons, inputs, tabs, descriptions, most body copy |
| `text-sm`               | 14px      | 20px        | Copy that needs to breathe: modal bodies, empty-state and onboarding paragraphs           |
| `text-base`             | 16px      | default     | Card and modal titles                                                                     |
| `text-xl`               | 20px      | default     | Section titles                                                                            |
| `text-2xl` / `text-3xl` | 24 / 30px | default     | Page titles, one per page                                                                 |

`text-meta` and `text-ui` are new and belong in `@theme` in `globals.css`:

```css
@theme {
  --text-meta: 11px;
  --text-meta--line-height: 16px;
  --text-ui: 13px;
  --text-ui--line-height: 19.5px;
}
```

**Why:** These two steps are not an invention, they are already the console's most-used
sizes, just spelled as arbitrary values: `text-[13px]` appears 43 times and `text-[11px]`
40 times, across 24 files. The 13px step is already paired with a 1.5 ratio, which is why
`leading-[19.5px]` appears 10 times. Naming what the console already does is what makes it
enforceable; leaving it unnamed guarantees the next person picks 12.5px.

Role names sit alongside t-shirt names deliberately. The two console-specific steps carry
roles so their purpose is unambiguous, and the inherited scale keeps its familiar names.

**Check:** `grep -rE 'text-\[[0-9]+px\]|leading-\[' src --include="*.tsx"` returns nothing.

## 5. Use two font weights

`font-medium` for anything that leads (headings, labels, table headers, buttons,
emphasis). Default weight for body copy. `font-semibold` is reserved for page titles only.
Do not use `font-bold`.

**Why:** The console already leans this way (173 `font-medium` against 12 explicit
`font-normal`), and a restricted weight set is most of what makes dense interfaces read as
calm. At 13px, the visual step from 400 to 500 is enough; 600 and 700 shout. The 8 remaining
`font-bold` uses are the exception to remove.

**Check:** No `font-bold` in `src`. `font-semibold` only on a page-level `h1`.

## 6. Keep the spacing rhythm

Use Tailwind's spacing scale. Prefer 4px steps (`1`, `2`, `3`, `4`, `6`, `8`). The 2px
half-steps (`0.5`, `1.5`, `2.5`) are allowed **inside dense controls only**: icon-to-label
gaps, badge padding, compact row padding. Never finer than 2px, and never an arbitrary
spacing value.

Established defaults, so these do not get re-decided per page:

- Icon to adjacent label: `gap-1.5`
- Related controls in a row: `gap-2`
- Fields within a form group: `gap-3`
- Cards in a grid, groups within a card: `gap-4`
- Sections within a page: `gap-6`
- Card padding: `p-4`, or `p-5` for a page-level card
- Modal padding: as set in `modal.css`, not overridden at the call site

**Why:** A 2px grid is the right call for this product (`gap-1.5` already appears 36 times
and `gap-2.5` 10 times), but only if the half-steps stay confined to control interiors. Once
they leak into page layout, nothing lines up across cards and the page reads as slightly
blurry without any single element looking wrong.

Tailwind's scale is already a 4px grid with 2px half-steps, so it is the console's spacing
scale and there is no custom one. The scale is not the constraint; the discipline of using
roughly eight of its thirty steps is.

**Check:** No arbitrary spacing values. Layout-level gaps are all 4px steps.

## 7. Derive control size from a shared height token, never from padding

Any control a user can click or type into (button, input, select, split button) takes its
height from a shared token, and horizontal padding is set independently of it:

```css
@theme {
  --control-height-sm: 28px;
  --control-height-md: 36px;
  --control-height-lg: 44px;
}
```

**Why:** Height computed from `py-*` plus line height plus border drifts the moment two
components pick different padding, and the drift is invisible in isolation and glaring in a
row. That is the current state: `Button` (md) resolves to 38px from `py-2`, while `Input`
and `Select` resolve to 42px from `py-2.5`, so every search-plus-button and
field-plus-submit row in the console is misaligned by 4px. Horizontal padding disagrees too
(`px-4` against `px-3`). Aligned controls are one of the clearest signals of a system that
somebody owns.

The same reasoning applies to measurements that must match across independently-written
components: page gutter, content max width, sidebar width. Those belong in `@theme` too, not
repeated at call sites.

**Check:** A story placing a button, an input, and a select in one `flex` row. Their tops
and bottoms line up exactly.

## 8. Use four radii

| Radius              | Use for                                                                |
| ------------------- | ---------------------------------------------------------------------- |
| `rounded-md` (6px)  | Buttons, inputs, selects, menu items, icon buttons, all small controls |
| `rounded-lg` (8px)  | Toasts, table containers, small inline panels                          |
| `rounded-xl` (12px) | Cards, modals, drawers, page-level panels                              |
| `rounded-full`      | Pills, badges, avatars, status dots                                    |

Nothing else. Not bare `rounded`, not `rounded-sm`, `rounded-2xl`, `rounded-3xl`, or
`rounded-[6px]`.

**Why:** Radius is where a system leaks most visibly, because mismatches show up as
optically wrong corners when elements nest. These four keep nesting correct: a 6px control
inside a 12px card reads as concentric, which is the effect polished products get and
unowned systems miss. This table ratifies existing practice rather than replacing it:
`Card.tsx` already uses `rounded-xl`, `modal.css` uses `rounded-xl`, `toast.css` uses
`rounded-lg`, and `button.css`, `Input.tsx`, and `Select.tsx` all use `rounded-md`. What
needs removing is the leftovers, including `rounded-[6px]`, which is already `rounded-md`.

Side-specific variants of a permitted radius (`rounded-l-md`, `rounded-t-lg`) are fine.

**Check:** this prints nothing.

```bash
grep -rhoE '\brounded(-(t|b|l|r|tl|tr|bl|br))?(-[a-z0-9]+|-\[[^]]*\])?' src --include="*.tsx" --include="*.css" | sort -u | grep -vE '(rounded(-(t|b|l|r|tl|tr|bl|br))?-(md|lg|xl|full))$'
```

## 9. Structure with borders, elevate only what floats

Elevation is reserved for things genuinely above the page, and scales with how far above.
Resting surfaces get a hairline border and, at most, the near-invisible `shadow-xs`:

| Surface                                     | Treatment                                                            |
| ------------------------------------------- | -------------------------------------------------------------------- |
| Cards, tables, inline panels, settings rows | Border plus at most `shadow-xs`. Use `Card`, which already does this |
| Dropdowns, popovers, menus                  | `shadow-md` plus border                                              |
| Toasts                                      | `shadow-lg` plus border                                              |
| Modals, drawers                             | `shadow-xl`, no border, over the backdrop                            |

Never use `shadow-sm`, `shadow-lg` or heavier on a resting surface, `shadow-2xl` at all, or
an arbitrary shadow value.

**Why:** Piling elevation onto flat content is the most reliable tell of an unowned system:
it makes page content look like it is hovering, and it destroys the contrast that should
mark a real overlay. `shadow-xs` is deliberately authored at 3% opacity, which reads as a
hairline lift rather than a shadow, and is the ceiling for anything in the page.

The console currently spans seven levels. 14 `shadow-sm` uses sit on resting surfaces and
should become `Card` or `shadow-xs`, and
`shadow-[0px_1px_2px_0px_rgba(0,0,0,0.05)]` duplicates `--shadow-xs` at a slightly
different opacity.

**Exception:** `box-shadow` used as a ring rather than elevation (for example
`shadow-[0px_0px_0px_1px_theme(colors.brand.100)]` for a selected state) is not elevation.
Use a `ring-*` utility instead so it is not mistaken for one.

**Check:** Every `shadow-*` in a diff is on an overlay, or is `shadow-xs`, or is a ring
expressed with `ring-*`.

## 10. Style focus with `focus-visible`, never `focus`

All focus rings use `focus-visible` (or the `brand-outline` utility applied under
`focus-visible`). This applies to the CSS component files too.

**Why:** Bare `:focus` draws the keyboard ring when a user clicks with a mouse. It is the
single most visible unfinished-feeling defect in the console right now, and it fires on
every button press. Keyboard users must still get a clearly visible ring: removing the
outline is never the fix.

Note that a text input behaves identically under either selector, because the
`:focus-visible` heuristic always matches when focus lands on a text-editable element
however it was focused. Use `focus-visible` there too, for consistency.

**Check:** all three print nothing. The `[^-]` matters: without it the pattern also matches
`focus-visible` and reports every compliant line as a violation.

```bash
grep -rE '(^|[^-])focus:' src --include="*.tsx"
grep -rE 'group-focus:' src --include="*.tsx"
grep -rE ':focus([^-]|$)' src --include="*.css"
```

Then click each interactive element and confirm no ring appears, and tab to each one and
confirm a clear ring does.

## 11. Keep motion within budget

- Transition **colour, opacity, and transform only**. Never `transition-all`.
- `duration-150` for local feedback (hover, focus, colour change).
- `duration-200` for elements entering or leaving (toasts, menus, popovers).
- Standard easing: `ease-out` for entering, `ease-in` for leaving.
- Nothing animates on page load. Nothing loops except a genuine progress indicator.
- Respect `prefers-reduced-motion`: movement is removed, opacity may remain.

**Why:** `transition-all` animates properties you did not intend, including layout, which
is where janky resizes come from. Unowned durations are why some interactions feel snappy
and others sluggish in the same product; the console currently mixes 150, 200, and 300 with
no rule, and uses `transition-all` in 5 places.

**Check:** No `transition-all`. Every duration is 150 or 200. Any new keyframe animation is
added to the Animations section of `DesignTokens.stories.tsx`.

## 12. Build every state

Every interactive element defines: default, hover, focus-visible, active, disabled, and
where it loads or fetches, loading, empty, and error. If a state is genuinely unreachable,
say so in a comment on the component.

Empty and error states are content, not placeholders. An empty state says what belongs here
and how to add it. An error says what failed and what to do next. Use `EmptyStateCard` and
`StateCard`; do not hand-roll either.

**Why:** Craft gaps are almost never a wrong colour. They are a state nobody built, found
later by a user tabbing through a form or opening a page with no data.

**Check:** A story per state, or one story showing all states together.

## 13. Treat 375px as a supported width

The console must work at 375px. Controls stack rather than squeeze; tables scroll rather
than compress; nothing is clipped and nothing overflows horizontally. Verify at 375px
before opening a pull request, not after someone reports it.

**Why:** People check buckets and billing from their phone. A cramped 375px layout is not a
graceful degradation, it is a broken page.

**Check:** A 375px screenshot on any pull request that touches layout.

## 14. Write interface copy in sentence case

Sentence case for every label, heading, button, and message. No em dashes; use commas,
colons, or parentheses. Buttons name the action (`Create bucket`, not `Submit`). Errors
state what happened and the next step. No exclamation marks.

**Why:** Copy drifts faster than any visual token because everyone writes it and nobody
reviews it as design. It is also the most-read part of the interface.

**Check:** Read every new string aloud. No em dashes anywhere in `src`.

---

## Migration backlog

The rules above describe the target. These are the known gaps, ordered by how much each one
affects perceived quality. Counts are a snapshot taken on `filipa/bulk-delete-objects`, so
treat the `Check` command in each rule as the live source of truth rather than the number
here.

1. **`focus` to `focus-visible`** (rule 10): 11 occurrences in CSS (`button.css` 8, plus
   `tabs.css`, `modal.css`, `toast.css`), plus 5 components (`Switch`, `Checkbox`,
   `CodeBlock`, `AccessKeyExpirationFields`, `billing/PaymentForm`).
2. **Control height mismatch** (rule 7): `Button` md resolves to 38px, `Input` and
   `Select` to 42px. Introduce the height tokens and migrate `Button`, `SplitButton`,
   `Input`, and `Select` in one change, since a partial migration looks worse than the
   current state.
3. **Off-scale type to `text-meta` / `text-ui`** (rule 4): 25 files. `text-[13px]` 43,
   `text-[11px]` 40, `text-[10px]` 18, `text-[12px]` 7, plus one-off `text-[14px]` and
   `text-[18px]`. Heaviest in `DashboardPage` (29) and `BillingPage` (26). Decide where
   10px goes: it most likely becomes `text-meta`.
4. **Raw hex to tokens** (rules 2 and 3): 7 distinct values across `MfaSettings`,
   `billing/PaymentForm`, and `SettingRow.stories`. Do `#0080ff` and `#0066ff` first, since
   a hardcoded brand blue also loses the documented AA contrast behaviour. Add the missing
   semantic variables before migrating the greys.
5. **Shadow collapse** (rule 9): 14 `shadow-sm`, 3 `shadow-2xl`, 2
   `shadow-[0px_1px_2px_...]`, 1 ring-as-shadow to convert to `ring-*`.
6. **Radius collapse** (rule 8): 29 bare `rounded`, 4 `rounded-[6px]`, 2 `rounded-sm`, 2
   `rounded-2xl`, 2 `rounded-3xl`.
7. **Motion** (rule 11): 5 `transition-all`, 1 `duration-300`, 4 `transition-transform` and
   2 `transition-opacity` to confirm as intentional.
8. **Weights** (rule 5): 8 `font-bold` uses to remove, and `font-semibold` (47 uses) to
   audit down to page titles.
9. **`font-heading` is undefined.** `DesignTokens.stories.tsx` uses it in two places and no
   CSS defines it, so the design tokens page renders its own headings in the fallback font.
   Either define the token or use `font-sans`.

## Not in this document yet

Deliberately deferred until the polish pass above lands, so they describe the console as it
will be rather than as it is:

- **Component selection map**: for a given need, which of the 174 components to use.
- **Layout patterns**: page shell, headers, table pages, detail pages, form pages.
- **Dark mode**: the `light-section` / `dark-section` variables exist, but console coverage
  is not verified.

---

## Pre-pull-request checklist

- [ ] No new component or token without a justification in the description
- [ ] No raw hex, `rgb()`, or `oklch()` values
- [ ] No `text-[Npx]` or `leading-[...]`; sizes come from the scale in rule 4
- [ ] No `font-bold`; `font-semibold` only on a page title
- [ ] No arbitrary spacing; half-steps only inside controls
- [ ] Control heights come from `--control-height-*`, not from padding
- [ ] Radii are `md`, `lg`, `xl`, or `full`
- [ ] Shadows only on overlays
- [ ] Focus rings use `focus-visible` and are clearly visible
- [ ] No `transition-all`; durations are 150 or 200
- [ ] Hover, focus-visible, active, disabled, loading, empty, and error all exist
- [ ] Verified at 375px
- [ ] Copy is sentence case, no em dashes, buttons name their action
- [ ] Stories cover the new or changed states
