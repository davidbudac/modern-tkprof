import { findIndexDiscards } from "./indexRowsDiscarded.js";
import { FULL_SCAN_RE, selfBuffers } from "./shared.js";
// Full scans (and fast full index scans) read everything by design; selective-full-scan covers them.
const ACCESS_RE = /^(TABLE ACCESS|INDEX|MAT_VIEW ACCESS)\b/;
export const bufferEfficiencyRule = {
    id: 'buffer-gets-per-row',
    requiresActualStats: true,
    evaluate(ctx) {
        const { maxFindingsPerRule, bufPerRowWarn, bufMinSelfGets, bufCriticalSelfGets, bufPerStartWarn, bufPerStartMinStarts, bufPerStartMaxRows, } = ctx.thresholds;
        // Table accesses already reported as "rows discarded after index" carry the same symptom.
        const discarded = new Set(findIndexDiscards(ctx.plan.allNodes, ctx.thresholds).map((h) => h.table.id));
        const candidates = [];
        for (const node of ctx.plan.allNodes) {
            const op = node.operation.toUpperCase();
            if (!ACCESS_RE.test(op) || FULL_SCAN_RE.test(op) || op.includes('FAST FULL SCAN'))
                continue;
            if (discarded.has(node.id))
                continue;
            const gets = selfBuffers(node);
            if (gets === undefined || gets < bufMinSelfGets)
                continue;
            const rows = node.actualRows;
            const starts = node.starts;
            const perRow = rows !== undefined ? gets / Math.max(rows, 1) : undefined;
            const perStart = starts !== undefined && starts > 0 ? gets / starts : undefined;
            const rowsPerStart = rows !== undefined && starts !== undefined && starts > 0 ? rows / starts : undefined;
            const perRowHit = perRow !== undefined && perRow >= bufPerRowWarn;
            const perStartHit = perStart !== undefined && starts !== undefined && starts >= bufPerStartMinStarts
                && perStart >= bufPerStartWarn && rowsPerStart !== undefined && rowsPerStart <= bufPerStartMaxRows;
            if (!perRowHit && !perStartHit)
                continue;
            const parts = [];
            if (perRowHit) {
                parts.push(`${Math.round(perRow).toLocaleString()} buffer gets per returned row (${gets.toLocaleString()} gets for ${rows.toLocaleString()} rows)`);
            }
            if (perStartHit) {
                parts.push(`${Math.round(perStart).toLocaleString()} buffer gets per start over ${starts.toLocaleString()} starts while returning only ${Math.round(rowsPerStart).toLocaleString()} rows per start`);
            }
            const severity = perRowHit && gets >= bufCriticalSelfGets ? 'critical' : 'warning';
            candidates.push({
                gets,
                finding: {
                    ruleId: 'buffer-gets-per-row',
                    severity,
                    nodeIds: [node.id],
                    title: `High buffer gets per row on ${node.operation}`,
                    explanation: `This operation did ${parts.join(' and ')} on its own (excluding its children), so it reads far more blocks than the rows it returns would need.`,
                    suggestion: 'Check that the access predicates match the leading columns of the index (an index with a better column order or extra filter columns would cut the blocks visited), and that a poor clustering factor or stale statistics are not forcing extra block visits.',
                },
            });
        }
        return candidates
            .sort((a, b) => (a.finding.severity === b.finding.severity ? b.gets - a.gets : a.finding.severity === 'critical' ? -1 : 1))
            .slice(0, maxFindingsPerRule)
            .map((c) => c.finding);
    },
};
