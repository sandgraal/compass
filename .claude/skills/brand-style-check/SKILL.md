---
name: brand-style-check
description: Verifies new UI uses Compass's tailwind tokens and design conventions (no raw hex colors, consistent spacing, lucide icons sized correctly). Auto-loads when editing files under src/components/ or src/pages/.
---

# Brand style check

Compass has a tight visual language. New code should match, not invent.

## Tokens (semantic, theme-aware)

Use these — never raw `#hex` or `bg-zinc-X`:

| Token | What it is | Example |
|---|---|---|
| `bg-background` | Page background | Outer container |
| `bg-card` | Card surface | Stats tiles, panels |
| `bg-secondary` | Inputs, buttons (default) | `<input>`, default button |
| `bg-secondary/60` | Subtle hover variant | `hover:bg-secondary/60` |
| `bg-primary` | Brand accent (blue) | Active state, primary action |
| `bg-primary/10`, `/20` | Tinted accent | Badges, selected nav |
| `bg-destructive` | Danger / delete | Confirm dialog primary |
| `text-foreground` | Default text | All copy |
| `text-muted-foreground` | Secondary text | Captions, sub-labels |
| `text-primary` | Accent text | Active links, badges |
| `text-destructive` | Danger text | Delete labels |
| `border-border` | Default border | Cards, inputs |
| `border-primary/50` | Active selection | Selected card |

## Sizing & spacing

- Page padding: `p-8 pt-14` (the pt-14 is for the macOS title bar)
- Page max-width: `max-w-2xl mx-auto` (settings) / `max-w-4xl` (integrations) / `max-w-5xl` (dashboard) — match siblings
- Card padding: `p-4` to `p-5`
- Card radius: `rounded-xl` for top-level cards, `rounded-lg` for nested
- Border: `border border-border` on cards
- Section gap: `mb-6` to `mb-8` between major sections
- Row gap: `gap-2` to `gap-4` for inline elements

## Icons (Lucide React)

- Sizes: `11`, `12`, `13`, `14`, `15`, `16` — pick the one that matches the surrounding text size
- Inline with text: `<Icon size={14} className="text-muted-foreground" />`
- Icon-only buttons: ALWAYS add `aria-label` and a tooltip (`title`)

## Animations

- Page enter: `animate-fade-in` (defined in tailwind.config.ts)
- Spinners: `animate-spin` on a Lucide icon
- Pulse loading: `animate-pulse` on skeleton placeholders
- Transitions: `transition-colors`, `transition-transform`, `transition-all duration-200`

## Anti-patterns

- ❌ `bg-zinc-900`, `text-gray-400`, `border-slate-700` — use semantic tokens
- ❌ `style={{ backgroundColor: '#1a1f2c' }}` — use tailwind classes
- ❌ Custom animations in CSS files — extend `tailwind.config.ts` keyframes
- ❌ Inline `font-size: 13px` — use `text-xs` (12px) or `text-sm` (14px)
- ❌ `border-1` — just `border`
- ❌ `rounded` (4px) — use `rounded-lg` or `rounded-xl` for visual consistency

## Output

Run grep against the diff:
```bash
git diff <branch> -- 'src/' | grep -E 'bg-zinc|bg-slate|bg-gray|text-gray|text-zinc|text-slate|border-zinc|border-slate|border-gray|#[0-9a-fA-F]{3,6}|style=\{\{'
```

If matches: list each `<file>:<line>` with the offending pattern + suggested replacement.
Else: "✅ Brand style check passed."
