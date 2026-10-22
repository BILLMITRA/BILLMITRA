import { useEffect, useState } from 'react'
import type { BranchInfo } from '../../shared/restaurant'
import { selectBranchId, selectedBranchId } from '../services/branchContext'
import { logoutStaff } from '../services/pos'
import CashierPage from './CashierPage'
import '../features/management/management.css'
import branchDefaults from '../../branches.json'

export default function BranchGateway() {
  const [branches, setBranches] = useState<BranchInfo[] | null>(null)
  const [selected, setSelected] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    if (window.pos) return
    let active = true
    fetch('/api/branches', { credentials: 'same-origin' }).then(async response => {
      if (!response.ok) throw new Error('The restaurant branch server is unavailable.')
      const data = await response.json() as { branches: BranchInfo[] }
      if (!Array.isArray(data.branches) || !data.branches.length) throw new Error('No restaurant branches are configured.')
      if (!active) return
      setBranches(data.branches)
      const previous = selectedBranchId()
      const id = data.branches.some(branch => branch.id === previous) ? previous : data.branches.length === 1 ? data.branches[0].id : ''
      selectBranchId(id); setSelected(id)
    }).catch(cause => { if (active) setError(cause instanceof Error ? cause.message : 'Unable to load branches.') })
    return () => { active = false }
  }, [])
  if (window.pos) return <CashierPage branchName={branchDefaults[0]?.name ?? 'Desktop restaurant'} />
  async function changeBranch() {
    setBusy(true)
    try { await logoutStaff(); selectBranchId(''); setSelected(''); setError('') }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Unable to sign out of this branch.') }
    finally { setBusy(false) }
  }
  if (selected && branches) return <><CashierPage key={selected} branchName={branches.find(branch => branch.id === selected)?.name} onChangeBranch={branches.length > 1 ? () => { if (!busy) void changeBranch() } : undefined} />{branches.length > 1 && <button className="branch-switch-button" disabled={busy} onClick={() => void changeBranch()}>Switch branch</button>}{error && <div className="branch-error" role="alert">{error}</div>}</>
  return <main className="management-shell"><header className="management-header"><div><span>BillMitra</span><h1>Select your restaurant branch</h1><p>Sign in separately for each branch. Each branch keeps its own accounts, bills and stock.</p></div></header>
    {error && <p className="management-error" role="alert">{error}</p>}
    {!branches && !error && <p>Loading branches…</p>}
    <div className="management-kitchen-grid">{branches?.map(branch => <button className="management-card" key={branch.id} onClick={() => { selectBranchId(branch.id); setSelected(branch.id) }}><h2>{branch.name}</h2><span>Open branch</span></button>)}</div>
    {error && !branches && <button onClick={() => window.location.reload()}>Retry connection</button>}
  </main>
}
