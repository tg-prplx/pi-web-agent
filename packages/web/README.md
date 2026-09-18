# `@earendil-works/pi-web-agent`

The local HTTP/SSE server and browser client for the repository's Pi Web Agent.

## Run from the repository root

```bash
npm ci --ignore-scripts
npm run build:offline
npm run web -- --cwd /absolute/path/to/project
```

Open <http://127.0.0.1:4317>. Add `--port 4400` to use another port.

## Runtime contract

The server starts `@earendil-works/pi-coding-agent/rpc-entry` as a child process for each active chat. Browser requests are translated into structured Pi RPC commands; Pi events return over Server-Sent Events.

- Credentials stay in the local Pi process.
- Chat metadata lives at `~/.pi/web-agent/chats.json` or `PI_WEB_AGENT_DIR`.
- Native session files stay in Pi's normal session directory.
- Removing a web chat does not delete its native session.
- New chats disable automatic model retry until it is enabled in the inspector.

See the [repository README](../../README.md) for features, controls, configuration, security notes, and troubleshooting.
