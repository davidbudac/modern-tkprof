/** Depth-first walk over a plan tree (parent before children). */
export function walkPlanTree(root, visit) {
    visit(root);
    for (const child of root.children) {
        walkPlanTree(child, visit);
    }
}
/**
 * The children whose work a node really waits on: each active child as is, and for an
 * inactive child (an adaptive-plan row the optimizer did not use) the effective children
 * below it instead. Cumulative cost/time of an active node under an inactive one still
 * flows to the nearest active ancestor this way.
 */
export function effectiveChildren(node) {
    const result = [];
    for (const child of node.children) {
        if (child.inactive)
            result.push(...effectiveChildren(child));
        else
            result.push(child);
    }
    return result;
}
/**
 * Derive per-operation self time from A-Time and normalize A-Time semantics
 * across sources. Runs once per parse, in place.
 *
 * Oracle reports A-Time cumulatively (a parent's time includes its children),
 * which makes "sort by A-Time" surface one hot leaf plus its entire ancestor
 * chain. Self time (own work only) is what hotspot ranking needs.
 *
 * - Cumulative sources (dbms_xplan, sql_monitor, json):
 *   selfTime = max(0, actualTime − Σ children.actualTime). The clamp absorbs
 *   parallel-execution and rounding artifacts where children exceed the parent.
 * - XBI: the parser stores SELF elapsed time in actualTime for every row
 *   EXCEPT the root, whose ">>> Plan totals >>>" row already carries the plan
 *   total (children's self times sum to it). Non-root actualTime is rolled up
 *   bottom-up to cumulative (matching the other sources), the root is derived
 *   like a cumulative source, and activityPercent is recomputed from self time.
 */
export function computeSelfTimes(plan) {
    if (!plan.rootNode)
        return;
    if (plan.source === 'xbi') {
        const root = plan.rootNode;
        // Post-order roll-up of non-root subtrees: children first, then parent.
        const rollUp = (node) => {
            for (const child of node.children)
                rollUp(child);
            node.selfTime = node.actualTime;
            const childSum = node.children.reduce((sum, child) => sum + (child.actualTime ?? 0), 0);
            if (node.actualTime !== undefined || node.children.some((c) => c.actualTime !== undefined)) {
                node.actualTime = (node.selfTime ?? 0) + childSum;
            }
        };
        for (const child of root.children)
            rollUp(child);
        // Root row is ">>> Plan totals >>>": its ms is the plan total (cumulative).
        const rootChildSum = root.children.reduce((sum, child) => sum + (child.actualTime ?? 0), 0);
        if (root.actualTime === undefined && root.children.some((c) => c.actualTime !== undefined)) {
            root.actualTime = rootChildSum;
        }
        root.selfTime = root.actualTime !== undefined
            ? Math.max(0, root.actualTime - rootChildSum)
            : undefined;
        plan.totalElapsedTime = root.actualTime;
        const total = plan.totalElapsedTime;
        if (total && total > 0) {
            for (const node of plan.allNodes) {
                if (node.selfTime !== undefined && node.parentId !== undefined) {
                    node.activityPercent = (node.selfTime / total) * 100;
                }
            }
        }
    }
    else {
        for (const node of plan.allNodes) {
            if (node.actualTime === undefined || node.inactive) {
                node.selfTime = undefined;
                continue;
            }
            const childSum = effectiveChildren(node).reduce((sum, child) => sum + (child.actualTime ?? 0), 0);
            node.selfTime = Math.max(0, node.actualTime - childSum);
        }
    }
    plan.maxSelfTime = Math.max(0, ...plan.allNodes.map((n) => n.selfTime ?? 0));
}
const isPartitionOp = (node) => node.operation.trim().toUpperCase().startsWith('PARTITION ');
const isReexecutingOp = (node) => {
    const op = node.operation.trim().toUpperCase();
    return op.startsWith('NESTED LOOPS') || op === 'FILTER';
};
const isPxOp = (node) => node.operation.trim().toUpperCase().startsWith('PX ');
const isNestedLoops = (node) => node.operation.trim().toUpperCase().startsWith('NESTED LOOPS');
/** Rowid fetches (TABLE ACCESS BY [GLOBAL|LOCAL] INDEX ROWID [BATCHED]) take their rows from an index scan. */
const isRowidAccess = (node) => {
    const op = node.operation.trim().toUpperCase();
    return op.startsWith('TABLE ACCESS BY') && op.includes('ROWID');
};
const lastChild = (node) => node.children[node.children.length - 1];
/**
 * Derive `estimatedRowsTotal` — the optimizer's row estimate over ALL starts —
 * so it can be compared with A-Rows. Runs once per parse, in place.
 *
 * Oracle's E-Rows is the estimate PER EXECUTION while A-Rows is cumulative over
 * every start, so a naive A-Rows / E-Rows makes each nested-loop inner side
 * look like a huge underestimate. The total is E-Rows × the number of
 * executions, where the multiplier is found by walking up from a "base" node:
 * - never started (Starts = 0): no signal, left undefined;
 * - rowid-source shapes: with nested-loop batching (or a BATCHED rowid fetch)
 *   the table-by-rowid line's E-Rows is per OUTER ROW, i.e. per start of the
 *   index scan feeding the join, not per rowid start. The base is then that
 *   index line (the last child of the inner nested loop) instead of the node;
 * - a probe side (a child other than the first of a NESTED LOOPS / FILTER)
 *   re-executes: multiplier = the base's own Starts;
 * - under a partition iterator (the topmost op of a contiguous PARTITION run
 *   above the base, reached before any probe side) child Starts count
 *   partitions, not executions: multiplier = that iterator's Starts;
 * - inside a parallel slave set (tq / in-out set, or a `PX …` ancestor), E-Rows
 *   is already global and Starts counts slaves/granules, so a node that is not
 *   on a probe side gets multiplier 1 (Starts and A-Rows of a probe side are
 *   summed over slaves, so those still use E-Rows × Starts);
 * - below a COUNT STOPKEY where fewer rows than estimated were produced: early
 *   termination, not a misestimate, left undefined.
 * Values already set by a parser (e.g. XBI) are kept.
 */
