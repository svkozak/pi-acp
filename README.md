# pi-acp

ACP (Agent Client Protocol) adapter for [`pi`](https://www.npmjs.com/package/@mariozechner/pi-coding-agent) aka [shittycodingagent.ai](https://shittycodingagent.ai).

`pi-acp` does not require modifications to pi core and speaks **ACP JSON-RPC 2.0 over stdio** to an ACP client (e.g. an editor) and spawns `pi --mode rpc`, bridging requests/events between the two.

## Status

This is an MVP-style adapter intended to be useful today and easy to iterate on. It intentionally leaves some ACP features unimplemented (see [Limitations](#limitations)).

## How it works

- **ACP side:** JSON-RPC 2.0 over stdio using `@agentclientprotocol/sdk`
- **Pi side:** spawns `pi --mode rpc` and communicates via newline-delimited JSON on stdio
- **Session model:** 1 ACP session ↔ 1 `pi` subprocess

High-level mapping:

- `session/new` → spawn `pi --mode rpc` (working directory = `cwd`)
- `session/prompt` → send `{ type: "prompt", message, attachments }` to pi and stream events back as `session/update`
- `session/cancel` → send `{ type: "abort" }`

## Features

- Streams assistant output as ACP `agent_message_chunk`
- Maps pi tool execution to ACP `tool_call` / `tool_call_update`
  - For `edit`, `pi-acp` snapshots the file before the tool runs and emits an ACP **structured diff** (`oldText`/`newText`) on completion when possible
- Session persistence
  - pi stores its own sessions in `~/.pi/agent/sessions/...`
  - `pi-acp` stores a small mapping file at `~/.pi/pi-acp/session-map.json` so `session/load` can reattach to a previous pi session file
- Slash commands
  - Loads file-based slash commands compatible with pi’s conventions
  - Adds a small set of built-in commands for headless/editor usage
- Skills are loaded by pi directly and are available in acp sessions

## Prerequisites

Make sure pi is installed

```bash
npm install -g @mariozechner/pi-coding-agent
```

- Node.js 22+
- `pi` installed and available on your `PATH` (the adapter runs the `pi` executable)
- Configure `pi` separately for your model providers/API keys

## Install

### Add pi-acp to your ACP client, e.g. [Zed](https://zed.dev/docs/agents/external-agents/)

Add the following to your Zed `settngs.json`:

#### Using with `npx` (no global install needed):

```json
  "agent_servers": {
    "pi": {
      "type": "custom",
      "command": "npx",
      "args": ["-y", "pi-acp"],
      "env": {},
    },
  },
```

#### Global install

```bash
npm install -g pi-acp
```

```json
  "agent_servers": {
    "pi": {
      "type": "custom",
      "command": "pi-acp",
      "args": [],
      "env": {},
    },
  },
```

#### From source

```bash
npm install
npm run build
```

Point your ACP client to the built `dist/index.js`:

```json
  "agent_servers": {
    "pi": {
      "type": "custom",
      "command": "node",
      "args": ["/path/to/pi-acp/dist/index.js"],
      "env": {},
    },
  },
```

## Features

### Slash commands

`pi-acp` supports slash commands:

#### 1) File-based commands (compatible with pi)

Loaded from:

- User commands: `~/.pi/agent/commands/**/*.md`
- Project commands: `<cwd>/.pi/commands/**/*.md`

These are expanded adapter-side (pi RPC mode doesn’t expand them).

#### 2) Built-in commands

- `/compact [instructions...]` – run pi compaction (optionally with custom instructions)
- `/autocompact on|off|toggle` – toggle automatic compaction
- `/export` – export the current session to HTML in the session `cwd`
- `/session` – show session stats (tokens/messages/cost/session file)
- `/queue all|one-at-a-time` – set pi queue mode (unstable feature)
- `/changelog` – print the installed pi changelog (best-effort)

Other built-in commands:

- `/model` - maps to model selector in Zed
- `/thinking` - maps to 'mode' selector in Zed
- `/clear` - not implemented (use ACP client 'new' command)

The rest are not yet implemented due to ACP limitations (e.g. no history)

## Development

```bash
npm install
npm run dev        # run from src via tsx
npm run build
npm run lint
npm test
```

Project layout:

- `src/acp/*` – ACP server + translation layer
- `src/pi-rpc/*` – pi subprocess wrapper (RPC protocol)

## Limitations

- No ACP filesystem delegation (`fs/*`) and no ACP terminal delegation (`terminal/*`). pi reads/writes and executes locally.
- MCP servers are accepted in ACP params and stored in session state, but not wired through to pi.
- Assistant streaming is currently sent as `agent_message_chunk` (no separate thought stream).
- Queue is implemented client-side and should work like pi's `one-at-a-time`
- ACP clients don't yet suport session history, but ACP sessions from `pi-acp` can be `/resume`d in pi directly

## License

MIT (see [LICENSE](LICENSE)).
