import { useEffect, useState } from 'react'
import { copyText } from '@lib/data/clipboard'
import { appInfo, inTauri } from '../platform'
import type { AssistBinds } from './settings'

/** The setup and tool list of `mtkprof mcp`, until the docs site is hosted. */
export const MCP_DOCS_URL = 'https://github.com/davidbudac/modern-tkprof#claude-code-and-other-mcp-clients'

/** Quoted for the shell when it holds a space (the app bundle's path on Windows, a renamed folder). */
const arg = (s: string) => (/[\s'"]/.test(s) ? `"${s}"` : s)

/** `claude mcp add` for the engine binary this app ships, with the bind setting of Settings → Assistant. */
export function mcpAddCommand(enginePath: string | undefined, binds: AssistBinds): string {
  const bin = inTauri && enginePath ? arg(enginePath) : 'mtkprof'
  return `claude mcp add -s user mtkprof -- ${bin} mcp${binds === 'keep' ? ' -binds keep' : ''}`
}

/** Settings → Assistant → Claude Code: the other way round, the user's own agent drives mtkprof's tools. */
export function McpSection({ binds }: { binds: AssistBinds }) {
  const [enginePath, setEnginePath] = useState<string>()
  const [copied, setCopied] = useState<string | null>(null)
  useEffect(() => {
    appInfo().then((i) => setEnginePath(i.enginePath), () => {})
  }, [])
  const cmd = mcpAddCommand(enginePath, binds)

  return (
    <>
      <h3>Claude Code and other MCP agents</h3>
      <p className="muted small">
        The same analysis tools also run as an MCP server for an agent you already use. Instead of chatting here about an open tab, you describe the
        problem in Claude Code (or any MCP client) and give it the trace's path; it opens the trace itself and digs in with the tools this panel uses.
      </p>

      <figure className="mcp-flow" aria-label="Two ways to ask about a trace">
        <div className="mcp-lane">
          <span className="mcp-lane-label">In this app</span>
          <span className="mcp-node">You</span>
          <span className="mcp-arrow" aria-hidden="true">→</span>
          <span className="mcp-node">Assistant panel</span>
          <span className="mcp-arrow" aria-hidden="true">→</span>
          <span className="mcp-node">provider or CLI</span>
          <span className="mcp-arrow" aria-hidden="true">⇄</span>
          <span className="mcp-node mcp-tools">mtkprof tools</span>
          <span className="mcp-arrow" aria-hidden="true">→</span>
          <span className="mcp-node">open tab</span>
        </div>
        <div className="mcp-lane mcp-new">
          <span className="mcp-lane-label">In your terminal</span>
          <span className="mcp-node">You</span>
          <span className="mcp-arrow" aria-hidden="true">→</span>
          <span className="mcp-node">Claude Code</span>
          <span className="mcp-arrow" aria-hidden="true">⇄</span>
          <span className="mcp-node mcp-tools">mtkprof mcp</span>
          <span className="mcp-arrow" aria-hidden="true">→</span>
          <span className="mcp-node mono">.trc files</span>
        </div>
        <figcaption className="muted small">
          Same tools, same numbers. The MCP server parses the files on your machine, calls no model and holds no key; only what the agent sends its own
          model leaves the machine. It works without this app running.
        </figcaption>
      </figure>

      <div className="field">
        <span className="label">Add it once</span>
        <span className="mcp-cmd">
          <code className="mono small">{cmd}</code>
          <button onClick={() => void copyText(cmd).then((ok) => setCopied(ok ? 'Copied.' : 'Could not copy to the clipboard.'))}>Copy</button>
        </span>
        {copied && <small className="muted" role="status">{copied}</small>}
      </div>
      <ul className="muted small mcp-notes">
        <li>
          Then ask in Claude Code, for example: <i>“the batch traced in /u01/…/orcl_ora_4711.trc got slow after 14:05, why?”</i> It cites trace lines as{' '}
          <span className="mono">file:line</span>.
        </li>
        <li>
          Bind values are {binds === 'keep' ? 'kept, as set above' : 'masked, as set above'}; SQL text is sent as traced.
          {inTauri && ' The command points into this app: run it again after moving the app.'}
        </li>
        <li>Notes, the current view and “show me” links are app-only: the agent sees the trace, not your tabs.</li>
      </ul>
      <p className="small">
        <a href={MCP_DOCS_URL} target="_blank" rel="noopener">How it works, the tools and setup for other agents →</a>
      </p>
    </>
  )
}
