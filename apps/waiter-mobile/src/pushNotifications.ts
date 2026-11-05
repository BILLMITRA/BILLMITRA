import { Platform } from 'react-native'
import Constants from 'expo-constants'
import * as Device from 'expo-device'
import * as Notifications from 'expo-notifications'
import { registerPushToken, type Session } from './api'

let visibleStaffChats = 0
export function trackVisibleStaffChat(): () => void {
  visibleStaffChats += 1
  return () => { visibleStaffChats = Math.max(0, visibleStaffChats - 1) }
}

export type StaffAlertType = 'staff-message' | 'kitchen-notice' | 'kitchen-order' | 'customer-waiting'

// Show the same compact Android heads-up banner while the app is open.
Notifications.setNotificationHandler({
  handleNotification: async notification => {
    const type = notification.request.content.data?.type
    const visible = type === 'customer-waiting' || type === 'kitchen-notice' || type === 'kitchen-order' || (type === 'staff-message' && visibleStaffChats === 0)
    return { shouldShowBanner: visible, shouldShowList: visible, shouldPlaySound: visible, shouldSetBadge: false }
  },
})

export async function showLocalStaffNotification(title: string, body: string, type: StaffAlertType, id: string): Promise<boolean> {
  if (Platform.OS !== 'android') return false
  const permission = await Notifications.getPermissionsAsync()
  if (!permission.granted) return false
  await Notifications.scheduleNotificationAsync({
    content: {
      title,
      body,
      data: { type, id },
      sound: 'waiting_chime.wav',
      ...(Platform.OS === 'android' ? { channelId: type === 'staff-message' ? 'billmitra_staff_messages' : 'staff-alerts' } : {}),
    },
    trigger: null,
  })
  return true
}

export async function registerStaffPushNotifications(session: Session): Promise<string | null> {
  if (Platform.OS !== 'android' || !Device.isDevice) return null

  await Notifications.setNotificationChannelAsync('staff-alerts', {
    name: 'Waiter and kitchen alerts',
    description: 'New orders, staff messages and customer waiting alerts',
    importance: Notifications.AndroidImportance.MAX,
    vibrationPattern: [0, 250, 150, 250],
    lightColor: '#B33732',
    sound: 'waiting_chime.wav',
  })
  await Notifications.setNotificationChannelAsync('billmitra_staff_messages', {
    name: 'Staff messages',
    description: 'Messages between Dining and Kitchen',
    importance: Notifications.AndroidImportance.MAX,
    vibrationPattern: [0, 250, 150, 250],
    lightColor: '#B33732',
    sound: 'waiting_chime.wav',
  })

  const current = await Notifications.getPermissionsAsync()
  const permission = current.granted ? current : await Notifications.requestPermissionsAsync()
  if (!permission.granted) return null

  const projectId = Constants.expoConfig?.extra?.eas?.projectId ?? Constants.easConfig?.projectId
  if (!projectId) throw new Error('Expo project ID is missing from the app configuration.')
  const token = (await Notifications.getExpoPushTokenAsync({ projectId })).data
  await registerPushToken(session, token)
  return token
}
