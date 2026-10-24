import { planRootCost } from "../analysis.js";
/**
 * Parser for Oracle execution plans in JSON format.
 * Handles JSON extracted from V$SQL_PLAN_STATISTICS_ALL via JSON_ARRAYAGG/JSON_OBJECT,
 * as used by tools like Datadog's explain plan visualizer and Tanel Poder's xdd.sql scripts.
 *
 * Expected input: a JSON array of objects, each representing a plan operation.
 * Keys are flexible (snake_case or camelCase variants supported).
 */
export const jsonPlanParser = {
    canParse(input) {
        const trimmed = input.trim();
        // Must start with [ and end with ] (JSON array)
        if (!trimmed.startsWith('[') || !trimmed.endsWith(']')) {
            return false;
        }
        try {
            const parsed = JSON.parse(trimmed);
            if (!Array.isArray(parsed) || parsed.length === 0) {
                return false;
            }
            // Check that first element looks like a plan operation
            const first = parsed[0];
            return (typeof first === 'object' &&
                first !== null &&
                ('id' in first || 'ID' in first) &&
                ('operation' in first || 'OPERATION' in first));
        }
        catch {
            return false;
        }
    },
    parse(input) {
        let rawArray;
        try {
            rawArray = JSON.parse(input.trim());
        }
        catch {
            return emptyPlan('json');
        }
        if (!Array.isArray(rawArray) || rawArray.length === 0) {
            return emptyPlan('json');
        }
        return buildPlanFromRows(rawArray, 'json');
    },
};
function emptyPlan(source) {
    return {
        rootNode: null,
        allNodes: [],
        totalCost: 0,
        maxRows: 0,
        source,
        hasActualStats: false,
    };
}
/**
 * Build a plan from V$SQL_PLAN-style rows (one object per operation, keys flexibly named).
 * Shared by the JSON and CSV parsers.
 */
export function buildPlanFromRows(rows, source) {
    // Normalize keys to lowercase for flexible matching
    const normalized = rows.map(normalizeKeys);
    const allNodes = [];
    const nodeMap = new Map();
    for (const row of normalized) {
        const node = parseJsonOperation(row);
        if (node) {
            nodeMap.set(node.id, node);
            allNodes.push(node);
        }
    }
    if (allNodes.length === 0) {
        return emptyPlan(source);
    }
    // Build parent-child relationships
    for (const node of allNodes) {
        if (node.parentId !== undefined) {
            const parent = nodeMap.get(node.parentId);
            if (parent) {
                parent.children.push(node);
            }
        }
    }
    // If no parent_id was available, build tree from depth
    const hasParentIds = allNodes.some(n => n.parentId !== undefined);
    if (!hasParentIds) {
        for (let i = 1; i < allNodes.length; i++) {
            const current = allNodes[i];
            for (let j = i - 1; j >= 0; j--) {
                if (allNodes[j].depth < current.depth) {
                    allNodes[j].children.push(current);
                    current.parentId = allNodes[j].id;
                    break;
                }
            }
        }
    }
    const rootNode = nodeMap.get(0) || allNodes.find(n => n.parentId === undefined) || null;
    const hasActualStats = allNodes.some(n => n.actualRows !== undefined || n.actualTime !== undefined);
    const totalCost = planRootCost(rootNode, allNodes);
    const maxRows = Math.max(...allNodes.map(n => n.actualRows || n.rows || 0), 0);
    const maxActualRows = Math.max(...allNodes.map(n => n.actualRows || 0), 0);
    const maxStarts = Math.max(...allNodes.map(n => n.starts || 0), 0);
    // Total elapsed time: root node's actualTime or sum heuristic
    const totalElapsedTime = rootNode?.actualTime || 0;
    // Try to extract plan hash from the data (some scripts include it as metadata)
    const planHashValue = getStr(normalized[0], 'plan_hash_value') ||
        getStr(normalized[0], 'plan_hash') || undefined;
    const sqlId = getStr(normalized[0], 'sql_id') || undefined;
    const childNumber = getInt(normalized[0], 'child_number');
    const sqlText = getStr(normalized[0], 'sql_text', 'sql_fulltext');
    return {
        planHashValue,
        sqlId,
        childNumber,
        sqlText,
        rootNode,
        allNodes,
        totalCost,
        maxRows,
        maxActualRows: hasActualStats ? maxActualRows : undefined,
        maxStarts: hasActualStats ? maxStarts : undefined,
        source,
        hasActualStats,
        totalElapsedTime,
    };
}
/**
 * Normalize all keys to lowercase with underscores for consistent lookup.
 * Handles: "OPERATION", "Operation", "operation", "object_name", "objectName", etc.
 */
