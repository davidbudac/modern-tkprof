import type { PlanNode } from './types.js';
export interface FormatOptions {
    empty?: string;
    infinity?: string;
}
export declare function formatNumberShort(value?: number, options?: FormatOptions): string | undefined;
export declare function formatBytes(value?: number, options?: FormatOptions): string | undefined;
export declare function formatTimeCompact(value?: number, options?: FormatOptions): string | undefined;
export declare function formatTimeShort(value?: number, options?: FormatOptions): string | undefined;
export declare function formatTimeDetailed(value?: number, options?: FormatOptions): string | undefined;
/**
 * Compute the ratio between actual and estimated rows. Returns undefined if either is missing.
 * Both operands are floored at 1 (Oracle itself floors E-Rows at 1), so the result is never
 * 0 or Infinity: E-Rows=1 vs A-Rows=0 is "accurate", not an infinite underestimate.
 * The estimate must be comparable with `aRows` (all starts) — prefer `nodeCardinalityRatio`.
 */
export declare function computeCardinalityRatio(eRows?: number, aRows?: number): number | undefined;
/**
 * THE function UI and advisor code should use for estimate-vs-actual comparisons.
 * Compares A-Rows with the estimate over all starts (`estimatedRowsTotal`), never the
 * per-start E-Rows. Undefined when no comparable estimate exists (never started,
 * early termination, no actual stats).
 */
export declare function nodeCardinalityRatio(node: PlanNode): number | undefined;
/**
 * Effective number of executions behind `estimatedRowsTotal` (total ÷ per-start E-Rows),
 * or undefined when the operation effectively ran once / there is no comparable total.
 * Not necessarily `Starts`: PX slave sets, partition iterators and NLJ-batched rowid
 * fetches derive their total differently (see `computeEstimatedRowTotals`).
 */
export declare function effectiveExecutions(node: Pick<PlanNode, 'rows' | 'estimatedRowsTotal'>): number | undefined;
/**
 * The per-start estimate as shown next to A-Rows (which is cumulative over all executions).
 * When the operation ran more than once it reads `E-Rows × executions` (e.g. "4 × 20.0K") so the
 * estimate is comparable with the actual at a glance; otherwise it is the plain E-Rows.
 * `title` explains the product and is only set for the `×` form. Tabular columns should keep
 * using the plain number.
 */
export declare function formatEstimatedRows(node: PlanNode, hasActualStats?: boolean): {
    text: string;
    title?: string;
};
/**
 * One-line explanation of a node's estimate-vs-actual comparison, e.g.
 * "Cardinality mismatch: estimated 1,000 rows (E-Rows 1 × 1,000 starts) vs A-Rows 250,000".
 * The "× starts" breakdown appears only when it changes the number.
 */
export declare function cardinalityMismatchText(node: PlanNode): string;
/** Format a cardinality ratio as a human-readable string like "10x over" or "5x under". */
export declare function formatCardinalityRatio(ratio: number | undefined): string | undefined;
/** Return a severity level for a cardinality ratio: 'good', 'warn', or 'bad'. */
export declare function cardinalityRatioSeverity(ratio: number | undefined): 'good' | 'warn' | 'bad';
/**
 * Format a partition Pstart/Pstop pair as a compact range string.
 * Returns e.g. "15–20", or "9" when start === stop (single partition),
 * or undefined when no partition range is present. Non-numeric markers
 * (KEY, KEY(I), :BFnnnn, ROWID, etc.) are passed through unchanged.
 */
export declare function formatPartitionRange(pstart?: string, pstop?: string): string | undefined;
