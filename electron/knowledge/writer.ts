import { existsSync, writeFileSync, readFileSync } from 'fs'
import { join } from 'path'

const STARTER_FILES: Record<string, string> = {
  'profile/personal.md': `# Personal Profile

> This file is auto-updated by Compass and can be edited by you at any time.

## Basic Information
- **Name:**
- **Date of Birth:**
- **Location:**
- **Phone:**
- **Email:**

## Emergency Contacts
- **Name / Relationship / Phone:**

## Notes
`,

  'profile/health.md': `# Health & Medical

> Sensitive details like insurance numbers belong in the Vault, not here.

## General Health
- **Blood Type:**
- **Allergies:**
- **Chronic Conditions:**

## Medications
| Medication | Dosage | Frequency |
|---|---|---|

## Providers
| Provider | Specialty | Phone |
|---|---|---|

## Notes
`,

  'profile/finances.md': `# Financial Overview

> Raw account numbers and credentials belong in the Vault (encrypted).
> This file holds summaries and context only.

## Accounts Summary
| Account | Institution | Type | Notes |
|---|---|---|---|

## Monthly Budget
- **Income:**
- **Fixed Expenses:**
- **Variable Expenses:**

## Financial Goals
-

## Notes
`,

  'profile/relationships.md': `# Relationships & Contacts

## Family
| Name | Relationship | Contact |
|---|---|---|

## Close Friends
| Name | Notes |
|---|---|

## Professional Network
| Name | Role / Company | Notes |
|---|---|---|

## Notes
`,

  'profile/goals.md': `# Goals & Aspirations

## This Year
-

## 3-Year Vision
-

## Long-Term (10+ Years)
-

## Current Focus Areas
1.
2.
3.

## Notes
`,

  'work/projects.md': `# Active Projects

| Project | Status | Deadline | Notes |
|---|---|---|---|

## On-Hold
| Project | Reason | Resume Date |
|---|---|---|

## Completed (Recent)
| Project | Completed |
|---|---|
`,

  'work/employers.md': `# Employment History

## Current Role
- **Company:**
- **Title:**
- **Start Date:**
- **Key Responsibilities:**

## Previous Roles
| Company | Title | Dates | Notes |
|---|---|---|---|
`,

  'work/github-summary.md': `# GitHub Summary

> Auto-updated by Compass on each sync.

## Open Issues Assigned to Me

_No data yet — connect GitHub in Integrations._

## Open Pull Requests

_No data yet._

## Recent Activity

_No data yet._
`,

  'calendar/upcoming.md': `# Upcoming Calendar Events

> Auto-updated by Compass on each sync.

_No data yet — connect Google Calendar in Integrations._
`,

  'inbox/action-items.md': `# Email Action Items

> Auto-extracted by Compass from Gmail on each sync.

_No data yet — connect Gmail in Integrations._
`,

  'drive/index.md': `# Google Drive Index

> Auto-updated by Compass on each sync.

_No data yet — connect Google Drive in Integrations._
`,

  'templates/daily.md': `# Daily Checklist Template

## Morning
- [ ] Review today's calendar
- [ ] Check email & prioritize
- [ ] Set 3 main goals for the day

## Work
- [ ] Deep work block (2 hrs)
- [ ] Review GitHub issues
- [ ] Team sync / standups

## Personal
- [ ] Exercise
- [ ] Read (30 min)

## Evening
- [ ] Plan tomorrow
- [ ] Tidy workspace
`,

  'templates/weekly.md': `# Weekly Review Template

## This Week's Goals
- [ ]
- [ ]

## Projects Status Review
- [ ]

## Weekly Reflection
### What went well?

### What were the blockers?

### Next week priorities:
1.
2.
3.
`,

  'templates/monthly.md': `# Monthly Planning Template

## Monthly Priorities
1.
2.
3.

## Habits Tracker
- [ ]

## Financial Check-in
- [ ] Review budget vs actuals
- [ ] Check upcoming bills
- [ ] Review savings progress

## Monthly Reflection
- **Biggest win:**
- **Biggest challenge:**
- **Focus for next month:**
`
}

export function seedKnowledgeFiles(knowledgeDir: string): void {
  for (const [relPath, content] of Object.entries(STARTER_FILES)) {
    const fullPath = join(knowledgeDir, relPath)
    if (!existsSync(fullPath)) {
      writeFileSync(fullPath, content, 'utf8')
    }
  }
}

export function updateKnowledgeFile(knowledgeDir: string, relPath: string, content: string): void {
  const fullPath = join(knowledgeDir, relPath)
  writeFileSync(fullPath, content, 'utf8')
}

export function readKnowledgeFile(knowledgeDir: string, relPath: string): string {
  const fullPath = join(knowledgeDir, relPath)
  if (!existsSync(fullPath)) return ''
  return readFileSync(fullPath, 'utf8')
}
