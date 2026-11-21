# design-sync notes — @filone/website (console UI)

- [GENERAL] This is the app's own source repo — no library dist. The bundle entry is a
  generated barrel at `packages/website/.design-sync.entry.ts` (one `export *` per storied
  component module). It lives inside the package so the converter's walk-up resolves
  PKG_DIR to `packages/website` (fixes `@types/react` resolution and src enrichment).
  New storied components must be added to the barrel or they get dropped as
  `[TITLE_UNMAPPED]`.
- [GENERAL] The barrel is ALSO listed in `extraEntries` — that's what feeds the exported-
  name gate (a source-only repo has no .d.ts tree, so without it all titles drop as
  `[TITLE_UNMAPPED]`).
- [GENERAL] Decorator auto-bundling fails on this repo (`.storybook/preview.tsx` imports
  Tailwind v4 source CSS + `@fontsource-variable/inter` woff2). Instead `cfg.provider` is
  `PreviewProviders` from `packages/website/.design-sync.preview.tsx` — it mirrors the
  storybook decorator chain: QueryClientProvider (retry: false) + ToastProvider + a
  `div.light-section.bg-white.p-8` frame. If `.storybook/preview.tsx` decorators change,
  update that file to match.
- [GENERAL] Compiled CSS comes from the storybook reference build (`[CSS_FROM_STORYBOOK]`
  scrape) — Tailwind v4 has no standalone css file to point `cssEntry` at. Rebuilding
  `.design-sync/sb-reference` is what refreshes the shipped CSS.
- Tabs: the dir index renames `TabItem` -> `Tab`; stories import `TabItem` from the file.
  The barrel exports both names explicitly (star-export pair would make shared names
  ambiguous and esbuild drops them silently -> "Element type is invalid" in every Tabs
  story, card root empty).
- PaymentForm: story wraps in `<Elements>` from `@stripe/react-stripe-js`. That package
  must be in `extraEntries` so the story's Elements context and the bundle component's
  `useStripe()` share one module copy (otherwise: "Could not find Elements context").
- titleMap: `BucketPropertiesCard` -> `BucketPropertyCards`, `RouteRecoveryPage` ->
  `RouteErrorPage`, `Toast` -> `ToastProvider`; `Design Tokens` excluded (self-contained
  showcase story with no component export; tokens ship via the synced CSS instead).
- `import.meta.env` is used by RouteRecoveryPage / accessible-control / two pages —
  watch for runtime errors in those previews (esbuild define may cover it; verify at
  compare time).
- fullBleed stories (AuthCard, LoginErrorPage, VerifyEmailPage) get the provider's
  white p-8 frame in previews while storybook renders them full-bleed — framing-only
  difference, judge the component itself.
- [GENERAL] `@tanstack/react-router` and `@tanstack/react-query` are in `extraEntries`:
  stories wrap components in RouterProvider/QueryClientProvider imported from those
  packages, and the provider context must share the bundle's module copy (symptom:
  "Cannot read properties of null (reading 'stores')" or missing-QueryClient errors).
- [GENERAL] Benign `[EXPORT_COLLISION]`: @tanstack/react-router exports `Link`, which the
  DS also exports. No story imports Link FROM the router package, so the DS Link winning
  the global merge is correct. Do NOT set storyImports.bundle for the router — that would
  reintroduce the two-copy context bug.
- [GENERAL] The compare harness captures the preview side at the card viewport
  (default 900x700, fullPage: false) while the storybook side captures the full root
  element. A tall story clipped at the bottom of the ds capture is a FRAMING limit, not
  a mismatch — verify the visible region, and if content that matters is cut off, request
  a `cfg.overrides.<Name>.viewport` (e.g. "900x1500") via learnings for the orchestrator.
- [GENERAL] Modal-family components: the dialog portals OUTSIDE storybook's root element,
  so the sb capture shows only backdrop/trigger. That's reference gating — judge the
  preview's dialog render on its own (rubric: "reference side is the artifact").
- Tiny controls (Checkbox/Radio/Switch): compare sheets are too small to judge — render
  4x-zoomed crops of the raw PNG pairs (playwright script; sips cropping unreliable).
- Viewport overrides for tall stories (capture completeness, not visual bugs):
  AccessKeyFormFields 900x1500, AccessKeyPermissionsFields 900x1300, Badge 900x1300.
- [STORY_CAP] Badge and Heading have 7 stories; cap is 6 — Badge recaptured with
  --max-stories 8 after the viewport change; Heading's 7th story remains cap-trusted.
