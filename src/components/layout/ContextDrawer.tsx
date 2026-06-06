import { BookOpen, Calendar, ChevronDown, ChevronRight, GitBranch, Inbox, X } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useLocation } from 'react-router-dom'
import { formatDate, formatTime } from '../../lib/utils'
import { useAppStore } from '../../store/appStore'

interface ContextSection {
  id: string
  label: string
  icon: React.ReactNode
  items: ContextItem[]
}

interface ContextItem {
  title: string
  subtitle?: string
  href?: string
}

export function ContextDrawer(): JSX.Element {
  const { contextDrawerOpen, setContextDrawerOpen } = useAppStore()
  const location = useLocation()
  const [sections, setSections] = useState<ContextSection[]>([])
  const [expanded, setExpanded] = useState<Set<string>>(new Set(['calendar', 'github']))

  // biome-ignore lint/correctness/useExhaustiveDependencies: refetch context on route change
  useEffect(() => {
    const isElectron = typeof window !== 'undefined' && !!window.api
    if (!isElectron) {
      setSections(getMockSections())
      return
    }

    const now = new Date()
    const endOfWeek = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000)

    Promise.all([
      window.api.calendar.getEvents(now.toISOString(), endOfWeek.toISOString()),
      window.api.github.getItems('open'),
      window.api.gmail.getActions(false)
    ])
      .then(([events, github, gmail]) => {
        const newSections: ContextSection[] = []

        if (events.length) {
          newSections.push({
            id: 'calendar',
            label: 'Upcoming',
            icon: <Calendar size={14} />,
            items: events.slice(0, 5).map((e) => ({
              title: e.title,
              subtitle: e.startAt ? `${formatDate(e.startAt)} ${formatTime(e.startAt)}` : 'All day'
            }))
          })
        }

        if (github.length) {
          newSections.push({
            id: 'github',
            label: 'GitHub',
            icon: <GitBranch size={14} />,
            items: github.slice(0, 5).map((g) => ({
              title: g.title,
              subtitle: g.repo,
              href: g.url
            }))
          })
        }

        if (gmail.length) {
          newSections.push({
            id: 'gmail',
            label: 'Inbox',
            icon: <Inbox size={14} />,
            items: gmail.slice(0, 5).map((m) => ({
              title: m.subject,
              subtitle: m.fromAddress
            }))
          })
        }

        setSections(newSections)
      })
      .catch(() => setSections(getMockSections()))
  }, [location.pathname])

  if (!contextDrawerOpen) return <></>

  return (
    <aside className="fixed right-0 top-0 bottom-0 w-80 flex flex-col bg-card border-l border-border pt-10">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-border">
        <div className="flex items-center gap-2 text-sm font-medium text-foreground">
          <BookOpen size={15} />
          Context
        </div>
        <button
          type="button"
          onClick={() => setContextDrawerOpen(false)}
          className="text-muted-foreground hover:text-foreground transition-colors p-1 rounded"
        >
          <X size={15} />
        </button>
      </div>

      {/* Sections */}
      <div className="flex-1 overflow-y-auto py-2">
        {sections.length === 0 ? (
          <div className="px-4 py-8 text-center">
            <p className="text-sm text-muted-foreground">
              Connect integrations to see context here.
            </p>
          </div>
        ) : (
          sections.map((section) => (
            <div key={section.id} className="mb-1">
              <button
                type="button"
                className="w-full flex items-center justify-between px-4 py-2 text-xs font-medium text-muted-foreground hover:text-foreground uppercase tracking-wider"
                onClick={() =>
                  setExpanded((prev) => {
                    const next = new Set(prev)
                    next.has(section.id) ? next.delete(section.id) : next.add(section.id)
                    return next
                  })
                }
              >
                <span className="flex items-center gap-1.5">
                  {section.icon}
                  {section.label}
                </span>
                {expanded.has(section.id) ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
              </button>

              {expanded.has(section.id) && (
                <div className="space-y-0.5 pb-2">
                  {section.items.map((item) => {
                    const key = `${section.id}:${item.title}:${item.href ?? ''}`
                    return item.href ? (
                      <a
                        key={key}
                        href={item.href}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="block px-4 py-2 cursor-pointer hover:bg-secondary/50 transition-colors"
                      >
                        <p className="text-xs text-foreground truncate">{item.title}</p>
                        {item.subtitle && (
                          <p className="text-xs text-muted-foreground truncate mt-0.5">
                            {item.subtitle}
                          </p>
                        )}
                      </a>
                    ) : (
                      <div key={key} className="px-4 py-2">
                        <p className="text-xs text-foreground truncate">{item.title}</p>
                        {item.subtitle && (
                          <p className="text-xs text-muted-foreground truncate mt-0.5">
                            {item.subtitle}
                          </p>
                        )}
                      </div>
                    )
                  })}
                </div>
              )}
            </div>
          ))
        )}
      </div>
    </aside>
  )
}

function getMockSections(): ContextSection[] {
  return [
    {
      id: 'calendar',
      label: 'Upcoming',
      icon: <Calendar size={14} />,
      items: [
        { title: 'Team standup', subtitle: 'Today, 9:00 AM' },
        { title: '1:1 with manager', subtitle: 'Tomorrow, 2:00 PM' }
      ]
    }
  ]
}
