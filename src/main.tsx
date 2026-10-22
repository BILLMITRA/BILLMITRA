import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './styles/global.css'
import BranchGateway from './pages/BranchGateway.tsx'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BranchGateway />
  </StrictMode>,
)
