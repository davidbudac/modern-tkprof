import { useEffect, useState } from 'react'
import { copyText } from '@lib/data/clipboard'
import { appInfo, inApp } from '../platform'
import type { AssistBinds } from './settings'
import { Card, Row, SubHead } from './parts'

/** The setup and tool list of `mtkprof mcp`, until the docs site is hosted. */
export const MCP_DOCS_URL = 'https://github.com/davidbudac/modern-tkprof#claude-code-and-other-mcp-clients'

/** Quoted for the shell when it holds a space (the app bundle's path on Windows, a renamed folder). */
const arg = (s: string) => (/[\s'"]/.test(s) ? `"${s}"` : s)

/** `claude mcp add` for the engine binary this app ships, with the bind setting of Settings → Assistant. */
export function mcpAddCommand(enginePath: string | undefined, binds: AssistBinds): string {
  const bin = inApp && enginePath ? arg(enginePath) : 'mtkprof'
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
      <SubHead
        title="Claude Code and other MCP agents"
        desc="The same analysis tools also run as an MCP server for an agent you already use. You describe the problem in Claude Code (or any MCP client) and give it the trace's path; it opens the trace itself and digs in with the tools this panel uses"
      />
      <Card>
        <figure className="mcp-flow" aria-label="Two ways to ask about a trace">
          <div className="mcp-grid">
            <div className="mcp-lane">
              <span className="mcp-lane-label">In this app</span>
              <span className="mcp-node">You</span>
              <span className="mcp-arrow" aria-hidden="true">→</span>
              <span className="mcp-node">Assistant panel</span>
              <span className="mcp-arrow" aria-hidden="true">→</span>
              <span className="mcp-node">Provider or CLI</span>
              <span className="mcp-arrow" aria-hidden="true">⇄</span>
              <span className="mcp-node mcp-tools">mtkprof tools</span>
              <span className="mcp-arrow" aria-hidden="true">→</span>
              <span className="mcp-node">Open tab</span>
            </div>
            <div className="mcp-lane">
              <span className="mcp-lane-label">In your terminal</span>
              <span className="mcp-node">You</span>
              <span className="mcp-arrow" aria-hidden="true">→</span>
              <span className="mcp-node mcp-wide">Claude Code</span>
              <span className="mcp-arrow" aria-hidden="true">⇄</span>
              <span className="mcp-node mcp-tools">mtkprof mcp</span>
              <span className="mcp-arrow" aria-hidden="true">→</span>
              <span className="mcp-node mono">.trc files</span>
            </div>
          </div>
          <figcaption className="set-desc">
            Same tools, same numbers. The MCP server parses the files on your machine, calls no model and holds no key; only what the agent sends its
            own model leaves the machine. It works without this app running.
          </figcaption>
        </figure>
        <Row label="Add it once" desc={<>Then ask in Claude Code, for example “the batch traced in /u01/…/orcl_ora_4711.trc got slow after 14:05, why?” It cites trace lines as <span className="mono">file:line</span></>} stack>
          <span className="mcp-cmd">
            <code className="mono"><span className="mcp-prompt" aria-hidden>$</span>{cmd}</code>
            <button
              onClick={() =>
                void copyText(cmd).then((ok) => {
                  setCopied(ok ? 'ok' : 'failed')
                  if (ok) setTimeout(() => setCopied(null), 2000)
                })
              }
            >
              {copied === 'ok' ? 'Copied' : 'Copy'}
            </button>
          </span>
          {copied === 'failed' && <small className="warn-text" role="status">Could not copy to the clipboard</small>}
        </Row>
        <div className="set-foot">
          <ul className="mcp-notes">
            <li>
              Bind values are {binds === 'keep' ? 'kept, as set above' : 'masked, as set above'}; SQL text is sent as traced.
              {inApp && ' The command points into this app: run it again after moving the app.'}
            </li>
            <li>Notes, the current view and “show me” links are app-only: the agent sees the trace, not your tabs.</li>
          </ul>
          <a href={MCP_DOCS_URL} target="_blank" rel="noopener">How it works, the tools and setup for other agents →</a>
        </div>
      </Card>
    </>
  )
}
