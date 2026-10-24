import { resolveIndexesForBlock } from "../../metadata/indexes.js";
import { analyzeColumnUses, resolveNodeAlias, tableNameOf } from "./sargable.js";
const FULL_SCAN_RE = /TABLE ACCESS (STORAGE )?FULL/;
export const unusedIndexRule = {
    id: 'index-exists-unused',
    requiresMetadata: true,
    evaluate(ctx) {
        const findings = [];
        const { maxFindingsPerRule } = ctx.thresholds;
        if (!ctx.bundle)
            return findings;
        const bundle = ctx.bundle;
        for (const node of ctx.plan.allNodes) {
            if (!FULL_SCAN_RE.test(node.operation.toUpperCase()))
                continue;
            if (!node.accessPredicates && !node.filterPredicates)
                continue;
            const match = ctx.findObject(node.objectName);
            if (!match || match.object.type !== 'TABLE')
                continue;
            // Only columns of this operation's own alias that a predicate can drive an index with:
            // join keys of other aliases, function-wrapped columns, <>, leading-wildcard LIKE and OR
            // chains across columns are ignored.
            const alias = resolveNodeAlias(node, tableNameOf(node.objectName));
            const uses = analyzeColumnUses([node.accessPredicates, node.filterPredicates], alias)
                .filter((u) => Object.prototype.hasOwnProperty.call(match.object.columns, u.column));
            const sargableCols = uses.filter((u) => u.kind === 'sargable').map((u) => u.column);
            const nullCols = uses.filter((u) => u.kind === 'is-null').map((u) => u.column);
            if (sargableCols.length === 0 && nullCols.length === 0)
                continue;
            const { indexes } = resolveIndexesForBlock(match, bundle);
            for (const idx of indexes) {
                if (ctx.usedIndexKeys.has(idx.key))
                    continue;
                if (idx.object.stats.status !== 'VALID')
                    continue;
                if (idx.object.stats.visibility !== 'VISIBLE')
                    continue;
                const leadingColumn = idx.object.columns[0];
                if (!leadingColumn)
                    continue;
                // IS NULL only reaches rows a B-tree stores: a composite key (or a bitmap index) keeps NULL
                // leading values, a single-column B-tree does not.
                const nullsIndexed = idx.object.columns.length > 1 || idx.object.stats.uniqueness === 'BITMAP';
                const predCols = nullsIndexed ? [...sargableCols, ...nullCols] : sargableCols;
                if (!predCols.includes(leadingColumn))
                    continue;
                findings.push({
                    ruleId: 'index-exists-unused',
                    severity: 'warning',
                    nodeIds: [node.id],
                    title: `Unused index ${idx.key} on ${node.operation}`,
                    explanation: `Index ${idx.key} leads with column ${leadingColumn}, which appears in a usable predicate on this node (${predCols.join(', ')}), but the plan does not use it.`,
                    suggestion: 'The optimizer may have priced this index out (low selectivity, stale stats, or a cheaper full scan) — verify with stats/histograms before assuming it is a missing-index problem.',
                });
                if (findings.length >= maxFindingsPerRule)
                    return findings;
            }
        }
        return findings;
    },
};
