# Docent Glass — Visual Design System

**Status:** the active design contract for this app. Implement it as written; when a value you
need is missing, use the nearest token in this file — never invent new hex values, font sizes, or
shadows. If anything here conflicts with the project's own instructions (`CLAUDE.md` etc.), those
win.

**Provenance:** a merge of two sources. The palette and glow-shadow language are adapted from the
**Flip7** design system (`../DESIGN.md` at the repo root — a retro-playful teal/coral/gold card
game system) — its literal game furniture (ribbon banners, fan-card logos, BOOM buttons, confetti)
is dropped, but its color DNA and "colored glow instead of black shadow" elevation model carry
over wholesale. The surface language — frosted, translucent, blurred — is **glassmorphism**,
requested explicitly for this app and now the system's core visual identity. This replaces the
prior "Warm Editorial" system (hard-offset shadows, cream/paper light surfaces, serif display)
entirely; nothing from that system is reused.

**The look in one paragraph:** a dark cockpit at night, lit from within. The app canvas is a deep
near-black navy with soft, blurred color blooms — teal, coral, gold — glowing behind everything
like light through frosted glass. Every panel, card, nav bar, and button is **frosted glass**:
translucent fill, blurred backdrop, a hairline light border, and a soft ambient shadow instead of a
hard black one. Status and action color (teal primary, coral danger, gold pending/live, sky info,
green success) glow rather than sit flat. Type is one confident geometric sans
(**Plus Jakarta Sans**) at extra-bold weight for headlines, a technical mono
(**JetBrains Mono**) for ids/code/agent-reasoning text. Motion has a slight spring to it — buttons
compress with a bounce, live indicators breathe with a glow pulse — nothing longer than ~250ms.

---

## 1. Setup

Frontend stack: React + Vite + **Tailwind v4, CSS-first** — all tokens live in `src/index.css`
inside `@theme`. There is **no** `tailwind.config.js`.

### 1.1 Fonts

```powershell
npm i @fontsource-variable/plus-jakarta-sans @fontsource-variable/jetbrains-mono
```

Add to the top of `src/main.jsx`, before the global CSS import:

```js
import "@fontsource-variable/plus-jakarta-sans";
import "@fontsource-variable/jetbrains-mono";
import "./index.css";
```

One family for everything except code — do not add a serif or a second display face. Weight does
the work: 400/500 for body, 700 for sub-headings, 800 for display/headlines/brand.

### 1.2 Theme tokens — replace the global stylesheet with exactly this

