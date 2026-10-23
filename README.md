# pi-claude-memory

[![Ask DeepWiki](https://deepwiki.com/badge.svg)](https://deepwiki.com/elecnix/pi-claude-memory)

A pi extension that reads and writes **Claude Code's own memory store**. Not a
parallel store, not a sync job — the same files, so a memory saved in either
agent is immediately visible to the other.

## Why

Claude Code keeps one memory per file under
`~/.claude/projects/<cwd-slug>/memory/`, with a `MEMORY.md` index holding one
pointer line per memory. Cross-agent memory tools generally stand up a *new*
store and teach both agents to use it, which leaves your existing memories
behind and gives Claude Code two memory systems at once. This extension just
uses the directory that is already there.

## What it does

Mirrors Claude Code's two-tier design, so a large store stays cheap:

- **Index injected once per session.** The `MEMORY.md` pointer lines are added
  to pi's system prompt at the first turn — titles and one-line hooks only,
  never the bodies.
- **Bodies read on demand.** `memory_read` fetches one memory when the index
  suggests it is relevant.

### Tools

| Tool | Purpose |
|---|---|
| `memory_read` | Read one memory by name |
| `memory_write` | Save or update a memory, or delete it with an empty body |
| `memory_list` | List every memory with its description |

Tool output is compact by default and expands with `ctrl+o`
(`app.tools.expand`), matching pi's built-in tools: `memory_write` shows the
new body — or a diff against the previous body when updating an existing
memory, or a one-line confirmation when deleting — and `memory_read` shows the
full body in place of the one-line description.

### Deleting a memory

Call `memory_write` with an empty body (`""`) and the name of the memory to
remove. A JSON `null` body and the literal text `"null"` are accepted as the
same request, because a client that encodes a null body as the string `"null"`
would otherwise overwrite the memory with those four characters and report a
successful update. A body that means "no body" never reaches the write path.

The reply tells the two apart, so a caller never has to re-list the store to
know what happened: `Deleted memory "<name>".` for a delete, `Saved memory
"<name>".` or `Updated memory "<name>".` for a write.

## Install

```bash
pi install npm:pi-claude-memory
```

Or install from a specific Git ref (e.g. a branch or tag):

```bash
pi install git:github.com/elecnix/pi-claude-memory@v0.1.1
```

Or load it directly for a one-off:

```bash
pi -e /path/to/pi-claude-memory/extensions/claude-memory/index.ts
```

## Scoping

The memory directory is a function of the working directory: Claude Code
slugifies the absolute path by replacing `/` and `.` with `-`. So
`/Users/you/Source/app.git` maps to
`~/.claude/projects/-Users-you-Source-app-git/memory/`.

This means memories do not follow you between projects — the same rule that
applies in Claude Code. Starting pi in a different directory gives you a
different store.

## File format

Written files match what Claude Code writes, so both agents parse them:

```markdown
---
name: prefers-tabs
description: Uses tabs, not spaces
metadata:
  node_type: memory
  type: feedback
---

Indent with tabs in this project.

**Why:** The user said so.
**How to apply:** Match tabs when editing.
```

`type` is one of `user`, `feedback`, `project`, or `reference`.

## Development

```bash
npm test
```

Tests cover the store logic and depend on nothing but Node — pi and typebox are
only needed to run the extension itself.

## Prior art

There is a healthy ecosystem of memory extensions for pi. Every one of them
gives pi *its own* memory. This extension exists because none of them read the
store Claude Code already writes.

### Cross-agent memory layers

These advertise both Claude Code and pi, and are the closest existing options.
Both work by standing up a **new** shared store that each agent is taught to
use — neither reads `~/.claude/projects/*/memory/`. If you want one store
across many agents and are willing to migrate, prefer these over this
extension; they are far more capable.

- **[memorix](https://github.com/AVIDS2/memorix)** — cross-agent memory layer
  over MCP, supporting Claude Code, Codex, Cursor, Gemini CLI, pi, and more.
  Ships a genuine [pi package](https://github.com/AVIDS2/memorix/tree/main/plugins/pi)
  with a session-hook extension and skills, not just MCP compatibility. Stores
  in `~/.memorix/data/`. The most complete option in this space.
- **[paxm](https://github.com/pax-beehive/paxm)** — provider-neutral persistent
  memory in Go, for Codex, Claude Code, OpenCode, pi, and MCP clients. Its pi
  support is generic MCP; there is no pi-specific integration code.

### Memory extensions for pi

Each keeps its own store, in its own format:

- **[VandeeFeng/pi-memory-md](https://github.com/VandeeFeng/pi-memory-md)** —
  the closest relative in format: markdown files with `description` frontmatter,
  much like Claude Code's. Uses its own `core/user/` directory layout, so it
  cannot be pointed at a Claude Code memory directory as-is.
- **[samfoy/pi-memory](https://github.com/samfoy/pi-memory)** — learns
  corrections, preferences, and patterns from sessions.
- **[jayzeng/pi-memory](https://github.com/jayzeng/pi-memory)** — daily logs,
  scratchpad, optional semantic search.
- **[chandra447/pi-hermes-memory](https://github.com/chandra447/pi-hermes-memory)** —
  Hermes-style persistent memory and learning loop.
- **[elpapi42/pi-observational-memory](https://github.com/elpapi42/pi-observational-memory)** —
  observational memory aimed at making sessions feel endless.
- **[k0valik/pi-blackhole](https://github.com/k0valik/pi-blackhole)** —
  combines algorithmic compaction with observational memory.

### Related

- **[elecnix/pi-subagents](https://github.com/elecnix/pi-subagents)** — supports
  opt-in per-agent persistent memory under a dedicated `agent-memory/`
  namespace, scoped to a recurring custom agent rather than to a project.

## Sources

- [pi extensions documentation](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/extensions.md)
  — the `before_agent_start` system-prompt hook, `registerTool`, and
  `withFileMutationQueue`, which this extension uses to keep concurrent index
  writes from clobbering each other.
- [pi context files](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/usage.md)
  — pi already discovers `AGENTS.md` and `CLAUDE.md`, so instruction files are
  shared between the two agents out of the box. Memory files are not, which is
  the gap this fills.
- [Claude Code memory documentation](https://docs.claude.com/en/docs/claude-code/memory)
  — `CLAUDE.md` discovery and precedence.

The on-disk memory layout this extension targets (`MEMORY.md` index plus one
file per memory, with `name`/`description`/`metadata.type` frontmatter) is not
formally documented. It was derived by reading a live store, and is pinned by
the tests in [`tests/`](tests/). It may change without notice.

## License

MIT
