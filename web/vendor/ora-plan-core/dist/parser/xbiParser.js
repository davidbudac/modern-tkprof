import { planRootCost } from "../analysis.js";
/**
 * Parser for Tanel Poder's xbi.sql (eXplain Better) output.
 *
 * xbi.sql produces SQL*Plus formatted output (space-padded columns, no pipe delimiters)
 * with two-line headers, explicit parent IDs, and self-elapsed runtime statistics.
 * See: https://github.com/tanelpoder/tpt-oracle/blob/master/xbi.sql
 */
export const xbiParser = {
    canParse(input) {
        // Check for xbi.sql banner
        if (/eXplain Better/i.test(input))
            return true;
        // Check for characteristic "Row Source" column header with multi-column dash separator
        return /\bRow Source\b/.test(input) && /^-{3,}(\s+-{3,}){5,}/m.test(input);
    },
    parse(input) {
        const lines = input.split('\n');
        const sqlId = extractSqlId(lines);
        const planHashValue = extractPlanHash(lines);
        const tableInfo = findMainPlanTable(lines);
        if (!tableInfo) {
            return emptyPlan();
        }
        const { headerLine1, headerLine2, separatorLine, separatorIndex } = tableInfo;
        const boundaries = parseColumnBoundaries(separatorLine);
        const columns = identifyColumns(boundaries, headerLine1, headerLine2);
        if (!columns) {
            return emptyPlan();
        }
        const { rows, endIndex: dataEndIndex } = parseDataRows(lines, separatorIndex + 1, columns);
        const predicates = parseXbiPredicates(lines, dataEndIndex);
        const { rootNode, allNodes } = buildTree(rows, predicates);
        // actualTime holds SELF elapsed time at this point; computeSelfTimes
        // (analysis.ts) rolls it up to cumulative and derives activityPercent.
        const totalElapsedMs = rootNode?.actualTime;
        const hasActualStats = allNodes.some(n => n.actualRows !== undefined || n.actualTime !== undefined);
        const totalCost = planRootCost(rootNode, allNodes);
        const maxRows = Math.max(...allNodes.map(n => n.rows || 0), 0);
        const maxActualRows = Math.max(...allNodes.map(n => n.actualRows || 0), 0);
        const maxStarts = Math.max(...allNodes.map(n => n.starts || 0), 0);
        return {
            planHashValue,
            rootNode,
            allNodes,
            totalCost,
            maxRows,
            maxActualRows: hasActualStats ? maxActualRows : undefined,
            maxStarts: hasActualStats ? maxStarts : undefined,
            source: 'xbi',
            hasActualStats,
            sqlId,
            totalElapsedTime: totalElapsedMs,
        };
    },
};
function emptyPlan() {
    return {
        rootNode: null,
        allNodes: [],
        totalCost: 0,
        maxRows: 0,
        source: 'xbi',
        hasActualStats: false,
    };
}
function extractSqlId(lines) {
    for (const line of lines) {
        // From banner: "sql_id=czxpthmzk8nnd"
        const match = line.match(/sql_id[=]\s*(\w+)/i);
        if (match)
            return match[1];
    }
    return undefined;
}
function extractPlanHash(lines) {
    for (const line of lines) {
        // From cursor metadata: "Plan Hash Value" header followed by number
        const match = line.match(/\b(\d{6,})\b.*Statement first parsed/);
        if (match)
            return match[1];
    }
    // Fallback: look for Plan Hash Value in header area
    for (let i = 0; i < lines.length; i++) {
        if (/Plan Hash Value/i.test(lines[i])) {
            // The value might be on the next line(s)
            for (let j = i + 1; j < Math.min(i + 5, lines.length); j++) {
                const numMatch = lines[j].match(/\b(\d{6,})\b/);
                if (numMatch)
                    return numMatch[1];
            }
        }
    }
    return undefined;
}
/**
 * Find the main plan table by locating the "Row Source" header.
 */
function findMainPlanTable(lines) {
    for (let i = 0; i < lines.length; i++) {
        // Look for header line containing "Row Source" (with space, to distinguish from "Rowsource")
        if (/\bRow Source\b/.test(lines[i])) {
            // This should be header line 2. Next line should be the separator.
            const separatorIndex = i + 1;
            if (separatorIndex < lines.length && /^-{3,}(\s+-{3,}){3,}/.test(lines[separatorIndex].trim())) {
                return {
                    headerLine1: i > 0 ? lines[i - 1] : '',
                    headerLine2: lines[i],
                    separatorLine: lines[separatorIndex],
                    separatorIndex,
                };
            }
        }
    }
    return null;
}
/**
 * Parse column boundaries from the dash separator line.
 * Each contiguous group of dashes defines a column.
 */
