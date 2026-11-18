/** The assistant's panel in a 10053 or dump tab: the assistant does not read optimizer traces or diagnostic dump files in this version, so it says so instead of offering to analyze. */
export function OptAssistantNotice({ what = 'optimizer (10053) traces', onClose }: { what?: string; onClose: () => void }) {
  return (
    <aside className="chat-panel" aria-label="Assistant">
      <header className="chat-head">
        <h2>Assistant</h2>
        <span className="spacer" />
        <button className="quiet chat-close" onClick={onClose} aria-label="Close the assistant" title="Close">×</button>
      </header>
      <div className="chat-log">
        <p className="msg-note" role="status">
          The assistant does not read {what} in this version. It works on 10046 traces: open one in a tab of its own and ask there.
        </p>
      </div>
    </aside>
  )
}
