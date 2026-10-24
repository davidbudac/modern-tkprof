import { pxSkew } from "../../parser/sqlMonitorXmlExtras.js";
function ms(value) {
    return value >= 1000 ? `${(value / 1000).toFixed(1)} s` : `${Math.round(value)} ms`;
}
function ratioText(m) {
    return `${m.ratio.toFixed(1)}x`;
}
/** The servers of a set that did the most work by `key`, busiest first, as "p005 (4.2 s)". */
function busiest(members, key, format) {
    return members
        .filter((m) => (m[key] ?? 0) > 0)
        .sort((a, b) => (b[key] ?? 0) - (a[key] ?? 0))
        .slice(0, 2)
        .map((m) => `${m.name} (${format(m[key])})`)
        .join(', ');
}
/**
 * Per-PX-server skew, from the `<parallel_info>` sessions of a SQL Monitor XML report. Oracle does not
 * say which plan lines a server set runs, so the finding is plan-level (`nodeIds: []`).
 */
export const pxSkewRule = {
    id: 'px-skew',
    evaluate(ctx) {
        const servers = ctx.plan.monitorMetadata?.parallelServers;
        if (!servers)
            return [];
        const { pxSkewWarn, pxSkewCritical, pxSkewMinElapsedMs, pxSkewMinBufferGets, maxFindingsPerRule } = ctx.thresholds;
        const dop = ctx.plan.monitorMetadata?.dop;
        const findings = [];
        for (const skew of pxSkew(servers)) {
            if (skew.serverCount < 2)
                continue;
            const members = servers.filter((s) => !s.isCoordinator && s.set === skew.set);
            const elapsedHit = skew.elapsed?.ratio !== undefined && skew.elapsed.ratio >= pxSkewWarn
                && skew.elapsed.avg * skew.serverCount >= pxSkewMinElapsedMs;
            const getsHit = skew.bufferGets?.ratio !== undefined && skew.bufferGets.ratio >= pxSkewWarn
                && skew.bufferGets.avg * skew.serverCount >= pxSkewMinBufferGets;
            if (!elapsedHit && !getsHit)
                continue;
            const worst = Math.max(elapsedHit ? skew.elapsed?.ratio : 0, getsHit ? skew.bufferGets?.ratio : 0);
            const severity = worst >= pxSkewCritical ? 'critical' : 'warning';
            const parts = [];
            if (elapsedHit && skew.elapsed) {
                parts.push(`elapsed time: the busiest server ran ${ms(skew.elapsed.max)} against an average of ${ms(skew.elapsed.avg)} (${ratioText(skew.elapsed)}; ${busiest(members, 'elapsedMs', ms)})`);
            }
            if (getsHit && skew.bufferGets) {
                const fmt = (v) => v.toLocaleString();
                parts.push(`buffer gets: ${fmt(Math.round(skew.bufferGets.max))} on the busiest server against an average of ${fmt(Math.round(skew.bufferGets.avg))} (${ratioText(skew.bufferGets)}; ${busiest(members, 'bufferGets', fmt)})`);
            }
            findings.push({
                ruleId: 'px-skew',
                severity,
                nodeIds: [],
                title: `Uneven work across PX server set ${skew.set}`,
                explanation: `PX server set ${skew.set} (${skew.serverCount} servers${dop !== undefined ? `, DOP ${dop}` : ''}) did its work unevenly - ${parts.join('; ')}. The statement waits for the slowest server of a set, so the rest of the degree of parallelism sits idle while one server finishes.`,
                suggestion: 'Check how rows are distributed to this set: a HASH distribution (PX SEND HASH) on a skewed join key or a hot value sends most rows to one server. Test PQ_DISTRIBUTE with BROADCAST for the smaller input (or HYBRID HASH, which lets 12c+ adaptive distribution switch to broadcast), look for a partition-wise join that avoids redistribution, and check the join key for data skew (a histogram on it lets the optimizer see hot values).',
            });
            if (findings.length >= maxFindingsPerRule)
                break;
        }
        return findings;
    },
};
