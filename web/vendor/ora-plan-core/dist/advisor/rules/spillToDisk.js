import { formatBytes } from "../../format.js";
/** Worst work-area behaviour recorded for a node: last execution (Used-Mem "(n)") or any execution (O/1/M). */
function workareaPassKind(node) {
    const execs = node.workareaExecutions;
    if ((node.workareaPasses ?? 0) > 1 || (execs?.multipass ?? 0) > 0)
        return 'multipass';
    if (node.workareaPasses === 1 || (execs?.onePass ?? 0) > 0)
        return 'onepass';
    return undefined;
}
function describePasses(node, kind) {
    const execs = node.workareaExecutions;
    const total = execs ? execs.optimal + execs.onePass + execs.multipass : 0;
    const affected = execs ? (kind === 'multipass' ? execs.multipass : execs.onePass + execs.multipass) : 0;
    const counted = total > 0 && affected > 0 ? ` (${affected.toLocaleString()} of ${total.toLocaleString()} executions)` : '';
    const optimal = node.estimatedOptimalMemory !== undefined
        ? ` The optimizer estimated ${formatBytes(node.estimatedOptimalMemory)} for an in-memory run.`
        : '';
    const used = node.memoryUsed !== undefined && node.memoryUsed > 0 ? ` It used ${formatBytes(node.memoryUsed)} of work-area memory.` : '';
    return kind === 'multipass'
        ? `The work area was too small and needed multiple passes over temp${counted}: the data was written to disk and re-read more than once, which degrades sharply as the shortfall grows.${used}${optimal}`
        : `The work area did not fit in memory and ran one-pass${counted}: the data was written to temp and read back once.${used}${optimal}`;
}
export const spillToDiskRule = {
    id: 'spill-to-disk',
    evaluate(ctx) {
        const findings = [];
        const { spillCriticalBytes, maxFindingsPerRule } = ctx.thresholds;
        for (const node of ctx.plan.allNodes) {
            const tempUsed = node.tempUsed !== undefined && node.tempUsed > 0 ? node.tempUsed : undefined;
            const passKind = workareaPassKind(node);
            if (tempUsed === undefined && passKind === undefined)
                continue;
            let severity = 'warning';
            if (tempUsed !== undefined && tempUsed >= spillCriticalBytes)
                severity = 'critical';
            if (passKind === 'multipass')
                severity = 'critical';
            let title;
            let explanation;
            if (tempUsed !== undefined && passKind !== undefined) {
                title = `Spill to disk (${passKind === 'multipass' ? 'multipass' : 'one-pass'}) on ${node.operation}`;
                explanation = `This operation used ${formatBytes(tempUsed)} of temp space, meaning it spilled to disk instead of completing in memory. ${describePasses(node, passKind)}`;
            }
            else if (tempUsed !== undefined) {
                title = `Spill to disk on ${node.operation}`;
                explanation = `This operation used ${formatBytes(tempUsed)} of temp space, meaning it spilled to disk instead of completing in memory.`;
            }
            else {
                title = `${passKind === 'multipass' ? 'Multipass' : 'One-pass'} work area on ${node.operation}`;
                explanation = describePasses(node, passKind);
            }
            findings.push({
                ruleId: 'spill-to-disk',
                severity,
                nodeIds: [node.id],
                title,
                explanation,
                suggestion: passKind === 'multipass'
                    ? 'Multipass work areas are far slower than optimal ones: raise PGA memory (PGA_AGGREGATE_TARGET / the session work-area limits) or cut the data feeding this operation (filter earlier, select fewer columns, avoid the sort/hash with an index).'
                    : 'Consider increasing PGA/work area memory, or reducing the row volume feeding this operation (better filtering, an index to avoid the sort/hash).',
            });
            if (findings.length >= maxFindingsPerRule)
                break;
        }
        return findings;
    },
};