function normalizeKeys(obj) {
    const result = {};
    for (const [key, value] of Object.entries(obj)) {
        // Convert camelCase to snake_case, then lowercase
        const normalized = key
            .replace(/([a-z])([A-Z])/g, '$1_$2')
            .toLowerCase();
        result[normalized] = value;
    }
    return result;
}
function getNum(row, ...keys) {
    for (const key of keys) {
        const val = row[key];
        if (val !== undefined && val !== null && val !== '') {
            const num = typeof val === 'number' ? val : parseFloat(String(val));
            if (!isNaN(num))
                return num;
        }
    }
    return undefined;
}
function getInt(row, ...keys) {
    const num = getNum(row, ...keys);
    return num !== undefined ? Math.round(num) : undefined;
}
function getStr(row, ...keys) {
    for (const key of keys) {
        const val = row[key];
        if (val !== undefined && val !== null && val !== '') {
            return String(val).trim();
        }
    }
    return undefined;
}
// OTHER_TAG values -> DBMS_XPLAN's IN-OUT column codes
const IN_OUT_CODES = {
    SERIAL_FROM_REMOTE: 'R->S',
    SERIAL_TO_PARALLEL: 'S->P',
    PARALLEL_FROM_SERIAL: 'S->P',
    PARALLEL_TO_SERIAL: 'P->S',
    PARALLEL_TO_PARALLEL: 'P->P',
    PARALLEL_COMBINED_WITH_PARENT: 'PCWP',
    PARALLEL_COMBINED_WITH_CHILD: 'PCWC',
    SERIAL: '',
};
/**
 * DBMS_XPLAN's %CPU: share of the cost that is not I/O, rounded. CPU_COST is in
 * CPU cycles, not cost units, so it cannot be compared with IO_COST directly.
 */