```css
@import "tailwindcss";

@theme {
  /* Fonts */
  --font-sans: "Plus Jakarta Sans Variable", "Plus Jakarta Sans", system-ui, sans-serif;
  --font-mono: "JetBrains Mono Variable", "JetBrains Mono", ui-monospace, Consolas, monospace;

  /* Canvas (app background) */
  --color-canvas: #0a0d12;        /* app background — deep near-black navy */
  --color-canvas-alt: #12161d;    /* raised background zones, footer band */
  --color-canvas-edge: #05070a;   /* deepest — orb blend edges, overlays */

  /* Glass surface */
  --color-glass: rgba(255, 255, 255, 0.06);         /* default panel/card fill */
  --color-glass-hover: rgba(255, 255, 255, 0.10);   /* hover / raised fill */
  --color-glass-deep: rgba(18, 22, 29, 0.72);       /* nav bar, code blocks — opaque enough to read over scroll */
  --color-glass-border: rgba(255, 255, 255, 0.14);  /* default glass edge */
  --color-glass-border-strong: rgba(255, 255, 255, 0.22); /* modals, focused panels */

  /* Text on dark canvas */
  --color-mist: #f4f6f9;          /* primary text — the dominant foreground */

  /* Accent palette (Flip7-derived, brightened for dark-glass contrast) */
  --color-teal: #3ed9cf;          /* brand / primary action */
  --color-teal-deep: #1e8c86;     /* teal hover / teal on light chips */
  --color-coral: #ff7a5c;         /* danger / destructive / energy */
  --color-coral-deep: #d45233;    /* coral hover */
  --color-gold: #ffd23f;          /* pending / live / highlight */
  --color-gold-deep: #e6b800;     /* gold hover */
  --color-sky: #6fbceb;           /* info / running / in-progress */
  --color-sky-deep: #3d82ae;      /* sky hover */
  --color-green: #34d399;         /* success / done / verified */
  --color-green-deep: #1f9d74;    /* green hover */
  --color-violet: #a78bfa;        /* special / variety accent (feature cards) */
  --color-violet-deep: #7c5cdb;   /* violet hover */

  /* Radii — generous, glass-friendly */
  --radius-dot: 8px;              /* tiny elements: checkboxes, meter cells */
  --radius-control: 14px;         /* buttons, inputs, selects, callouts */
  --radius-card: 20px;            /* cards, tables, code blocks, panels */
  --radius-card-lg: 28px;         /* modals, hero/feature cards */
  --radius-pill: 999px;           /* pill buttons, badges, nav pills */

  /* Elevation — glass depth (ambient + inset sheen, never flat black) */
  --shadow-glass-sm: 0 2px 12px rgba(0, 0, 0, 0.35), inset 0 1px 0 rgba(255, 255, 255, 0.10);
  --shadow-glass: 0 8px 32px rgba(0, 0, 0, 0.45), inset 0 1px 0 rgba(255, 255, 255, 0.12);
  --shadow-glass-lg: 0 16px 56px rgba(0, 0, 0, 0.55), inset 0 1px 0 rgba(255, 255, 255, 0.14);

  /* Elevation — colored glow (Flip7 callback: glow instead of black shadow) */
  --shadow-teal-glow: 0 4px 28px rgba(62, 217, 207, 0.38);
  --shadow-coral-glow: 0 4px 28px rgba(255, 122, 92, 0.38);
  --shadow-gold-glow: 0 4px 28px rgba(255, 210, 63, 0.40);
  --shadow-sky-glow: 0 4px 24px rgba(111, 188, 235, 0.35);
  --shadow-green-glow: 0 4px 24px rgba(52, 211, 153, 0.35);

  /* Motion */
  --ease-glass: cubic-bezier(0.22, 1, 0.36, 1);   /* smooth lift/hover */
  --ease-bounce: cubic-bezier(0.34, 1.56, 0.64, 1); /* press/pop — Flip7 callback */

  /* Display type (font-sans, extra-bold — no separate serif family) */
  --text-display: 3.5rem;
  --text-display--line-height: 1.02;
  --text-display--letter-spacing: -0.02em;
  --text-display--font-weight: 800;
  --text-display-sm: 2.25rem;
  --text-display-sm--line-height: 1.08;
  --text-display-sm--letter-spacing: -0.015em;
  --text-display-sm--font-weight: 800;

  /* Headings */
  --text-h1: 1.75rem;
  --text-h1--line-height: 1.15;
  --text-h1--font-weight: 700;
  --text-h2: 1.3125rem;
  --text-h2--line-height: 1.25;
  --text-h2--font-weight: 700;
  --text-h3: 1.0625rem;
  --text-h3--line-height: 1.3;
  --text-h3--font-weight: 700;

  /* Caps label — badges, eyebrows, table headers (always with `uppercase`) */
  --text-label: 0.72rem;
  --text-label--line-height: 1.2;
  --text-label--letter-spacing: 0.08em;
  --text-label--font-weight: 800;
}

/* Glass surface utilities — the system's signature. Backdrop-blur + translucent
   fill + hairline light border + ambient shadow, never a flat opaque panel. */
@utility glass {
  background: var(--color-glass);
  border: 1px solid var(--color-glass-border);
  box-shadow: var(--shadow-glass);
  backdrop-filter: blur(20px) saturate(160%);
  -webkit-backdrop-filter: blur(20px) saturate(160%);
}
@utility glass-raised {
  background: var(--color-glass-hover);
  border: 1px solid var(--color-glass-border-strong);
  box-shadow: var(--shadow-glass-lg);
  backdrop-filter: blur(24px) saturate(160%);
  -webkit-backdrop-filter: blur(24px) saturate(160%);
}
@utility glass-deep {
  background: var(--color-glass-deep);
  border: 1px solid var(--color-glass-border);
  box-shadow: var(--shadow-glass);
  backdrop-filter: blur(28px) saturate(140%);
  -webkit-backdrop-filter: blur(28px) saturate(140%);
}

/* Background orbs — fixed, blurred color blooms behind all content. This is
   what the glass actually shows through; never remove or flatten this layer. */
@utility bg-orbs {
  position: fixed;
  inset: 0;
  z-index: -10;
  pointer-events: none;
  background:
    radial-gradient(600px circle at 12% 18%, color-mix(in srgb, var(--color-teal) 35%, transparent), transparent 65%),
    radial-gradient(700px circle at 88% 12%, color-mix(in srgb, var(--color-gold) 22%, transparent), transparent 65%),
    radial-gradient(800px circle at 78% 88%, color-mix(in srgb, var(--color-coral) 28%, transparent), transparent 65%),
    radial-gradient(900px circle at 10% 95%, color-mix(in srgb, var(--color-violet) 16%, transparent), transparent 65%);
}

body {
  @apply bg-canvas font-sans text-mist antialiased;
}

/* Glow pulse — live/recording indicators, active steps (Flip7 callback). */
@keyframes glow-pulse {
  0%, 100% { opacity: 1; transform: scale(1); }
  50% { opacity: 0.55; transform: scale(1.08); }
}
.animate-glow-pulse {
  animation: glow-pulse 2s ease-in-out infinite;
}

@media (prefers-reduced-motion: reduce) {
  .animate-glow-pulse {
    animation: none;
  }
}
```

