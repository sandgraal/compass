import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { QuickCapture } from './QuickCapture'

const root = document.getElementById('root')
if (!root) throw new Error('No root element found')

createRoot(root).render(
  <StrictMode>
    <QuickCapture />
  </StrictMode>
)