export function computeEstimatedRowTotals(plan) {
    if (!plan.rootNode)
        return;
    const byId = new Map();
    for (const node of plan.allNodes)
        byId.set(node.id, node);
    const parentOf = (node) => node.parentId === undefined ? undefined : byId.get(node.parentId);
    const ancestorsOf = (node) => {
        const chain = [];
        for (let p = parentOf(node); p && chain.length <= plan.allNodes.length; p = parentOf(p))
            chain.push(p);
        return chain;
    };
    for (const node of plan.allNodes) {
        if (node.inactive)
            continue;
        if (node.estimatedRowsTotal !== undefined)
            continue;
        if (node.actualRows === undefined || node.rows === undefined)
            continue;
        if (node.starts === 0)
            continue;
        const ancestors = ancestorsOf(node);
        // 1. Pick the base node whose Starts the estimate is per.
        let base = node;
        if (isRowidAccess(node)) {
            const first = node.children[0];
            const parent = parentOf(node);
            if (first && isNestedLoops(first)) {
                base = lastChild(first) ?? node;
            }
            else if (parent && isNestedLoops(parent) && parent.children.length >= 2
                && lastChild(parent) === node && isNestedLoops(parent.children[0])) {
                base = lastChild(parent.children[0]) ?? node;
            }
        }
        // 2. Walk up from the base looking for a probe side and a partition iterator.
        let probeFound = false;
        let partitionTop;
        let prevWasPartition = false;
        let child = base;
        for (const anc of ancestorsOf(base)) {
            if (isPxOp(anc))
                break; // slave-set boundary
            if (isPartitionOp(anc)) {
                if (!probeFound && (partitionTop === undefined || prevWasPartition))
                    partitionTop = anc;
                prevWasPartition = true;
            }
            else {
                prevWasPartition = false;
                if ((isNestedLoops(anc) || isReexecutingOp(anc)) && anc.children[0] !== child)
                    probeFound = true;
            }
            child = anc;
        }
        const inPx = [node, base].some((n) => (n.tq !== undefined && n.tq !== '')
            || (n.inOut !== undefined && n.inOut !== '') || isPxOp(n))
            || ancestors.some(isPxOp);
        // 3. Multiplier.
        let multiplier;
        if (partitionTop && (probeFound || !inPx))
            multiplier = partitionTop.starts ?? 1;
        else if (probeFound)
            multiplier = base.starts ?? 1;
        else if (inPx)
            multiplier = 1;
        else
            multiplier = base.starts ?? 1;
        const total = node.rows * multiplier;
        const stopkey = ancestors.some((a) => a.operation.trim().toUpperCase() === 'COUNT STOPKEY');
        if (stopkey && node.actualRows < total)
            continue;
        node.estimatedRowsTotal = total;
    }
}
/**
 * The plan's total optimizer cost. Oracle cost is already cumulative, so the
 * root's cost is the total; falls back to the largest node cost when the root
 * has none, and 0 when no node has a cost.
 */
