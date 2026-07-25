# Pi Coding Agent Extension Ecosystem Research

## Overview

Pi extensions are TypeScript modules that extend the pi coding agent's behavior. They are loaded via [jiti](https://github.com/unjs/jiti), so TypeScript works without compilation. Extensions can register custom tools, intercept events, add commands, and interact with the TUI.

---

## Extension API

### Core Pattern: Default Export Factory Function

Every extension exports a default factory function receiving `ExtensionAPI`:

```typescript
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  // Register tools, subscribe to events, add commands
  pi.registerTool({ /* ... */ });
  pi.on("tool_call", async (event, ctx) => { /* ... */ });
  pi.registerCommand("mycommand", { /* ... */ });
}
```

### Async Factory Functions

For one-time startup work (fetching config, discovering models):

```typescript
export default async function (pi: ExtensionAPI) {
  const response = await fetch("http://localhost:1234/v1/models");
  // pi awaits the promise before continuing startup
}
```

### Key ExtensionAPI Methods

| Method | Purpose |
|--------|---------|
| `pi.registerTool(definition)` | Register LLM-callable tool |
| `pi.on(event, handler)` | Subscribe to lifecycle events |
| `pi.registerCommand(name, options)` | Add `/command` |
| `pi.registerShortcut(key, options)` | Bind keyboard shortcut |
| `pi.registerFlag(name, options)` | Add CLI flag |
| `pi.sendMessage(message, options?)` | Inject agent message |
| `pi.sendUserMessage(content, options?)` | Inject user message |
| `pi.appendEntry(customType, data?)` | Persist extension state |
| `pi.exec(command, args, options?)` | Run shell command |
| `pi.setActiveTools(names)` | Enable/disable tools at runtime |
| `pi.registerProvider(name, config)` | Register LLM provider |
| `pi.getModel()` / `pi.setModel(model)` | Model management |

---

## Package.json Structure

Extensions distributed as npm/git packages use a `pi` manifest in `package.json`:

```json
{
  "name": "pi-my-extension",
  "version": "1.0.0",
  "type": "module",
  "keywords": ["pi-package", "pi-coding-agent", "extension"],
  "license": "MIT",
  "pi": {
    "extensions": ["./index.ts"],
    "skills": ["./skills"],
    "prompts": ["./prompts"]
  },
  "files": [
    "index.ts",
    "src/**/*.ts",
    "skills/**/*",
    "README.md"
  ],
  "peerDependencies": {
    "@earendil-works/pi-coding-agent": "*",
    "@earendil-works/pi-tui": "*"
  },
  "peerDependenciesMeta": {
    "@earendil-works/pi-coding-agent": { "optional": true },
    "@earendil-works/pi-tui": { "optional": true }
  },
  "dependencies": {
    "typebox": "^1.1.24"
  }
}
```

### Convention Directories (no manifest needed)

- `extensions/` — loads `.ts` and `.js` files
- `skills/` — recursively finds `SKILL.md` folders
- `prompts/` — loads `.md` files
- `themes/` — loads `.json` files

### Installation

```bash
pi install npm:pi-my-extension@1.0.0
pi install git:github.com/user/repo@v1
pi install /path/to/local/package
```

---

## Extension Locations

| Location | Scope |
|----------|-------|
| `~/.pi/agent/extensions/*.ts` | Global (all projects) |
| `~/.pi/agent/extensions/*/index.ts` | Global (subdirectory) |
| `.pi/extensions/*.ts` | Project-local |
| `.pi/extensions/*/index.ts` | Project-local |

Extensions in auto-discovered locations can be hot-reloaded with `/reload`.

---

## Event Lifecycle

```
pi starts
  ├─► project_trust (user/global extensions only)
  ├─► session_start { reason: "startup" }
  └─► resources_discover { reason: "startup" }
      │
user sends prompt
  ├─► input (can modify)
  ├─► before_agent_start (can modify system prompt)
  │
  ┌─── turn (repeats while LLM calls tools) ───┐
  │   ├─► turn_start                            │
  │   ├─► context (can modify messages)         │
  │   ├─► before_provider_headers               │
  │   ├─► before_provider_request               │
  │   ├─► after_provider_response               │
  │   │                                         │
  │   │   Tool calls:                           │
  │   │     ├─► tool_execution_start            │
  │   │     ├─► tool_call (CAN BLOCK)           │
  │   │     ├─► tool_execution_update           │
  │   │     ├─► tool_result (can modify)        │
  │   │     └─► tool_execution_end              │
  │   │                                         │
  │   └─► turn_end                              │
  └───                                           │
  ├─► agent_end                                 │
  └─► agent_settled                             │

session shutdown
  └─► session_shutdown
```

