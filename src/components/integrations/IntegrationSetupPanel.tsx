import { CheckCircle2, ChevronDown, ChevronRight, ExternalLink, Plug2 } from 'lucide-react'
import { useState } from 'react'
import type { IntegrationSetup, SetupField } from '../../lib/integration-setup'

interface ByoProps {
  fields: SetupField[]
  values: Record<string, string>
  onChange: (key: string, value: string) => void
  onSubmit: () => void
  busy: boolean
}

interface IntegrationSetupPanelProps {
  setup: IntegrationSetup
  connected: boolean
  busy: boolean
  /** Values for `setup.fields` (empty for relay-widget / local-file). */
  values: Record<string, string>
  onChange: (key: string, value: string) => void
  /** Submit the fields form, or trigger the direct connect when there are none. */
  onConnect: () => void
  onDisconnect: () => void
  /** BYO-direct escape hatch (Terra today). */
  byo?: ByoProps
}

const INPUT_CLASS =
  'w-full text-xs font-mono px-2 py-1.5 bg-background border border-border rounded focus:outline-none focus:ring-1 focus:ring-primary placeholder:text-muted-foreground/40'

/**
 * Declarative connect UI rendered from an IntegrationSetup spec — used for the
 * simple auth kinds (paste-token, relay-widget, local-file). Shows the
 * prerequisites, "what you'll need", numbered steps, a generic form built from
 * `setup.fields`, and (for relay aggregators that support it) a BYO toggle.
 * This is what replaces the 9 bare "Connect" buttons that gave no guidance.
 */
export default function IntegrationSetupPanel({
  setup,
  connected,
  busy,
  values,
  onChange,
  onConnect,
  onDisconnect,
  byo
}: IntegrationSetupPanelProps): JSX.Element {
  const [byoOpen, setByoOpen] = useState(false)
  const connectLabel = setup.connectLabel ?? 'Connect'
  const missingRequired = setup.fields.some((f) => !values[f.key]?.trim())

  if (connected) {
    return (
      <div className="flex items-center justify-between gap-2">
        <span className="inline-flex items-center gap-1 text-xs font-medium text-emerald-500">
          <CheckCircle2 size={13} /> Connected
        </span>
        <button
          type="button"
          onClick={onDisconnect}
          className="text-xs px-3 py-1.5 border border-border hover:border-destructive text-muted-foreground hover:text-destructive rounded-lg transition-colors"
        >
          Disconnect
        </button>
      </div>
    )
  }

  return (
    <div className="space-y-3">
      {(setup.cost || setup.prerequisites.length > 0) && (
        <div className="flex flex-wrap gap-1.5">
          {setup.cost && (
            <span className="rounded-full bg-primary/10 px-2 py-0.5 text-[10px] font-medium text-primary">
              {setup.cost}
            </span>
          )}
          {setup.prerequisites.map((p) => (
            <span
              key={p}
              className="rounded-full border border-border px-2 py-0.5 text-[10px] text-muted-foreground"
            >
              {p}
            </span>
          ))}
        </div>
      )}

      {setup.whatYoullNeed.length > 0 && (
        <div className="text-xs text-muted-foreground">
          <p className="font-medium text-foreground/80">What you’ll need</p>
          <ul className="mt-1 list-disc list-inside space-y-0.5">
            {setup.whatYoullNeed.map((w) => (
              <li key={w}>{w}</li>
            ))}
          </ul>
        </div>
      )}

      <ol className="list-decimal list-inside space-y-1.5 text-xs leading-relaxed text-muted-foreground">
        {setup.steps.map((step, i) => (
          <li key={`${setup.id}-step-${i}`}>
            {step.text}
            {step.href && (
              <>
                {' '}
                <a
                  href={step.href}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-primary underline underline-offset-2 inline-flex items-center gap-0.5"
                >
                  {step.hrefLabel ?? 'Open'}
                  <ExternalLink size={10} className="opacity-70" />
                </a>
              </>
            )}
          </li>
        ))}
      </ol>

      {setup.fields.map((field) => (
        <div key={field.key} className="space-y-1">
          <label
            htmlFor={`${setup.id}-${field.key}`}
            className="block text-xs text-muted-foreground"
          >
            {field.label}
          </label>
          {field.type === 'textarea' ? (
            <textarea
              id={`${setup.id}-${field.key}`}
              rows={3}
              placeholder={field.placeholder}
              aria-label={field.label}
              value={values[field.key] ?? ''}
              onChange={(e) => onChange(field.key, e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Escape') (e.target as HTMLTextAreaElement).blur()
              }}
              className={`${INPUT_CLASS} resize-none`}
            />
          ) : (
            <input
              id={`${setup.id}-${field.key}`}
              type={field.type}
              placeholder={field.placeholder}
              aria-label={field.label}
              value={values[field.key] ?? ''}
              onChange={(e) => onChange(field.key, e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !missingRequired && !busy) onConnect()
              }}
              className={INPUT_CLASS}
            />
          )}
          {field.help && <p className="text-[11px] text-muted-foreground/70">{field.help}</p>}
        </div>
      ))}

      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={onConnect}
          disabled={busy || missingRequired}
          className="flex items-center gap-1.5 text-xs px-3 py-1.5 bg-primary/20 hover:bg-primary/30 text-primary rounded-lg transition-colors disabled:opacity-50"
        >
          <Plug2 size={11} />
          {busy ? 'Connecting…' : connectLabel}
        </button>
        {setup.signupUrl && (
          <a
            href={setup.signupUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="text-xs text-muted-foreground hover:text-foreground transition-colors inline-flex items-center gap-0.5"
          >
            Get access
            <ExternalLink size={10} className="opacity-70" />
          </a>
        )}
      </div>

      {byo && setup.byoSupported && (
        <div className="border-t border-border pt-2">
          <button
            type="button"
            onClick={() => setByoOpen((v) => !v)}
            aria-expanded={byoOpen}
            className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
          >
            {byoOpen ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
            Use my own API keys (advanced) — bypass the relay
          </button>
          {byoOpen && (
            <div className="mt-2 space-y-2">
              {byo.fields.map((field) => (
                <div key={field.key} className="space-y-1">
                  <label
                    htmlFor={`${setup.id}-byo-${field.key}`}
                    className="block text-xs text-muted-foreground"
                  >
                    {field.label}
                  </label>
                  <input
                    id={`${setup.id}-byo-${field.key}`}
                    type={field.type === 'textarea' ? 'text' : field.type}
                    placeholder={field.placeholder}
                    aria-label={field.label}
                    value={byo.values[field.key] ?? ''}
                    onChange={(e) => byo.onChange(field.key, e.target.value)}
                    className={INPUT_CLASS}
                  />
                </div>
              ))}
              <button
                type="button"
                onClick={byo.onSubmit}
                disabled={byo.busy || byo.fields.some((f) => !byo.values[f.key]?.trim())}
                className="flex items-center gap-1.5 text-xs px-3 py-1.5 bg-primary/20 hover:bg-primary/30 text-primary rounded transition-colors disabled:opacity-50"
              >
                <Plug2 size={11} />
                {byo.busy ? 'Connecting…' : 'Connect directly'}
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