- EmptyBucketDialog has 9 stories (cap 6) — verified in full with --max-stories 9;
  its error/failure tail variants all match.
- PaymentForm: Stripe-hosted card fields (number/expiry/CVC) cannot mount under
  Elements stripe={null} on either panel — identical by construction, not a defect.
- SlowOperationIndicator "Not Loading" renders null by design — blank on both panels is match.
- [KNOWN LIMITATION] `<img src="/fil-one-logo.svg">` (AuthCard, LoginErrorPage,
  VerifyEmailPage, RouteErrorPage/RouteNotFoundPage, and any other logo-bearing
  component) renders as a broken-image glyph outside the console app — the root-absolute
  public asset is not part of the bundle and no converter knob covers it. Both compare
  panels agree (blind-spot class, like fonts), so grades stay match. Warned about in the
  conventions header. Upstream fix: import the SVG as a module asset in the components.
- [ACCEPTED CLOSE] RouteErrorPage "Route Error": preview/designs show an extra collapsed
  "Technical details" disclosure — the converter's iife define sets a synthetic
  import.meta.env with DEV:true, while the sb-reference is a production build
  (RouteRecoveryPage.tsx gates the disclosure on import.meta.env.DEV). The fix is a
  committed fork of lib/common.mjs flipping IIFE_IMPORT_META_DEFINE's env to
  {"MODE":"production","DEV":false,"PROD":true,...} + cfg.libOverrides {"common": ...} —
  but fork bytes are part of the GLOBAL grade key, so landing it invalidates every
  component's grade. Apply it (if desired) at the START of a future sync, before grading.
- [SKIPPED] SupportPage story pages-supportpage--filled-in: an interaction test — its
  play function runs in the sb-reference capture (typed fields, selected radio) but play
  is stubbed inert in previews, so the panels can never match and the card cell would
  misleadingly show an empty form under "Filled In". Play functions running in the
  static reference (contrary to common assumption) also explain Table "Selection"'s
  accepted-close focus-ring delta — any story with a play function has this limit.
- [GENERAL] Full-height overlays (`fixed inset-y-0`, e.g. BucketDrawer): the preview's
  fixed-containment wrapper only gets content height, so inset-y-0 collapses. Owned
  preview wraps the story in `position:relative; height:640px`. Centered modals are
  unaffected (intrinsic height). Owned file: .design-sync/previews/BucketDrawer.tsx.
- ObjectBrowser has 11 stories (cap 6) — tail verified with a --max-stories 11 pass.

## Re-sync risks (watch-list for the next run)

- Known validate warns, triaged: `[RENDER_THIN]` on AccessKeyBucketScopeFields and Link —
  their stories legitimately render near-identically at card-cell size; both were
  image-verified against storybook (all stories match). Not a defect.
- Story caps: EmptyBucketDialog (9 stories) and ObjectBrowser (11) were verified in full
  with --max-stories passes, but the DEFAULT cap is 6 — a plain compare run re-captures
  only 6; their tail grades are recorded and carry. Heading's 7th story is cap-trusted
  (never image-verified). Raise --max-stories when re-verifying these.
- Accepted `close`/skips that can go stale: RouteErrorPage "Route Error" (DEV-gated
  disclosure; see the ACCEPTED CLOSE bullet), Table "Selection" (play-function focus
  residue), SupportPage filled-in story skipped. If the repo changes how these stories
  work, re-triage.
- Data inlined in config: none. Owned previews: BucketDrawer only (tied to the drawer's
  fixed inset-y-0 layout — re-check if the drawer's layout changes).
- Build assumptions: node >= 24 + pnpm 10 (repo toolchain); chromium via .ds-sync
  playwright install; the sb-reference build must be refreshed together with any DS
  source change (CSS ships from its scrape — a stale reference ships stale CSS).
- The generated barrel (packages/website/.design-sync.entry.ts) must gain a line for any
  NEW storied component, or it drops as [TITLE_UNMAPPED].
- packages/website/CLAUDE.md names type tokens (`text-ui`, `text-meta`) and
  `--control-height-*` variables that do NOT exist in src/styles/ or the compiled CSS —
  documented-but-absent, so they were kept out of conventions.md (which only names
  verified vocabulary). If the repo later defines them, add them to the header. The
  verified DESIGN.md-adjacent rules worth adding then: four radii
  (md/lg/xl/full), shadows only on overlays (shadow-xs), focus-visible only.
- BucketDrawer.tsx (owned preview) was reformatted by oxfmt AFTER the final upload —
  the next sync will recapture/re-grade that one component (byte-keyed source). Expected.
