/**
 * Robustness for plan tables whose data rows do not line up with the header — hand-edited or
 * re-pasted plans where an operation name overflows its column by a character. Real Oracle
 * output is aligned, so rows normally keep the header's column ranges untouched.
 */
/** Indexes of every `|` in a line. */
export declare function pipeIndexes(line: string): number[];
/**
 * Column ranges for one data row. When the row has the same number of `|` as the header but
 * not at the header's positions, each range moves to the row's own pipes (cell i ↔ header
 * column i); the cell still starts right after its pipe, so operation indentation stays
 * comparable with aligned rows. Otherwise the header ranges are returned as they are.
 */
export declare function alignColumnsToRow<T extends object>(columns: T, headerPipes: number[], line: string): T;
