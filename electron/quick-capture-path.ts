import { join } from 'node:path'

export const QUICK_CAPTURE_HTML_ENTRY = 'src/quickCapture/index.html'

export function getQuickCaptureHtmlUrl(rendererUrl: string): string {
  const baseUrl = rendererUrl.endsWith('/') ? rendererUrl : `${rendererUrl}/`
  return new URL(QUICK_CAPTURE_HTML_ENTRY, baseUrl).toString()
}

export function getQuickCaptureHtmlPath(dirname: string): string {
  return join(dirname, '../renderer', QUICK_CAPTURE_HTML_ENTRY)
}
