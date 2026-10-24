export function evaluateBadges(input) {
    const badges = [];
    if (!input.match)
        return badges;
    const { key, object } = input.match;
    if (object.type !== 'TABLE')
        return badges;
    const isEnabled = (kind) => input.enabled?.[kind] !== false;
    if (isEnabled('stale-stats') && object.stats.stale_stats === 'YES') {
        badges.push({
            kind: 'stale-stats',
            reason: `Stale stats — DBA_TAB_STATISTICS.STALE_STATS = 'YES' on ${key}.`,
        });
    }
    if (isEnabled('missing-stats') && (object.stats.last_analyzed === null || object.stats.num_rows === null)) {
        const detail = object.stats.last_analyzed === null && object.stats.num_rows === null
            ? 'last_analyzed and num_rows are null'
            : object.stats.last_analyzed === null
                ? 'last_analyzed is null'
                : 'num_rows is null';
        badges.push({
            kind: 'missing-stats',
            reason: `Missing stats — ${detail} on ${key}.`,
        });
    }
    if (isEnabled('mismatch-no-histogram')) {
        const severity = input.cardinalitySeverity;
        const cols = input.predicateColumns ?? [];
        if (severity === 'warn' || severity === 'bad') {
            const resolved = cols.filter((c) => Object.prototype.hasOwnProperty.call(object.columns, c));
            if (resolved.length > 0 && resolved.every((c) => object.columns[c].histogram.type === 'NONE')) {
                const list = resolved.join(', ');
                badges.push({
                    kind: 'mismatch-no-histogram',
                    reason: `Cardinality mismatch on ${key} — no histogram on predicate column${resolved.length === 1 ? '' : 's'} ${list}.`,
                });
            }
        }
    }
    return badges;
}
