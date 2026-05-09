/**
 * Type declarations for the quick-capture popover window.
 * Only window.quickCaptureApi is available here — window.api is NOT exposed.
 */
declare interface Window {
  quickCaptureApi: {
    quickAdd(title: string): Promise<{ success: boolean; error?: string }>
    hide(): void
  }
}