function parseColumnBoundaries(separatorLine) {
    const columns = [];
    let i = 0;
    while (i < separatorLine.length) {
        // Skip spaces
        while (i < separatorLine.length && separatorLine[i] !== '-')
            i++;
        if (i >= separatorLine.length)
            break;
        // Start of dash group
        const start = i;
        while (i < separatorLine.length && separatorLine[i] === '-')
            i++;
        columns.push({ start, end: i });
    }
    return columns;
}
/**
 * Identify which column is which by examining the two header lines.
 */
function identifyColumns(boundaries, headerLine1, headerLine2) {
    let idCol;
    let rowSourceCol;
    const result = {};
    for (const bounds of boundaries) {
        const h1 = safeSubstring(headerLine1, bounds.start, bounds.end).trim().toLowerCase();
        const h2 = safeSubstring(headerLine2, bounds.start, bounds.end).trim().toLowerCase();
        const combined = h1 + ' ' + h2;
        if (h1.includes('pred') || h2.includes('#col')) {
            result.pred = bounds;
        }
        else if (h1.includes('par') && h2 === 'id') {
            result.parentId = bounds;
        }
        else if ((h1 === 'op' || h1 === '') && h2 === 'id') {
            // Op ID: h1 is "Op" (or empty), h2 is "ID", and NOT "Par."
            idCol = bounds;
        }
        else if (h1.includes('#sib') || h2.includes('ling')) {
            result.position = bounds;
        }
        else if (combined.includes('row source')) {
            rowSourceCol = bounds;
        }
        else if (combined.includes('query block') || (h2 === 'name' && !combined.includes('object'))) {
            result.queryBlock = bounds;
        }
        else if (combined.includes('ms spent') || combined.includes('this operation')) {
            result.selfElapsedMs = bounds;
        }
        else if (h1.includes('consistent') && (h2.includes('gets') || h2 === 'gets')) {
            result.consistentGets = bounds;
        }
        else if (h1.includes('rowsource') || (h2 === 'starts' && h1.includes('rowsource'))) {
            result.starts = bounds;
        }
        else if (combined.includes('real') && combined.includes('row')) {
            result.actualRows = bounds;
        }
        else if (combined.includes('est.') && combined.includes('row')) {
            result.estRowsTotal = bounds;
        }
        else if (h1.includes('current') && h2.includes('gets')) {
            result.currentGets = bounds;
        }
        else if (h1.includes('physical') && h2.includes('read')) {
            result.physicalReads = bounds;
        }
        else if (h1.includes('physical') && h2.includes('write')) {
            result.physicalWrites = bounds;
        }
        else if (h1.includes('memory') || h2.includes('used (mb)')) {
            result.memoryUsedMB = bounds;
        }
        else if (h2 === 'cost' || (h1.includes('optimizer') && combined.includes('cost'))) {
            result.cost = bounds;
        }
        else if (h2 === 'starts' && !h1.includes('rowsource')) {
            // Fallback for starts column if "Rowsource" wasn't in h1
            result.starts = bounds;
        }
    }
    // id and rowSource are required
    if (!idCol || !rowSourceCol)
        return null;
    return {
        ...result,
        id: idCol,
        rowSource: rowSourceCol,
    };
}
function safeSubstring(str, start, end) {
    if (start >= str.length)
        return '';
    return str.substring(start, Math.min(end, str.length));
}
/**
 * Parse xbi numeric value: handles commas and decimals.
 */
function parseXbiNumber(str) {
    const cleaned = str.replace(/,/g, '').trim();
    if (!cleaned)
        return undefined;
    const val = parseFloat(cleaned);
    return isNaN(val) ? undefined : val;
}
function parseXbiInt(str) {
    const val = parseXbiNumber(str);
    return val !== undefined ? Math.round(val) : undefined;
}
/**
 * Parse the "Row Source" field which contains operation + optional [ObjectName].
 */
function parseRowSource(rawText) {
    // Count leading spaces for depth
    let spaces = 0;
    for (const ch of rawText) {
        if (ch === ' ')
            spaces++;
        else
            break;
    }
    const trimmed = rawText.trim();
    // Extract object name from brackets: "TABLE ACCESS FULL [MY_TABLE]"
    const bracketMatch = trimmed.match(/^(.+?)\s+\[([^\]]+)\]\s*$/);
    if (bracketMatch) {
        return { depth: spaces, operation: bracketMatch[1].trim(), objectName: bracketMatch[2] };
    }
    // The Row Source column is cut at a fixed width, so a long name arrives with
    // no closing bracket: "TABLE ACCESS FULL [SYS_TEMP_0FD9". Keep the fragment.
    const truncatedMatch = trimmed.match(/^(.+?)\s+\[([^\]]+)$/);
    if (truncatedMatch) {
        return { depth: spaces, operation: truncatedMatch[1].trim(), objectName: truncatedMatch[2].trim() };
    }
    return { depth: spaces, operation: trimmed };
}
/**
 * Parse data rows from the plan table.
 */
