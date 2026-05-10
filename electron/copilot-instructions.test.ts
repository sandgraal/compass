import { readFileSync, readdirSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'

const REPO_ROOT = join(__dirname, '..')
const INSTRUCTIONS_DIR = join(REPO_ROOT, '.github', 'instructions')
const REPO_WIDE_INSTRUCTIONS = join(REPO_ROOT, '.github', 'copilot-instructions.md')
const COPILOT_FILE_LIMIT = 4000

function getPathScopedInstructionFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = join(dir, entry.name)
    if (entry.isDirectory()) {
      return getPathScopedInstructionFiles(entryPath)
    }

    return entry.name.endsWith('.instructions.md') ? [entryPath] : []
  })
}

function getCopilotInstructionFiles(): string[] {
  return [REPO_WIDE_INSTRUCTIONS, ...getPathScopedInstructionFiles(INSTRUCTIONS_DIR)]
}

describe('Copilot review instructions', () => {
  it("keeps every custom instruction file within GitHub's 4,000-character limit", () => {
    for (const file of getCopilotInstructionFiles()) {
      const contents = readFileSync(file, 'utf8')
      expect(contents.length, `${relative(REPO_ROOT, file)} is too long`).toBeLessThanOrEqual(
        COPILOT_FILE_LIMIT
      )
    }
  })

  it('keeps review-critical guidance covered across the instruction set', () => {
    const combinedInstructions = getCopilotInstructionFiles()
      .map((file) => readFileSync(file, 'utf8'))
      .join('\n')

    expect(combinedInstructions).toMatch(/must-fix/i)
    expect(combinedInstructions).toMatch(/nice-to-have/i)
    expect(combinedInstructions).toMatch(/aria-label/i)
    expect(combinedInstructions).toMatch(/test plan/i)
  })
})
