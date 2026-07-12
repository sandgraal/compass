/**
 * Compass mobile companion (Phase 4c) — a READ-ONLY viewer over the device-sync
 * encrypted snapshot (see `electron/integrations/device-sync.ts` + `relay/src/sync.ts`).
 *
 * Flow: Setup (relay URL + device token + the SAME sync passphrase as the
 * desktop) → pull the ciphertext blob → decrypt ON-DEVICE (pure-JS scrypt +
 * AES-GCM; the passphrase/keys never leave the phone) → render a summary +
 * timeline. The decrypted bundle lives in MEMORY ONLY — nothing plaintext is
 * ever written to disk; the passphrase itself sits in the OS keychain
 * (expo-secure-store). Quick-capture / write-back is the explicitly deferred
 * next slice.
 */

import AsyncStorage from '@react-native-async-storage/async-storage'
import * as SecureStore from 'expo-secure-store'
import { StatusBar } from 'expo-status-bar'
import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  SafeAreaView,
  StyleSheet,
  Text,
  TextInput,
  View
} from 'react-native'
import { fetchSnapshotBlob } from './src/lib/relay'
import {
  type SnapshotSummary,
  type TimelineItem,
  snapshotSummary,
  timelineItems
} from './src/lib/selectors'
import { decryptSnapshot, deriveGroupId } from './src/lib/snapshot'

const RELAY_URL_KEY = 'compass.relayUrl'
const TOKEN_KEY = 'compass.deviceToken'
const PASSPHRASE_KEY = 'compass.syncPassphrase' // SecureStore (OS keychain)

type Config = { relayUrl: string; deviceToken: string; passphrase: string }

export default function App(): JSX.Element {
  const [config, setConfig] = useState<Config | null | 'loading'>('loading')

  useEffect(() => {
    ;(async () => {
      const [relayUrl, deviceToken, passphrase] = await Promise.all([
        AsyncStorage.getItem(RELAY_URL_KEY),
        SecureStore.getItemAsync(TOKEN_KEY),
        SecureStore.getItemAsync(PASSPHRASE_KEY)
      ])
      setConfig(
        relayUrl && deviceToken && passphrase ? { relayUrl, deviceToken, passphrase } : null
      )
    })()
  }, [])

  async function saveConfig(next: Config): Promise<void> {
    await Promise.all([
      AsyncStorage.setItem(RELAY_URL_KEY, next.relayUrl),
      SecureStore.setItemAsync(TOKEN_KEY, next.deviceToken),
      SecureStore.setItemAsync(PASSPHRASE_KEY, next.passphrase)
    ])
    setConfig(next)
  }

  async function forget(): Promise<void> {
    await Promise.all([
      AsyncStorage.removeItem(RELAY_URL_KEY),
      SecureStore.deleteItemAsync(TOKEN_KEY),
      SecureStore.deleteItemAsync(PASSPHRASE_KEY)
    ])
    setConfig(null)
  }

  return (
    <SafeAreaView style={styles.root}>
      <StatusBar style="light" />
      {config === 'loading' ? (
        <View style={styles.center}>
          <ActivityIndicator color="#8b8cf8" />
        </View>
      ) : config === null ? (
        <SetupScreen onSave={saveConfig} />
      ) : (
        <ViewerScreen config={config} onForget={forget} />
      )}
    </SafeAreaView>
  )
}

