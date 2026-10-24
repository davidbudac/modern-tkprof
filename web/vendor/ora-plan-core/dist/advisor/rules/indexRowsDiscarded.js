import { extractQuotedColumns } from "../predicates.js";
import { isIndexScan, isTableByRowid, liveChildren } from "./shared.js";
/**
 * Table accesses by rowid that throw away most of what the index below them returned:
 * the index scan's A-Rows far exceed the table access's A-Rows and the table access
 * applies a filter. Both A-Rows are cumulative over all starts, so they compare directly.
 */
export function findIndexDiscards(nodes, thresholds) {
    const hits = [];
    for (const table of nodes) {
        if (!isTableByRowid(table) || !table.filterPredicates)
            continue;
        const index = liveChildren(table).find(isIndexScan);
        if (!index)
            continue;
        const indexRows = index.actualRows;
        const tableRows = table.actualRows;
        if (indexRows === undefined || tableRows === undefined)
            continue;
        const discarded = indexRows - tableRows;
        if (discarded < thresholds.indexDiscardMinRows)
            continue;
        if (indexRows < thresholds.indexDiscardRatio * Math.max(tableRows, 1))
            continue;
        hits.push({ table, index, indexRows, tableRows, discarded });
    }
    return hits;
}
export const indexRowsDiscardedRule = {
    id: 'index-rows-discarded',
    requiresActualStats: true,
    evaluate(ctx) {
        const { maxFindingsPerRule, indexDiscardCriticalRows } = ctx.thresholds;
        const hits = findIndexDiscards(ctx.plan.allNodes, ctx.thresholds)
            .sort((a, b) => b.discarded - a.discarded)
            .slice(0, maxFindingsPerRule);
        return hits.map(({ table, index, indexRows, tableRows, discarded }) => {
            const indexMatch = ctx.findObject(index.objectName);
            const indexColumns = indexMatch && indexMatch.object.type === 'INDEX' ? indexMatch.object.columns : undefined;
            const filterColumns = extractQuotedColumns(table.filterPredicates).map((c) => c.column);
            const missing = indexColumns ? filterColumns.filter((c) => !indexColumns.includes(c)) : filterColumns;
            const indexName = index.objectName ?? index.operation;
            let suggestion;
            if (filterColumns.length === 0) {
                suggestion = `Add the filtered column(s) to ${indexName} so the filter is applied inside the index, before the table rows are fetched.`;
            }
            else if (indexColumns && missing.length === 0) {
                suggestion = `The filter column(s) ${filterColumns.join(', ')} are already in ${indexName} but the filter is only applied after the table access; check the column order and whether the predicate (a function or conversion on the column?) can be used as an index access or filter predicate.`;
            }
            else {
                suggestion = `Add ${missing.join(', ')} to ${indexName} (or create an index covering the access and filter columns) so these rows are eliminated in the index instead of by visiting the table.`;
            }
            return {
                ruleId: 'index-rows-discarded',
                severity: discarded >= indexDiscardCriticalRows ? 'critical' : 'warning',
                nodeIds: [table.id, index.id],
                title: `Rows discarded after index on ${table.operation}`,
                explanation: `${index.operation}${index.objectName ? ` ${index.objectName}` : ''} (operation ${index.id}) returned ${indexRows.toLocaleString()} rows, but the filter on the table access kept only ${tableRows.toLocaleString()}. ${discarded.toLocaleString()} table rows were fetched only to be thrown away, and each one cost a table block visit.`,
                suggestion,
            };
        });
    },
};