Body text sizes reuse Tailwind defaults: `text-base` (16px) prose, `text-[15px]` default UI/body,
`text-sm` (14px) secondary + table cells, `text-xs` (12px) captions, `text-[13px]` mono/code.

---

## 2. Color rules

### 2.1 Semantic map — statuses across the app MUST use these

| Meaning | Color | Typical uses |
|---|---|---|
| Primary action / brand / links | `teal` | the screen's main CTA, active tab, link text |
| Success / done / positive | `green` | completed / verified states, success toasts |
| Pending / warning / attention / live | `gold` | pending review, recording/live indicator, near-limit warnings |
| Failure / danger / destructive | `coral` | failed jobs, rejected items, revoke/delete buttons, error states |
| Info / running / neutral-active | `sky` | in-progress steps, informational accents |
| Special / variety | `violet` | feature-card variety on marketing surfaces (no strict domain meaning) |
| Muted / draft / disabled | `glass` + `mist/40–70` | draft badges, dividers, secondary text |

**Never use teal for errors** — teal means "act here." Never use gold for destructive actions —
gold means "pending/live," not "danger."

### 2.2 Contrast rules (checked; do not re-derive)

- `mist` on `canvas`/`canvas-alt` ≈ 14:1 — the default pairing, always safe.
- Because the canvas is dark, mid-tone accents (`teal` `coral` `gold` `sky` `green` `violet`) are
  **already high-contrast as text** on `canvas`/glass surfaces (all ≥4.5:1) — unlike a light-canvas
  system, there is no separate "-deep" text rule to apply for small text. Use the accent directly.
- `-deep` variants exist only for **hover states** on solid-fill accent surfaces (e.g. a solid teal
  button darkens to `teal-deep` on hover) and for text placed on a *light* chip if one is ever
  needed — not for routine body text.
- Solid-fill buttons (`bg-teal`, `bg-coral`, `bg-gold`) use **`text-canvas`** (near-black), not
  white — these accents are light/bright enough that dark text reads best on them.
- Secondary text = `text-mist/70`, tertiary/placeholder = `text-mist/45`. No grays — never use
  Tailwind `gray-*`/`slate-*`/`zinc-*`, and never `bg-white`/flat opaque panels — every surface
  above `canvas` is glass.

---

## 3. Typography rules

| Role | Classes | Use |
|---|---|---|
| Hero statement | `font-sans text-display font-extrabold` | one hero moment per app (landing) |
| Section statement | `font-sans text-display-sm font-extrabold` | marketing sections, empty states |
| Page title | `text-h1` | one per page, top of content |
| Card/section title | `text-h2` | card headings, panel titles |
| Sub-heading | `text-h3` | sub-sections, modal titles |
| Body | `text-[15px]` / `text-base` | default UI text / docs prose |
| Secondary | `text-sm text-mist/70` | descriptions, meta, table cells |
| Caption | `text-xs text-mist/60` | timestamps, footnotes, source lines |
| Caps label | `text-label uppercase` | eyebrows, badges, table headers, form labels |
| Code / IDs | `font-mono text-[13px]` | keys, URLs, JSON, ids, money amounts, counts |

