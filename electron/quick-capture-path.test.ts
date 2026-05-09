import { describe, expect, it } from 'vitest'
import {
  QUICK_CAPTURE_HTML_ENTRY,
  getQuickCaptureHtmlPath,
  getQuickCaptureHtmlUrl
} from './quick-capture-path'

describe('quick capture path helpers', () => {
  it('uses the renderer entry path emitted by vite in production', () => {
    expect(getQuickCaptureHtmlPath('/tmp/Compass.app/Contents/Resources/app.asar/out/main')).toBe(
      '/tmp/Compass.app/Contents/Resources/app.asar/out/renderer/src/quickCapture/index.html'
    )
  })

  it('builds the dev-server URL without duplicating or dropping slashes', () => {
    expect(getQuickCaptureHtmlUrl('http://127.0.0.1:5173')).toBe(
      'http://127.0.0.1:5173/src/quickCapture/index.html'
    )
    expect(getQuickCaptureHtmlUrl('http://127.0.0.1:5173/')).toBe(
      'http://127.0.0.1:5173/src/quickCapture/index.html'
    )
  })

  it('keeps the vite input and packaged HTML path anchored to the source entry', () => {
    expect(QUICK_CAPTURE_HTML_ENTRY).toBe('src/quickCapture/index.html')
  })
})
