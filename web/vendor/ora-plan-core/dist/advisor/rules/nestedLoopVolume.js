import { liveChildren, liveDescendants } from "./shared.js";
/** Probe count and inner volume of a high-volume nested loop, or undefined when it is not one. */
export function nestedLoopVolume(node, thresholds) {
    if (!node.operation.toUpperCase().startsWith('NESTED LOOPS'))
        return undefined;
    const children = liveChildren(node);
    if (children.length < 2)
        return undefined;
    const outer = children[0];
    const inner = children[1];
    const probes = inner.starts ?? outer.actualRows;
    const volume = inner.actualRows;
    if (probes === undefined || volume === undefined)
        return undefined;
    if (!(probes >= thresholds.nlStartsWarn && volume >= thresholds.nlInnerRowsWarn))
        return undefined;
    return {
        probes,
        volume,
        critical: probes >= thresholds.nlStartsCritical && volume >= thresholds.nlInnerRowsCritical,
    };
}
export const nestedLoopVolumeRule = {
    id: 'nested-loop-volume',
    requiresActualStats: true,
    evaluate(ctx) {
        const findings = [];
        const { maxFindingsPerRule } = ctx.thresholds;
        for (const node of ctx.plan.allNodes) {
            const vol = nestedLoopVolume(node, ctx.thresholds);
            if (!vol)
                continue;
            // Each probe of a remote inner side is a network round trip, which is worse than the local volume suggests.
            const inner = liveChildren(node)[1];
            const remote = [inner, ...liveDescendants(inner)].some((n) => n.operation.toUpperCase().startsWith('REMOTE'));
            const remoteNote = remote ? ' The inner side includes a REMOTE operation, so every probe is a network round trip to the remote database.' : '';
            findings.push({
                ruleId: 'nested-loop-volume',
                severity: vol.critical ? 'critical' : 'warning',
                nodeIds: [node.id],
                title: `High-volume nested loop on ${node.operation}`,
                explanation: `The inner row source was probed ${vol.probes.toLocaleString()} times and produced ${vol.volume.toLocaleString()} total rows (A-Rows is cumulative across all probes).${remoteNote}`,
                suggestion: remote
                    ? 'Consider a hash join (for example with the DRIVING_SITE hint or by pulling the remote rows into a local temporary result) so the remote side is read once instead of once per outer row.'
                    : 'Consider whether a hash join would perform fewer total logical reads than repeatedly probing the inner row source at this volume.',
            });
            if (findings.length >= maxFindingsPerRule)
                break;
        }
        return findings;
    },
};