- **The accent-phrase move (signature, carried over):** display headlines are `mist` with exactly
  ONE phrase wrapped in `text-teal` (or `text-gold` on alternating sections). Never two accents in
  one headline. Example: `<h1 class="font-sans text-display font-extrabold">Watch it think, <span class="text-teal">not just answer.</span></h1>`
- **One font family, weight does the work.** No serif, no second display face. Extra-bold (800)
  + tight tracking (`-0.02em` at display sizes) is what signals "headline," not a different typeface.
- **Eyebrow pattern:** caps label above a page/section title, colored `text-teal` (or the section's
  accent): `<p class="text-label uppercase text-teal mb-2">Overview</p>`
- Numbers that align in columns (money, counts, quotas): add `font-mono tabular-nums`.

---

## 4. Surfaces, glass, elevation, interaction

**Surface stack:** `bg-orbs` (fixed, behind everything) → `canvas` app background → **glass**
panels/cards/nav at increasing opacity (`glass` → `glass-raised` → `glass-deep`) floating on top.
Nothing above `canvas` is ever a flat opaque fill — if it's a container, it's glass.

**Border rule:** every glass surface gets its paired border (`glass` → `glass-border`,
`glass-raised`/modals → `glass-border-strong`). Decorative accent edges: `border-l-4
border-l-{accent}` (callouts) or `border-t-4 border-t-{accent}` (plan/feature cards), layered on
top of the glass border, not replacing it.

**Elevation:**

| Token | Use |
|---|---|
| `shadow-glass-sm` | small controls: sm buttons, chips |
| `shadow-glass` | standard cards, inputs, badges |
| `shadow-glass-lg` | hero/feature cards, modals, toasts |
| `shadow-{accent}-glow` | primary/danger buttons, live indicators, the active step, StatChips |
| none | quiet/dense admin surfaces — glass fill and border still apply, just no shadow |

**Interaction physics (buttons and clickable cards):**

- Hover: glass fill steps up (`glass` → `glass-hover`); clickable cards additionally lift:
  `hover:-translate-y-1 hover:shadow-glass-lg`, `duration-200 ease-glass`.
- Press: a soft bounce-compress, not a hard offset-collapse: `active:scale-[0.97]`,
  `duration-150 ease-bounce`.
- Focus: `focus-visible:outline-[3px] focus-visible:outline-gold focus-visible:outline-offset-2`
  everywhere (gold reads on every surface here, since everything is dark).
- Disabled: `disabled:pointer-events-none disabled:opacity-40 disabled:shadow-none`.
- Transitions: `transition-[transform,box-shadow,background-color,opacity]`, 150–220ms, never
  longer than ~250ms — springy, not slow.
- Live/active indicators use `.animate-glow-pulse` (opacity + scale breathing), not a flat
  `animate-pulse` dot.

The blur is the point — never disable `backdrop-filter` for a "cleaner" look; a glass surface with
no blur is just a translucent rectangle.

---

## 5. Component recipes

Build these as shared components in `src/components/ui/`. Class strings below are the spec;
variant props map to them.

### Button

```
base:    inline-flex items-center justify-center gap-2 rounded-pill font-bold
         transition-[transform,box-shadow,background-color,opacity] duration-150 ease-glass
         focus-visible:outline-[3px] focus-visible:outline-gold focus-visible:outline-offset-2
         active:scale-[0.97] active:duration-150 active:ease-bounce
         disabled:pointer-events-none disabled:opacity-40 disabled:shadow-none
size md: px-5 py-2.5 text-[15px]                     size sm: px-4 py-1.5 text-sm
primary: bg-teal text-canvas shadow-teal-glow hover:bg-teal-deep hover:text-mist  ← ONE per screen
glass:   glass text-mist hover:bg-glass-hover                                     ← default/secondary
danger:  bg-coral text-canvas shadow-coral-glow hover:bg-coral-deep hover:text-mist
gold:    bg-gold text-canvas shadow-gold-glow hover:bg-gold-deep hover:text-mist  ← live/recording actions
ghost:   bg-transparent text-mist/70 shadow-none hover:bg-glass hover:text-mist
         (no press/shadow physics; danger-ghost: text-coral hover:bg-coral/10)
```

