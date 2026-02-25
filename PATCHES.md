# Custom Patches (dev-geilt)

Branch `dev-geilt` carries custom features on top of upstream releases.
When rebasing onto a new upstream release, use this manifest to identify
conflict-prone files and verify nothing is lost.

**Current base:** `v2026.2.24`

## Patch A — contextScripts pre-spawn hook

Runs shell scripts before sub-agent spawning to inject environment-specific
context (identity files, GNAS.md, etc.) into the agent bootstrap.

**Files touched:**

| File                                      | Change                                        |
| ----------------------------------------- | --------------------------------------------- |
| `docs/concepts/context-scripts.md`        | **new** — feature documentation               |
| `src/agents/context-scripts.ts`           | **new** — core implementation                 |
| `src/agents/subagent-spawn.ts`            | modified — calls contextScripts before spawn  |
| `src/agents/tools/sessions-spawn-tool.ts` | modified — imports SUBAGENT_SPAWN_MODES       |
| `src/config/zod-schema.agent-defaults.ts` | modified — adds contextScripts config         |
| `src/config/zod-schema.agent-runtime.ts`  | modified — adds contextScripts runtime schema |

**Conflict-prone areas:**

- `subagent-spawn.ts` — upstream refactors to spawn logic clash with the
  contextScripts block and the `resolvedTask` variable in `childTaskMessage`.
  Keep BOTH upstream's `spawnMode` session check AND our `resolvedTask` (not `task`).
- `sessions-spawn-tool.ts` — upstream may add/remove imports from `subagent-spawn.js`.
  Ensure `SUBAGENT_SPAWN_MODES` stays imported if upstream exports it; drop duplicate
  `AnyAgentTool` import if upstream already has it.
- `zod-schema.agent-defaults.ts` — upstream adds fields to the `subagents` object;
  our `contextScripts` field goes after the last upstream field (currently `announceTimeoutMs`).

## Patch B — GNAS.md workspace bootstrap

Adds `GNAS.md` to the `MINIMAL_BOOTSTRAP_ALLOWLIST` so sub-agents receive
the shared agent identity document.

**Files touched:**

| File                      | Change                                               |
| ------------------------- | ---------------------------------------------------- |
| `src/agents/workspace.ts` | modified — adds `DEFAULT_GNAS_FILENAME` to allowlist |

**Conflict-prone areas:**

- `workspace.ts` — upstream changes to `MINIMAL_BOOTSTRAP_ALLOWLIST` entries will
  conflict; just re-add the `DEFAULT_GNAS_FILENAME` entry after resolving.
  Note: `DEFAULT_GNAS_FILENAME` constant is already defined upstream since v2026.2.24.

## Rebase checklist

1. Use `git rebase --onto <new-tag> <old-tag> dev-geilt` (NOT `git rebase main` —
   release tags diverge from `main` with extra commits).
2. Resolve the 3-4 conflicts using this manifest.
3. `pnpm build` to verify.
4. `npm link` then reinstall services:
   `openclaw gateway stop && openclaw node stop && openclaw gateway install && openclaw node install`
5. Kill any stale processes: `pgrep -fl openclaw-(gateway|node)` — verify all show
   the correct `OPENCLAW_SERVICE_VERSION`. Kill old PIDs if needed; launchd respawns.
6. Force-push: `git push --force-with-lease origin dev-geilt`
7. Update this file with the new base tag.

## Post-rebase gotchas

- **Stale services:** `openclaw gateway restart` may not fully replace old processes.
  Always `stop` + `install` (which re-generates the plist with the correct version).
  Verify with `pgrep -fl openclaw-` that version strings match.
- **Release tags vs main:** upstream release tags (e.g. `v2026.2.24`) contain commits
  NOT on `origin/main`. Always rebase onto the tag, not `origin/main`.
- **npm link:** after rebase+rebuild, run `npm link` from repo root to update the
  global binary at `/opt/homebrew/bin/openclaw`. A global `npm install -g openclaw`
  will overwrite the link.
- **Plugin removal:** check for stale plugin entries in `~/.openclaw/openclaw.json`
  after version bumps (e.g. `google-antigravity-auth` was removed in v2026.2.24).
