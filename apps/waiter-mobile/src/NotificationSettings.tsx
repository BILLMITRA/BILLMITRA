import { useState } from 'react'
import { Alert, Pressable, StyleSheet, Text, View } from 'react-native'
import * as DocumentPicker from 'expo-document-picker'
import * as SecureStore from 'expo-secure-store'
import { File, Paths } from 'expo-file-system'

export type AlertSound = { uri: string; name: string } | null
const soundKey = 'billmitra-staff-alert-sound'

export async function loadAlertSound(): Promise<AlertSound> {
  try {
    const raw = await SecureStore.getItemAsync(soundKey)
    if (!raw) return null
    const saved = JSON.parse(raw) as AlertSound
    return saved?.uri && new File(saved.uri).exists ? saved : null
  } catch { return null }
}

export function NotificationSettings({ sound, onChange, onPreview }: { sound: AlertSound; onChange: (sound: AlertSound) => void; onPreview: () => void }) {
  const [busy, setBusy] = useState(false)
  async function chooseSound() {
    setBusy(true)
    try {
      const result = await DocumentPicker.getDocumentAsync({ type: 'audio/*', copyToCacheDirectory: true, multiple: false })
      if (result.canceled) return
      const asset = result.assets[0]
      if (asset.size && asset.size > 10 * 1024 * 1024) throw new Error('Choose an audio file under 10 MB.')
      const extension = asset.name.match(/\.[a-z0-9]{1,6}$/i)?.[0] ?? '.audio'
      const destination = new File(Paths.document, `staff-alert-${Date.now()}${extension}`)
      new File(asset.uri).copy(destination)
      const saved = { uri: destination.uri, name: asset.name }
      await SecureStore.setItemAsync(soundKey, JSON.stringify(saved)); onChange(saved)
    } catch (cause) { Alert.alert('Cannot use this sound', cause instanceof Error ? cause.message : 'Choose an audio file stored on this device.') }
    finally { setBusy(false) }
  }
  async function reset() {
    try { await SecureStore.deleteItemAsync(soundKey); onChange(null) }
    catch { Alert.alert('Could not reset sound', 'Please try again.') }
  }
  return <View style={styles.panel}><Text style={styles.title}>Notification sound</Text>
    <Text style={styles.description}>Current: {sound?.name ?? 'BillMitra chime'}</Text>
    <Text style={styles.description}>Choose an audio file from your phone. Sound and vibration follow your phone settings.</Text>
    <View style={styles.row}><Button label={busy ? 'Opening…' : 'Choose audio'} disabled={busy} onPress={() => void chooseSound()} /><Button label="Play sample" disabled={busy} onPress={onPreview} /><Button label="Use default" disabled={busy || !sound} onPress={() => void reset()} /></View>
  </View>
}
function Button({ label, disabled, onPress }: { label: string; disabled?: boolean; onPress: () => void }) {
  return <Pressable accessibilityRole="button" disabled={disabled} onPress={onPress} style={[styles.button, disabled && { opacity: .5 }]}><Text style={styles.buttonText}>{label}</Text></Pressable>
}
const styles = StyleSheet.create({
  panel: { padding: 14, borderWidth: 1, borderColor: '#e5c9c6', borderRadius: 10, backgroundColor: '#fff', gap: 8 },
  title: { color: '#302525', fontWeight: '700', fontSize: 17 }, description: { color: '#756b69', fontSize: 13 },
  row: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 }, button: { padding: 10, minHeight: 44, justifyContent: 'center', borderWidth: 1, borderColor: '#e5c9c6', borderRadius: 8 }, buttonText: { color: '#b4342f', fontWeight: '700' },
})
