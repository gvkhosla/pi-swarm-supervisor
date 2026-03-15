# pi-swarm-supervisor

A Pi package for supervising multiple coding agents at once.

## Features

- managed side agents running in isolated `pi --mode json` subprocesses
- live status, warnings, last tool, last output, cost/context stats
- stuck detection heuristics
- analyzer side agents that recommend interventions
- one-click suggestion application
- session snapshot persistence via `pi.appendEntry()`

## Install from GitHub

> Use either the packaged repo or the project-local `.pi/extensions/swarm` copy, not both at the same time, otherwise Pi will report command/tool conflicts.


After pushing this folder as its own GitHub repo:

```bash
pi install git:github.com/<your-user>/pi-swarm-supervisor
```

Or try it without installing:

```bash
pi -e git:github.com/<your-user>/pi-swarm-supervisor
```

## Install from a local checkout

```bash
pi install ./pi-swarm-supervisor
```

Or run once without installing:

```bash
pi -e ./pi-swarm-supervisor
```

## Commands

- `/swarm`
- `/swarm-start name@model :: task`
- `/swarm-start-role role@model :: task`
- `/swarm-stop <id|name|all>`
- `/swarm-restart <id|name>`
- `/swarm-analyze <id|name>`
- `/swarm-apply <id|name> [index]`
- `/swarm-clear`

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

## Quick demo

1. `/swarm-start scout :: inspect this repo and find likely hotspots`
2. `/swarm-start worker :: try to solve bug X`
3. `/swarm`
4. `/swarm-analyze worker`
5. `/swarm-apply worker`

## Suggested repo layout

Push the contents of this directory as the root of a GitHub repo:

```text
pi-swarm-supervisor/
  package.json
  README.md
  extensions/
    swarm/
      index.ts
      dashboard.ts
      heuristics.ts
      prompts.ts
      runner.ts
      state.ts
      types.ts
```
