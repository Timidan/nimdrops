import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { startSurfaceGuard } from './ui/surface'

/**
 * Before React renders anything.
 *
 * The glass and the drift are settled on the document element up front so a
 * device that cannot afford `backdrop-filter` never paints a frame of it, and
 * so the field and the sheet — different components, different parts of the
 * tree — cannot disagree about which surface they are on.
 */
startSurfaceGuard()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