### Badge (status + tier)

```
base:     inline-flex items-center gap-1 rounded-pill border px-2.5 py-0.5 text-label uppercase
neutral:  border-glass-border bg-glass text-mist/70               (draft, default, unknown)
success:  border-green/40 bg-green/12 text-green
pending:  border-gold/40 bg-gold/12 text-gold
failed:   border-coral/40 bg-coral/12 text-coral
info:     border-sky/40 bg-sky/12 text-sky                        (running, in-progress)
violet:   border-violet/40 bg-violet/12 text-violet                (variety accent)
```

Live/recording indicator: prepend `<span class="size-2 rounded-pill bg-gold shadow-gold-glow animate-glow-pulse" />`.

### CapsLabel (eyebrow)

`<p class="text-label uppercase text-teal">…</p>` — accent colors directly, or `text-mist/60` for neutral.

### Card

```
feature:  rounded-card-lg glass-raised p-6                       (hero moments, 1–2/screen)
standard: rounded-card glass p-5                                 (dashboard cards)
clickable: standard + block transition-[transform,box-shadow,background-color] duration-200 ease-glass
           hover:-translate-y-1 hover:shadow-glass-lg hover:bg-glass-hover
quiet:    rounded-card border border-glass-border bg-glass/60 p-5, no shadow  (admin, dense)
callout:  rounded-control glass border-l-4 border-l-gold p-4
          (instructions/notes; left-border color = semantic; starts with a CapsLabel)
plan:     feature/standard + border-t-4 with the plan's accent (border-t-sky, border-t-violet)
```

### StatChip (glass stat display — signature)

```
<div class="glass inline-flex flex-col gap-0.5 rounded-card px-5 py-3 shadow-teal-glow">
  <span class="text-2xl font-extrabold tabular-nums leading-none text-mist">265,660</span>
  <span class="text-xs font-bold text-mist/60">events this month</span>
</div>
```

Swap `shadow-teal-glow` for the metric's own accent glow when the stat has a semantic color (e.g.
`shadow-coral-glow` for a failure count).

### Form field

```
label:    mb-1.5 block text-label uppercase text-mist/60
input:    w-full glass rounded-control px-3.5 py-2 text-[15px] text-mist
          placeholder:text-mist/40 focus-visible:outline-[3px] focus-visible:outline-gold
          focus-visible:outline-offset-2 disabled:opacity-40
error:    input + border-coral/60 focus-visible:outline-coral; message: mt-1 text-xs font-medium text-coral
help:     mt-1 text-xs text-mist/60
select/textarea: same as input; checkbox: size-4 rounded-dot border-2 border-glass-border accent-teal
```

### Table (all data tables)

```
wrapper:  overflow-x-auto glass rounded-card
table:    w-full text-sm
thead th: border-b border-glass-border-strong px-3 py-2 text-left text-label uppercase text-mist/50
tbody tr: border-b border-glass-border last:border-0 hover:bg-glass-hover
td:       px-3 py-2.5   (ids/keys/money/timestamps: font-mono text-[13px] tabular-nums)
```

Empty table body: single full-width cell, `py-8 text-center text-sm text-mist/60`.

### Modal

```
overlay: fixed inset-0 z-50 grid place-items-center bg-canvas/60 p-4 backdrop-blur-sm
panel:   w-full max-w-md glass-raised rounded-card-lg p-6
title:   text-h3 (or text-h2)  · actions row: mt-6 flex justify-end gap-3 (cancel=ghost, confirm=primary/danger)
```

### Toast

`fixed bottom-4 right-4 z-50 w-80 glass-raised rounded-card p-4`
+ `border-l-4 border-l-green|gold|coral` by severity. Title `text-sm font-bold text-mist`, body `text-sm text-mist/70`.

### CodeBlock (shell examples, JSON responses, config)

