import { findFunctionWrappedColumns, findImplicitConversions } from "../predicates.js";
import { resolveIndexesForBlock } from "../../metadata/indexes.js";
import { FULL_SCAN_RE } from "./shared.js";
// A column Oracle generated for a function-based index (SYS_NC00005$).
const FBI_COLUMN_RE = /^SYS_NC\d+\$$/;
/** The alias a node scans, without the query block: "E@SEL$1" -> "E". */
function scannedAlias(node) {
    const raw = node.objectAlias ?? node.alias;
    if (!raw)
        return undefined;
    const alias = raw.split('@')[0].replace(/^"|"$/g, '');
    return alias || undefined;
}
export const functionOnIndexedColumnRule = {
    id: 'function-on-indexed-column',
    requiresMetadata: true,
    evaluate(ctx) {
        const findings = [];
        const { maxFindingsPerRule } = ctx.thresholds;
        const bundle = ctx.bundle;
        if (!bundle)
            return findings;
        for (const node of ctx.plan.allNodes) {
            const op = node.operation.toUpperCase();
            // Index operations that show UPPER("COL") are using a function-based index: that is the fix, not the problem.
            if (!op.startsWith('TABLE ACCESS'))
                continue;
            const isFullScan = FULL_SCAN_RE.test(op);
            if (!isFullScan && !node.filterPredicates)
                continue;
            const match = ctx.findObject(node.objectName);
            if (!match || match.object.type !== 'TABLE')
                continue;
            const table = match.object;
            const { indexes } = resolveIndexesForBlock(match, bundle);
            const usable = indexes.filter((i) => i.object.stats.status !== 'UNUSABLE' && i.object.stats.visibility !== 'INVISIBLE');
            if (usable.length === 0)
                continue;
            // The bundle lists index columns only, not the indexed expressions, so a function-based
            // index (hidden SYS_NC column) on the table might be the very index that matches: stay silent.
            if (indexes.some((i) => i.object.columns.some((c) => FBI_COLUMN_RE.test(c))))
                continue;
            const ownAlias = scannedAlias(node);
            const alreadyConversion = new Set(findImplicitConversions(node.accessPredicates, node.filterPredicates).map((h) => h.column.toUpperCase()));
            // On a full scan the access list holds storage() predicates; on a rowid fetch only the filter is a post-index check.
            const hits = findFunctionWrappedColumns(isFullScan ? node.accessPredicates : undefined, node.filterPredicates);
            const seen = new Set();
            for (const hit of hits) {
                const column = hit.column.toUpperCase();
                // A qualified reference must point at the table this node scans (an NL join predicate can mention the outer one).
                if (hit.alias !== undefined && ownAlias !== undefined && hit.alias.toUpperCase() !== ownAlias.toUpperCase())
                    continue;
                if (hit.alias !== undefined && ownAlias === undefined)
                    continue;
                if (!Object.prototype.hasOwnProperty.call(table.columns, column))
                    continue;
                if (alreadyConversion.has(column))
                    continue;
                const key = `${hit.fn}:${column}`;
                if (seen.has(key))
                    continue;
                const index = usable.find((i) => i.object.columns[0]?.toUpperCase() === column);
                if (!index)
                    continue;
                seen.add(key);
                findings.push({
                    ruleId: 'function-on-indexed-column',
                    severity: 'warning',
                    nodeIds: [node.id],
                    title: `Indexed column wrapped in function on ${node.operation}`,
                    explanation: `The predicate applies ${hit.fn} to ${column}, which leads index ${index.key}, so the optimizer cannot use that index for it (${hit.fragment} in ${hit.source}). No function-based index on the expression is present.`,
                    suggestion: `Rewrite the predicate so ${column} stands alone (for dates, compare against a range instead of TRUNC), or create a function-based index on ${hit.fn}(${column}).`,
                });
                if (findings.length >= maxFindingsPerRule)
                    return findings;
            }
        }
        return findings;
    },
};
