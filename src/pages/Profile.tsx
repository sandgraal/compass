import { IdCard } from 'lucide-react'
import { useEffect, useState } from 'react'

// The static identity snapshot — fed by the Facebook profile recognizer into
// `snapshot_facts` (category `profile`): name, username, registration date, emails,
// phones, birthday, gender, family. It's who the export says you ARE, not what you
// did. Drop `personal_information/profile_information/profile_information.html` from
// your Facebook export on the Timeline. Local-only — nothing leaves your machine.

export default function Profile(): JSX.Element {
  const [facts, setFacts] = useState<SnapshotFactRecord[]>([])
  const [loaded, setLoaded] = useState(false)

  useEffect(() => {
    if (!window.api) return
    window.api.snapshot
      .list({ source: 'facebook', category: 'profile' })
      .then(setFacts)
      .finally(() => setLoaded(true))
  }, [])

  return (
    <div className="p-8 pt-14 max-w-2xl mx-auto animate-fade-in">
      <div className="mb-6">
        <div className="flex items-center gap-2.5 mb-1">
          <IdCard size={22} className="text-primary" />
          <h1 className="text-2xl font-semibold text-foreground">Profile</h1>
        </div>
        <p className="text-sm text-muted-foreground">
          {facts.length > 0
            ? 'The identity details your data exports hold about you'
            : 'Who your exports say you are — drop your Facebook profile file on the Timeline'}
        </p>
      </div>

      {loaded && facts.length === 0 && (
        <div className="rounded-xl border border-dashed border-border bg-card/40 px-6 py-10 text-center">
          <IdCard size={22} className="mx-auto mb-2 text-muted-foreground" />
          <p className="text-sm text-foreground font-medium">No profile data yet</p>
          <p className="text-xs text-muted-foreground mt-1 max-w-md mx-auto">
            From your Facebook "Download Your Information" export, drop{' '}
            <code className="text-foreground">profile_information.html</code> on the Timeline.
            Nothing leaves your machine.
          </p>
        </div>
      )}

      {facts.length > 0 && (
        <dl className="rounded-xl border border-border bg-card/40 divide-y divide-border">
          {facts.map((f) => (
            <div key={f.id} className="flex gap-4 px-4 py-3">
              <dt className="w-32 shrink-0 text-xs font-medium text-muted-foreground pt-0.5">
                {f.label}
              </dt>
              <dd className="flex-1 text-sm text-foreground break-words whitespace-pre-line">
                {f.value}
              </dd>
            </div>
          ))}
        </dl>
      )}
    </div>
  )
}
