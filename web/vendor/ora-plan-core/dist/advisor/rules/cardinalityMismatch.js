import { nodeCardinalityRatio, cardinalityRatioSeverity } from "../../format.js";
import { liveChildren } from "./shared.js";
function describeEstimate(c) {
    if (c.starts !== undefined && c.starts > 1 && c.eRowsPerStart !== undefined && c.eRowsPerStart !== c.eRowsTotal) {
        const unit = c.eRowsPerStart === 1 ? 'row' : 'rows';
        return `Estimated ${c.eRowsPerStart.toLocaleString()} ${unit} per start × ${c.starts.toLocaleString()} starts = ${c.eRowsTotal.toLocaleString()} rows`;
    }
    return `Estimated ${c.eRowsTotal.toLocaleString()} rows (E-Rows)`;
}
export const cardinalityMismatchRule = {
    id: 'cardinality-mismatch',
    requiresActualStats: true,
    evaluate(ctx) {
        const { maxFindingsPerRule, cardinalityMinRowDelta } = ctx.thresholds;
        /** Deviation (>= 1) and severity when the estimate is materially off, else undefined. */
        const assess = (node) => {
            const ratio = nodeCardinalityRatio(node);
            if (ratio === undefined)
                return undefined;
            const eRowsTotal = node.estimatedRowsTotal;
            const aRows = node.actualRows;
            // Tiny absolute differences (5 estimated vs 60 actual) are ratio noise, not a problem.
            if (Math.abs(aRows - eRowsTotal) < cardinalityMinRowDelta)
                return undefined;
            const sev = cardinalityRatioSeverity(ratio);
            if (sev === 'good')
                return undefined;
            return { deviation: ratio >= 1 ? ratio : 1 / ratio, severity: sev === 'bad' ? 'critical' : 'warning' };
        };
        const off = new Map();
        for (const node of ctx.plan.allNodes)
            off.set(node, assess(node));
        // A node whose own estimate is wrong because a child's was (the error just flows upward)
        // is not a separate problem. Operations without a comparable estimate (never started,
        // cut off early) don't break the chain: look through them to their children.
        const inputsOff = (node) => liveChildren(node).some((child) => {
            if (off.get(child) !== undefined)
                return true;
            return nodeCardinalityRatio(child) === undefined && inputsOff(child);
        });
        const byId = new Map(ctx.plan.allNodes.map((n) => [n.id, n]));
        const inheritingAncestors = (node) => {
            let count = 0;
            let parent = node.parentId === undefined ? undefined : byId.get(node.parentId);
            while (parent) {
                if (off.get(parent) !== undefined)
                    count++;
                else if (nodeCardinalityRatio(parent) !== undefined)
                    break; // estimate was right again: error absorbed
                parent = parent.parentId === undefined ? undefined : byId.get(parent.parentId);
            }
            return count;
        };
        const candidates = [];
        for (const node of ctx.plan.allNodes) {
            const verdict = off.get(node);
            if (!verdict)
                continue;
            if (inputsOff(node))
                continue;
            candidates.push({ node, ...verdict, inherited: inheritingAncestors(node) });
        }
        candidates.sort((a, b) => b.deviation - a.deviation);
        return candidates.slice(0, maxFindingsPerRule).map((c) => {
            const { node } = c;
            const inheritNote = c.inherited > 0
                ? ` The estimates of ${c.inherited} operation${c.inherited === 1 ? '' : 's'} above it are off because of this error.`
                : '';
            const root = node.children.length === 0 ? '' : ' Its inputs were estimated accurately, so the error originates here.';
            return {
                ruleId: 'cardinality-mismatch',
                severity: c.severity,
                nodeIds: [node.id],
                title: `Cardinality mismatch on ${node.operation}`,
                explanation: `${describeEstimate({ eRowsPerStart: node.rows, starts: node.starts, eRowsTotal: node.estimatedRowsTotal })} but actually produced ${node.actualRows.toLocaleString()} rows (A-Rows), a ${c.deviation.toFixed(1)}x deviation.${root}${inheritNote}`,
                suggestion: 'Gather fresh statistics (including histograms on filtered columns) or consider an SQL profile/plan baseline if the estimate consistently diverges from reality.',
            };
        });
    },
};
