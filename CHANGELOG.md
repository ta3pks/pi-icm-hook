# Changelog

All notable changes to pi-icm-hook.

## [0.1.0] — 2026-05-21

### Added

- Initial release
- 8 ICM tools: `icm_recall`, `icm_store`, `icm_update`, `icm_forget`, `icm_consolidate`, `icm_health`, `icm_topics`, `icm_stats`
- `before_agent_start` hook — recall + directive injection into system prompt
- `message_end` hook — trigger detection (5 patterns) + auto-save + footer indicator
- `session_before_compact` hook — context save before compaction
- `session_start` / `session_shutdown` hooks — lifecycle management
- Trigger detection ported from `hermes-icm-memory/mapping.py`
- Graceful degradation when ICM CLI is not found
- Configurable recall limit, timeouts, and indicator toggles
