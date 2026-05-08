---
"compass": minor
---

Replace native `alert()` and `confirm()` dialogs with accessible toast and confirm-dialog primitives.

- New `ToastProvider` / `useToast()` hook: stacked toasts (success, error, info), auto-dismiss after 4 s, ARIA-live regions, click to close.
- New `ConfirmDialogProvider` / `useConfirm()` hook: Radix AlertDialog, Esc to cancel, Enter to confirm, destructive variant with red button.
- Both providers mounted at the `AppLayout` level — available app-wide.
- Replaced all 12 `alert()` / `confirm()` call sites across Settings, Vault, Integrations, and Daily.
- Removed the hand-rolled toast implementation from Vault (now uses the shared primitive).
