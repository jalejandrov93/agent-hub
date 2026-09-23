# Task: ReactBits UI modernization for the dashboard

Branch: `feat/reactbits-dashboard-ui` · Worktree: `agent-hub-worktrees/reactbits-ui`
Status: Phases 1-5 DONE, Phase 4 gates DONE, screenshots PENDING (no desktop browser connected)
- Phase 1 (LetterGlitch background): verified 202 tests; delivery review passed after 1 test-query fix (AppBackground.test.tsx scoped its duplicated "Overview" query).
- Phase 2 (PixelCard KPIs + CountUpValue): verified 213 tests; delivery review passed after 1 fix (missing `waitFor` import in metrics test).
- Phase 3 (BorderGlow Live badge + Magnet Refresh): all 4 hub checks green first try.
- Phase 5 (HoldButton on running-job cancel, user-decided flow: hold FIRST then existing ConfirmDialog): vendored with CSP adaptation (STYLE template moved to HoldButton.css), Tailwind adaptation (template-literal shadow-[${GLOW}] moved to static .hb-root[data-glow] rules — Tailwind cannot generate interpolated utilities), token colors (var(--card)/var(--destructive)/var(--destructive-foreground); added --destructive-foreground token to index.css), aria-hidden hint span so the accessible name stays "Cancel". Two defect rounds: agent used role "dialog" (Base UI AlertDialog is role="alertdialog") and sync getByRole under fake timers (portal needs real-timer polling) — fixed by orchestrator directly. Final: 222/222 tests, typecheck, build, dist CSP gate all green.
- Phase 6 (jobs column visibility, user-requested): DropdownMenu checkbox toggles above the DataTable, state kept in views/jobs (view-scope rule respected — DataTable.tsx untouched), defaults hidden = Timeout + Working dir + Profile, Actions column never hideable. One defect round by agent; the empty-state test then exposed two latent bugs the orchestrator fixed: (1) renderView lacked a RouterProvider and the empty state's `<Button render={<Link to="/history"}/>` crashed useLinkPropsFor — added a local createTestRouter (overview.test.tsx pattern); (2) that control's accessible role is "link", not "button". Also observed: full-suite runs under CPU contention from other agent-hub jobs produce random findBy flakes in untouched views (different set per run) — rerun to distinguish from real failures. Final: 226/226 tests, typecheck, build, dist CSP gate all green.
- Phase 4 gates: `npm run -w dashboard test` 213/213, typecheck ✅, `npm run build` ✅, dist CSP grep clean ✅, served CSP header verified on :7788 ✅.
- Delegated via agent-hub (agy gemini-3.8-flash-medium write jobs + job_reply correction turns).
- TEMP dashboard running: http://127.0.0.1:7788 (worktree build), PID 292131.
- Visual screenshots light/dark not captured: browser tool reports no desktop browser connected — verify manually at :7788.

## Objective

