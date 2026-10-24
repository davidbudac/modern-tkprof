import { BROADCAST_LARGE_ROWS, computeParallelSignals, getDopDowngrade } from "../../planSignals.js";
/** Rows through the query coordinator before serial work above it counts as a bottleneck. */
const QC_FUNNEL_MIN_ROWS = BROADCAST_LARGE_ROWS;
const QC_SEND_RE = /^PX SEND QC/i;
const ONE_SLAVE_SEND_RE = /^PX SEND 1 SLAVE/i;
/** Serial work worth worrying about above the coordinator (SORT AGGREGATE only combines partials). */
const HEAVY_SERIAL_RE = /^(?:SORT (?!AGGREGATE)|HASH |WINDOW|NESTED LOOPS|MERGE JOIN|FILTER|UNION|MINUS|INTERSECT|CONNECT BY|BUFFER SORT)/i;
/**
 * IN-OUT as DBMS_XPLAN prints it (`P->S`, `S->P`, `P->P`, `PCWP`, `PCWC`). Other sources may spell the
 * transition out, or omit the column (SQL Monitor), where the sender operation still tells.
 */
function transitionOf(node) {
    const raw = node.inOut?.replace(/\s+/g, '').toUpperCase();
    if (raw === 'P->S' || raw === 'PARALLEL_TO_SERIAL')
        return 'P->S';
    if (raw === 'S->P' || raw === 'PARALLEL_FROM_SERIAL' || raw === 'SERIAL_TO_PARALLEL')
        return 'S->P';
    if (raw)
        return raw;
    if (QC_SEND_RE.test(node.operation) || ONE_SLAVE_SEND_RE.test(node.operation))
        return 'P->S';
    return undefined;
}
export const parallelSignalsRule = {
    id: 'parallel-signals',
    evaluate(ctx) {
        const findings = [];
        const { maxFindingsPerRule } = ctx.thresholds;
        let broadcastCount = 0;
        for (const signal of computeParallelSignals(ctx.plan)) {
            if (signal.kind !== 'broadcast-large')
                continue;
            if (broadcastCount >= maxFindingsPerRule)
                continue;
            broadcastCount++;
            findings.push({
                ruleId: 'parallel-broadcast-large',
                severity: 'warning',
                nodeIds: [signal.nodeId],
                title: 'Large broadcast in parallel plan',
                explanation: signal.reason,
                suggestion: 'Consider a HASH distribution instead of BROADCAST when the redistributed row source is large.',
            });
        }
        const byId = new Map(ctx.plan.allNodes.map((n) => [n.id, n]));
        let serialCount = 0;
        let feedCount = 0;
        for (const node of ctx.plan.allNodes) {
            const transition = transitionOf(node);
            const rows = node.actualRows ?? node.rows;
            const rowText = rows !== undefined ? `${rows.toLocaleString()} rows` : 'all rows';
            if (transition === 'P->S') {
                let reason;
                if (!QC_SEND_RE.test(node.operation)) {
                    reason = `Data flows from parallel to serial execution here (${rowText}), creating a serialization point.`;
                }
                else if (rows !== undefined && rows >= QC_FUNNEL_MIN_ROWS) {
                    // Every parallel plan ends in a P->S send to the coordinator; it only matters when the
                    // coordinator then does real work on the rows by itself.
                    const coordinator = node.parentId !== undefined ? byId.get(node.parentId) : undefined;
                    const consumer = coordinator?.parentId !== undefined ? byId.get(coordinator.parentId) : undefined;
                    if (coordinator && /^PX COORDINATOR/i.test(coordinator.operation) && consumer && HEAVY_SERIAL_RE.test(consumer.operation)) {
                        reason = `${rowText} are funneled through the query coordinator, which then runs ${consumer.operation} (operation ${consumer.id}) as a single serial process.`;
                    }
                }
                if (reason && serialCount < maxFindingsPerRule) {
                    serialCount++;
                    findings.push({
                        ruleId: 'parallel-serial-point',
                        severity: 'warning',
                        nodeIds: [node.id],
                        title: 'Serialization point in parallel plan',
                        explanation: reason,
                        suggestion: 'Review whether this operation can remain parallel (P->P) to avoid funneling all rows through a single process.',
                    });
                }
            }
            else if (transition === 'S->P' && !/^PX COORDINATOR/i.test(node.operation) && feedCount < maxFindingsPerRule) {
                feedCount++;
                findings.push({
                    ruleId: 'parallel-serial-feed',
                    severity: 'warning',
                    nodeIds: [node.id],
                    title: 'Serial row source feeding a parallel set',
                    explanation: `A single serial process (typically a non-parallel scan or a serial PL/SQL function evaluated by the query coordinator) produces ${rowText} and distributes them to the parallel servers. The servers wait on that one producer, so this part of the plan does not scale with the degree of parallelism.`,
                    suggestion: 'Make the producing step parallel: check the table/index DEGREE or a PARALLEL hint, and look for objects or functions that force serial execution (e.g. a PL/SQL function not declared PARALLEL_ENABLE).',
                });
            }
        }
        const downgrade = getDopDowngrade(ctx.plan.monitorMetadata);
        if (downgrade) {
            findings.push({
                ruleId: 'dop-downgrade',
                severity: 'warning',
                nodeIds: [],
                title: 'Degree of parallelism downgraded',
                explanation: `Requested DOP ${downgrade.requested} but only ${downgrade.allocated} parallel servers were allocated at runtime.`,
                suggestion: 'Check parallel_max_servers and system load — insufficient PX server availability commonly causes DOP downgrade.',
            });
        }
        return findings;
    },
};
