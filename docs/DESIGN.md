# Docent Glass v2 — Visual Design System

**Status:** the active design contract for this app. Implement it as written; when a value you
need is missing, use the nearest token in this file — never invent new hex values, font sizes, or
shadows. If anything here conflicts with the project's own instructions (`CLAUDE.md` etc.), those
win.

**Provenance:** palette and glow-shadow language adapted from the **Flip7** design system
(`../DESIGN.md` at the repo root); surface language is **glassmorphism**. v2 (this file) replaced
v1's single dark uniform-glass look after user feedback: v1 was monotone (every panel the same
translucent white) and over-blurred. v2 adds a **light theme as the primary/demo theme**, a
**surface-tier system** (blur is budgeted, not default), and **distinctly colorful tinted zones**.

**The look in one paragraph:** frosted glass over soft color. The canvas is a cool off-white (or
near-black navy in dark mode) with four blurred accent blooms — teal, gold, coral, violet —
glowing behind everything. Top-level chrome (nav, status bars, the stage frame, hero cards) is
true frosted glass: translucent, backdrop-blurred, hairline-bordered. Nested content sits on
**panels** — translucent but *not* blurred — and important zones are **tinted panels**: teal for
questions, green/gold/coral for outcomes, a rainbow of tints across feature cards. Status and
action colors glow rather than sit flat. Type is one geometric sans (**Plus Jakarta Sans**),
extra-bold for headlines; **JetBrains Mono** for ids/code/agent reasoning. Motion is springy and
short (≤250ms); live indicators breathe.

---

## 1. Setup

Frontend stack: React + Vite + **Tailwind v4, CSS-first** — all tokens live in `src/index.css`.
There is **no** `tailwind.config.js`.

### 1.1 Fonts

```powershell
npm i @fontsource-variable/plus-jakarta-sans @fontsource-variable/jetbrains-mono
```

Imported at the top of `src/main.jsx` before the global CSS. One family for everything except
code; weight does the work (400/500 body, 700 sub-heads, 800 display/brand).

### 1.2 Theming mechanism (do not restructure casually)

Two themes; **light is default/primary** (demo theme). All theme-dependent values are plain CSS
vars named `--t-*`, defined on `:root` (light) and overridden under `:root[data-theme="dark"]`.
Tailwind tokens map onto them inside **`@theme inline`** so generated utilities carry the `var()`
reference and flip live. Static tokens (fonts, radii, type scale, easings, the accent hexes)
live in a normal `@theme` block. See `src/index.css` — it is the source of truth for every value;
this doc describes roles and rules, not hexes.

Theme selection: `index.html` sets `document.documentElement.dataset.theme` **pre-paint** from
`localStorage("docent-theme")`, defaulting to `light` (system preference deliberately unused —
demos must be predictable). `src/hooks/useTheme.js` mirrors + toggles it; the AppShell header has
the sun/moon toggle.

### 1.3 Token roles

| Token | Role |
|---|---|
| `canvas` / `canvas-alt` / `canvas-edge` | page background / raised band / deepest band (all flip per theme) |
| `fg` | the foreground text color (dark ink on light, near-white on dark) |
| `glass`, `glass-hover`, `glass-deep`, `glass-border`, `glass-border-strong` | glass fills/borders (flip) |
| `panel` | non-blurred nested surface fill (flip) |
| `teal coral gold sky green violet` (+`-deep`) | accent hexes, **identical in both themes** |
| `{accent}-ink` | accent as TEXT — deep variant on light, bright on dark; always AA at small sizes |
| `night` / `snow` | constant near-black / near-white — text on solid accent fills only |
| `focus` | focus outline color (teal-ink on light, gold on dark) |
| shadows: `glass-sm/glass/glass-lg`, `panel`, `{accent}-glow` | all flip per theme |

Body text sizes reuse Tailwind defaults: `text-base` prose, `text-[15px]` default UI,
`text-sm` secondary/tables, `text-xs` captions, `text-[13px]` mono.

---

## 2. Color rules

### 2.1 Semantic map — statuses across the app MUST use these

