import { BrowserWindow } from 'electron'
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import type { StaffAccessState } from '../shared/domain.js'
import { staffHasPermission } from '../shared/staffPermissions.js'
import type { ClaimedPrintJob, PrinterSettings, PrintJobSummary, PrintKind, PrintRequest, OrderPrintDetails } from '../shared/printing.js'
import { DesktopPrintWorker, PrintOutcomeUnknown, type PrintAttempt } from './services/desktopPrintWorker.cjs'
import { printDocument } from './services/printDocument.cjs'
import type { posChannels } from '../shared/posChannels.js'

const schema = z.object({ bill: z.string().max(250), kot: z.string().max(250), restaurant: z.string().trim().max(120), branch: z.string().trim().max(120) }).strict()
type Invoke = (channel: typeof posChannels[keyof typeof posChannels], senderId: number, input?: unknown) => unknown
export function desktopPrinting(window: BrowserWindow, directory: string, scope: string, invoke: Invoke) {
  mkdirSync(directory, { recursive: true })
  const key = createHash('sha256').update(scope).digest('hex').slice(0, 24)
  const path = join(directory, `printing-${key}.json`)
  const id = window.webContents.id
  let state: { deviceId: string; settings: PrinterSettings; pending: PrintAttempt | null; requests: Record<string, PrintRequest> } = {
    deviceId: randomUUID(), settings: { bill: '', kot: '', restaurant: '', branch: '' }, pending: null, requests: {},
  }
  if (existsSync(path)) {
    const saved = JSON.parse(readFileSync(path, 'utf8')) as typeof state
    state = { deviceId: z.string().uuid().parse(saved.deviceId), settings: schema.parse(saved.settings), pending: saved.pending ?? null, requests: saved.requests ?? {} }
  }
  const persist = () => { writeFileSync(path + '.tmp', JSON.stringify(state)); renameSync(path + '.tmp', path) }
  persist()
  let kinds: PrintKind[] = []
  let checking = false
  let closed = false
  let accessError = ''
  async function access() {
    const result = await invoke('staff:get-access-state', id) as StaffAccessState
    if (!result.staff || (!staffHasPermission(result.staff.role, 'pos:access') && !staffHasPermission(result.staff.role, 'kitchen:operate'))) throw new Error('Sign in as cashier, manager, owner, or kitchen staff to operate printers.')
    return result.staff
  }
  const worker = new DesktopPrintWorker({
    deviceId: state.deviceId,
    invoke: async (channel, input) => invoke(channel, id, input),
    kinds: () => kinds,
    load: () => state.pending,
    save: attempt => { state.pending = attempt; persist() },
    spool: async (job: ClaimedPrintJob) => {
      const deviceName = state.settings[job.kind]
      const printers = await window.webContents.getPrintersAsync()
      if (!deviceName || !printers.some(printer => printer.name === deviceName)) throw new Error('Configured printer is unavailable. Check Desktop printers settings.')
      const page = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } })
      page.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
      page.webContents.on('will-navigate', event => event.preventDefault())
      try {
        await page.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(printDocument(job.kind, job.document, state.settings))}`)
        await new Promise<void>((resolve, reject) => {
          const timeout = setTimeout(() => reject(new PrintOutcomeUnknown('Printer did not confirm submission. Check paper before requesting a copy.')), 60_000)
          page.webContents.print({ silent: true, deviceName, printBackground: true, color: false, usePrinterDefaultPageSize: true }, (success, reason) => {
            clearTimeout(timeout)
            if (success) resolve(); else reject(new Error(reason || 'Printer submission failed.'))
          })
        })
      } finally { if (!page.isDestroyed()) page.destroy() }
    },
  })
  async function poll() {
    if (checking || closed) return
    checking = true
    try {
      const staff = await access()
      kinds = (['bill', 'kot'] as const).filter(kind => state.settings[kind] && (staffHasPermission(staff.role, 'pos:access') || kind === 'kot'))
      accessError = ''
      await worker.tick()
    } catch (cause) { accessError = cause instanceof Error ? cause.message : 'Sign in to start desktop printing.' }
    finally { checking = false }
  }
  const timer = setInterval(() => void poll(), 2000)
  window.webContents.once('destroyed', () => { closed = true; clearInterval(timer) })
  return {
    async getOrderDetails(raw: unknown) {
      const staff = await access()
      const orderId = z.string().uuid().parse(raw)
      const result = await invoke('print:details', id, orderId) as Omit<OrderPrintDetails, 'pendingRequests'>
      return { ...result, pendingRequests: Object.entries(state.requests).filter(([key, input]) => key.startsWith(`${staff.id}|`) && input.orderId === orderId).map(([, input]) => input) }
    },
    async request(raw: unknown) {
      const staff = await access()
      if (!staffHasPermission(staff.role, 'pos:access')) throw new Error('Sign in as cashier, manager, or owner to request table printing.')
      const input = z.object({ orderId: z.string().uuid(), kind: z.enum(['bill', 'kot']), ticketId: z.string().uuid().optional() }).strict().parse(raw)
      // Canonical keys retain the same request ID after a timeout or desktop restart.
      const key = `${staff.id}|${JSON.stringify({ orderId: input.orderId, kind: input.kind, ticketId: input.ticketId ?? null })}`
      const request = state.requests[key] ?? { ...input, requestId: randomUUID() }
      state.requests[key] = request; persist()
      const result = await invoke('print:request-pos', id, request) as PrintJobSummary
      delete state.requests[key]
      try { persist() } catch (cause) { state.requests[key] = request; throw cause }
      void poll()
      return result
    },
    async getState() {
      await access()
      accessError = ''
      return { settings: state.settings, printers: (await window.webContents.getPrintersAsync()).map(({ name, displayName }) => ({ name, displayName })), jobs: await invoke('print:list', id) as PrintJobSummary[], error: worker.error || accessError }
    },
    async saveSettings(raw: unknown) {
      await access()
      const settings = schema.parse(raw)
      const printers = await window.webContents.getPrintersAsync()
      for (const name of [settings.bill, settings.kot]) if (name && !printers.some(printer => printer.name === name)) throw new Error('Select an installed printer.')
      state.settings = settings; persist(); void poll()
    },
  }
}
