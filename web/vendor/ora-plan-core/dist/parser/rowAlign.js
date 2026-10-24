/**
 * Robustness for plan tables whose data rows do not line up with the header — hand-edited or
 * re-pasted plans where an operation name overflows its column by a character. Real Oracle
 * output is aligned, so rows normally keep the header's column ranges untouched.
 */
const isRange = (value) => typeof value === 'object' && value !== null
    && typeof value.start === 'number' && typeof value.end === 'number';
/** Indexes of every `|` in a line. */
export function pipeIndexes(line) {
    const pipes = [];
    for (let i = 0; i < line.length; i++) {
        if (line[i] === '|')
            pipes.push(i);
    }
    return pipes;
}
/**
 * Column ranges for one data row. When the row has the same number of `|` as the header but
 * not at the header's positions, each range moves to the row's own pipes (cell i ↔ header
 * column i); the cell still starts right after its pipe, so operation indentation stays
 * comparable with aligned rows. Otherwise the header ranges are returned as they are.
 */
export function alignColumnsToRow(columns, headerPipes, line) {
    const pipes = pipeIndexes(line);
    if (pipes.length !== headerPipes.length)
        return columns;
    if (pipes.every((pos, i) => pos === headerPipes[i]))
        return columns;
    const remap = (value) => {
        if (isRange(value)) {
            const from = headerPipes.indexOf(value.start - 1);
            const to = headerPipes.indexOf(value.end);
            return from >= 0 && to > from ? { start: pipes[from] + 1, end: pipes[to] } : value;
        }
        if (typeof value === 'object' && value !== null) {
            return Object.fromEntries(Object.entries(value).map(([key, inner]) => [key, remap(inner)]));
        }
        return value;
    };
    return remap(columns);
}