function SetupScreen({ onSave }: { onSave: (c: Config) => Promise<void> }): JSX.Element {
  const [relayUrl, setRelayUrl] = useState('https://relay.compass.app')
  const [deviceToken, setDeviceToken] = useState('')
  const [passphrase, setPassphrase] = useState('')
  const [busy, setBusy] = useState(false)
  const canSave =
    relayUrl.trim().length > 0 &&
    deviceToken.trim().length > 0 &&
    passphrase.trim().length >= 12

  return (
    <View style={styles.setup}>
      <Text style={styles.title}>Compass</Text>
      <Text style={styles.subtitle}>
        Read-only companion. Enter your relay, a device token the relay allows, and the SAME sync
        passphrase you set on your desktop — everything decrypts on this phone; the relay only ever
        sees ciphertext.
      </Text>
      <TextInput
        style={styles.input}
        value={relayUrl}
        onChangeText={setRelayUrl}
        placeholder="Relay URL"
        placeholderTextColor="#5a5d6e"
        autoCapitalize="none"
        autoCorrect={false}
      />
      <TextInput
        style={styles.input}
        value={deviceToken}
        onChangeText={setDeviceToken}
        placeholder="Device token"
        placeholderTextColor="#5a5d6e"
        autoCapitalize="none"
        autoCorrect={false}
      />
      <TextInput
        style={styles.input}
        value={passphrase}
        onChangeText={setPassphrase}
        placeholder="Sync passphrase (min 12 chars)"
        placeholderTextColor="#5a5d6e"
        secureTextEntry
      />
      <Pressable
        style={[styles.button, !canSave && styles.buttonDisabled]}
        disabled={!canSave || busy}
        onPress={async () => {
          setBusy(true)
          try {
            await onSave({
              relayUrl: relayUrl.trim(),
              deviceToken: deviceToken.trim(),
              passphrase: passphrase.trim()
            })
          } finally {
            setBusy(false)
          }
        }}
      >
        <Text style={styles.buttonText}>{busy ? 'Saving…' : 'Connect'}</Text>
      </Pressable>
    </View>
  )
}

