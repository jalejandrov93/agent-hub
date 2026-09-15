# dashboard/ — rules for agents

React 19 + TypeScript + Vite + Tailwind v4 + shadcn/ui on **Base UI** (`@base-ui/react`, not Radix), TanStack Router (hash history) and TanStack Query. Built to `dashboard/dist/` and served by `src/dashboard.mjs` under a strict CSP.

## Hard constraints

- **CSP:** `script-src 'self'; style-src 'self'`.
  - Never add `<style>` elements, `dangerouslySetInnerHTML`, inline `<script>`, or `style=""` in static HTML.
  - The React `style={{...}}` prop is allowed; it writes through CSSOM.
- **Banned packages:** `sonner`, `next-themes`, CSS-in-JS runtimes, anything that injects `<style>`. Toasts use the shadcn Base UI `toast` component.
- **Offline:** no CDN, no Google Fonts, no external requests. Only same-origin `/api/*` and `/events`.
- **Dependencies:** do not add or upgrade any; `package.json` and the lockfile are owned by the orchestrator. If a shadcn component is missing, say so in your delivery; do not install it.
- **Types:** use the shared zod schemas through `@shared` (`../src/schemas.mjs`) and `z.infer`. Never redeclare API types by hand.
- **Data access:** only through the hooks in `src/lib/queries.ts` and the functions in `src/lib/api.ts`. No raw `fetch` in views.
- **Search params:** read them with the route's schema from `src/routes/search.ts`, and update them by navigating (so deep links work). No local copies of filter state.

## shadcn rules (Base UI variant)

- **Custom triggers:** use `render`, not `asChild`. Items always sit inside their Group (`SelectItem` in `SelectGroup`, `DropdownMenuItem` in `DropdownMenuGroup`).
- **Layout classes:** `className` is for layout only. Use `flex flex-col gap-*`, never `space-y-*`; `size-*` when width equals height; `truncate`; `cn()` for conditional classes.
- **Colors:** semantic tokens only (`bg-background`, `text-muted-foreground`, `text-destructive`). No raw colors, no manual `dark:` overrides.
- **Status:** status is never color-only. Use `StatusBadge` from `src/components`, which renders text + icon.
- **Composition:** `Card` uses `CardHeader`/`CardTitle`/`CardDescription`/`CardContent`/`CardFooter`. Callouts use `Alert`, empty states `Empty` (or `EmptyState`), loading `Skeleton`, dividers `Separator`.
- **Overlays:** `Dialog`/`Sheet`/`AlertDialog` always have a Title (use `sr-only` if hidden). Destructive or quota-spending actions go through `ConfirmDialog`.
- **Icons:** from `lucide-react`. In buttons use `data-icon="inline-start"`, with no size classes.
- **Tables:** use `DataTable` from `src/components`. Rows are keyboard focusable, and a row click opens detail in a `Sheet`.
- **Accessibility:** every icon-only button has `aria-label`, and inputs have labels (`Field` + `FieldLabel`). Live counts update without stealing focus.

## Ownership and delivery

- **Scope:** a view package edits only `dashboard/src/views/<name>/**` and its tests (`*.test.tsx` next to the files).
- **Entry point:** the placeholder `index.tsx` must keep exporting `<Name>View`.
- **Tests:** strict TDD with Vitest + Testing Library + happy-dom. Mock `src/lib/api.ts` or wrap in a `QueryClientProvider` with seeded data built from `test/fixtures/v2/*.json` shapes.
- **Verification before reporting:** `npm run -w dashboard test`, `npm run -w dashboard typecheck`, `npm run build`, and then `rg -n '<style|style="|data:font' dashboard/dist`, which must print nothing.
- **Git:** do not commit or push.
