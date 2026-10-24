/**
 * Small pure value parsers shared by the DBMS_XPLAN and SQL Monitor text parsers.
 *
 * Oracle abbreviates large numbers in plan tables with a letter suffix. Counts
 * (Rows, Starts, Buffers, Cost…) use 1000-based suffixes; sizes (memory, temp)
 * use 1024-based ones.
 */
/** Line endings to `\n` (CRLF and lone CR) so files saved on Windows/old Mac parse like LF ones. */
export declare function normalizeNewlines(input: string): string;
/** Expand tabs to spaces on 8-column tab stops. */
export declare function expandTabs(line: string, tabSize?: number): string;
/**
 * Expand tabs in plan-table lines (those starting with `|`) so column slicing and
 * indentation depth see real columns. Other lines (SQL text, predicates) are untouched.
 */
export declare function expandTableTabs(lines: string[]): string[];
/** Count with 1000-based K/M/G/T/P/E suffixes; commas allowed ("1,234", "4823K"). */
export declare function parseCount(str: string): number | null;
/** Byte size with 1024-based K/M/G/T/P/E suffixes and an optional trailing B ("2048K", "10M", "512B"). */
export declare function parseByteSize(str: string): number | null;
/** "123 (5)", "4823K (1)", "13M  (2)" → cost (1000-based suffix) and the %CPU in parentheses. */
export declare function parseCostCell(str: string): {
    cost: number;
    cpuPercent?: number;
} | null;
/**
 * ALLSTATS Used-Mem: memory used by the last execution plus, in parentheses, how
 * many passes the work area needed (0 optimal, 1 one-pass, n > 1 multipass).
 * "1385K (0)" → { bytes: 1418240, passes: 0 }.
 */
export declare function parseUsedMem(str: string): {
    bytes: number;
    passes?: number;
} | null;
/** ALLSTATS (without LAST) O/1/M column: executions that ran optimal / one-pass / multipass ("1/0/0"). */
export declare function parseWorkareaExecutions(str: string): {
    optimal: number;
    onePass: number;
    multipass: number;
} | null;
/** A-Time ("00:00:00.06", "01:02:03", or plain seconds) → milliseconds. */
export declare function parseTimeToMs(timeStr: string): number | null;