function ViewerScreen({
  config,
  onForget
}: { config: Config; onForget: () => Promise<void> }): JSX.Element {
  const [state, setState] = useState<
    | { phase: 'idle' }
    | { phase: 'syncing'; step: string }
    | { phase: 'ready'; summary: SnapshotSummary; items: TimelineItem[] }
    | { phase: 'error'; message: string }
  >({ phase: 'idle' })

  const sync = useCallback(async () => {
    try {
      setState({ phase: 'syncing', step: 'Deriving sync key…' })
      // scrypt in pure JS takes a moment on a phone — yield to paint first.
      await new Promise((r) => setTimeout(r, 30))
      const groupId = deriveGroupId(config.passphrase)
      setState({ phase: 'syncing', step: 'Downloading snapshot…' })
      const { blob } = await fetchSnapshotBlob(config.relayUrl, config.deviceToken, groupId)
      setState({ phase: 'syncing', step: 'Decrypting on device…' })
      await new Promise((r) => setTimeout(r, 30))
      const bundle = decryptSnapshot(blob, config.passphrase)
      setState({
        phase: 'ready',
        summary: snapshotSummary(bundle),
        items: timelineItems(bundle, 500)
      })
    } catch (err) {
      setState({ phase: 'error', message: err instanceof Error ? err.message : String(err) })
    }
  }, [config])

  useEffect(() => {
    void sync()
  }, [sync])

  const header = useMemo(() => {
    if (state.phase !== 'ready') return null
    const s = state.summary
    return (
      <View style={styles.summary}>
        <Text style={styles.summaryTitle}>
          {s.recordCount.toLocaleString()} records · snapshot {s.exportedAt.slice(0, 10)}
        </Text>
        <Text style={styles.summaryLine}>
          {s.taskCount} tasks · {s.habitCount} habits · {s.contactCount} contacts ·{' '}
          {s.documentCount} documents
        </Text>
        <View style={styles.chips}>
          {s.sourceCounts.slice(0, 8).map((c) => (
            <Text key={c.source} style={styles.chip}>
              {c.source} {c.count}
            </Text>
          ))}
        </View>
      </View>
    )
  }, [state])

  return (
    <View style={styles.viewer}>
      <View style={styles.topBar}>
        <Text style={styles.title}>Compass</Text>
        <View style={styles.topActions}>
          <Pressable onPress={() => void sync()}>
            <Text style={styles.link}>Sync</Text>
          </Pressable>
          <Pressable onPress={() => void onForget()}>
            <Text style={styles.linkMuted}>Forget</Text>
          </Pressable>
        </View>
      </View>

      {state.phase === 'syncing' && (
        <View style={styles.center}>
          <ActivityIndicator color="#8b8cf8" />
          <Text style={styles.mutedText}>{state.step}</Text>
        </View>
      )}
      {state.phase === 'error' && (
        <View style={styles.center}>
          <Text style={styles.errorText}>{state.message}</Text>
          <Pressable style={styles.button} onPress={() => void sync()}>
            <Text style={styles.buttonText}>Retry</Text>
          </Pressable>
        </View>
      )}
      {state.phase === 'ready' && (
        <FlatList
          data={state.items}
          keyExtractor={(item) => String(item.id)}
          ListHeaderComponent={header}
          renderItem={({ item }) => (
            <View style={styles.row}>
              <View style={styles.rowHead}>
                <Text style={styles.rowSource}>{item.source}</Text>
                <Text style={styles.rowDate}>
                  {item.occurredAt ? new Date(item.occurredAt).toLocaleDateString() : ''}
                </Text>
              </View>
              <Text style={styles.rowTitle} numberOfLines={2}>
                {item.title}
              </Text>
              {item.body ? (
                <Text style={styles.rowBody} numberOfLines={1}>
                  {item.body}
                </Text>
              ) : null}
            </View>
          )}
        />
      )}
    </View>
  )
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#0f1117' },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 12, padding: 24 },
  setup: { flex: 1, padding: 24, justifyContent: 'center', gap: 12 },
  title: { color: '#e7e9f4', fontSize: 22, fontWeight: '600' },
  subtitle: { color: '#9aa0b5', fontSize: 13, lineHeight: 19, marginBottom: 8 },
  input: {
    backgroundColor: '#1a1d29',
    borderColor: '#2a2e3f',
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 12,
    color: '#e7e9f4',
    fontSize: 14
  },
  button: {
    backgroundColor: '#8b8cf833',
    borderRadius: 10,
    paddingVertical: 12,
    alignItems: 'center',
    marginTop: 4
  },
  buttonDisabled: { opacity: 0.4 },
  buttonText: { color: '#a5a6ff', fontSize: 14, fontWeight: '600' },
  viewer: { flex: 1 },
  topBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 12
  },
  topActions: { flexDirection: 'row', gap: 18 },
  link: { color: '#a5a6ff', fontSize: 14, fontWeight: '600' },
  linkMuted: { color: '#5a5d6e', fontSize: 14 },
  mutedText: { color: '#9aa0b5', fontSize: 13 },
  errorText: { color: '#f89ba0', fontSize: 13, textAlign: 'center' },
  summary: {
    marginHorizontal: 16,
    marginBottom: 10,
    padding: 14,
    backgroundColor: '#1a1d29',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#2a2e3f',
    gap: 6
  },
  summaryTitle: { color: '#e7e9f4', fontSize: 14, fontWeight: '600' },
  summaryLine: { color: '#9aa0b5', fontSize: 12 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 4 },
  chip: {
    color: '#9aa0b5',
    fontSize: 11,
    backgroundColor: '#232738',
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 6,
    overflow: 'hidden'
  },
  row: {
    marginHorizontal: 16,
    marginBottom: 8,
    padding: 12,
    backgroundColor: '#161927',
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#232738',
    gap: 3
  },
  rowHead: { flexDirection: 'row', justifyContent: 'space-between' },
  rowSource: { color: '#8b8cf8', fontSize: 11, fontWeight: '600' },
  rowDate: { color: '#5a5d6e', fontSize: 11 },
  rowTitle: { color: '#e7e9f4', fontSize: 14 },
  rowBody: { color: '#9aa0b5', fontSize: 12 }
})
