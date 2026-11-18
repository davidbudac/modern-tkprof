import type { DiagFile } from '../../data/diag'
import { describeFile, releaseOf } from '../../data/diagdoc'
import { fmtInt } from '../../data/format'

/** The facts of the file above the toolbar: what it is, the release and version, the lines, and the notes the reader owes (another version, lines in no known part, an incident, 10046 records). */
export function DiagFacts({ file, onOpenAs10046 }: { file: DiagFile; onOpenAs10046?: () => void }) {
  const inc = file.incident
  const rel = releaseOf(file)
  return (
    <div className="opt-info dg-info" aria-label="The file">
      <span><b>{file.name}</b></span>
      <span title="What the parser found in the file">{describeFile(file)}</span>
      {rel && <span>{rel}</span>}
      {file.version && <span>Version <b>{file.version}</b></span>}
      <span><b>{fmtInt(file.lines)}</b> lines</span>
      {!file.tested && <span className="opt-warn" title="The rules were written for 19c; another version is read best effort">read with the 19c rules; this file is {file.version || 'of no version the prologue names'}</span>}
      {!file.tested && <span className="opt-warn" title="Lines outside the file header and every section that are none of: blank, a marker, a rule line, a 10046 record">{fmtInt(file.unplaced)} {file.unplaced === 1 ? 'line' : 'lines'} outside any known part</span>}
      {inc && (
        <span title={inc.dumpFile}>Incident{inc.id ? <> <b>{inc.id}</b></> : null}{inc.problem ? <> · {inc.problem}</> : null}{inc.continuedFrom ? <> · continued from <span className="dg-mono">{inc.continuedFrom.split('/').pop()}</span></> : null}</span>
      )}
      {file.records10046 > 0 && (
        <span title="Lines of SQL trace (10046) records, shown as plain text here">
          <b>{fmtInt(file.records10046)}</b> {file.records10046 === 1 ? 'line' : 'lines'} of 10046 records; open it as a SQL trace for them
          {onOpenAs10046 && <> <button type="button" className="link" onClick={onOpenAs10046}>Open as SQL trace</button></>}
        </span>
      )}
    </div>
  )
}