### Key Events

- **`tool_call`** — Can block execution. Return `{ block: true, reason }`. `event.input` is mutable.
- **`tool_result`** — Can modify result before it enters context.
- **`session_start`** — Restore state from previous session entries.
- **`turn_start` / `turn_end`** — Per-turn hooks for checkpointing, logging.
- **`session_before_fork`** — Can cancel fork, restore state.
- **`session_before_compact`** — Can cancel or customize compaction.
- **`session_shutdown`** — Cleanup, final commits.
- **`input`** — Transform user input before processing.
- **`before_agent_start`** — Modify system prompt per-turn.

---

## Tool Registration Pattern

### Basic Tool

```typescript
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

const helloTool = defineTool({
  name: "hello",
  label: "Hello",
  description: "A simple greeting tool",
  parameters: Type.Object({
    name: Type.String({ description: "Name to greet" }),
  }),

  async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
    return {
      content: [{ type: "text", text: `Hello, ${params.name}!` }],
    };
  },
});

export default function (pi: ExtensionAPI) {
  pi.registerTool(helloTool);
}
```

### Tool with Custom TUI Rendering

```typescript
pi.registerTool({
  name: "web_fetch",
  label: "Web Fetch",
  description: "Fetch and extract content from URLs",
  parameters: Type.Object({
    url: Type.String(),
    prompt: Type.Optional(Type.String()),
  }),

  async execute(toolCallId, params, signal, onUpdate, ctx) {
    // Stream progress
    onUpdate?.({ content: [{ type: "text", text: "Fetching..." }] });

    const content = await fetchContent(params.url);

    return {
      content: [{ type: "text", text: content }],
      details: { url: params.url, totalChars: content.length },
    };
  },

  renderCall(args, theme) {
    // Custom TUI rendering for tool call display
    const { url } = args;
    return new Text(`Fetching: ${url}`, theme.colors.info);
  },

  renderResult(result, theme) {
    // Custom TUI rendering for tool result display
    const { url, totalChars } = result.details || {};
    return new Text(`${url} (${totalChars} chars)`, theme.colors.success);
  },
});
```

### Tool with Dynamic Loading (Search Pattern)

Tools can be registered after startup and activated on-demand:

```typescript
pi.registerTool({
  name: "search_tools",
  description: "Search for and enable tools relevant to a task",
  promptSnippet: "Search for additional tools when active tools cannot perform the task",
  promptGuidelines: [
    "Use search_tools when a task requires a capability not currently available.",
  ],
  parameters: Type.Object({
    query: Type.String({ description: "Capability to search for" }),
  }),
  async execute(_toolCallId, params) {
    const matches = findMatchingTools(params.query);
    for (const tool of matches) {
      pi.registerTool(tool);
    }
    // Activate newly found tools
    const current = pi.getActiveTools();
    pi.setActiveTools([...new Set([...current, "search_tools", ...matches.map(t => t.name)])]);
    return { content: [{ type: "text", text: `Enabled: ${matches.map(t => t.name).join(", ")}` }] };
  },
});
```

---

## State Management Patterns

### In-Memory State with Session Restoration

```typescript
export default function (pi: ExtensionAPI) {
  let items: string[] = [];

  // Reconstruct state from session on reload
  pi.on("session_start", async (_event, ctx) => {
    items = [];
    for (const entry of ctx.sessionManager.getEntries()) {
      if (entry.type === "custom" && entry.customType === "my-state") {
        items = entry.data.items;
      }
    }
  });

  pi.registerTool({
    name: "my_tool",
    // ...
    async execute(_id, params) {
      items.push(params.item);
      return {
        content: [{ type: "text", text: "Added" }],
        details: { items: [...items] }, // Store for reconstruction
      };
    },
  });
}
```

### Persistent Entries with Custom Rendering

