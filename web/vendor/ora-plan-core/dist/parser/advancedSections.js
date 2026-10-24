/**
 * Parsers for the sections DBMS_XPLAN adds with the ADVANCED format: Outline Data, Peeked
 * Binds, Column Projection Information, Remote SQL Information and the Hint Report.
 * Each parser reads only its own section: it starts at its header and stops at the next
 * known section header (or earlier, at the section's natural end), so one section never
 * swallows another.
 */
/** Headers of every section DBMS_XPLAN can print after the plan table. */
const SECTION_HEADER = /^\s*(Plan hash value|Predicate Information|Query Block Name|Query Block Registry|Outline Data|Peeked Binds|Column Projection Information|Hint Report|Remote SQL Information|Other XML|Dynamic sampling|Sql Plan Directive|Reoptimized|Adaptive plan)\b|^\s*Note\s*$/i;
/** Index of the line that opens a section, or -1. */
function findHeader(lines, header) {
    return lines.findIndex((line) => header.test(line));
}
/** Strip the double quotes Oracle puts around identifiers (`"E"@"SEL$1"` → `E@SEL$1`). */
function unquote(text) {
    return text.replace(/"/g, '');
}
// ---------------------------------------------------------------------------------------------
// Outline Data
// ---------------------------------------------------------------------------------------------
/** Net change in parenthesis depth of `text`, ignoring quoted text. */
function parenDelta(text) {
    let depth = 0;
    let single = false;
    let double = false;
    for (const ch of text) {
        if (single) {
            if (ch === "'")
                single = false;
        }
        else if (double) {
            if (ch === '"')
                double = false;
        }
        else if (ch === "'") {
            single = true;
        }
        else if (ch === '"') {
            double = true;
        }
        else if (ch === '(') {
            depth++;
        }
        else if (ch === ')') {
            depth--;
        }
    }
    return depth;
}
/**
 * Parse the "Outline Data" block into one hint per entry, verbatim. The comment wrapper
 * and the BEGIN/END_OUTLINE_DATA markers are dropped; a hint that wraps across lines
 * (unbalanced parentheses) is joined with one space.
 */
export function parseOutlineSection(lines) {
    const start = findHeader(lines, /^\s*Outline Data\b/i);
    if (start === -1)
        return undefined;
    const hints = [];
    let pending = '';
    let sawBody = false;
    for (let i = start + 1; i < lines.length; i++) {
        const line = lines[i];
        if (SECTION_HEADER.test(line))
            break;
        let text = line.trim();
        if (text === '' || /^[-=]+$/.test(text)) {
            if (sawBody && pending === '' && text === '')
                break;
            continue;
        }
        sawBody = true;
        const closes = /\*\/\s*$/.test(text);
        text = text.replace(/^\/\*\+\s*/, '').replace(/\s*\*\/\s*$/, '');
        if (text !== '') {
            pending = pending ? `${pending} ${text}` : text;
            if (parenDelta(pending) <= 0) {
                if (!/^(BEGIN|END)_OUTLINE_DATA$/i.test(pending))
                    hints.push(pending);
                pending = '';
            }
        }
        if (closes)
            break;
    }
    if (pending && !/^(BEGIN|END)_OUTLINE_DATA$/i.test(pending))
        hints.push(pending);
    return hints.length > 0 ? hints : undefined;
}
// ---------------------------------------------------------------------------------------------
// Peeked Binds
// ---------------------------------------------------------------------------------------------
/**
 * Split `(TYPE[, CSID=n …]): value` after a bind name. Returns the text between the outer
 * parentheses and what follows the colon, or null when the shape is not recognised.
 */
function splitBindBody(rest) {
    if (!rest.startsWith('('))
        return null;
    let depth = 0;
    for (let i = 0; i < rest.length; i++) {
        if (rest[i] === '(')
            depth++;
        else if (rest[i] === ')') {
            depth--;
            if (depth === 0) {
                const after = rest.slice(i + 1).trim();
                if (!after.startsWith(':'))
                    return null;
                return { meta: rest.slice(1, i), value: after.slice(1).trim() };
            }
        }
    }
    return null;
}
/** First top-level comma-separated part of `VARCHAR2(30), CSID=873` → `VARCHAR2(30)`. */
function bindType(meta) {
    let depth = 0;
    for (let i = 0; i < meta.length; i++) {
        if (meta[i] === '(')
            depth++;
        else if (meta[i] === ')')
            depth--;
        else if (meta[i] === ',' && depth === 0)
            return meta.slice(0, i).trim() || undefined;
    }
    return meta.trim() || undefined;
}
/**
 * Parse "Peeked Binds (identified by position)": `1 - :1 (NUMBER): 20` and
 * `2 - :2 (VARCHAR2(30), CSID=873): 'SYS'`. String values lose their surrounding quotes so
 * they agree with the SQL Monitor XML parser (which stores the element text); an unquoted
 * `NULL` becomes `null`.
 */
export function parsePeekedBinds(lines) {
    const start = findHeader(lines, /^\s*Peeked Binds\b/i);
    if (start === -1)
        return [];
    const binds = [];
    for (let i = start + 1; i < lines.length; i++) {
        const line = lines[i];
        const trimmed = line.trim();
        if (SECTION_HEADER.test(line))
            break;
        if (trimmed === '' || /^[-=]+$/.test(trimmed)) {
            if (binds.length > 0 && trimmed === '')
                break;
            continue;
        }
        const head = line.match(/^\s*(\d+)\s*-\s*(:?[\w$#]+)\s*/);
        if (!head)
            break;
        const body = splitBindBody(line.slice(head[0].length));
        if (!body)
            continue;
        let value = body.value;
        const quoted = value.match(/^'(.*)'$/s);
        if (quoted)
            value = quoted[1].replace(/''/g, "'");
        else if (/^NULL$/i.test(value) || value === '')
            value = null;
        binds.push({
            name: head[2],
            type: bindType(body.meta),
            value,
            position: parseInt(head[1], 10),
        });
    }
    return binds;
}
// ---------------------------------------------------------------------------------------------
// Column Projection Information / Remote SQL Information
// ---------------------------------------------------------------------------------------------
/**
 * Parse an "identified by operation id" section whose entries are `<id> - <text>` with
 * wrapped continuation lines (indented, no id). Wrapped lines are joined with one space;
 * the first blank line after the entries ends the section.
 */
function parseIdTextSection(lines, header) {
    const result = new Map();
    const start = findHeader(lines, header);
    if (start === -1)
        return result;
    let currentId = null;
    let parts = [];
    const flush = () => {
        if (currentId !== null) {
            const text = parts.filter(Boolean).join(' ');
            if (text)
                result.set(currentId, result.has(currentId) ? `${result.get(currentId)} ${text}` : text);
        }
        currentId = null;
        parts = [];
    };
    for (let i = start + 1; i < lines.length; i++) {
        const line = lines[i];
        const trimmed = line.trim();
        if (SECTION_HEADER.test(line))
            break;
        if (trimmed === '') {
            if (currentId !== null)
                break; // a blank line after the entries ends the section
            continue;
        }
        if (/^[-=]+$/.test(trimmed))
            continue;
        const entry = line.match(/^\s*(\d+)\s*-\s?(.*)$/);
        if (entry) {
            flush();
            currentId = parseInt(entry[1], 10);
            parts.push(entry[2].trim());
        }
        else if (currentId !== null) {
            parts.push(trimmed);
        }
    }
    flush();
    return result;
}
/** Per-operation `Column Projection Information` text. */
export function parseProjectionSection(lines) {
    return parseIdTextSection(lines, /^\s*Column Projection Information\b/i);
}
/** Per-operation `Remote SQL Information` statement text. */
export function parseRemoteSqlSection(lines) {
    return parseIdTextSection(lines, /^\s*Remote SQL Information\b/i);
}
/** `   1 -  SEL$1 / O@SEL$1` — a hint group: operation id, query block, optional alias. */
const HINT_GROUP = /^\s*(\d+)\s*-\s+(\S+)(?:\s*\/\s*(\S+))?\s*$/;
/** `         E -  no_such_hint` / `         -  FULL(t)` — a hint, optionally with a status letter. */
const HINT_ENTRY = /^\s+(?:([A-Za-z])\s+)?-\s+(.*\S)\s*$/;
function statusOf(code) {
    switch (code?.toUpperCase()) {
        case undefined:
            return 'used';
        case 'U':
            return 'unused';
        case 'E':
            return 'error';
        default:
            return 'other';
    }
}
/** `Total hints for statement: 3 (U - Unused (1), E - Syntax error (2))` */
function parseHintSummary(line) {
    const total = line.match(/Total hints for statement:\s*(\d+)/i);
    if (!total)
        return undefined;
    const unused = line.match(/U\s*-\s*Unused\s*\((\d+)\)/i);
    const errors = line.match(/E\s*-\s*Syntax error\s*\((\d+)\)/i);
    return {
        total: parseInt(total[1], 10),
        unused: unused ? parseInt(unused[1], 10) : 0,
        errors: errors ? parseInt(errors[1], 10) : 0,
    };
}
/**
 * Parse the 19c+ "Hint Report" into per-operation hints and the statement summary.
 *
 * Hints are grouped under `<id> -  QB [/ alias]` lines. A status letter marks a problem
 * (`U` unused, `E` syntax error, anything else `other`); no letter means the hint was used.
 * Text after ` / ` in an entry is the reason.
 */
export function parseHintReport(lines) {
    const hints = new Map();
    const start = findHeader(lines, /^\s*Hint Report\b/i);
    if (start === -1)
        return { hints };
    let summary;
    let group = null;
    const counted = { total: 0, unused: 0, errors: 0 };
    for (let i = start + 1; i < lines.length; i++) {
        const line = lines[i];
        const trimmed = line.trim();
        if (SECTION_HEADER.test(line))
            break;
        if (trimmed === '' || /^[-=]+$/.test(trimmed))
            continue;
        if (/^\s*Total hints/i.test(line)) {
            summary = parseHintSummary(line) ?? summary;
            continue;
        }
        const groupMatch = line.match(HINT_GROUP);
        if (groupMatch) {
            group = {
                id: parseInt(groupMatch[1], 10),
                queryBlock: unquote(groupMatch[2]),
                alias: groupMatch[3] ? unquote(groupMatch[3]) : undefined,
            };
            continue;
        }
        const entry = line.match(HINT_ENTRY);
        if (entry && group) {
            const code = entry[1];
            const slash = entry[2].indexOf(' / ');
            const text = (slash === -1 ? entry[2] : entry[2].slice(0, slash)).trim();
            const reason = slash === -1 ? undefined : entry[2].slice(slash + 3).trim() || undefined;
            const status = statusOf(code);
            const hint = { text, status, queryBlock: group.queryBlock };
            if (code)
                hint.code = code.toUpperCase();
            if (reason)
                hint.reason = reason;
            if (group.alias)
                hint.alias = group.alias;
            const list = hints.get(group.id) ?? [];
            list.push(hint);
            hints.set(group.id, list);
            counted.total++;
            if (status === 'unused')
                counted.unused++;
            if (status === 'error')
                counted.errors++;
        }
    }
    return { hints, summary: summary ?? (counted.total > 0 ? counted : undefined) };
}
