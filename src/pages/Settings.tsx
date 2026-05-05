import { useState, useEffect } from 'react'
import { Sun, Moon, Monitor, Bell, Shield, Database, Trash2, Download } from 'lucide-react'
import { cn } from '../lib/utils'
import { useAppStore } from '../store/appStore'

export default function Settings(): JSX.Element {
  const { theme, setTheme } = useAppStore()
  const [syncInterval, setSyncInterval] = useState('15')
  const [notifications, setNotifications] = useState(true)
  const [contextDrawer, setContextDrawer] = useState(true)
  const { setContextDrawerOpen } = useAppStore()

  useEffect(() => {
    const isElectron = typeof window !== 'undefined' && !!window.api
    if (isElectron) {
      window.api.settings.getAll().then(s => {
        setSyncInterval(s.syncInterval || '15')
        setNotifications(s.notificationsEnabled !== 'false')
        setContextDrawer(s.showContextDrawer !== 'false')
      })
    }
  }, [])

  async function save(key: string, value: string) {
    const isElectron = typeof window !== 'undefined' && !!window.api
    if (isElectron) {
      await window.api.settings.set(key, value)
    }
  }

  return (
    <div className="p-8 pt-14 max-w-2xl mx-auto animate-fade-in">
      <h1 className="text-2xl font-semibold text-foreground mb-8">Settings</h1>

      {/* Appearance */}
      <SettingsSection icon={<Sun size={16} />} title="Appearance">
        <SettingsRow label="Theme" description="Choose how Compass looks">
          <div className="flex items-center gap-2">
            {[
              { id: 'light', icon: <Sun size={14} />, label: 'Light' },
              { id: 'dark', icon: <Moon size={14} />, label: 'Dark' },
              { id: 'system', icon: <Monitor size={14} />, label: 'System' }
            ].map(t => (
              <button
                key={t.id}
                onClick={() => {
                  const v = t.id === 'system' ? (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light') : t.id as 'dark' | 'light'
                  setTheme(v)
                  save('theme', t.id)
                }}
                className={cn(
                  'flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-lg border transition-colors',
                  (t.id === theme || (t.id === 'system' && !['light', 'dark'].includes(theme)))
                    ? 'border-primary bg-primary/10 text-primary'
                    : 'border-border text-muted-foreground hover:text-foreground'
                )}
              >
                {t.icon} {t.label}
              </button>
            ))}
          </div>
        </SettingsRow>

        <SettingsRow label="Context Drawer" description="Show the right-side context panel by default">
          <Toggle
            enabled={contextDrawer}
            onChange={(v) => {
              setContextDrawer(v)
              setContextDrawerOpen(v)
              save('showContextDrawer', String(v))
            }}
          />
        </SettingsRow>
      </SettingsSection>

      {/* Sync */}
      <SettingsSection icon={<Database size={16} />} title="Sync">
        <SettingsRow label="Auto-sync interval" description="How often to pull data from connected services">
          <select
            value={syncInterval}
            onChange={(e) => { setSyncInterval(e.target.value); save('syncInterval', e.target.value) }}
            className="bg-secondary border border-border rounded-lg px-3 py-1.5 text-sm text-foreground outline-none focus:ring-1 focus:ring-primary"
          >
            <option value="5">Every 5 minutes</option>
            <option value="15">Every 15 minutes</option>
            <option value="30">Every 30 minutes</option>
            <option value="60">Every hour</option>
            <option value="0">Manual only</option>
          </select>
        </SettingsRow>
      </SettingsSection>

      {/* Notifications */}
      <SettingsSection icon={<Bell size={16} />} title="Notifications">
        <SettingsRow label="Sync notifications" description="Show a notification when sync completes">
          <Toggle
            enabled={notifications}
            onChange={(v) => { setNotifications(v); save('notificationsEnabled', String(v)) }}
          />
        </SettingsRow>
      </SettingsSection>

      {/* Security */}
      <SettingsSection icon={<Shield size={16} />} title="Security & Privacy">
        <SettingsRow label="Data storage" description="All data is stored locally in ~/Library/Application Support/Compass">
          <span className="text-xs text-emerald-400 bg-emerald-400/10 px-2 py-1 rounded-full">Local only</span>
        </SettingsRow>
        <SettingsRow label="Vault encryption" description="Sensitive data encrypted with AES-256-GCM, key in OS Keychain">
          <span className="text-xs text-emerald-400 bg-emerald-400/10 px-2 py-1 rounded-full">AES-256-GCM</span>
        </SettingsRow>
      </SettingsSection>

      {/* Data */}
      <SettingsSection icon={<Download size={16} />} title="Data">
        <SettingsRow label="Open data folder" description="Browse your local knowledge base, vault, and database files in Finder">
          <button
            onClick={() => window.api?.settings.openDataDir()}
            className="flex items-center gap-1.5 text-xs px-3 py-1.5 bg-secondary hover:bg-secondary/80 rounded-lg transition-colors"
          >
            <Database size={12} /> Open in Finder
          </button>
        </SettingsRow>
        <SettingsRow label="Export data" description="Save all your data (tasks, habits, finance, knowledge index) as a JSON file">
          <button
            onClick={async () => {
              const r = await window.api?.settings.exportData()
              if (r?.success) alert(`Exported to:\n${r.path}`)
              else if (!r?.canceled) alert('Export failed: ' + r?.error)
            }}
            className="flex items-center gap-1.5 text-xs px-3 py-1.5 bg-secondary hover:bg-secondary/80 rounded-lg transition-colors"
          >
            <Download size={12} /> Export JSON
          </button>
        </SettingsRow>
      </SettingsSection>

      {/* Danger zone */}
      <div className="border border-destructive/30 rounded-xl p-5 bg-destructive/5">
        <h3 className="text-sm font-semibold text-destructive mb-1 flex items-center gap-2"><Trash2 size={14} /> Danger Zone</h3>
        <p className="text-xs text-muted-foreground mb-4">These actions are permanent and cannot be undone.</p>
        <div className="space-y-3">
          <SettingsRow label="Wipe knowledge base" description="Delete all files in your local knowledge-base folder">
            <button
              onClick={async () => {
                if (!confirm('Delete all knowledge base files? This cannot be undone.')) return
                const r = await window.api?.settings.wipeKnowledge()
                if (r?.success) alert('Knowledge base wiped.')
                else alert('Error: ' + r?.error)
              }}
              className="text-xs px-3 py-1.5 border border-destructive/50 text-destructive hover:bg-destructive/10 rounded-lg transition-colors"
            >
              Wipe
            </button>
          </SettingsRow>
          <SettingsRow label="Wipe vault" description="Delete all encrypted vault data (.enc files). Cannot be recovered.">
            <button
              onClick={async () => {
                if (!confirm('Delete all vault data? All encrypted entries will be permanently lost.')) return
                const r = await window.api?.settings.wipeVault()
                if (r?.success) alert('Vault wiped.')
                else alert('Error: ' + r?.error)
              }}
              className="text-xs px-3 py-1.5 border border-destructive/50 text-destructive hover:bg-destructive/10 rounded-lg transition-colors"
            >
              Wipe vault
            </button>
          </SettingsRow>
        </div>
      </div>
    </div>
  )
}

function SettingsSection({ icon, title, children }: { icon: React.ReactNode; title: string; children: React.ReactNode }): JSX.Element {
  return (
    <div className="mb-8">
      <h2 className="text-sm font-semibold text-foreground flex items-center gap-2 mb-3">
        {icon} {title}
      </h2>
      <div className="bg-card border border-border rounded-xl divide-y divide-border">
        {children}
      </div>
    </div>
  )
}

function SettingsRow({ label, description, children }: { label: string; description: string; children: React.ReactNode }): JSX.Element {
  return (
    <div className="flex items-center justify-between px-4 py-3.5">
      <div>
        <p className="text-sm text-foreground font-medium">{label}</p>
        <p className="text-xs text-muted-foreground mt-0.5">{description}</p>
      </div>
      <div className="ml-4 shrink-0">{children}</div>
    </div>
  )
}

function Toggle({ enabled, onChange }: { enabled: boolean; onChange: (v: boolean) => void }): JSX.Element {
  return (
    <button
      onClick={() => onChange(!enabled)}
      className={cn(
        'w-10 h-5 rounded-full transition-colors relative',
        enabled ? 'bg-primary' : 'bg-secondary'
      )}
    >
      <span className={cn(
        'absolute top-0.5 w-4 h-4 rounded-full bg-white transition-transform shadow-sm',
        enabled ? 'translate-x-5' : 'translate-x-0.5'
      )} />
    </button>
  )
}
