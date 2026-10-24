import { nestedLoopVolume } from "./nestedLoopVolume.js";
import { liveChildren } from "./shared.js";
const STATEMENT_ROOT_RE = /^(SELECT|INSERT|UPDATE|DELETE|MERGE) STATEMENT/;
/**
 * Work that is redone for every row of another row source: FILTER subqueries, scalar
 * subqueries in the select list, and remote operations driven per row. (Nested-loop
 * inner sides in general are covered by nested-loop-volume; this rule only adds the
 * remote case below them.)
 */
export const perRowReexecutionRule = {
    id: 'per-row-reexecution',
    requiresActualStats: true,
    evaluate(ctx) {
        const { reexecStartsWarn, reexecStartsCritical, remoteStartsWarn, remoteStartsCritical, maxFindingsPerRule } = ctx.thresholds;
        const candidates = [];
        // FILTER / nested-loop nodes whose re-executed side already has a more specific finding.
        const covered = new Set();
        // (c) REMOTE operations started once per outer row.
        const visit = (node, owner) => {
            const kids = liveChildren(node);
            const op = node.operation.toUpperCase();
            if (owner && op.startsWith('REMOTE') && node.starts !== undefined && node.starts >= remoteStartsWarn) {
                const volumeCovered = owner.kind === 'nested-loop' && nestedLoopVolume(owner.node, ctx.thresholds) !== undefined;
                covered.add(owner.key);
                if (!volumeCovered) {
                    const severity = node.starts >= remoteStartsCritical ? 'critical' : 'warning';
                    const where = owner.kind === 'nested-loop'
                        ? `the inner side of the ${owner.node.operation} at operation ${owner.node.id}`
                        : owner.kind === 'filter'
                            ? `the subquery side of the FILTER at operation ${owner.node.id}`
                            : `a scalar subquery (operation ${owner.key})`;
                    candidates.push({
                        starts: node.starts,
                        finding: {
                            ruleId: 'per-row-reexecution',
                            severity,
                            nodeIds: [node.id],
                            title: `Remote operation started per row on ${node.operation}`,
                            explanation: `This remote operation sits on ${where} and was started ${node.starts.toLocaleString()} times. Every start is a network round trip to the remote database, so the elapsed time scales with the row count rather than with the data volume.`,
                            suggestion: 'Fetch the remote rows once (a hash join with the DRIVING_SITE hint, or materialise the remote result in a local temporary table or subquery) instead of probing the remote database per outer row.',
                        },
                    });
                }
            }
            const isNl = op.startsWith('NESTED LOOPS');
            const isFilter = op === 'FILTER' || op.startsWith('FILTER ');
            kids.forEach((child, index) => {
                if (index >= 1 && isNl)
                    visit(child, { node, kind: 'nested-loop', key: node.id });
                else if (index >= 1 && isFilter)
                    visit(child, { node, kind: 'filter', key: node.id });
                else
                    visit(child, owner);
            });
        };
        const root = ctx.plan.rootNode;
        const rootKids = root ? liveChildren(root) : [];
        // Scalar subqueries: extra children of the statement root that come before the main row source.
        const scalarSubqueries = root && STATEMENT_ROOT_RE.test(root.operation.toUpperCase()) ? rootKids.slice(0, -1) : [];
        if (root) {
            rootKids.forEach((child) => {
                if (scalarSubqueries.includes(child))
                    visit(child, { node: root, kind: 'scalar', key: child.id });
                else
                    visit(child);
            });
        }
        const severityFor = (starts) => (starts >= reexecStartsCritical ? 'critical' : 'warning');
        // (a) FILTER whose subquery side runs once per row.
        for (const node of ctx.plan.allNodes) {
            const op = node.operation.toUpperCase();
            if (!(op === 'FILTER' || op.startsWith('FILTER ')))
                continue;
            if (covered.has(node.id))
                continue;
            const kids = liveChildren(node);
            if (kids.length < 2)
                continue;
            let worst;
            for (const sub of kids.slice(1)) {
                if (sub.starts !== undefined && (worst === undefined || sub.starts > worst.starts))
                    worst = sub;
            }
            if (!worst || worst.starts < reexecStartsWarn)
                continue;
            const starts = worst.starts;
            const driver = kids[0].actualRows;
            candidates.push({
                starts,
                finding: {
                    ruleId: 'per-row-reexecution',
                    severity: severityFor(starts),
                    nodeIds: [node.id],
                    title: `Subquery re-executed per row on ${node.operation}`,
                    explanation: `The subquery side of this FILTER (operation ${worst.id}, ${worst.operation}) was started ${starts.toLocaleString()} times${driver !== undefined ? `, once for each of the ${driver.toLocaleString()} rows (or distinct correlation values, as Oracle caches subquery results) coming from the first child` : ''}. The work is repeated per row instead of being done once.`,
                    suggestion: 'Rewrite the correlated subquery as a join or semi/anti-join (unnest it, e.g. EXISTS to JOIN or the UNNEST hint) so it runs once, or make each execution cheap with an index on the correlated column.',
                },
            });
        }
        // (b) Scalar subqueries.
        if (root) {
            for (const sub of scalarSubqueries) {
                if (sub.starts === undefined || sub.starts < reexecStartsWarn)
                    continue;
                if (covered.has(sub.id))
                    continue;
                const main = rootKids[rootKids.length - 1];
                candidates.push({
                    starts: sub.starts,
                    finding: {
                        ruleId: 'per-row-reexecution',
                        severity: severityFor(sub.starts),
                        nodeIds: [sub.id],
                        title: `Scalar subquery executed per row on ${sub.operation}`,
                        explanation: `This subquery (a scalar subquery in the select list or a similar per-row lookup) was started ${sub.starts.toLocaleString()} times${main.actualRows !== undefined ? ` while the main row source produced ${main.actualRows.toLocaleString()} rows` : ''}. Oracle caches scalar subquery results, so each start is a distinct correlation value that had to be looked up again.`,
                        suggestion: 'Replace the scalar subquery with an outer join (or a join to an aggregated inline view) so the lookup is done once for all rows, and make sure the correlated column is indexed.',
                    },
                });
            }
        }
        candidates.sort((a, b) => {
            const sev = (c) => (c.finding.severity === 'critical' ? 0 : 1);
            return sev(a) - sev(b) || b.starts - a.starts;
        });
        return candidates.slice(0, maxFindingsPerRule).map((c) => c.finding);
    },
};
