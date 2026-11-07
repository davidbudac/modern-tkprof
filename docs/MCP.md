# MCP: use an AI assistant to analyze traces

`mtkprof mcp` exposes Oracle SQL trace analysis tools through the Model
Context Protocol (MCP). An AI client launches the server, discovers its tools
and calls them to investigate your question. mtkprof parses the trace and
calculates the numbers; the assistant interprets the results and cites the
evidence.

Standalone use needs the `mtkprof` CLI and an MCP client that can launch a
stdio server. It needs no desktop app, running engine or database connection.
The MCP server itself calls no AI model; your client supplies the model and
its authentication.

## Quick start with Claude Code

Install the CLI using the [README](../README.md), then check that the client
can find it:

```sh
mtkprof version
mtkprof mcp -h
```

Register the server once:

```sh
claude mcp add -s user mtkprof -- mtkprof mcp
```

Then ask Claude Code, for example:

> The nightly batch traced in /u01/diag/orcl_ora_4711.trc got slow after
> 14:05. What was it waiting on, and which statement accounts for the time?

The assistant calls `open_trace` with the absolute path, reads the overview,
then narrows its investigation to statements, executions, waits or a time
window. You can give several files or a directory for one trace set. The
paths must be readable on the machine where the MCP server runs.

To scope the registration to a repository, use `-s project` instead of
`-s user`. To include bind values in tool results, append `-binds keep` to
the server command when configuring it:

```sh
mtkprof mcp -binds keep
```

