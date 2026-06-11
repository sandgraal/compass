import { useCallback, useEffect, useRef, useState } from 'react'

type CaptureKind = 'task' | 'note' | 'expense'

const KINDS: CaptureKind[] = ['task', 'note', 'expense']

const KIND_META: Record<CaptureKind, { label: string; placeholder: string; hint: string }> = {
  task: {
    label: 'Task',
    placeholder: 'Quick task…',
    hint: 'Enter adds to today · Tab switches type · Esc dismisses'
  },
  note: {
    label: 'Note',
    placeholder: 'Quick note…',
    hint: 'Enter appends to your inbox note · Tab switches type'
  },
  expense: {
    label: 'Expense',
    placeholder: '12.50 coffee…',
    hint: 'Amount + description, either order · Tab switches type'
  }
}

export function QuickCapture() {
  const [kind, setKind] = useState<CaptureKind>('task')
  const [text, setText] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  const hide = useCallback(() => {
    window.quickCaptureApi.hide()
  }, [])

  const cycleKind = useCallback((dir: 1 | -1) => {
    setError(null)
    setKind((k) => KINDS[(KINDS.indexOf(k) + dir + KINDS.length) % KINDS.length])
  }, [])

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === 'Escape') {
        hide()
      } else if (e.key === 'Tab') {
        e.preventDefault()
        cycleKind(e.shiftKey ? -1 : 1)
      }
    },
    [hide, cycleKind]
  )

  const handleSubmit = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault()
      const trimmed = text.trim()
      if (!trimmed) return

      setSubmitting(true)
      setError(null)

      try {
        const result = await window.quickCaptureApi.submit(kind, trimmed)
        if (result.success) {
          setText('')
          hide()
        } else {
          setError(result.error ?? 'Failed to capture')
        }
      } catch (err) {
        setError(String(err))
      } finally {
        setSubmitting(false)
      }
    },
    [text, kind, hide]
  )

  const selectKind = useCallback((k: CaptureKind) => {
    setError(null)
    setKind(k)
    inputRef.current?.focus()
  }, [])

  return (
    <div
      style={{
        width: '360px',
        height: '120px',
        background: 'hsl(222 47% 9%)',
        border: '1px solid hsl(222 47% 16%)',
        borderRadius: '10px',
        boxShadow: '0 8px 32px rgba(0,0,0,0.6), 0 2px 8px rgba(0,0,0,0.4)',
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'center',
        padding: '0 16px',
        overflow: 'hidden'
      }}
    >
      <div style={{ display: 'flex', gap: '6px', marginBottom: '8px' }}>
        {KINDS.map((k) => (
          <button
            key={k}
            type="button"
            onClick={() => selectKind(k)}
            aria-pressed={k === kind}
            // Deliberately out of the tab order: Tab/Shift+Tab on the input
            // IS the keyboard affordance for switching kinds (see handleKeyDown).
            tabIndex={-1}
            style={{
              background: k === kind ? 'hsl(238 82% 68% / 0.18)' : 'transparent',
              color: k === kind ? 'hsl(238 90% 78%)' : 'hsl(215 20% 55%)',
              border: `1px solid ${k === kind ? 'hsl(238 82% 68% / 0.5)' : 'hsl(222 47% 18%)'}`,
              borderRadius: '6px',
              fontSize: '11px',
              fontFamily: 'inherit',
              padding: '2px 10px',
              cursor: 'pointer',
              lineHeight: 1.4
            }}
          >
            {KIND_META[k].label}
          </button>
        ))}
      </div>
      <form
        onSubmit={handleSubmit}
        style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
          <svg
            width="16"
            height="16"
            viewBox="0 0 16 16"
            fill="none"
            xmlns="http://www.w3.org/2000/svg"
            style={{ flexShrink: 0, opacity: 0.6 }}
            aria-hidden="true"
          >
            <path
              d="M8 2L9.5 7H14.5L10.5 10L12 15L8 12L4 15L5.5 10L1.5 7H6.5L8 2Z"
              fill="hsl(238 82% 68%)"
            />
          </svg>
          <input
            ref={inputRef}
            type="text"
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={KIND_META[kind].placeholder}
            disabled={submitting}
            autoComplete="off"
            autoCorrect="off"
            spellCheck={false}
            aria-label={`Quick capture ${KIND_META[kind].label.toLowerCase()}`}
            style={{
              flex: 1,
              background: 'transparent',
              border: 'none',
              outline: 'none',
              color: 'hsl(213 31% 91%)',
              fontSize: '15px',
              fontFamily: 'inherit',
              caretColor: 'hsl(238 82% 68%)',
              opacity: submitting ? 0.5 : 1
            }}
          />
        </div>
        {error && (
          <p
            style={{
              color: 'hsl(0 72% 65%)',
              fontSize: '12px',
              paddingLeft: '26px',
              lineHeight: 1.2
            }}
          >
            {error}
          </p>
        )}
        {!error && (
          <p
            style={{
              color: 'hsl(215 20% 45%)',
              fontSize: '11px',
              paddingLeft: '26px',
              lineHeight: 1.2
            }}
          >
            {KIND_META[kind].hint}
          </p>
        )}
      </form>
    </div>
  )
}
