const PARTITION_ALL_RE = /PARTITION\s+(RANGE|LIST|HASH)\s+ALL/i;
const RUNTIME_PRUNING_RE = /^KEY(\(I\)|\(SQ\)|\(AP\))?$|^:BF\d+$/i;
/**
 * Assess partition pruning behavior for a node based on its Pstart/Pstop columns.
 * Returns undefined when the node has neither pstart nor pstop.
 */
export function assessPartitionPruning(node) {
    if (node.pstart === undefined && node.pstop === undefined) {
        return undefined;
    }
    // A "PARTITION ... ALL" operation always accesses every partition, regardless
    // of what the Pstart/Pstop cells happen to contain.
    if (PARTITION_ALL_RE.test(node.operation)) {
        return 'none';
    }
    const values = [node.pstart, node.pstop].filter((v) => v !== undefined);
    if (values.some((v) => RUNTIME_PRUNING_RE.test(v.trim()))) {
        return 'runtime';
    }
    // Numeric ranges, ROW LOCATION, INVALID, ANY — all resolved at parse/compile
    // time (or otherwise not a runtime-determined key), so treat as static.
    return 'static';
}
export const BROADCAST_LARGE_ROWS = 100_000;
/**
 * Detect notable parallel-execution signals in a plan:
 *  - broadcast-large: a PX SEND BROADCAST redistributing a large row count
 *  - serial-point: a P->S transition that isn't the final send to the QC
 */
export function computeParallelSignals(plan) {
    const signals = [];
    for (const node of plan.allNodes) {
        if (node.pqDistrib?.includes('BROADCAST')) {
            const rowCount = node.actualRows ?? node.rows ?? 0;
            if (rowCount > BROADCAST_LARGE_ROWS) {
                signals.push({
                    nodeId: node.id,
                    kind: 'broadcast-large',
                    reason: `Broadcasts ${rowCount.toLocaleString()} rows to every parallel server — consider HASH distribution instead.`,
                });
            }
        }
        if (node.inOut === 'P->S' && !node.operation.toUpperCase().startsWith('PX SEND QC')) {
            signals.push({
                nodeId: node.id,
                kind: 'serial-point',
                reason: `Data flows from parallel to serial execution here, creating a serialization point.`,
            });
        }
    }
    return signals;
}
/**
 * Determine whether the requested degree of parallelism was downgraded at
 * runtime (fewer PX servers allocated than requested).
 */
export function getDopDowngrade(meta) {
    if (!meta || meta.pxServersRequested === undefined || meta.pxServersAllocated === undefined) {
        return null;
    }
    if (meta.pxServersAllocated < meta.pxServersRequested) {
        return { requested: meta.pxServersRequested, allocated: meta.pxServersAllocated };
    }
    return null;
}