```
container: overflow-hidden rounded-card glass-deep
header:    flex items-center justify-between border-b border-glass-border px-4 py-2
           lang: text-label uppercase text-mist/50
           copy: rounded-dot border border-glass-border px-2 py-1 text-xs font-bold text-mist
                 hover:bg-glass-hover focus-visible:outline-gold
pre:       overflow-x-auto p-4 font-mono text-[13px] leading-relaxed text-mist
```

Inline code / key display: `rounded-dot border border-glass-border bg-glass px-1.5 py-0.5 font-mono text-[0.9em]`.

### Segmented meter (countable quota/usage — signature)

```
row:     flex items-center gap-3
cells:   flex flex-wrap gap-1.5
cell:    size-5 rounded-dot border   unused: border-glass-border bg-glass
         used: border-green/40 bg-green shadow-green-glow   (ALL used cells flip to border-coral/40 bg-coral shadow-coral-glow at limit)
caption: font-mono text-sm tabular-nums text-mist/70  ("7 / 10 today")
```

Unlimited quota: no cells, just `text-sm text-mist/60` "Unlimited". Continuous meters: track `h-2
w-full max-w-xs rounded-pill bg-glass border border-glass-border`, fill `h-full rounded-pill
bg-green shadow-green-glow` (`bg-gold` ≥80%, `bg-coral` at 100%).

### Log feed (live events / console output — the agent's reasoning stream)

```
panel: h-72 overflow-y-auto glass-deep rounded-card p-3 font-mono text-xs leading-relaxed text-mist/90
line:  timestamp text-mist/45 · line-type prefix colors: info/navigation=text-sky,
       action/warning=text-gold, success=text-green, error=text-coral
```

### Empty state

```
rounded-card border-2 border-dashed border-glass-border-strong bg-glass/40 p-10 text-center
+ font-sans text-display-sm font-extrabold statement with one teal or gold phrase, text-sm text-mist/70 line, primary Button
```

### Loading

Spinner: `size-5 animate-spin rounded-pill border-2 border-glass-border border-t-teal`.
Skeleton: `animate-pulse rounded-control bg-glass`.

### Success flourish (optional, celebratory moment)

For the moment the agent lands a correct/final answer — a restrained nod to Flip7's confetti,
scaled down to fit a professional tool: a soft radial "ping" ring in the answer's accent color
(teal or gold), one pulse, ~600ms, never confetti particles or emoji. Use sparingly — the Watch
screen's answer reveal is the only place this belongs.

---

## 6. App shell & layout

One shared `AppShell` (adopt on every page — pages never render their own headers). The canvas
(`bg-orbs` + `bg-canvas`) sits behind everything; the top bar is **glass-deep** so it stays legible
over scrolling content:

```
canvas:  a single fixed <div class="bg-orbs" /> rendered once, behind the app; body/html get bg-canvas
header:  sticky top-0 z-40 glass-deep border-b border-glass-border
inner:   mx-auto flex h-14 max-w-6xl items-center justify-between px-6
brand:   font-sans text-lg font-extrabold tracking-tight text-mist   (product wordmark, no serif)
links:   rounded-pill px-3 py-1.5 text-sm font-bold text-mist/70 hover:bg-glass-hover hover:text-mist
active:  bg-glass-hover text-gold
right:   user identity text-xs text-mist/60 · optional tier Badge · logout ghost button
```

Content: `mx-auto max-w-6xl px-6 py-8`. Page header pattern: optional eyebrow CapsLabel,
`text-h1`, optional `text-sm text-mist/70` subline, actions right-aligned; `mb-8`.
Section gaps `space-y-8`; card grids `grid gap-5 md:grid-cols-2 lg:grid-cols-3`.
Secondary nav (sub-tabs) = pill tabs: active `rounded-pill bg-glass-hover px-3 py-1.5 text-sm
font-bold text-mist`, inactive `text-mist/70 hover:bg-glass`.

Responsive: desktop-first by default. One breakpoint of care: ≤900px stacks grids to one column
and the nav collapses to brand + logout. Invest beyond that only if the product demands mobile.

---

## 7. Surface archetype guide

