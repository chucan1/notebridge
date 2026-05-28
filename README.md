# notebridge

> Multi-platform note bridge — translate notes between any reading platform and any knowledge base.

```
weread → IR → getnote
flomo  → IR → obsidian
local  → IR → notion
```

## Install

```bash
npm install -g notebridge
```

## Quick Start

```bash
# Set credentials
export WEREAD_API_KEY=wrk-xxx
export GETNOTE_API_KEY=gk_xxx

# Transfer highlights from WeRead to GetNote
notebridge weread --book "三体" --to getnote

# Dry-run: preview without writing
notebridge weread --book "三体" --to getnote --dry-run

# Transfer to Obsidian vault
notebridge weread --book "三体" --to obsidian

# List available platforms
notebridge --list-sources
notebridge --list-targets
```

## Supported Platforms

### Sources
- **weread** — WeChat Read highlights and thoughts
- **local-markdown** — Local .md files with frontmatter

### Destinations
- **getnote** — GetNote (Get 笔记)
- **obsidian** — Obsidian vault (.md files with frontmatter)

## How It Works

notebridge uses a universal intermediate representation (IR) to translate notes between platforms:

```
[Source] → SourceAdapter → NoteIR[] → DestinationAdapter → [Target]
```

Each platform only needs two adapters (read + write). Add a new platform and it works with all existing platforms — no combinatorial bridge explosion.

## Write Your Own Adapter

```typescript
import { registerSource, SourceAdapter } from "notebridge";

const myReader: SourceAdapter = {
  platform: "my-app",
  version: "0.1.0",
  async healthCheck(config) { /* ... */ },
  async listResources(config) { /* ... */ },
  async fetch(resource, config) { /* return NoteIR[] */ },
};

registerSource(myReader);
```

See `src/adapters/interfaces.ts` for the full interface.

## Claude Code Skill

There's a companion skill that wraps notebridge for Claude Code:
```bash
claude skills add chucan1/weread-to-getnote
```

## License

MIT
