export function restoreEnvVar(name: string, originalValue: string | undefined): void {
  if (originalValue === undefined) {
    delete process.env[name]
    return
  }

  process.env[name] = originalValue
}
