# Pi Web Agent

A local browser interface for the [Pi coding agent](https://pi.dev). It keeps Pi's real RPC runtime, sessions, tools, provider configuration, and filesystem access, while replacing the terminal UI with a persistent web workspace.

The browser is only the interface. Agent execution stays in local Pi processes.

## What works

- Persistent chats backed by native Pi session files
- Separate workspace and agent process for each open chat
- Streaming Markdown responses without rebuilding the whole conversation
- Collapsible reasoning that closes when reasoning finishes
- Live `read`, `write`, `edit`, `bash`, `grep`, `find`, and other tool cards
- File previews with extension-aware syntax highlighting
- Image upload and clipboard paste with automatic resizing
- Model and thinking-level selection from the existing Pi configuration
- Stop, steer, follow-up, compact, clone, fork, export, and session-tree controls
- Foldable desktop navigation and a mobile chat drawer
- Forwarding of Pi extension dialogs into the browser

## Requirements

- Node.js 22.19 or newer
- A working Pi provider configuration under `~/.pi/agent`
- Provider credentials configured exactly as they are for the Pi CLI

## Quick start

```bash
git clone https://github.com/tg-prplx/pi-web-agent.git
cd pi-web-agent
npm ci --ignore-scripts
npm run build:offline
npm run web -- --cwd /absolute/path/to/your/project
```

Open [http://127.0.0.1:4317](http://127.0.0.1:4317).

Choose another port when needed:

```bash
npm run web -- --cwd /absolute/path/to/project --port 4400
```

The server binds to `127.0.0.1` by default. Do not expose it to a public network: Pi runs tools with the permissions of the current operating-system user and the web server does not add an authentication layer.

## How it is structured

```text
Browser UI
    │ HTTP + Server-Sent Events
    ▼
Local Pi Web server
    │ JSON-lines RPC
    ▼
Pi coding-agent runtime
    ├── provider and model configuration
    ├── native Pi sessions
    ├── filesystem and shell tools
    └── extensions
```

Credentials never need to be sent to the browser. The local server starts the RPC entry point from the bundled `@earendil-works/pi-coding-agent` workspace package and forwards structured events to the UI.

## Interface

### Chats and workspaces

Every chat has a fixed working directory. Selecting **Change workspace** creates a new chat in the chosen directory so the original Pi session keeps a consistent filesystem context.

Removing a chat only removes it from the web list. The underlying Pi JSONL session remains on disk.

### Response controls

- `Enter` sends a message; `Shift+Enter` inserts a new line.
- While Pi is responding and the composer is empty, the send button becomes **Stop**.
- Typing during a response enables **Steer** or **Follow-up** delivery.
- `Cmd/Ctrl+K` opens the integrated Pi command palette.
- `Cmd/Ctrl+N` creates a chat.

### Images

Images can be selected, dropped, or pasted. The browser reduces large inputs to at most 1536 pixels on either side and about one megapixel before sending them to Pi.

Image attachment support does not make a text-only model multimodal. Select a model whose Pi metadata advertises image input when you need vision.

### Agent activity

Reasoning is open while it streams and folded after completion. Tool calls update in place, including partial command output and file content. File-based tools use the filename extension to select a highlighter.

## Local data

Web chat metadata is stored in:

```text
~/.pi/web-agent/chats.json
```

Override that directory with `PI_WEB_AGENT_DIR`. Native Pi sessions remain in Pi's normal session directory.

## Configuration

Pi Web uses the existing Pi configuration. Configure providers, API keys, models, extensions, prompts, and tools through the normal Pi files and commands; the web layer does not maintain a second credential store.

Automatic model retry is disabled for new web chats by default to prevent repeated error loops. It can be enabled per chat under **Agent behavior**.

## Development

```bash
# Build only the web package
npm --workspace=@earendil-works/pi-web-agent run build

# Run focused web tests
cd packages/web
node ../../node_modules/vitest/dist/cli.js --run test/presentation.test.ts

# Repository checks
cd ../..
npm run check
```

The web client is framework-free TypeScript. Static assets are produced by `packages/web/scripts/build.mjs`; the local HTTP/SSE server and Pi process manager live under `packages/web/src/server`.

## Troubleshooting

### `Connection error`

First verify the same model works in the Pi CLI. Pi Web uses the same provider configuration and network path. Then check:

```bash
curl --fail http://127.0.0.1:4317/api/health
```

If the health request works but the model does not, the failure is between Pi and the configured provider rather than between the browser and the local server.

### The model cannot see an image

Select a vision-capable model. A text-only model may accept the chat request but will not receive image content from Pi.

### A workspace cannot be opened

Use an existing absolute directory path. Pi Web deliberately does not create or guess project directories.

## Upstream and license

This project is based on the Pi agent harness and keeps the upstream package layout so the browser UI can use the genuine Pi runtime. Upstream Pi documentation is available at [pi.dev](https://pi.dev).

MIT, matching the upstream project. See [LICENSE](LICENSE).
