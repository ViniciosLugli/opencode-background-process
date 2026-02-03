---
name: update-tool-descriptions
description: Edit tool descriptions safely
---

# Update Tool Descriptions

## Prerequisites
- Repository checked out
- Node dependencies available

## Steps
1. Read `src/index.ts` to locate tool metadata.
2. Update tool `description` and argument `describe` strings only; avoid behavioral changes.
3. Keep wording explicit about scope (e.g., only processes launched by this tool).
4. Run `npm run build` to regenerate `dist/` artifacts.
5. Verify `dist/` updates are expected and no other files changed unexpectedly.

## Expected Outcomes
- `src/index.ts` updated descriptions only.
- `dist/` regenerated via build.

## Troubleshooting
- If build fails, run `npx tsc --noEmit` to surface type errors.
- If `dist/` differs unexpectedly, re-check for unintended code edits.