function parseDataRows(lines, startIndex, columns) {
    const rows = [];
    let i = startIndex;
    for (; i < lines.length; i++) {
        const line = lines[i];
        // Stop at empty line, separator line (for predicate section), or non-data content
        if (line.trim() === '') {
            i++;
            break;
        }
        // Stop if we hit another separator line (predicate section header separator)
        if (/^-{3,}(\s+-{3,}){2,}/.test(line.trim()) && i > startIndex) {
            break;
        }
        // Stop if we hit a section header (e.g., "Predicate Information", notes with "*")
        if (/^\s*\*\s/.test(line) || /Predicate Information/i.test(line)) {
            break;
        }
        // Try to parse as a data row - must have a numeric ID
        const idStr = safeSubstring(line, columns.id.start, columns.id.end).trim();
        const idMatch = idStr.match(/^\d+$/);
        if (!idMatch) {
            // Could be a header for the predicate section or other content
            // Check if it looks like a non-data line
            if (!/^\s/.test(line) && !/\d/.test(idStr)) {
                break;
            }
            continue;
        }
        const id = parseInt(idMatch[0], 10);
        // Parse parent ID
        const parentIdStr = columns.parentId
            ? safeSubstring(line, columns.parentId.start, columns.parentId.end).trim()
            : '';
        const parentId = parentIdStr ? parseInt(parentIdStr, 10) : undefined;
        // Parse Row Source (operation + object name)
        const rowSourceRaw = safeSubstring(line, columns.rowSource.start, columns.rowSource.end);
        const { depth, operation, objectName } = parseRowSource(rowSourceRaw);
        if (!operation)
            continue;
        // Parse query block
        let queryBlock;
        if (columns.queryBlock) {
            const qb = safeSubstring(line, columns.queryBlock.start, columns.queryBlock.end).trim();
            // Ignore the ">>> Plan totals >>>" display label
            if (qb && !qb.includes('>>>')) {
                queryBlock = qb;
            }
        }
        // Parse numeric columns
        const selfElapsedMs = columns.selfElapsedMs
            ? parseXbiNumber(safeSubstring(line, columns.selfElapsedMs.start, columns.selfElapsedMs.end))
            : undefined;
        const consistentGets = columns.consistentGets
            ? parseXbiInt(safeSubstring(line, columns.consistentGets.start, columns.consistentGets.end))
            : undefined;
        const starts = columns.starts
            ? parseXbiInt(safeSubstring(line, columns.starts.start, columns.starts.end))
            : undefined;
        const actualRows = columns.actualRows
            ? parseXbiInt(safeSubstring(line, columns.actualRows.start, columns.actualRows.end))
            : undefined;
        const estRowsTotal = columns.estRowsTotal
            ? parseXbiInt(safeSubstring(line, columns.estRowsTotal.start, columns.estRowsTotal.end))
            : undefined;
        const currentGets = columns.currentGets
            ? parseXbiInt(safeSubstring(line, columns.currentGets.start, columns.currentGets.end))
            : undefined;
        const physicalReads = columns.physicalReads
            ? parseXbiInt(safeSubstring(line, columns.physicalReads.start, columns.physicalReads.end))
            : undefined;
        const physicalWrites = columns.physicalWrites
            ? parseXbiInt(safeSubstring(line, columns.physicalWrites.start, columns.physicalWrites.end))
            : undefined;
        const memoryUsedMB = columns.memoryUsedMB
            ? parseXbiNumber(safeSubstring(line, columns.memoryUsedMB.start, columns.memoryUsedMB.end))
            : undefined;
        const cost = columns.cost
            ? parseXbiInt(safeSubstring(line, columns.cost.start, columns.cost.end))
            : undefined;
        rows.push({
            id,
            parentId: !isNaN(parentId) ? parentId : undefined,
            depth,
            operation,
            objectName,
            queryBlock,
            selfElapsedMs,
            consistentGets,
            starts,
            actualRows,
            estRowsTotal,
            currentGets,
            physicalReads,
            physicalWrites,
            memoryUsedMB,
            cost,
        });
    }
    return { rows, endIndex: i };
}
/**
 * Parse the predicate section that follows the main plan table.
 * Predicates are formatted as: ID QBLOCK - access/filter/storage(...)
 */
