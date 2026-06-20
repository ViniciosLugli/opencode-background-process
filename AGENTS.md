<instructions>
## Build & Verification
- Use `bun run build` for one-shot compilation and skill sync.
- Use `bun run typecheck` for fast type-checking without output.
- MUST NOT run `bun run dev` or any long-running/blocking processes.
- Verification MUST be performed using one-shot commands before finishing tasks.

## Task Routing
- Core Logic: `src/` contains the background process management implementation.
- Skill Definitions: `skills/` contains JSON definitions for OpenCode skills.
- Distribution: `dist/` is generated and MUST NOT be edited directly.
- Configuration: `example-opencode.json` provides reference for plugin integration.

## Repository Constraints
- `node_modules/` is READ-ONLY.
- `bun.lock` is the package lockfile.
- `dist/` is READ-ONLY; it is overwritten on every build.
- `LICENSE` is READ-ONLY.
- Coding: MUST use ESM (Module) syntax per `package.json`.
- Environment: Project relies on Bun types; use Bun-compatible APIs where appropriate.
</instructions>

<rules>
- You MUST run `bun run build` after modifying files in `src/` or `skills/`.
- You MUST NOT use interactive `git` commands (e.g., `rebase -i`).
- You MUST handle process lifecycle (spawn, kill, signals) explicitly in `src/`.
- You SHOULD use `example-opencode.json` as a blueprint for new plugin features.
</rules>
