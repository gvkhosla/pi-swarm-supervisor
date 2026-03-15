# Swarm Extension

Project-local Pi extension scaffold for managing multiple agents at once.

## What it does

- Spawns managed child `pi` agents in `--mode json`
- Tracks status, last tool, last output, token/cost stats
- Flags likely stuck agents with lightweight heuristics
- Runs side analyzer agents that suggest interventions
- Applies safe suggestions in one step (restart, switch model, spawn helper)
- Persists swarm snapshots with `pi.appendEntry()` and restores them on resume
- Shows a footer + widget summary in the Pi UI
- Provides commands and tools for orchestration

## Commands

- `/swarm` — open dashboard overlay
- `/swarm-start name@model :: task` — start a managed agent
- `/swarm-start-role role@model :: task` — start a managed agent from a preset role
- `/swarm-stop <id|name|all>` — stop agents
- `/swarm-restart <id|name>` — restart agent with same config
- `/swarm-analyze <id|name>` — spawn analyzer side agent
- `/swarm-apply <id|name> [index]` — apply latest analyzer suggestion
- `/swarm-clear` — remove finished agents from the dashboard

## Preset roles

- `scout`
- `planner`
- `reviewer`
- `debugger`
- `worker`

## Tools

- `swarm_spawn`
- `swarm_spawn_role`
- `swarm_list`
- `swarm_stop`
- `swarm_analyze`
- `swarm_apply_suggestion`

## Current heuristics

- quiet for 45s+ => warning
- quiet for 120s+ => stuck
- same tool repeated 3x => warning
- repeated error keys => warning
- context tokens above 150k => warning

## Current suggestion actions

- `restart-from-summary`
- `switch-model`
- `spawn-side-agent`
- `rewrite-prompt` / `compact-context` / `split-task` currently map to a supervised restart

## Good next steps

- persist snapshots with `pi.appendEntry()`
- add richer overlay actions and transcript view
- add SDK-based in-process runner for live `setModel()`
- add project-specific agent presets
