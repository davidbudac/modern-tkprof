export function formatNumberShort(value, options = {}) {
    if (value === undefined)
        return options.empty;
    if (value === Infinity)
        return options.infinity ?? '∞';
    if (value >= 1000000)
        return (value / 1000000).toFixed(1) + 'M';
    if (value >= 1000)
        return (value / 1000).toFixed(1) + 'K';
    return value.toString();
}
export function formatBytes(value, options = {}) {
    if (value === undefined)
        return options.empty;
    if (value === Infinity)
        return options.infinity ?? '∞';
    if (value >= 1073741824)
        return (value / 1073741824).toFixed(1) + ' GB';
    if (value >= 1048576)
        return (value / 1048576).toFixed(1) + ' MB';
    if (value >= 1024)
        return (value / 1024).toFixed(1) + ' KB';
    return value + ' B';
}
export function formatTimeCompact(value, options = {}) {
    if (value === undefined)
        return options.empty;
    if (value === Infinity)
        return options.infinity ?? '∞';
    if (value >= 60000) {
        const mins = Math.floor(value / 60000);
        const secs = ((value % 60000) / 1000).toFixed(1);
        return `${mins}m ${secs}s`;
    }
    if (value >= 1000)
        return (value / 1000).toFixed(2) + 's';
    return value.toFixed(0) + 'ms';
}
export function formatTimeShort(value, options = {}) {
    if (value === undefined)
        return options.empty;
    if (value === Infinity)
        return options.infinity ?? '∞';
    if (value >= 60000)
        return (value / 60000).toFixed(1) + 'm';
    if (value >= 1000)
        return (value / 1000).toFixed(2) + 's';
    return value.toFixed(0) + 'ms';
}
export function formatTimeDetailed(value, options = {}) {
    if (value === undefined)
        return options.empty;
    if (value === Infinity)
        return options.infinity ?? '∞';
    if (value >= 60000) {
        const minutes = Math.floor(value / 60000);
        const seconds = ((value % 60000) / 1000).toFixed(1);
        return `${minutes}m ${seconds}s`;
    }
    if (value >= 1000)
        return (value / 1000).toFixed(2) + 's';
    if (value >= 1)
        return value.toFixed(1) + 'ms';
    return (value * 1000).toFixed(0) + 'us';
}
/**
 * Compute the ratio between actual and estimated rows. Returns undefined if either is missing.
 * Both operands are floored at 1 (Oracle itself floors E-Rows at 1), so the result is never
 * 0 or Infinity: E-Rows=1 vs A-Rows=0 is "accurate", not an infinite underestimate.
 * The estimate must be comparable with `aRows` (all starts) — prefer `nodeCardinalityRatio`.
 */
export function computeCardinalityRatio(eRows, aRows) {
    if (eRows === undefined || aRows === undefined)
        return undefined;
    return Math.max(aRows, 1) / Math.max(eRows, 1);
}
/**
 * THE function UI and advisor code should use for estimate-vs-actual comparisons.
 * Compares A-Rows with the estimate over all starts (`estimatedRowsTotal`), never the
 * per-start E-Rows. Undefined when no comparable estimate exists (never started,
 * early termination, no actual stats).
 */
export function nodeCardinalityRatio(node) {
    return computeCardinalityRatio(node.estimatedRowsTotal, node.actualRows);
}
/**
 * Effective number of executions behind `estimatedRowsTotal` (total ÷ per-start E-Rows),
 * or undefined when the operation effectively ran once / there is no comparable total.
 * Not necessarily `Starts`: PX slave sets, partition iterators and NLJ-batched rowid
 * fetches derive their total differently (see `computeEstimatedRowTotals`).
 */