function cpuPercentFromCost(cost, ioCost) {
    if (cost === undefined || ioCost === undefined)
        return undefined;
    if (cost <= 0)
        return 0;
    return Math.min(100, Math.max(0, Math.round(((cost - ioCost) * 100) / cost)));
}
function unquote(value) {
    return value?.replace(/"/g, '') || undefined;
}
/** Whole seconds as DBMS_XPLAN's Time column prints them (HH:MM:SS); an already formatted value passes through. */
function parsePlanTime(value) {
    if (!value)
        return undefined;
    if (value.includes(':'))
        return value;
    if (!/^\d+(\.\d+)?$/.test(value))
        return undefined;
    const totalSeconds = Math.round(parseFloat(value));
    const pad = (n) => String(n).padStart(2, '0');
    const h = Math.floor(totalSeconds / 3600);
    const m = Math.floor((totalSeconds % 3600) / 60);
    return `${pad(h)}:${pad(m)}:${pad(totalSeconds % 60)}`;
}
/** Buffers as DISPLAY_CURSOR reports them: consistent gets + current gets. */
function getBufferGets(row) {
    for (const prefix of ['actual_', 'last_', '']) {
        const cr = getInt(row, `${prefix}cr_buffer_gets`);
        const cu = getInt(row, `${prefix}cu_buffer_gets`);
        if (cr !== undefined || cu !== undefined)
            return (cr ?? 0) + (cu ?? 0);
    }
    return getInt(row, 'buffer_gets', 'logical_reads');
}
/** LAST_EXECUTION: 'OPTIMAL' -> 0, 'ONE PASS' / '1 PASS' -> 1, 'n PASSES' -> n. */
function parseWorkareaPasses(value) {
    if (value === undefined || value === null || value === '')
        return undefined;
    if (typeof value === 'number')
        return Number.isFinite(value) ? value : undefined;
    const text = String(value).trim().toUpperCase();
    if (text === 'OPTIMAL')
        return 0;
    if (/^(ONE|1)[\s_-]*PASS$/.test(text))
        return 1;
    const m = /^(\d+)\s*PASSES$/.exec(text);
    return m ? parseInt(m[1], 10) : undefined;
}
function parseJsonOperation(row) {
    const id = getInt(row, 'id');
    if (id === undefined)
        return null;
    // Build operation name from operation + options (V$SQL_PLAN format)
    const operation = getStr(row, 'operation') || '';
    const options = getStr(row, 'options');
    const fullOperation = options ? `${operation} ${options}` : operation;
    if (!fullOperation)
        return null;
    const depth = getInt(row, 'depth') || 0;
    // Object info
    const objectName = getStr(row, 'object_name');
    // V$SQL_PLAN quotes aliases ("P"@"SEL$1"); the other parsers store them without quotes
    const objectAlias = unquote(getStr(row, 'object_alias'));
    // Estimated stats (optimizer)
    const rows = getInt(row, 'cardinality', 'rows', 'e_rows');
    const bytes = getInt(row, 'bytes');
    const cost = getInt(row, 'cost');
    const ioCost = getInt(row, 'io_cost');
    // Actual runtime stats
    // V$SQL_PLAN_STATISTICS_ALL uses last_* prefix
    const actualRows = getInt(row, 'actual_rows', 'last_output_rows', 'output_rows', 'a_rows');
    const starts = getInt(row, 'actual_starts', 'last_starts', 'starts');
    // Workarea sizes (LAST_MEMORY_USED, ESTIMATED_*_SIZE) are bytes in these views,
    // although the Oracle reference says KB (verified on 19c against DBMS_XPLAN OMem/1Mem/Used-Mem).
    const memoryUsed = getInt(row, 'actual_memory_used', 'last_memory_used', 'max_memory', 'used_mem');
    // LAST_TEMPSEG_SIZE is bytes.
    const tempUsed = getInt(row, 'actual_tempseg_size', 'last_tempseg_size', 'max_tempseg_size', 'used_tmp');
    const physicalReads = getInt(row, 'actual_disk_reads', 'last_disk_reads', 'physical_reads');
    const physicalWrites = getInt(row, 'actual_disk_writes', 'last_disk_writes', 'disk_writes', 'physical_writes');
    const logicalReads = getBufferGets(row);
    // Elapsed time: V$SQL_PLAN_STATISTICS_ALL stores in microseconds
    const elapsedTimeUs = getNum(row, 'actual_elapsed_time', 'last_elapsed_time', 'elapsed_time');
    const actualTime = elapsedTimeUs !== undefined ? elapsedTimeUs / 1000 : undefined;
    // Predicates
    const accessPredicates = getStr(row, 'access_predicates');
    const filterPredicates = getStr(row, 'filter_predicates');
    // Optimizer time estimate (V$SQL_PLAN.TIME is whole seconds), shown like DBMS_XPLAN's Time column
    const time = parsePlanTime(getStr(row, 'time'));
    const projection = getStr(row, 'projection');
    // Query block / partition info
    const queryBlock = unquote(getStr(row, 'qblock_name', 'query_block'));
    // Temp space from optimizer (estimate; actual spill is tempUsed)
    const tempSpace = getInt(row, 'temp_space');
    // Partition / parallel execution columns (V$SQL_PLAN: PARTITION_START/STOP,
    // OBJECT_NODE, OTHER_TAG, DISTRIBUTION), or the DBMS_XPLAN short names
    const pstart = getStr(row, 'partition_start', 'pstart');
    const pstop = getStr(row, 'partition_stop', 'pstop');
    const tq = getStr(row, 'object_node', 'tq');
    const otherTag = getStr(row, 'other_tag', 'in_out');
    const inOut = otherTag ? (IN_OUT_CODES[otherTag.toUpperCase()] ?? otherTag) || undefined : undefined;
    const pqDistrib = getStr(row, 'distribution', 'pq_distrib');
    // Workarea (V$SQL_PLAN_STATISTICS_ALL), bytes (see above)
    const estimatedOptimalMemory = getInt(row, 'estimated_optimal_size');
    const estimatedOnePassMemory = getInt(row, 'estimated_onepass_size');
    const workareaPasses = parseWorkareaPasses(row['last_execution']);
    const optimalExecs = getInt(row, 'optimal_executions');
    const onePassExecs = getInt(row, 'onepass_executions');
    const multipassExecs = getInt(row, 'multipasses_executions');
    const workareaExecutions = optimalExecs !== undefined || onePassExecs !== undefined || multipassExecs !== undefined
        ? { optimal: optimalExecs ?? 0, onePass: onePassExecs ?? 0, multipass: multipassExecs ?? 0 }
        : undefined;
    const node = {
        id,
        depth,
        operation: fullOperation,
        objectName,
        objectAlias,
        queryBlock,
        rows,
        bytes,
        cost,
        time,
        cpuPercent: cpuPercentFromCost(cost, ioCost),
        tempSpace,
        pstart,
        pstop,
        tq,
        inOut,
        pqDistrib,
        estimatedOptimalMemory,
        estimatedOnePassMemory,
        workareaPasses,
        workareaExecutions,
        physicalWrites,
        actualRows,
        actualTime,
        starts,
        memoryUsed,
        tempUsed,
        physicalReads,
        logicalReads,
        accessPredicates,
        filterPredicates,
        projection,
        children: [],
    };
    // Parent ID
    const parentId = getInt(row, 'parent_id');
    if (parentId !== undefined) {
        node.parentId = parentId;
    }
    return node;
}
