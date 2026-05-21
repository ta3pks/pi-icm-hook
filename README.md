# pi-icm-hook

A [Pi](https://github.com/earendil-works/pi-coding-agent) extension wrapping [ICM](https://github.com/rtk-ai/icm) — **persistent, semantic, cross-session memory** via the same SQLite database your editors already use.

[![License: BSD-3-Clause](https://img.shields.io/badge/License-BSD_3--Clause-blue.svg)](./LICENSE) ![Version: 0.1.0](https://img.shields.io/badge/version-0.1.0-blue)

## Why

Pi forgets between sessions. You wire up AGENTS.md with CLI instructions, but it's fragile — the model has to remember to call `icm recall` and `icm store` at the right times. Miss one, and context is lost.

This extension makes ICM **native to Pi**:

- **8 tools** — `icm_recall`, `icm_store`, `icm_update`, `icm_forget`, `icm_consolidate`, `icm_health`, `icm_topics`, `icm_stats`
- **Auto-recall** — memories injected into the system prompt at the start of every agent cycle
- **Auto-save** — regex-based trigger detection saves decisions, fixes, preferences, learnings, and gotchas automatically
- **Footer indicator** — `📚 N · 💾 topic` on every response, showing recall count and what was saved

One SQLite file. Shared with Hermes, Claude Code, Cursor, OpenCode, Codex CLI — all your editors.

## Quickstart

Three steps, under two minutes if `icm` is already on your `$PATH`.

**1. Verify ICM is installed.**

```bash
icm --version    # expected: e.g. "icm 0.10.43"
```

If not found: <https://github.com/rtk-ai/icm>

**2. Install the extension.**

```bash
pi install npm:pi-icm-hook
```

From local:

```bash
pi install ./icm.ts
```

**3. Restart Pi.** The footer `📚 N · 💾 —` at the end of responses confirms it's active.

That's it. No config file, no daemon, no prompts to copy-paste.

## Tools

| Tool | Description |
|---|---|
| `icm_recall` | Search memories by query, topic, or both. Returns ranked results. |
| `icm_store` | Save a memory with topic, content, importance, and keywords. |
| `icm_update` | Edit an existing memory by ID. |
| `icm_forget` | Delete a memory by ID or clear an entire topic. |
| `icm_consolidate` | Merge all memories in a topic into a single summary. |
| `icm_health` | Audit memory health — staleness, consolidation needs. |
| `icm_topics` | List all memory topics. |
| `icm_stats` | Global memory statistics (count, average weight, date range). |

## Lifecycle Hooks

| Event | Action |
|---|---|
| `session_start` | Checks ICM availability. Gracesful degrade if missing. |
| `before_agent_start` | Recalls memories matching the user's prompt. Injects them + a save directive into the system prompt. |
| `message_end` | Runs trigger detection on the assistant's response. Auto-saves decisions, fixes, preferences, learnings, and gotchas. Injects the `📚 N · 💾 topic` footer. |
| `session_before_compact` | Saves a context marker before compaction truncates the session. |
| `session_shutdown` | Cleanup. |

## Auto-Save Triggers

The extension detects these categories and saves to the corresponding ICM topic:

| Trigger | Topic Template | Example |
|---|---|---|
| Error resolved | `errors-resolved-{project}` | `errors-resolved-pi-icm-hook` |
| Decision made | `decisions-{project}` | `decisions-chatterbox` |
| Preference discovered | `preferences` | `preferences` (global) |
| Learning / insight | `learnings-{project}` | `learnings-moon-backend` |
| Gotcha / pitfall | `gotchas-{project}` | `gotchas-cloudflare-wrangler` |

`{project}` is derived automatically from `basename(cwd)`.

## Configuration

Edit constants at the top of `icm.ts`:

```typescript
const DEFAULT_CONFIG = {
  recallLimit: 5,           // top-K memories to recall (default: 5)
  prefetchEnabled: true,    // auto-inject on every agent cycle
  defaultImportance: "high", // default for auto-saves
  readTimeoutMs: 3000,      // timeout for recall/health/topics/stats
  writeTimeoutMs: 5000,     // timeout for store/update/forget/consolidate
  indicatorEnabled: true,   // show 📚 · 💾 footer on responses
};
```

## How It Works

```
User prompt
  │
  ├── before_agent_start
  │   ├── icm recall <prompt> --format json --limit 5
  │   ├── Format recalled memories
  │   └── Inject into system prompt + save directive
  │
  ├── LLM generates response
  │   ├── Can call icm_recall / icm_store / etc. as tools
  │   └── ...
  │
  └── message_end
      ├── Detect triggers in assistant text (regex, no LLM cost)
      ├── Fire-and-forget icm store for each match
      └── Inject 📚 N · 💾 topic footer
```

No LLM calls wasted on memory management. Triggers are pure regex, recall is a single subprocess call at the start of each prompt cycle.

## Related Projects

- **[hermes-icm-memory](https://github.com/ta3pks/hermes-icm-memory)** — Same patterns, for the Hermes agent (Python)
- **[ICM](https://github.com/rtk-ai/icm)** — The memory engine (Rust)
- **[Pi](https://github.com/earendil-works/pi-coding-agent)** — The coding agent runtime

## License

BSD 3-Clause — see [LICENSE](./LICENSE).