export function effectiveExecutions(node) {
    const { rows, estimatedRowsTotal: total } = node;
    if (rows === undefined || total === undefined || rows <= 0 || total <= rows)
        return undefined;
    const raw = total / rows;
    // Floating noise (e.g. 80000 / 4 computed from a rounded total) — it is an execution count.
    const rounded = Math.round(raw);
    const executions = Math.abs(raw - rounded) < 1e-6 * Math.max(1, raw) ? rounded : raw;
    return executions > 1 ? executions : undefined;
}
/**
 * The per-start estimate as shown next to A-Rows (which is cumulative over all executions).
 * When the operation ran more than once it reads `E-Rows × executions` (e.g. "4 × 20.0K") so the
 * estimate is comparable with the actual at a glance; otherwise it is the plain E-Rows.
 * `title` explains the product and is only set for the `×` form. Tabular columns should keep
 * using the plain number.
 */
export function formatEstimatedRows(node, hasActualStats = true) {
    const plain = { text: formatNumberShort(node.rows, { empty: '—' }) };
    if (!hasActualStats)
        return plain;
    const executions = effectiveExecutions(node);
    if (executions === undefined || node.rows === undefined || node.estimatedRowsTotal === undefined)
        return plain;
    const execText = Number.isInteger(executions) ? executions.toLocaleString('en-US') : executions.toFixed(1);
    const perExec = node.rows.toLocaleString('en-US');
    return {
        text: `${formatNumberShort(node.rows)} × ${formatNumberShort(executions).replace(/\.0(?=[KM]$)/, '')}`,
        title: `${perExec} ${node.rows === 1 ? 'row' : 'rows'} per execution × ${execText} executions = ` +
            `${Math.round(node.estimatedRowsTotal).toLocaleString('en-US')} estimated in total ` +
            `(A-Rows is the total over all executions)`,
    };
}
/**
 * One-line explanation of a node's estimate-vs-actual comparison, e.g.
 * "Cardinality mismatch: estimated 1,000 rows (E-Rows 1 × 1,000 starts) vs A-Rows 250,000".
 * The "× starts" breakdown appears only when it changes the number.
 */
export function cardinalityMismatchText(node) {
    const total = node.estimatedRowsTotal;
    const fmt = (n) => formatNumberShort(n) ?? '?';
    if (total === undefined) {
        return `Cardinality mismatch: E-Rows ${fmt(node.rows)} vs A-Rows ${fmt(node.actualRows)}`;
    }
    const perStart = node.starts !== undefined && node.starts > 1 && node.rows !== undefined && node.rows !== total
        ? ` (E-Rows ${fmt(node.rows)} × ${fmt(node.starts)} starts)`
        : '';
    return `Cardinality mismatch: estimated ${fmt(total)} rows${perStart} vs A-Rows ${fmt(node.actualRows)}`;
}
/** Format a cardinality ratio as a human-readable string like "10x over" or "5x under". */
export function formatCardinalityRatio(ratio) {
    if (ratio === undefined)
        return undefined;
    if (ratio === Infinity)
        return '∞ over';
    if (ratio >= 1) {
        if (ratio < 1.5)
            return 'accurate';
        return `${ratio >= 100 ? Math.round(ratio) : ratio.toFixed(1)}x over`;
    }
    const inverse = 1 / ratio;
    if (inverse < 1.5)
        return 'accurate';
    return `${inverse >= 100 ? Math.round(inverse) : inverse.toFixed(1)}x under`;
}
/** Return a severity level for a cardinality ratio: 'good', 'warn', or 'bad'. */
export function cardinalityRatioSeverity(ratio) {
    if (ratio === undefined)
        return 'good';
    const deviation = ratio >= 1 ? ratio : 1 / ratio;
    if (deviation >= 10)
        return 'bad';
    if (deviation >= 3)
        return 'warn';
    return 'good';
}
/**
 * Format a partition Pstart/Pstop pair as a compact range string.
 * Returns e.g. "15–20", or "9" when start === stop (single partition),
 * or undefined when no partition range is present. Non-numeric markers
 * (KEY, KEY(I), :BFnnnn, ROWID, etc.) are passed through unchanged.
 */
export function formatPartitionRange(pstart, pstop) {
    const start = pstart?.trim() || undefined;
    const stop = pstop?.trim() || undefined;
    if (!start && !stop)
        return undefined;
    if (start && stop) {
        return start === stop ? start : `${start}–${stop}`;
    }
    return start ?? stop;
}
