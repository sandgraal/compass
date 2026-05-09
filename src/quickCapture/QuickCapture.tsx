import { useCallback, useEffect, useRef, useState } from 'react'

export function QuickCapture() {
  const [title, setTitle] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  const hide = useCallback(() => {
    window.quickCaptureApi.hide()
  }, [])

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === 'Escape') {
        hide()
      }
    },
    [hide]
  )

  const handleSubmit = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault()
      const trimmed = title.trim()
      if (!trimmed) return

      setSubmitting(true)
      setError(null)

      try {
        const result = await window.quickCaptureApi.quickAdd(trimmed)
        if (result.success) {
          setTitle('')
          hide()
        } else {
          setError(result.error ?? 'Failed to add task')
        }
      } catch (err) {
        setError(String(err))
      } finally {
        setSubmitting(false)
      }
    },
    [title, hide]
  )

  return (
    <div
      style={{
        width: '360px',
        height: '80px',
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
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Quick task…"
            disabled={submitting}
            autoComplete="off"
            autoCorrect="off"
            spellCheck={false}
            aria-label="Quick capture task title"
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
            Press Enter to add to today · Esc to dismiss
          </p>
        )}
      </form>
    </div>
  )
}