| Meaning | Color | Typical uses |
|---|---|---|
| Primary action / brand / links | `teal` | main CTA, active nav, question cards |
| Success / done / positive | `green` | answered/verified, success outcomes |
| Pending / warning / attention / live | `gold` | best-effort, live dot, near-limit |
| Failure / danger / destructive | `coral` | errors, stop/delete buttons |
| Info / running / neutral-active | `sky` | in-progress steps, informational |
| Special / variety | `violet` | feature-card variety (no strict domain meaning) |
| Muted / draft / disabled | `panel` + `fg/40–70` | drafts, dividers, secondary text |

**Never teal for errors; never gold for destructive.**

### 2.2 Contrast rules (checked; do not re-derive)

- `fg` on `canvas`/glass/panel ≥ 12:1 in both themes — the default pairing.
- **Colored text at any size below display scale uses `{accent}-ink`, never the raw accent.**
  The `-ink` vars are tuned ≥4.5:1 per theme (deep on light, bright on dark). Raw accents as
  text are allowed only inside display headlines via the accent-phrase move.
- **Solid accent fills** (`bg-teal`, `bg-gold`, `bg-coral`) always use `text-night`; their
  `-deep` hover fills use `text-snow`. Never `text-fg` on an accent fill — `fg` flips with the
  theme and will fail on one of them.
- Secondary text = `text-fg/70`, tertiary/placeholder = `text-fg/45`. No grays — never
  `gray-*`/`slate-*`/`zinc-*`, never `bg-white`/`text-black`.

---

## 3. Typography rules

Unchanged roles from v1 (display/h1/h2/h3/body/label/mono table in §3 of the git history if
needed) with two amendments:

