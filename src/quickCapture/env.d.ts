/**
 * Type declarations for the quick-capture popover window.
 * Only window.quickCaptureApi is available here — window.api is NOT exposed.
 */
declare interface Window {
  quickCaptureApi: {
    submit(
      kind: 'task' | 'note' | 'expense',
      text: string
    ): Promise<{ success: boolean; error?: string }>
    hide(): void
  }
}
