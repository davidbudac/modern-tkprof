export const DEFAULT_THRESHOLDS = {
    nlStartsWarn: 10_000,
    nlStartsCritical: 100_000,
    nlInnerRowsWarn: 100_000,
    nlInnerRowsCritical: 1_000_000,
    cardinalityMinRowDelta: 100,
    cartesianMinSideRows: 100,
    cartesianCriticalProduct: 10_000_000,
    ftsMinTableRows: 10_000,
    ftsSelectivityWarn: 0.01,
    ftsSelectivityCritical: 0.001,
    ftsCriticalMinTableRows: 1_000_000,
    ftsFallbackMaxRowsPerStart: 1_000,
    ftsFallbackMinGetsPerStart: 10_000,
    spillCriticalBytes: 1 << 30,
    // Per-row re-execution (FILTER / scalar subqueries). Oracle caches subquery results, so Starts
    // counts real executions: 10k is where a cheap subquery starts to show up in elapsed time.
    reexecStartsWarn: 10_000,
    reexecStartsCritical: 100_000,
    // A remote operation started per row is one network round trip per start (~1 ms or more on a LAN).
    remoteStartsWarn: 100,
    remoteStartsCritical: 1_000,
    // Rows an index scan returned that the table access then threw away (A-Rows are cumulative on both).
    indexDiscardRatio: 10,
    indexDiscardMinRows: 1_000,
    indexDiscardCriticalRows: 1_000_000,
    // Self buffer gets of an access operation. A healthy index probe costs ~1-5 gets per row and a
    // rowid fetch ~1; 100 gets per returned row with at least 10k gets means ~99% of the blocks read
    // contributed nothing. The per-start trigger catches repeated probes (Starts >= 10) that read
    // 1,000+ blocks each to return at most 100 rows.
    bufPerRowWarn: 100,
    bufMinSelfGets: 10_000,
    bufCriticalSelfGets: 1_000_000,
    bufPerStartWarn: 1_000,
    bufPerStartMinStarts: 10,
    bufPerStartMaxRows: 100,
    // Hash join build side (the first child) much larger than the probe side. 100k rows is where the
    // hash table stops being trivially small for the default work area.
    hashBuildMinRows: 100_000,
    hashBuildProbeRatio: 10,
    // PX skew: busiest server of a set vs the set's average. Needs material work in the set (summed
    // over its servers) so a 20 ms query that happens to be 3x lopsided does not light up.
    pxSkewWarn: 2,
    pxSkewCritical: 4,
    pxSkewMinElapsedMs: 1_000,
    pxSkewMinBufferGets: 100_000,
    maxFindingsPerRule: 5,
};