function parseXbiPredicates(lines, startIndex) {
    const predicates = new Map();
    let currentId = null;
    let currentType = null;
    let currentText = '';
    for (let i = startIndex; i < lines.length; i++) {
        const line = lines[i];
        // Stop at notes section ("    *  ...") or outline hints
        if (/^\s*\*\s/.test(line) && !/^\s*\d/.test(line))
            break;
        if (/Outline Hints/i.test(line))
            break;
        // Check for new predicate line: "   ID  QBLOCK  - type(...)"
        const predMatch = line.match(/^\s*(\d+)\s+.*?-\s+(access|filter|storage)\((.*)$/i);
        if (predMatch) {
            // Save previous predicate
            if (currentId !== null && currentType && currentText) {
                savePredicate(predicates, currentId, currentType, currentText);
            }
            currentId = parseInt(predMatch[1], 10);
            const type = predMatch[2].toLowerCase();
            // Treat storage as access (Exadata storage indexes)
            currentType = type === 'filter' ? 'filter' : 'access';
            currentText = predMatch[3];
            // Check if complete (balanced parens)
            if (isParenBalanced(currentType + '(' + currentText)) {
                savePredicate(predicates, currentId, currentType, stripTrailingParen(currentText));
                currentId = null;
                currentType = null;
                currentText = '';
            }
            continue;
        }
        // Continuation of multi-line predicate
        if (currentId !== null && currentType && line.trim()) {
            currentText += ' ' + line.trim();
            if (isParenBalanced(currentType + '(' + currentText)) {
                savePredicate(predicates, currentId, currentType, stripTrailingParen(currentText));
                currentId = null;
                currentType = null;
                currentText = '';
            }
        }
    }
    // Save any remaining predicate
    if (currentId !== null && currentType && currentText) {
        savePredicate(predicates, currentId, currentType, stripTrailingParen(currentText));
    }
    return predicates;
}
function savePredicate(map, id, type, text) {
    const existing = map.get(id) || {};
    existing[type] = text.trim();
    map.set(id, existing);
}
function isParenBalanced(text) {
    let depth = 0;
    for (const ch of text) {
        if (ch === '(')
            depth++;
        if (ch === ')')
            depth--;
    }
    return depth <= 0;
}
function stripTrailingParen(text) {
    return text.replace(/\)\s*$/, '').trim();
}
/**
 * Build tree from parsed rows using explicit parent IDs.
 */
function buildTree(rows, predicates) {
    if (rows.length === 0) {
        return { rootNode: null, allNodes: [] };
    }
    const nodeMap = new Map();
    const allNodes = [];
    for (const row of rows) {
        const preds = predicates.get(row.id);
        // Derive per-start estimated rows from total estimated rows
        let estimatedRows;
        if (row.estRowsTotal !== undefined && row.starts && row.starts > 0) {
            estimatedRows = Math.round(row.estRowsTotal / row.starts);
        }
        else if (row.estRowsTotal !== undefined) {
            estimatedRows = row.estRowsTotal;
        }
        // Logical reads = consistent gets + current gets
        const logicalReads = row.consistentGets !== undefined || row.currentGets !== undefined
            ? (row.consistentGets || 0) + (row.currentGets || 0)
            : undefined;
        const node = {
            id: row.id,
            depth: row.depth,
            operation: row.operation,
            objectName: row.objectName,
            cost: row.cost,
            rows: estimatedRows,
            // XBI reports the true total estimate; keep it exact instead of re-deriving
            // it from the rounded per-start figure. A never-started row carries no signal.
            estimatedRowsTotal: row.actualRows !== undefined && row.starts !== 0 ? row.estRowsTotal : undefined,
            actualRows: row.actualRows,
            actualTime: row.selfElapsedMs,
            starts: row.starts,
            logicalReads,
            physicalReads: row.physicalReads,
            memoryUsed: row.memoryUsedMB !== undefined ? Math.round(row.memoryUsedMB * 1048576) : undefined,
            queryBlock: row.queryBlock,
            accessPredicates: preds?.access,
            filterPredicates: preds?.filter,
            children: [],
        };
        nodeMap.set(row.id, node);
        allNodes.push(node);
    }
    // Link parent-child using explicit parentId
    for (const row of rows) {
        if (row.parentId !== undefined) {
            const node = nodeMap.get(row.id);
            const parent = nodeMap.get(row.parentId);
            if (node && parent) {
                parent.children.push(node);
                node.parentId = row.parentId;
            }
        }
    }
    // Root is id 0 or first node without a parent
    const rootNode = nodeMap.get(0) || allNodes.find(n => n.parentId === undefined) || allNodes[0] || null;
    return { rootNode, allNodes };
}
