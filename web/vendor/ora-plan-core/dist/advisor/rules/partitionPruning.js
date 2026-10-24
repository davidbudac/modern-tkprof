import { assessPartitionPruning } from "../../planSignals.js";
import { analyzeColumnUses, referencedColumns, resolveNodeAlias, tableNameOf } from "./sargable.js";
/** Operations under the iterator that read a (partitioned) object: the scans that carry the predicates. */
function scansUnder(node) {
    const scans = [];
    const walk = (n) => {
        if (n.objectName)
            scans.push(n);
        n.children.forEach(walk);
    };
    node.children.forEach(walk);
    return scans;
}
/** Partition (and subpartition) key columns for the object a scan reads, from the metadata bundle. */
function partitionKeyOf(ctx, scan) {
    const match = ctx.findObject(scan.objectName);
    if (!match)
        return { key: [] };
    if (match.object.type === 'TABLE') {
        const { partition_key = [], subpartition_key = [] } = match.object.stats;
        return { key: [...partition_key, ...subpartition_key].map((c) => c.toUpperCase()), tableName: tableNameOf(match.key) };
    }
    // Index scan: a globally partitioned index has its own key, a local one follows its table's.
    const ownKey = match.object.stats.partition_key ?? [];
    const table = ctx.bundle?.objects[match.object.table];
    const tableStats = table && table.type === 'TABLE' ? table.stats : undefined;
    const key = ownKey.length > 0 ? ownKey : [...(tableStats?.partition_key ?? []), ...(tableStats?.subpartition_key ?? [])];
    return { key: key.map((c) => c.toUpperCase()), tableName: tableNameOf(match.object.table) };
}
export const partitionPruningRule = {
    id: 'partition-no-pruning',
    evaluate(ctx) {
        const findings = [];
        const { maxFindingsPerRule } = ctx.thresholds;
        for (const node of ctx.plan.allNodes) {
            if (assessPartitionPruning(node) !== 'none')
                continue;
            // A PARTITION ... ALL iterator is only a problem when pruning was possible: a predicate on the
            // partition key. Reading every partition of an unfiltered (or non-key-filtered) scan is normal.
            const scans = scansUnder(node);
            const withPredicates = scans.filter((s) => s.accessPredicates || s.filterPredicates);
            if (withPredicates.length === 0)
                continue;
            let keyKnown = false;
            let finding = null;
            for (const scan of withPredicates) {
                const { key, tableName } = partitionKeyOf(ctx, scan);
                if (key.length === 0)
                    continue;
                keyKnown = true;
                const alias = resolveNodeAlias(scan, tableName);
                const predicates = [scan.accessPredicates, scan.filterPredicates];
                const onKey = referencedColumns(predicates, alias).filter((c) => key.includes(c));
                if (onKey.length === 0)
                    continue;
                const uses = analyzeColumnUses(predicates, alias).filter((u) => key.includes(u.column));
                const unusable = uses.filter((u) => u.kind !== 'sargable').map((u) => u.column);
                const cause = unusable.length > 0
                    ? `${unusable.join(', ')} is wrapped in a function or conversion, or compared in a form that cannot prune`
                    : 'the predicate looks prunable, so check for an implicit conversion or a bind/literal datatype or NLS mismatch on the key';
                finding = {
                    ruleId: 'partition-no-pruning',
                    severity: 'warning',
                    nodeIds: [node.id],
                    title: `No partition pruning on ${node.operation}`,
                    explanation: `This operation accesses all partitions even though a predicate references the partition key (${onKey.join(', ')}) — ${cause}.`,
                    suggestion: 'Compare the predicate with the partition key column exactly (no function, no implicit conversion) so the optimizer can prune to a subset of partitions.',
                };
                break;
            }
            // No usable partition key information at all: say so at info level rather than guess.
            if (!finding && !keyKnown) {
                finding = {
                    ruleId: 'partition-no-pruning',
                    severity: 'info',
                    nodeIds: [node.id],
                    title: `All partitions accessed on ${node.operation}`,
                    explanation: 'This operation accesses all partitions (Pstart/Pstop indicate no pruning) while its scans filter on other columns. The partition key is unknown, so it cannot be told whether a key predicate was expected.',
                    suggestion: 'Attach schema metadata to see the partition key, or check whether a predicate on it could be added to prune to a subset of partitions.',
                };
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
