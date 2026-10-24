import { extractPredicateColumns } from "../../metadata/predicateColumns.js";
const FULL_SCAN_RE = /TABLE ACCESS (STORAGE )?FULL/;
const PARTITION_ITERATOR_RE = /^(?:PX )?PARTITION\b/i;
const PARTITION_ALL_RE = /\bALL\b/i;
/** Pstop of an interval-partitioned table that is not pruned. */
const INTERVAL_MAX_PARTITION = 1_048_575;
function partitionIteratorOf(node, byId) {
    let parent = node.parentId !== undefined ? byId.get(node.parentId) : undefined;
    while (parent && /^PX BLOCK/i.test(parent.operation)) {
        parent = parent.parentId !== undefined ? byId.get(parent.parentId) : undefined;
    }
    return parent && PARTITION_ITERATOR_RE.test(parent.operation) ? parent : undefined;
}
function scanScope(node, table, byId) {
    if (!table.stats.partitioned)
        return { kind: 'whole' };
    const iterator = partitionIteratorOf(node, byId);
    const pstart = node.pstart ?? iterator?.pstart;
    const pstop = node.pstop ?? iterator?.pstop;
    if (!iterator && pstart === undefined && pstop === undefined)
        return { kind: 'unknown' };
    if (iterator && PARTITION_ALL_RE.test(iterator.operation))
        return { kind: 'whole' };
    const partitionCount = table.stats.partition_count;
    const start = pstart !== undefined && /^\d+$/.test(pstart.trim()) ? Number(pstart) : undefined;
    const stop = pstop !== undefined && /^\d+$/.test(pstop.trim()) ? Number(pstop) : undefined;
    if (start === 1 && stop !== undefined && (stop >= INTERVAL_MAX_PARTITION || (partitionCount !== undefined && stop >= partitionCount))) {
        return { kind: 'whole' };
    }
    // Subpartition numbering makes Pstart/Pstop counts unreliable.
    const composite = !!table.stats.subpartition_type && table.stats.subpartition_type !== 'NONE';
    if (iterator && /\bSINGLE\b/i.test(iterator.operation) && !composite)
        return { kind: 'pruned', partitions: 1 };
    if (start !== undefined && stop !== undefined && stop >= start && !composite) {
        return { kind: 'pruned', partitions: stop - start + 1 };
    }
    return { kind: 'pruned' };
}
export const selectiveFullScanRule = {
    id: 'selective-full-scan',
    evaluate(ctx) {
        const findings = [];
        const { ftsMinTableRows, ftsSelectivityWarn, ftsSelectivityCritical, ftsCriticalMinTableRows, ftsFallbackMaxRowsPerStart, ftsFallbackMinGetsPerStart, maxFindingsPerRule, } = ctx.thresholds;
        const byId = new Map(ctx.plan.allNodes.map((n) => [n.id, n]));
        for (const node of ctx.plan.allNodes) {
            if (!FULL_SCAN_RE.test(node.operation.toUpperCase()))
                continue;
            if (!node.accessPredicates && !node.filterPredicates)
                continue;
            if (node.starts === 0)
                continue;
            const match = ctx.findObject(node.objectName);
            const table = match && match.object.type === 'TABLE' ? match.object : undefined;
            // Rows the scan could read: the whole table, or for a pruned scan of a partitioned table an
            // even-partition share of it. Without the partition count a pruned scan has no usable
            // denominator, so only the measured buffer-gets fallback below can judge it.
            let tableRows = table?.stats.num_rows ?? undefined;
            let partitionNote = '';
            if (table && tableRows !== undefined) {
                const scope = scanScope(node, table, byId);
                const partitionCount = table.stats.partition_count;
                if (scope.kind === 'unknown') {
                    tableRows = undefined;
                }
                else if (scope.kind === 'pruned') {
                    if (scope.partitions !== undefined && partitionCount !== undefined && partitionCount > 0) {
                        const scanned = Math.min(scope.partitions, partitionCount);
                        tableRows = Math.round((tableRows * scanned) / partitionCount);
                        partitionNote = ` (${scanned.toLocaleString()} of ${partitionCount.toLocaleString()} partitions; estimated as table rows x partitions scanned / partition count, assuming evenly sized partitions)`;
                    }
                    else {
                        tableRows = undefined;
                    }
                }
            }
            const returned = node.actualRows ?? node.rows;
            let finding = null;
            if (tableRows !== undefined && tableRows >= ftsMinTableRows && returned !== undefined) {
                const selectivity = tableRows > 0 ? returned / tableRows : 0;
                if (selectivity <= ftsSelectivityWarn) {
                    const isCritical = selectivity <= ftsSelectivityCritical && tableRows >= ftsCriticalMinTableRows;
                    const columns = extractPredicateColumns(node.accessPredicates, node.filterPredicates);
                    finding = {
                        ruleId: 'selective-full-scan',
                        severity: isCritical ? 'critical' : 'warning',
                        nodeIds: [node.id],
                        title: `Selective full scan on ${node.operation}`,
                        explanation: `Full scan of ${partitionNote ? `about ${tableRows.toLocaleString()} rows in the partitions scanned${partitionNote}` : `a table with ${tableRows.toLocaleString()} rows`} returned only ${returned.toLocaleString()} rows (${(selectivity * 100).toFixed(3)}% selectivity).`,
                        suggestion: columns.length > 0
                            ? `Consider an index on ${columns.join(', ')} to avoid scanning the entire table for this filter.`
                            : 'Consider an index on the filtered column(s) to avoid scanning the entire table.',
                    };
                }
            }
            else {
                const starts = node.starts;
                const actualRows = node.actualRows;
                const logicalReads = node.logicalReads;
                if (starts !== undefined && starts >= 1 && actualRows !== undefined && logicalReads !== undefined) {
                    const rowsPerStart = actualRows / starts;
                    const getsPerStart = logicalReads / starts;
                    if (rowsPerStart <= ftsFallbackMaxRowsPerStart && getsPerStart >= ftsFallbackMinGetsPerStart) {
                        const isCritical = starts > 1;
                        const columns = extractPredicateColumns(node.accessPredicates, node.filterPredicates);
                        finding = {
                            ruleId: 'selective-full-scan',
                            severity: isCritical ? 'critical' : 'warning',
                            nodeIds: [node.id],
                            title: `Selective full scan on ${node.operation}`,
                            explanation: `Full scan averaged ${getsPerStart.toLocaleString()} logical reads per start but returned only ${rowsPerStart.toLocaleString()} rows per start across ${starts.toLocaleString()} start(s).`,
                            suggestion: columns.length > 0
                                ? `Consider an index on ${columns.join(', ')} to avoid scanning the entire table for this filter.`
                                : 'Consider an index on the filtered column(s) to avoid scanning the entire table.',
                        };
                    }
                }
            }
            if (finding) {
                findings.push(finding);
                if (findings.length >= maxFindingsPerRule)
                    break;
            }
        }
        return findings;
    },
};