| Archetype | Tone | Recipe |
|---|---|---|
| Landing / marketing | LOUD | orb canvas at full strength behind a dark hero; display headline with one teal/gold accent phrase; feature cards `glass-raised` with rotating `border-t-4` teal/coral/gold/violet; footer band `canvas-alt` with brand mark; exactly one primary CTA |
| Watch (cinematic, live) | LOUD/cinematic | dark stage; the live dashboard screenshot is the one bright object, floating in a `glass` frame with soft glow; reasoning feed streams in mono on `glass-deep`; live dot pulses gold; filmstrip as a horizontal glass timeline |
| Dashboard / home | medium | page header + headline stat (StatChips or segmented meter); content as clickable glass cards; status Badges; CapsLabel meta |
| Detail page (one entity) | medium | header: name + status Badge + primary action; identifiers in inline-code + sm copy button; StatChip row; attribute Tables; CodeBlock for payloads |
| Docs / long-form prose | docs | `text-display-sm` title; prose `text-base leading-relaxed`; CodeBlocks; quiet glass cards per section |
| Forms / settings | quiet | quiet glass cards per section; §5 form fields; danger zone = quiet card + `border-coral/40` + danger buttons |
| Focused single task (auth, wizard step) | medium | single centered feature card; one primary Button; gold callout for process explanation |
| Live / monitoring | medium | status row (Badge with pulsing gold dot, StatChip counters); log feed panel on `glass-deep`; coral "Stop" button |
| Admin / data-dense | QUIET | dense Tables (`text-sm`, mono ids/amounts); filters as sm inputs; row actions = primary sm / danger sm; counts as StatChips; no orb glow, no feature cards |

---

## 8. Do / Don't

| Do | Don't |
|---|---|
| Every non-canvas surface is glass (fill + border + blur) | Any flat opaque panel, `bg-white`, or solid gray card |
| Colored glow shadows (`shadow-{accent}-glow`) on active/primary elements | Flat black drop shadows anywhere |
| One teal primary action per screen | Teal for errors/warnings (coral/gold exist) |
| Accent colors directly as text on dark surfaces | Inventing "-deep" text variants for dark-bg contrast (not needed here) |
| `backdrop-filter: blur(...)` on every glass utility | Disabling blur "for performance" without checking it's actually needed |
| One accent phrase per display headline | Rainbow headlines, two accents in one statement |
| `font-mono tabular-nums` for ids, keys, money, counts | Proportional digits in tables/quotas |
| Radius by role (control 14 / card 20 / pill badges) | Mixing radii within one component class |
| `text-mist/70`, `text-mist/45` for muted text | Any `gray-*`/`slate-*`/`zinc-*`/`text-black`/`bg-white` |
| Reuse `components/ui/` everywhere | Re-hand-rolling per-page glass/button/card classes |
| Bounce/spring easing on press, glow-pulse on live states | Hard-offset shadow physics, flat `animate-pulse` for "live" |

---

## 9. Implementation order & definition of done

Work in this order; keep diffs reviewable (commit per step or per page group):

1. **Tokens**: fonts installed + imported in `main.jsx`; global stylesheet replaced with §1.2
   (includes the `bg-orbs` layer and `glass`/`glass-raised`/`glass-deep` utilities).
2. **UI kit**: `src/components/ui/` — Button, Badge, CapsLabel, Card, StatChip, Field/Input,
   Table, Modal, Toast (if used), CodeBlock, segmented meter, Spinner, EmptyState per §5.
3. **Shell**: `AppShell` per §6 — mount the fixed orb layer once, glass-deep header, adopt on all
   pages.
4. **Pages** (loud→quiet): landing → Watch (cinematic centerpiece) → history/admin.
5. **Sweep**: delete dead per-page style constants left behind by the migration.

Done when ALL of these hold:

- `grep -rnE "(gray|slate|zinc|stone|neutral)-[0-9]|text-black|bg-white|shadow-offset|border-ink|bg-paper|bg-cream|text-ink|font-display" src` → **zero hits**.
- Every glass surface has visible blur (check in-browser, not just in code — some renderers/GPUs
  disable `backdrop-filter` silently).
- Every status color matches the §2.1 semantic map; exactly one teal primary button per screen.
- Every interactive element has visible `focus-visible` outline; disabled states render per §4.
- `npm run build` passes; visual pass at 1280px and ~900px shows no broken layout.
- Fonts actually render (Jakarta Sans UI/display, JetBrains Mono code) — check in the browser.
