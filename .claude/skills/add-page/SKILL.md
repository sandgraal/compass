---
name: add-page
description: Boilerplate for a new top-level page (route, sidebar entry, command palette entry, page component). Auto-loads when the user asks to add a new view, page, tab, or section to Compass.
---

# Adding a new page

## Files you'll touch

| File | What you add |
|---|---|
| `src/pages/<Page>.tsx` | The page component |
| `src/App.tsx` | `<Route path="<route>" element={<Page />} />` |
| `src/components/layout/Sidebar.tsx` | Sidebar nav entry (icon + label) |
| `src/components/CommandPalette.tsx` | `{ id, label, description, icon, action: () => nav('<route>'), keywords }` |
| `docs/architecture.md` | Add to the routes table |

## Step-by-step

### 1. Page component (`src/pages/<Page>.tsx`)

Match the existing pattern (see `src/pages/Settings.tsx` for a good template):

```typescript
import { useState, useEffect } from 'react'
import { Icon } from 'lucide-react'
import { cn } from '../lib/utils'

export default function <Page>(): JSX.Element {
  const [data, setData] = useState<...>([])

  useEffect(() => {
    const isElectron = typeof window !== 'undefined' && !!window.api
    if (!isElectron) return
    window.api.<domain>.<get>().then(setData)
  }, [])

  return (
    <div className="p-8 pt-14 max-w-2xl mx-auto animate-fade-in">
      <h1 className="text-2xl font-semibold text-foreground mb-8">Page Title</h1>
      {/* ... */}
    </div>
  )
}
```

Conventions:
- `pt-14` (top padding for the macOS title bar)
- `max-w-2xl` or `max-w-4xl` (consistent with siblings)
- `animate-fade-in` on root
- `<EmptyState>` and loading skeletons (steal from `Dashboard.tsx`)
- `aria-label` on every icon-only button

### 2. Route in `src/App.tsx`

```typescript
import <Page> from './pages/<Page>'
// ...
<Route path="<route>" element={<<Page> />} />
```

### 3. Sidebar entry

In `src/components/layout/Sidebar.tsx`, find the nav array and append:
```typescript
{ to: '/<route>', icon: <Icon size={16} />, label: '<Label>' }
```

### 4. Command palette entry

In `src/components/CommandPalette.tsx COMMANDS` array:
```typescript
{
  id: '<id>',
  label: '<Label>',
  description: '<short description>',
  icon: <Icon size={15} />,
  action: () => nav('/<route>'),
  keywords: ['<keyword1>', '<keyword2>']
}
```

### 5. Update docs

In `docs/architecture.md`, find the "Pages & top-level components" table and add the new row.

### 6. Verify

```bash
npm run typecheck && npm run check && npm run dev
```

Open the app, click the sidebar entry, press ⌘K and verify the command appears.

## Common page patterns

- **List + detail**: file tree on left, editor on right (see KnowledgeBase, Vault)
- **Stats + cards**: top stats row, two-column card grid (see Dashboard)
- **Calendar grid**: 7-column or month-view (see Weekly, Monthly)
- **Form-heavy**: section + row + control (see Settings)

Pick the closest existing pattern and adapt — don't invent a new layout system.
