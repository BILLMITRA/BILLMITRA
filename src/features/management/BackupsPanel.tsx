import { useEffect, useState } from 'react'
import type { BackupInfo } from '../../../shared/restaurant'
import { createBackup, listBackups } from '../../services/pos'

export function BackupsPanel() {
  const [backups, setBackups] = useState<BackupInfo[]>([])
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  useEffect(() => { let active = true; listBackups().then(value => { if (active) setBackups(value) }).catch(cause => { if (active) setError(String(cause)) }); return () => { active = false } }, [])
  async function create() {
    setBusy(true); setError('')
    try { await createBackup(); setBackups(await listBackups()) } catch (cause) { setError(cause instanceof Error ? cause.message : 'Backup failed.') } finally { setBusy(false) }
  }
  return <section className="management-card"><h2>Database backups</h2><p>A verified database snapshot is created before startup changes to an existing database and every 24 hours while the application is running. Backups are saved in the backups folder beside this installation’s database. Browser backups live on the server.</p><p>Keep a separate copy outside this computer. Restoring requires stopping the application and running the documented restore command. Existing data is retained in a recovery file during restore.</p><button disabled={busy} onClick={() => void create()}>{busy ? 'Creating backup…' : 'Create backup now'}</button>{error && <p role="alert" className="management-error">{error}</p>}<div className="management-table-wrap"><table><thead><tr><th>Created</th><th>File</th><th>Size</th></tr></thead><tbody>{backups.map(backup => <tr key={backup.name}><td>{new Date(backup.createdAt).toLocaleString()}</td><td>{backup.name}</td><td>{(backup.sizeBytes / 1024).toFixed(1)} KB</td></tr>)}</tbody></table></div></section>
}
