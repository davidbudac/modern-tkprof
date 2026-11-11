/** The assistant's panel in a 10053 tab: the assistant does not read optimizer traces in this version, so it says so instead of offering to analyze. */
export function OptAssistantNotice({ onClose }: { onClose: () => void }) {
  return (
    <aside className="chat-panel" aria-label="Assistant">
      <header className="chat-head">
        <h2>Assistant</h2>
        <span className="spacer" />
        <button className="quiet chat-close" onClick={onClose} aria-label="Close the assistant" title="Close">×</button>
      </header>
      <div className="chat-log">
        <p className="msg-note" role="status">
          The assistant does not read optimizer (10053) traces in this version. It works on 10046 traces: open one in a tab of its own and ask there.
        </p>
      </div>
    </aside>
  )
}