The default is `-binds mask`; see [Data sent to the model](#data-sent-to-the-model).

## Other MCP clients

Configure a **stdio** server with `mtkprof` as its executable and `mcp` as its
argument. Clients that use the `mcpServers` JSON format can use:

```json
{
  "mcpServers": {
    "mtkprof": {
      "command": "/absolute/path/to/mtkprof",
      "args": ["mcp"]
    }
  }
}
```

Replace the executable path with your installation path. On Windows, use
the path to `mtkprof.exe` and escape backslashes in JSON (or use forward
slashes). Other clients may use different configuration keys; the executable
and arguments are the same. No server URL or mtkprof API key is needed for
standalone use.

To preload a case, use arguments such as
`["mcp", "/absolute/path/to/trace.trc"]`. Parsing is deferred until the first
tool call that needs a trace. Without preloaded paths, the assistant opens
the case with `open_trace`.

## How a request works

1. The client starts `mtkprof mcp` as a subprocess and connects to its stdin
   and stdout.
2. It sends `initialize`; the server returns its protocol version,
   capabilities and, in standalone mode, analysis instructions. The client
   then sends `notifications/initialized`.
3. It sends `tools/list`; the server returns tool names, descriptions and
   JSON argument schemas.
4. The assistant chooses a tool and arguments. The client sends a
   `tools/call` request, for example:

   ```json
   {"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"open_trace","arguments":{"paths":["/absolute/path/to/trace.trc"]}}}
   ```

5. mtkprof runs the analysis and returns JSON as an MCP text content block.
   The client gives the result to the model, which may request more tools
   before answering.

Messages are one JSON-RPC object per line. Stdout carries only the protocol;
diagnostics go to stderr. The server also supports `ping`. It exposes tools;
it does not implement MCP resources or prompt templates. Tool failures, such
as an unreadable trace or invalid arguments, return `isError: true` so the
assistant can correct the call.

## Available tools

| Tool | Purpose |
|---|---|
| `open_trace` | Open files or a directory as one trace set and return its overview. A successful open replaces the previous set; a failed open leaves it available. |
| `overview` | Summarize files, sessions, response time, CPU, waits, top statements and findings. |
| `statements`, `statement` | Rank statements or inspect one statement's SQL, calls, waits and plans. |
| `executions` | Inspect executions, timings and bind values for a statement. |
| `pivot` | Group calls or waits by dimensions such as statement, event or session context. |
| `timeline` | Aggregate activity into time buckets. |
| `lines`, `search_lines` | Read trace lines or find text and regular-expression matches. |

Scoped analysis tools accept `from`/`to` in trace-time microseconds and
session `contexts`; the discovery schemas describe each tool's arguments.
Results are capped at about 8,000 tokens. When a result is truncated, the
assistant should narrow the scope or use the tool's pagination.

The standalone server keeps one trace set open at a time. It uses the
in-memory model; it does not use the desktop's persistent index cache or the
CLI's spill mode. The tools report what was captured: missing waits, binds
or STAT plan lines cannot be reconstructed from the trace.

## Standalone and desktop bridge modes

| | Standalone | Desktop bridge |
|---|---|---|
| Selected by | `MTKPROF_ENGINE` is unset. | `MTKPROF_ENGINE` names a running engine. |
| Trace | Opened locally by `open_trace` or supplied on the command line. | An existing engine session, selected by `MTKPROF_SESSION`. |
| Execution | Tools run inside the MCP process. | MCP forwards calls to the engine over authenticated HTTP. |
| Additional tools | `open_trace`. | `notes`, `current_view`, `show` for desktop context and navigation. |
| Bind policy | `-binds mask` (default) or `-binds keep`. | Controlled by the engine and conversation; the CLI flag does not override it. |

The desktop app configures the bridge when it starts a CLI assistant. You
do not need to register a standalone server to use the desktop assistant.
See the [desktop assistant guide](DESKTOP.md#assistant).

For integrations, the bridge reads these environment variables:

| Variable | Meaning |
|---|---|
| `MTKPROF_ENGINE` | Engine `host:port` or base URL; selects bridge mode. |
| `MTKPROF_TOKEN` | Required engine bearer token. |
| `MTKPROF_SESSION` | Existing trace session whose tools will be called. |
| `MTKPROF_CONVERSATION` | Optional conversation ID; associates calls with its scope, masking, desktop context and turn events. |

Tool discovery uses `GET /engine/assist/tools`; calls use
`POST /s/{session}/api/assist/tools/{name}`. The token goes in the
`Authorization` header, and the conversation ID in `X-Mtkprof-Conversation`.
These are the engine's internal HTTP routes; the client still talks MCP
over stdio. See [api/engine.openapi.yaml](../api/engine.openapi.yaml) for
the engine API and [DESIGN.md](DESIGN.md) for the assistant architecture.

## Data sent to the model

Standalone parsing and analysis run locally. Your AI client decides what
it sends to its model, including your question and tool results. Those
results can include SQL text, file names, session metadata and trace lines.
The MCP server does not require a model credential or contact a model itself.

Bind values are masked by default as type, length and a salted hash, for
example `<NUMBER len=2 h=…>`. The salt is random per MCP server process:
equal values match across every trace opened by that process. Restarting
the server creates a new salt. In desktop conversations, masking is managed
by the engine and conversation instead.

`-binds keep` exposes captured bind values. SQL text, including literal
values, is never masked. The standalone server does not show the desktop's
per-trace/provider consent dialog; use your client's controls to decide
which model receives results.

## Troubleshooting

| Symptom | What to check |
|---|---|
| Client cannot start the server | Run `mtkprof version` and `mtkprof mcp -h`. Use an absolute executable path if the client's PATH differs from your terminal's. |
| `mtkprof mcp` appears to wait in a terminal | It is waiting for JSON-RPC on stdin. Configure it in the MCP client, which launches and communicates with it. |
| No trace is open | Ask the assistant to call `open_trace` with absolute paths, or configure trace paths after the `mcp` argument. |
| File does not exist or cannot be read | Check the path and permissions on the server's machine. A path on your laptop is not automatically available to a client running in a container or on a remote host. |
| Unexpected engine/token errors | Check for an inherited `MTKPROF_ENGINE`. Remove the `MTKPROF_*` bridge variables from the standalone server's environment and restart it. |
| Engine connection refused, unauthorized, or session gone | In bridge mode, check that the engine is running and its address, token, session and optional conversation are still valid. |
| Missing `notes`, `current_view` or `show` | Those tools require desktop bridge mode. Standalone clients use trace evidence and `file:line` citations. |
| Results are truncated | Narrow the time window, statement or session context, or request another page. |

For diagnostics, inspect the client's MCP server logs (stderr). Keep stdout
free of shell banners or wrapper-script messages, which would corrupt the
protocol.
