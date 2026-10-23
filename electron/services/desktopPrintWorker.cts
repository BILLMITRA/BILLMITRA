import type { ClaimedPrintJob, PrintKind, PrintStatus } from '../../shared/printing.js'

export interface PrintAttempt { id: string; claimToken: string; status: 'attempting' | 'submitted' | 'failed' | 'unknown'; error: string }
export class PrintOutcomeUnknown extends Error {}
export interface WorkerDependencies {
  deviceId: string
  invoke: (channel: 'print:claim' | 'print:finish', input?: unknown) => Promise<unknown>
  kinds: () => PrintKind[]
  spool: (job: ClaimedPrintJob) => Promise<void>
  load: () => PrintAttempt | null
  save: (attempt: PrintAttempt | null) => void
}
export class DesktopPrintWorker {
  private running = false
  error = ''
  constructor(private dependencies: WorkerDependencies) {}
  async tick() {
    if (this.running) return
    this.running = true
    const d = this.dependencies
    try {
      let attempt = d.load()
      if (!attempt) {
        const kinds = d.kinds()
        if (!kinds.length) return
        const job = await d.invoke('print:claim', { deviceId: d.deviceId, kinds }) as ClaimedPrintJob | null
        if (!job) { this.error = ''; return }
        attempt = { id: job.id, claimToken: job.claimToken, status: 'attempting', error: '' }
        d.save(attempt) // Durable marker before touching the OS spooler.
        try { await d.spool(job); attempt.status = 'submitted' }
        catch (cause) { attempt.status = cause instanceof PrintOutcomeUnknown ? 'unknown' : 'failed'; attempt.error = cause instanceof Error ? cause.message.slice(0, 500) : 'Printer submission failed.' }
        d.save(attempt)
      } else if (attempt.status === 'attempting') {
        attempt.status = 'unknown'
        attempt.error = 'Desktop restarted during printing. Check paper before requesting a copy.'
        d.save(attempt)
      }
      await d.invoke('print:finish', { ...attempt, status: attempt.status as PrintStatus, deviceId: d.deviceId })
      d.save(null)
      this.error = attempt.status === 'submitted' ? '' : attempt.error
    } catch (cause) { this.error = cause instanceof Error ? cause.message : 'Desktop print connection failed.' }
    finally { this.running = false }
  }
}