export function planRootCost(root, allNodes) {
    if (root?.cost !== undefined)
        return root.cost;
    return allNodes.reduce((max, n) => Math.max(max, n.cost ?? 0), 0);
}
/**
 * Derive per-operation self cost: max(0, cost − Σ children cost), for nodes
 * with a defined cost. Runs once per parse, in place. Inactive adaptive-plan
 * rows get none, and their active descendants count as the children of the
 * nearest active ancestor (`effectiveChildren`).
 */
export function computeSelfCosts(plan) {
    for (const node of plan.allNodes) {
        if (node.cost === undefined || node.inactive) {
            node.selfCost = undefined;
            continue;
        }
        const childSum = effectiveChildren(node).reduce((sum, child) => sum + (child.cost ?? 0), 0);
        node.selfCost = Math.max(0, node.cost - childSum);
    }
}
const isSqlMonitorSource = (plan) => plan.source === 'sql_monitor_text' || plan.source === 'sql_monitor_xml';
/**
 * Whether time ranking should use ASH activity: SQL Monitor sources, where
 * A-Time active windows overlap so derived self time is meaningless, and at
 * least one non-root node has an ASH activity share.
 */
export function usesActivityRanking(plan) {
    return isSqlMonitorSource(plan)
        && plan.allNodes.some((n) => n.parentId !== undefined && (n.activityPercent ?? 0) > 0);
}
/**
 * Non-root nodes ranked by time, hottest first. The measure is ASH
 * `activityPercent` for SQL Monitor sources that have it, else self time
 * (falling back to cumulative A-Time). Nodes with no measure are excluded.
 */
export function rankNodesByTime(plan) {
    const byActivity = usesActivityRanking(plan);
    const measure = (n) => byActivity ? n.activityPercent : (n.selfTime ?? n.actualTime);
    return plan.allNodes
        .filter((n) => n.parentId !== undefined && !n.inactive && measure(n) !== undefined)
        .sort((a, b) => (measure(b) ?? 0) - (measure(a) ?? 0));
}
/**
 * The node deserving the "hotspot" ring, excluding root statement nodes.
 * SQL Monitor sources with ASH data use the highest `activityPercent`;
 * otherwise the highest self time (falling back to cumulative A-Time for
 * nodes without derived self time). Returns null when the plan has no actual
 * statistics.
 */
export function computeHottestNodeId(plan) {
    if (!plan?.hasActualStats)
        return null;
    const byActivity = usesActivityRanking(plan);
    let hottestId = null;
    let hottestTime = 0;
    for (const node of plan.allNodes) {
        if (node.parentId === undefined || node.inactive)
            continue; // skip root statement nodes and inactive rows
        const time = byActivity ? node.activityPercent : (node.selfTime ?? node.actualTime);
        if (time !== undefined && time > hottestTime) {
            hottestTime = time;
            hottestId = node.id;
        }
    }
    return hottestId;
}
