import type { BindVariable } from './parser/types.js';
import type { PlanNotes } from './parser/noteSection.js';
export type { BindVariable } from './parser/types.js';
export type { PlanNotes } from './parser/noteSection.js';
export interface PlanNode {
    id: number;
    depth: number;
    operation: string;
    objectName?: string;
    alias?: string;
    inactive?: boolean;
    rows?: number;
    bytes?: number;
    cost?: number;
    cpuPercent?: number;
    time?: string;
    tempSpace?: number;
    pstart?: string;
    pstop?: string;
    tq?: string;
    inOut?: string;
    pqDistrib?: string;
    actualRows?: number;
    actualTime?: number;
    selfTime?: number;
    starts?: number;
    memoryUsed?: number;
    tempUsed?: number;
    estimatedRowsTotal?: number;
    selfCost?: number;
    physicalReads?: number;
    physicalWrites?: number;
    logicalReads?: number;
    estimatedOptimalMemory?: number;
    estimatedOnePassMemory?: number;
    workareaPasses?: number;
    workareaExecutions?: {
        optimal: number;
        onePass: number;
        multipass: number;
    };
    ioReadRequests?: number;
    ioReadBytes?: number;
    ioWriteRequests?: number;
    ioWriteBytes?: number;
    activityPercent?: number;
    firstActiveOffset?: number;
    lastActiveOffset?: number;
    firstRowOffset?: number;
    accessPredicates?: string;
    filterPredicates?: string;
    storagePredicates?: string;
    queryBlock?: string;
    objectAlias?: string;
    projection?: string;
    remoteSql?: string;
    hints?: PlanHint[];
    parentId?: number;
    children: PlanNode[];
}
/** One entry of the DBMS_XPLAN Hint Report (19c+), attached to the operation it was reported on. */
export interface PlanHint {
    text: string;
    /** `used` = no status letter; `unused` = U; `error` = E (syntax error); `other` = any other letter. */
    status: 'used' | 'unused' | 'error' | 'other';
    /** The raw status letter (U, E, …) when one was printed. */
    code?: string;
    /** Text after ` / ` in the entry, e.g. "hint on view cannot be pushed into view". */
    reason?: string;
    queryBlock?: string;
    alias?: string;
}
/** Hint Report totals: `Total hints for statement: 3 (U - Unused (1), E - Syntax error (2))`. */
export interface HintSummary {
    total: number;
    unused: number;
    errors: number;
}
export type PlanSource = 'dbms_xplan' | 'sql_monitor_text' | 'sql_monitor_xml' | 'json' | 'csv' | 'xbi';
export type NodeIndicatorMetric = 'cost' | 'actualRows' | 'actualTime' | 'starts' | 'activityPercent';
/**
 * Something the parser could not read or had to guess at. The plan still loads, but the user
 * is told what is missing (see `lib/parser/warnings.ts`). `code` is stable (tests, dismissal).
 */
