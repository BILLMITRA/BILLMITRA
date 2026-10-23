import { useEffect, useState } from 'react'
import type { DesktopPrinting, PrinterSettings, PrinterState } from '../../../shared/printing'

declare global { interface Window { desktopPrinting?: DesktopPrinting } }

export function DesktopPrinters() {
  const bridge = window.desktopPrinting
  const [open, setOpen] = useState(false)
  const [state, setState] = useState<PrinterState | null>(null)
  const [settings, setSettings] = useState<PrinterSettings>({ bill: '', kot: '', restaurant: '', branch: '' })
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState('')
  useEffect(() => {
    if (!open || !bridge) return
    let active = true
    let initial = true
    const refresh = async () => {
      try {
        const value = await bridge.getState()
        if (active) { setState(value); if (initial) { setSettings(value.settings); initial = false } setError('') }
      } catch (cause) { if (active) setError(cause instanceof Error ? cause.message : 'Cannot read printer settings.') }
    }
    void refresh(); const timer = setInterval(() => void refresh(), 3000)
    return () => { active = false; clearInterval(timer) }
  }, [open, bridge])
  if (!bridge) return null
  async function save() {
    setBusy(true); setError(''); setNotice('')
    try { await bridge!.saveSettings(settings); setNotice('Saved. This desktop will process phone requests while signed in.') }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Cannot save printers.') }
    finally { setBusy(false) }
  }
  return <><button className="staff-management-button" onClick={() => setOpen(true)}>Desktop printers</button>{open && <div className="print-backdrop"><section className="print-settings" role="dialog" aria-modal="true" aria-labelledby="printer-title"><header><h2 id="printer-title">Desktop printers</h2><button onClick={() => setOpen(false)} aria-label="Close printer settings">×</button></header>
    <p>Choose the cashier and kitchen printers installed on this computer. Keep BillMitra open and signed in to receive phone requests.</p>
    {(error || state?.error) && <p role="alert" className="management-error">{error || state?.error}</p>}{notice && <p role="status">{notice}</p>}
    <fieldset disabled={busy || !state}>{(['bill', 'kot'] as const).map(kind => <label key={kind}>{kind === 'bill' ? 'Cashier bill printer' : 'Kitchen KOT printer'}<select value={settings[kind]} onChange={event => setSettings({ ...settings, [kind]: event.target.value })}><option value="">Disabled — leave requests queued</option>{state?.printers.map(printer => <option key={printer.name} value={printer.name}>{printer.displayName || printer.name}</option>)}</select></label>)}
      <label>Restaurant name on paper<input maxLength={120} value={settings.restaurant} onChange={event => setSettings({ ...settings, restaurant: event.target.value })} /></label><label>Branch name on paper<input maxLength={120} value={settings.branch} onChange={event => setSettings({ ...settings, branch: event.target.value })} /></label><button onClick={() => void save()}>{busy ? 'Saving…' : 'Save printers'}</button></fieldset>
    <p>“Submitted” means Windows accepted the job. Check the printer for paper, errors, and completed output.</p>
    <h3>Recent requests</h3>{state?.jobs.length === 0 && <p>No print requests yet.</p>}<ul>{state?.jobs.slice(0, 20).map(job => <li key={job.id}><b>{job.kind.toUpperCase()}{job.copy ? ' copy' : ''}</b> · {job.status} · {job.createdAt} UTC{job.error && <p>{job.error}</p>}</li>)}</ul>
  </section></div>}</>
}
