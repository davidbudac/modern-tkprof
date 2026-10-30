/** Status belongs to the input file, even when the views combine many files. */
export function FileStatus({ file }: { file: { truncated?: boolean; continuedFrom?: readonly string[] } }) {
  return <>
    {file.truncated && <span className="chip-q file-status truncated" title="This file was cut by max_dump_file_size; its trace data is incomplete."><span aria-hidden="true">⚠ </span>Truncated</span>}
    {!!file.continuedFrom?.length && <span className="chip-q file-status" title={`This file continues an earlier trace: ${file.continuedFrom.join(', ')}`}><span aria-hidden="true">↳ </span>Continued</span>}
  </>
}