```typescript
pi.appendEntry("status-card", { title: "Indexed files", count: 17 });

// Pair with custom renderer
pi.registerEntryRenderer("status-card", (data, theme) => {
  return new Box(1, 1, (t) => theme.bg("infoBg", t)).addChild(
    new Text(`${data.title}: ${data.count}`)
  );
});
```

---

## Notable Published Extensions

### 1. pi-autoresearch (7,252 stars)
- **Repo:** https://github.com/davebcn87/pi-autoresearch
- **Author:** davebcn87
- **Purpose:** Autonomous experiment loop — run, measure, keep or discard
- **Pattern:** Uses `extensions/` directory convention, `skills/` for SKILL.md
- **Package:** `type: "module"`, peer deps on pi-coding-agent, pi-ai, pi-tui

### 2. pi-subagents (2,707 stars)
- **Repo:** https://github.com/nicobailon/pi-subagents
- **Author:** nicobailon
- **Purpose:** Async subagent delegation with truncation, artifacts, session sharing
- **Pattern:** Single `index.ts` entry point, re-exports from `src/extension/index.ts`
- **Features:** Config file (~/.pi/agent/extensions/subagent/config.json), TUI fleet view, background jobs
- **Structure:** Complex — multiple modules for foreground/background runs, agents discovery, artifacts
- **Package:** Includes `bin` entry (`install.mjs`), `prompts/` directory

### 3. pi-web-access (879 stars)
- **Repo:** https://github.com/nicobailon/pi-web-access
- **Author:** nicobailon
- **Purpose:** Web search, URL fetching, GitHub cloning, PDF extraction, YouTube understanding
- **Pattern:** Single `index.ts` at root, imports from local modules
- **Features:** Multiple search providers (OpenAI, Brave, Tavily, Exa, Perplexity, Gemini), session result caching
- **Package:** Uses `typebox` for schemas, no peer deps declared

### 4. pi-messenger (651 stars)
- **Repo:** https://github.com/nicobailon/pi-messenger
- **Author:** nicobailon
- **Purpose:** Multi-agent communication extension

### 5. pi-interactive-shell (542 stars)
- **Repo:** https://github.com/nicobailon/pi-interactive-shell
- **Author:** nicobailon
- **Purpose:** Run AI coding agents in pi TUI overlays with PTY emulation
- **Pattern:** Flat file structure at root, `skills/` directory
- **Features:** Custom TUI components, background widgets, session manager integration
- **Package:** Uses `zigpty` for PTY, `@xterm/headless`, vitest for testing

---

## Common Patterns Summary

### 1. Export Pattern
- **Standard:** `export default function (pi: ExtensionAPI) { ... }`
- **Re-export:** `export { default } from "./src/extension/index.ts"` (pi-subagents)
- **defineTool helper:** `const tool = defineTool({ ... }); pi.registerTool(tool);`

### 2. Directory Structure
```
my-extension/
├── package.json          # "pi": { "extensions": ["./index.ts"], "skills": ["./skills"] }
├── index.ts              # Main extension entry point
├── src/                  # Source modules (optional)
│   ├── extension/
│   │   └── index.ts      # Actual implementation
│   └── shared/           # Utilities
├── skills/               # SKILL.md files
│   └── my-skill/
│       └── SKILL.md
├── prompts/              # Prompt templates (optional)
└── README.md
```

### 3. Dependencies
- **Required:** `typebox` for tool parameter schemas
- **Common peer deps:** `@earendil-works/pi-coding-agent`, `@earendil-works/pi-tui`, `@earendil-works/pi-ai`
- **Peer deps marked optional** in `peerDependenciesMeta` for compatibility

### 4. Testing
- `pi-subagents`: Node test runner with `--experimental-strip-types`
- `pi-interactive-shell`: vitest
- `pi-autoresearch`: Node test runner with `--experimental-strip-types`

### 5. Keywords
All packages use `"pi-package"` keyword for discoverability, plus domain-specific keywords.

### 6. Lifecycle Hooks
- **session_start**: Restore state from session entries
- **turn_start/turn_end**: Per-turn checkpointing, logging
- **tool_call**: Intercept/block tool execution (permission gates)
- **tool_result**: Modify results before context injection
- **session_shutdown**: Cleanup, final commits
- **session_before_fork**: State restoration for branched sessions