export interface PlanWarning {
    code: string;
    /** Short plain-English sentence: what was lost and what to do about it. */
    message: string;
    /** Specifics (column names, row ids, ...) for the expanded view. */
    detail?: string;
    /** `info` = nothing was lost (e.g. noise was ignored); default `warn`. */
    severity?: 'info' | 'warn';
}
export interface ParsedPlan {
    planHashValue?: string;
    rootNode: PlanNode | null;
    allNodes: PlanNode[];
    totalCost: number;
    maxRows: number;
    maxActualRows?: number;
    maxStarts?: number;
    maxSelfTime?: number;
    source: PlanSource;
    hasActualStats: boolean;
    sqlId?: string;
    childNumber?: number;
    sqlText?: string;
    totalElapsedTime?: number;
    bindVariables?: BindVariable[];
    monitorMetadata?: SqlMonitorMetadata;
    notes?: PlanNotes;
    activityTimeline?: ActivityTimeline;
    planInfo?: Record<string, string>;
    outlineHints?: string[];
    hintSummary?: HintSummary;
    warnings?: PlanWarning[];
}
/** One ASH sample from a SQL Monitor report-level <activity_detail> bucket. */
export interface ActivitySample {
    bucket: number;
    line?: number;
    waitClass: string;
    event?: string;
    count: number;
}
/** Report-level ASH timeline parsed from <activity_detail>. */
export interface ActivityTimeline {
    startTime?: string;
    durationSecs: number;
    bucketIntervalSecs: number;
    bucketCount: number;
    samples: ActivitySample[];
}
/** One parallel execution session from SQL Monitor XML <parallel_info>. Times in milliseconds. */
export interface ParallelServer {
    /** Oracle process name: `p000`, `PX Coordinator`, ... */
    name: string;
    /** True for the query coordinator session (it belongs to no server set). */
    isCoordinator?: boolean;
    /** PX server set number (1 = producers/consumers of the first DFO, ...). */
    set?: number;
    group?: number;
    serverNum?: number;
    instance?: number;
    sessionId?: number;
    sessionSerial?: number;
    elapsedMs?: number;
    cpuMs?: number;
    ioWaitMs?: number;
    otherWaitMs?: number;
    bufferGets?: number;
    readReqs?: number;
    readBytes?: number;
}
export interface SqlMonitorMetadata {
    status?: string;
    duration?: number;
    sqlExecStart?: string;
    sqlExecId?: string;
    cpuTime?: number;
    userIoWaitTime?: number;
    otherWaitTime?: number;
    plsqlExecTime?: number;
    sessionId?: number;
    sessionSerial?: number;
    instanceId?: number;
    user?: string;
    program?: string;
    module?: string;
    service?: string;
    dbVersion?: string;
    dbUniqueName?: string;
    dbPlatform?: string;
    reportHostName?: string;
    cpuCores?: number;
    hyperthread?: boolean;
    bufferGets?: number;
    readReqs?: number;
    readBytes?: number;
    userFetchCount?: number;
    optimizerEnv?: Record<string, string>;
    dop?: number;
    pxServersRequested?: number;
    pxServersAllocated?: number;
    parallelServers?: ParallelServer[];
    pxServerSets?: number;
    pxServerGroups?: number;
}
export type PredicateType = 'access' | 'filter' | 'storage' | 'none';
export interface NodeDisplayOptions {
    showRows: boolean;
    showCost: boolean;
    showBytes: boolean;
    showObjectName: boolean;
    showPredicateIndicators: boolean;
    showPredicateDetails: boolean;
    showPartitionInfo: boolean;
    showQueryBlockBadge: boolean;
    showQueryBlockGrouping: boolean;
    showActualRows: boolean;
    showActualTime: boolean;
    showStarts: boolean;
    showHotspotBadge: boolean;
    showSpillBadge: boolean;
    showCardinalityBadge: boolean;
    showAdvisorBadge: boolean;
    showStaleStatsBadge: boolean;
    showMissingStatsBadge: boolean;
    showMismatchNoHistogramBadge: boolean;
    showAnnotations: boolean;
    /**
     * Progressive disclosure: collapse the whole node body into a single quiet
     * mono metric line plus one amber warning dot. Suppresses the stats grid,
     * badge row, query-block/alias chips, partition info and predicate chips
     * regardless of the individual toggles above (those keep acting as signal
     * sources for the dot). Defaults to false for existing saved settings.
     */
    compactStats: boolean;
}
export interface FilterState {
    operationTypes: string[];
    minCost: number;
    maxCost: number;
    searchText: string;
    showPredicates: boolean;
    predicateTypes: PredicateType[];
    animateEdges: boolean;
    scaleEdgeWidth: boolean;
    focusSelection: boolean;
    nodeDisplayOptions: NodeDisplayOptions;
    minActualRows: number;
    maxActualRows: number;
    minActualTime: number;
    maxActualTime: number;
    minCardinalityMismatch: number;
}
export type ViewMode = 'hierarchical' | 'sankey' | 'flame' | 'tabular' | 'text' | 'sql' | 'metadata' | 'compare' | 'monitor' | 'experimental' | 'ai' | 'ai-report';
export type SankeyMetric = 'rows' | 'cost' | 'actualRows' | 'actualTime';
export type ExperimentalSubView = 'scatter' | 'timeline' | 'waterfall' | 'morph' | 'waits';
export type { FlameMetric } from './flameLayout.js';
export type Theme = 'light' | 'dark';
export declare const OPERATION_CATEGORIES: Record<string, string[]>;
export declare function getOperationCategory(operation: string): string;
export type ColorScheme = 'contrast' | 'semantic' | 'estact' | 'rail' | 'ticker' | 'stripe' | 'tinted' | 'terminal';
/**
 * App palette — a third appearance axis next to theme (light/dark) and color
 * scheme (data paint). It re-skins the app's neutral surfaces and accent by
 * redefining the Tailwind slate/blue ramps under `html[data-palette=…]`
 * (see the palette blocks in index.css). 'slate' is the built-in look and
 * applies zero overrides.
 */
export type AppPalette = 'slate' | 'graphite' | 'teal' | 'violet' | 'paper';
export declare const APP_PALETTE_ORDER: AppPalette[];
export declare const APP_PALETTE_LABELS: Record<AppPalette, string>;
export declare const COLOR_SCHEME_PALETTES: Record<ColorScheme, Record<string, string>>;
/**
 * Theme-aware paint for a category swatch in the data-viz views
 * (flame bars, sankey nodes, waterfall bars).
 *
 * Light mode keeps the saturated palette hex as a solid fill. Dark mode
 * follows the tree view's grammar instead — a tinted surface (hue at ~15%)
 * with a colored hairline (hue at ~60%) — so the canvas stays quiet and the
 * chrome, not the data, reads as the loudest thing on screen.
 */
export declare function getCategoryPaint(category: string, scheme: ColorScheme, isDark: boolean): {
    fill: string;
    stroke: string;
};
export declare const EDGE_SCHEME_COLORS: Record<ColorScheme, {
    light: {
        active: string;
        default: string;
        focus: string;
        dimmed: string;
    };
    dark: {
        active: string;
        default: string;
        focus: string;
        dimmed: string;
    };
}>;
export declare const COLOR_SCHEMES: Record<ColorScheme, Record<string, {
    bg: string;
    border: string;
    text: string;
}>>;
export declare function getCostColor(cost: number, totalCost: number): string;
export declare function getMetricColor(ratio: number): string;
export declare function formatNumber(num: number): string;
/** Brief tooltips for common Oracle execution plan operations. */
export declare const OPERATION_TOOLTIPS: Record<string, string>;
/** Look up tooltip for an operation, trying exact match first, then prefix match. */
export declare function getOperationTooltip(operation: string): string | undefined;