- **The accent-phrase move:** display headlines are `fg` with exactly ONE phrase in an `-ink`
  accent (`text-teal-ink` or the section's accent `-ink`). Never two accents per headline.
- **Eyebrow pattern:** `<p class="text-label uppercase text-teal-ink mb-2">…</p>` — always an
  `-ink` color or `text-fg/60`.
- Numbers that align in columns: `font-mono tabular-nums`.

---

## 4. Surface tiers, elevation, interaction

**Surface stack:** `bg-orbs` (fixed, behind everything) → `canvas` → **panels** (content) →
**glass** (chrome floating above content).

| Tier | Utility | Blur | Used for |
|---|---|---|---|
| Glass chrome | `glass` / `glass-raised` / `glass-deep` | yes | app header, Watch status bar + composer + filmstrip rail + feed container, stage frame, modals, hero feature card |
| Panel | `panel` | no | nested cards, tables, code blocks, inputs, inspect panel, thumbnails |
| Tinted panel | `panel-tint-{teal,coral,gold,sky,green,violet}` | no | the colorful zones: question cards (teal), outcome cards (green/gold/coral), loop/feature cards (rotating), landing step-flow nodes |

**Blur budget: ≤6 blurred surfaces per screen.** Blur-inside-blur is banned — a panel inside a
glass container never blurs. If a new surface needs blur, something else on the screen should
give it up.

**Borders:** glass/panel utilities bring their own hairline border. Decorative accent edges
(`border-t-4 border-t-{accent}` on feature cards, `border-l-4` on callouts/outcomes) layer on top.

**Elevation:** `shadow-glass*` on glass tiers; `shadow-panel` on standard cards;
`shadow-{accent}-glow` on primary/danger buttons, live dots, the stage frame. Panels
in dense/quiet zones carry no shadow. panel/panel-tint utilities deliberately do NOT set
box-shadow — compose it with a shadow utility so glows don't fight the base shadow.

**Interaction physics:** hover = fill steps up (`hover:bg-glass-hover`) and clickable cards lift
(`hover:-translate-y-1 hover:shadow-glass-lg`, 200ms `ease-glass`); press = bounce-compress
(`active:scale-[0.97]`, 150ms `ease-bounce`); focus = `focus-visible:outline-[3px]
focus-visible:outline-focus focus-visible:outline-offset-2` everywhere; disabled =
`disabled:opacity-40 disabled:shadow-none`. Live indicators use `.animate-glow-pulse`.

---

## 5. Component recipes

Shared components in `src/components/ui/` are the source of truth; highlights:

- **Button** — pill. `primary` = `bg-teal text-night shadow-teal-glow hover:bg-teal-deep
  hover:text-snow` (ONE per screen); `gold`/`danger` same pattern in their hue; `default` =
  `panel text-fg hover:bg-glass-hover`; `ghost`/`danger-ghost` = transparent, no press physics.
- **Badge** — pill, `border-{accent}/40 bg-{accent}/12 text-{accent}-ink`; live dot =
  `bg-gold shadow-gold-glow animate-glow-pulse`.
- **Card** — `feature` = `rounded-card-lg glass-raised p-6` (hero only); `standard` =
  `rounded-card panel p-5 shadow-panel`; `accent` prop swaps panel → `panel-tint-{accent}` (+
  `border-t-4`); `callout` = `rounded-control panel p-4 border-l-4`; clickable adds lift.
- **Field** — `panel rounded-control`, placeholder `text-fg/40`, error = `border-coral/60` +
  `text-coral-ink` message.
- **Table** — wrapper `panel rounded-card`; th `text-label uppercase text-fg/50` over
  `border-b border-glass-border-strong`; row hover `bg-glass-hover`.
- **CodeBlock** — `panel rounded-card`, mono `text-fg`.
- **Modal** — overlay `bg-canvas-edge/60 backdrop-blur-sm`; panel `glass-raised rounded-card-lg`.
- **EmptyState** — dashed `border-glass-border-strong bg-glass/40`, display statement with one
  `-ink` accent phrase.
- **Spinner** — `border-glass-border border-t-teal-ink`. **Skeleton** — `animate-pulse bg-glass`.
- **Segmented meter** — used cells `bg-green shadow-green-glow` (all flip to coral at limit),
  unused `bg-glass border-glass-border`, mono caption.
- **Success flourish** — `.ring-ping` one 600ms ring on the final answer only.

## 6. App shell & layout

One `AppShell`: fixed `bg-orbs` div once; header `glass-deep sticky top-0` with brand (800 sans),
nav pills (active = `bg-glass-hover text-teal-ink` on the History pill / `text-gold-ink` for
Watch tabs), and the theme toggle. Content `mx-auto max-w-6xl px-6 py-8` (landing/watch are
full-bleed). Landing bands alternate rooms: hero (orbs strong) → gallery (plain canvas) → loop
band (`bg-canvas-alt/70`, tinted step cards teal→sky→gold→green) → features (tinted cards) →
stats (`bg-canvas-edge/70`) → footer. Watch: a **fixed-viewport cockpit on desktop** — the shell
is `h-dvh overflow-hidden` at ≥901px so the page never scrolls; the stage image is height-capped
(`calc(100dvh - 19rem)` in `.frame-layer`) and the frame shrink-wraps it (`w-fit`); the right
rail stacks tabs / question thread (flex-1, scrolls internally) / composer pinned at the bottom.
Stage column gets `bg-canvas-edge/40` (spotlight wash) with the glass+teal-glow frame on top;
feed is glass-deep chrome with tinted question/outcome panels inside. ≤900px falls back to normal
page flow and stacks to one column.

---

## 7. Do / Don't

| Do | Don't |
|---|---|
| Blur only glass chrome; panels everywhere else | Blur nested surfaces or exceed the ≤6/screen budget |
| Distinct tinted zones (`panel-tint-*`) for semantic areas | One uniform surface color across a screen |
| `{accent}-ink` for ALL small colored text | Raw accents (`text-gold`) as small text in either theme |
| `text-night`/`text-snow` on solid accent fills | `text-fg` on accent fills (breaks in one theme) |
| Colored glow shadows on active/primary elements | Flat black drop shadows |
| One teal primary action per screen | Teal errors, gold destructive actions |
| `outline-focus` on every interactive element | Hardcoded outline colors per component |
| Both themes checked for every new surface | Designing on one theme and hoping |

---

## 8. Definition of done (for any styling change)

- Works in **both themes** — actually toggle and look, in the browser.
- `grep -rnE "(gray|slate|zinc|stone|neutral)-[0-9]|text-black|bg-white|text-mist|shadow-offset" frontend/src` → zero hits.
- Colored small text is all `-ink`; solid accent fills use night/snow text.
- Blurred-element count per screen ≤ ~8 (probe: computed `backdrop-filter !== "none"`).
- Every interactive element shows the `outline-focus` ring; `npm run build` passes; 1280px and
  ~900px look right.