Modernize the dashboard UI using ReactBits (https://reactbits.dev) copy-paste components
while passing every hard constraint in `dashboard/AGENTS.md`.

## Hard constraints (load-bearing — restate in every delegated task)

- CSP (`src/dashboard.mjs:44`): `default-src 'self'; script-src 'self'; style-src 'self';
  connect-src 'self'; img-src 'self' data:; base-uri 'none'; frame-ancestors 'none'`.
  No `<style>` elements, no `dangerouslySetInnerHTML`, no inline `<script>`, no `style=""`
  in static HTML. React `style={{...}}` props are allowed (CSSOM).
- No new/upgraded npm dependencies (`package.json` + lockfile owned by the orchestrator).
- Offline only: no CDN, no Google Fonts, no external requests.
- Semantic color tokens only (`bg-card`, `text-muted-foreground`, …); no raw colors, no
  manual `dark:` overrides. Theme flips at runtime without reload.
- `prefers-reduced-motion` must gate every always-on animation.
- Verification gate: `npm run -w dashboard test`, `npm run -w dashboard typecheck`,
  `npm run build`, then `rg -n '<style|style="|data:font' dashboard/dist` must print nothing.
- No commits from delegates. TDD: failing test first.

## Verified component facts (repo source, HEAD c5df861)

| Component | Variant chosen | Deps | Notes |
|---|---|---|---|
| PixelCard | TS-CSS | none | props: `variant`, `gap`, `speed`, `colors` (comma string), `noFocus`, `className`, `children`. No pixel-size prop. Glow color only via `--pixel-card-active-color`. Honors reduced-motion; animates on hover/focus only. Baked classes `h-[400px] w-[300px] aspect-[4/5] rounded-[25px] border-[#27272a]` must be overridden. |
| LetterGlitch | TS-TW | none | props required in TS: `glitchColors[]`, `glitchSpeed` (ms), `centerVignette`, `outerVignette`, `smooth`, `characters`; optional `lightMode`, `backgroundColor`, `className`. rAF never stops while mounted; NO reduced-motion handling; effect deps `[glitchSpeed, smooth]` only (colors do not re-init → remount via `key={theme}`). |
| GlareHover | TS-TW | none | shine sweep for summary cards; hardcoded default colors must be tokenized. |
| BorderGlow | TS-TW | none | one instance only (pointermove setState + rAF) → topbar "Live" badge. |
| Magnet | TS-TW | none | window mousemove per instance → max 1-2 dashboard-wide. |

Banned (do not paste): anything importing `motion/react`, `@hugeicons/*`, `matter-js`,
`three`; runtime-`<style>` components (StatusMark, GradualBlur, ProfileCard, TextPressure,
ASCIIText…); network fetchers (VariableProximity, CircularGallery…). ReactBits `CountUp`
imports `motion` → replaced by an in-house `CountUpValue`.

## Scope decisions (user-confirmed 2026-09-22)

- **Running jobs stays a DataTable** — no per-row canvas. PixelCard goes on the Overview
  "Running jobs" KPI card instead (plus metrics/subagents cards).
- Background lives **inside `SidebarInset` only** (never behind the opaque sidebar).

## Phases

### Phase 1 — LetterGlitch background (host: `src/components/shell/app-shell.tsx`)
- New shared `src/components/AppBackground.tsx`:
  - `absolute inset-0 -z-10 pointer-events-none aria-hidden`, `style={{opacity: 0.08}}` (user-tuned down from 0.15).
  - Theme-aware palette via `useTheme()` + `key={theme}` remount; `backgroundColor: "transparent"`;
    vignettes off or token-derived (defaults are hardcoded black/white).
  - `glitchSpeed` 200-300 ms (CPU: full grid redraw per tick, no visibility pause).
  - `prefers-reduced-motion: reduce` → static single frame (component does not handle it).
  - Canvas colors: verify oklch parsing; fallback = hex companions in `index.css`.
- `app-shell.tsx`: add `isolate` to `SidebarInset`, render `<AppBackground />` before Topbar/main.
- Tests: no new text nodes/roles (`App.test.tsx` asserts "Coming soon" + sidebar labels);
  reduced-motion path renders a static canvas.

### Phase 2 — PixelCard on KPI cards
- `views/overview/index.tsx` L310-351: `Link > PixelCard(noFocus) > content`; label + badge +
  value stay inside the anchor (`overview.test.tsx` asserts `closest("a")` contains value).
  Override baked size classes; wire `--pixel-card-*` vars to semantic tokens.
- `views/metrics/index.tsx`, `views/subagents/index.tsx`: same treatment for summary cards.
- In-house `CountUpValue` (~15 lines rAF, mount/value-change only, `tabular-nums`,
  reduced-motion → instant) for KPI numbers; SSE churn = 15 s poll + 250 ms debounce, so
  count-up must not retrigger on identical values.
- Tests: existing `overview.test.tsx` / `metrics` zero-`<style>` assertion must stay green.

### Phase 3 — Micro accents (topbar)
- `BorderGlow` on the "Live" badge (`shell/topbar.tsx:41-44`), `animated={false}`, 1 instance.
- `Magnet` on the Refresh button (`topbar.tsx:46-49`), 1 instance.
- Both gated by `prefers-reduced-motion`; colors tokenized (BorderGlow defaults `#120F17` + purple).

### Phase 4 — Verification + delivery review
- Full gate above, light/dark screenshots, CPU check of the background, diff review,
  `rg` gate on `dashboard/dist`.

## Deferred-issues ledger

| id | found by | problem | evidence | proposed fix |
|---|---|---|---|---|
| (none yet) | | | | |
