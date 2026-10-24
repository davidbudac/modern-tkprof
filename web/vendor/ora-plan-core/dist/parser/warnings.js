/**
 * Partial-parse diagnostics. The parsers read what they can and keep going; the helpers here
 * work out what was lost (an unknown column, a row that would not parse, a cut-off paste, a
 * SQL*Plus wrapper around the XML ...) and phrase it so the user knows what to do about it.
 *
 * Every warning has a stable `code` (tests and dismissal key on it) and a one-sentence message
 * that says what is missing and how to fix the capture.
 */
/** What to tell someone whose CLOB output stops mid-document. */
export const TRUNCATION_ADVICE = 'In SQL*Plus run SET LONG 100000000 LONGCHUNKSIZE 100000000 before spooling, then capture it again.';
/** Message used when XML (or an ACTIVE report) ends before its closing tag. */
export const TRUNCATED_REPORT_MESSAGE = `The report looks cut off. ${TRUNCATION_ADVICE}`;
/** Plan-table headers the parsers deliberately skip — no warning when one of them shows up. */
const IGNORED_HEADERS = [
    /^$/,
    // SQL Monitor text report columns the app has no use for
    /^cell( offload)?$/,
    /^activity detail\b/,
];
/** True for a plan-table header that is known and deliberately not read. */
export function isIgnoredHeader(label) {
    const normalized = label.trim().toLowerCase();
    return IGNORED_HEADERS.some((pattern) => pattern.test(normalized));
}
const HEADER_ROW = /\|\s*Id\s*\|.*Operation/i;
const SEPARATOR_ROW = /^[-=|+\s]+$/;
function truncateLine(line, max = 90) {
    const trimmed = line.trim();
    return trimmed.length > max ? `${trimmed.slice(0, max - 1)}…` : trimmed;
}
function listIds(ids, max = 10) {
    const shown = ids.slice(0, max).join(', ');
    return ids.length > max ? `${shown} … (+${ids.length - max} more)` : shown;
}
/** A line inside the plan table that begins a data row but could not be turned into one. */
export function isRejectedRow(line, idCell) {
    if (!line.trimStart().startsWith('|'))
        return false;
    if (HEADER_ROW.test(line))
        return false;
    // Empty Id cell = continuation line of a multi-line cell (SQL Monitor "Activity Detail").
    return idCell.trim() !== '';
}
/** Inspect the lines of the plan table that starts at `headerIndex`. */
export function scanTableShape(lines, headerIndex) {
    const header = lines[headerIndex]?.trimEnd() ?? '';
    let endIndex = headerIndex;
    let cutRows = 0;
    let strayLines = 0;
    for (let i = headerIndex + 1; i < lines.length; i++) {
        const line = lines[i].trimEnd();
        if (line.trim() === '')
            break;
        endIndex = i;
        if (SEPARATOR_ROW.test(line) && !line.includes('|'))
            continue;
        if (line.trimStart().startsWith('|')) {
            if (!line.endsWith('|'))
                cutRows++;
        }
        else {
            strayLines++;
        }
    }
    const lastLine = [...lines].reverse().find((line) => line.trim() !== '')?.trimEnd() ?? '';
    const endsMidRow = endIndex > headerIndex && lastLine.trimStart().startsWith('|') && !lastLine.endsWith('|');
    const headerCut = !header.endsWith('|');
    const wrapped = headerCut || cutRows - (endsMidRow ? 1 : 0) >= 2 || strayLines >= 2;
    return { wrapped, truncated: !wrapped && endsMidRow, endIndex };
}
/** True when the input has a plan table whose lines were wrapped (see `scanTableShape`). */
export function looksWrappedTable(input) {
    const lines = input.split('\n');
    const headerIndex = lines.findIndex((line) => HEADER_ROW.test(line));
    return headerIndex >= 0 && scanTableShape(lines, headerIndex).wrapped;
}
export const WRAPPED_TABLE_MESSAGE = 'The plan table looks wrapped — its lines were split, probably because the SQL*Plus LINESIZE was too small, so rows are missing or garbled. Run SET LINESIZE 300 (or wider) and SET TRIMSPOOL ON, then capture the plan again.';
/** Warnings for a DBMS_XPLAN / SQL Monitor text plan table. */
export function textTableWarnings(d) {
    const warnings = [];
    const shape = scanTableShape(d.lines, d.headerIndex);
    if (shape.wrapped) {
        // Wrapped rows make every other symptom (rejected rows, id gaps, odd columns) noise.
        warnings.push({
            code: 'wrapped_plan_table',
            message: WRAPPED_TABLE_MESSAGE,
        });
        return warnings;
    }
    if (shape.truncated) {
        warnings.push({
            code: 'truncated_plan_table',
            message: `The plan ends in the middle of a row, so the paste looks cut off. ${TRUNCATION_ADVICE}`,
        });
    }
    const unknown = [...new Set(d.unknownColumns)];
    if (unknown.length > 0) {
        warnings.push({
            code: 'unknown_columns',
            message: `${unknown.length === 1 ? 'A plan-table column was' : `${unknown.length} plan-table columns were`} not recognised and ignored: ${unknown.join(', ')}. Their values are not shown.`,
            detail: 'The parser does not know this column yet; the rest of the plan is read normally.',
        });
    }
    const ids = new Set(d.nodeIds);
    const max = d.nodeIds.reduce((m, id) => Math.max(m, id), -1);
    const missing = [];
    for (let id = 0; id <= max; id++)
        if (!ids.has(id))
            missing.push(id);
    if (d.rejectedLines.length > 0) {
        const n = d.rejectedLines.length;
        warnings.push({
            code: 'unparsed_rows',
            message: `${n} plan-table row${n === 1 ? '' : 's'} could not be read and ${n === 1 ? 'is' : 'are'} missing from the tree. Check that the copy is complete and was not reformatted.`,
            detail: [
                ...d.rejectedLines.slice(0, 3).map(truncateLine),
                ...(missing.length > 0 ? [`Missing operation ids: ${listIds(missing)}`] : []),
            ].join('\n'),
        });
    }
    else if (missing.length > 0) {
        warnings.push({
            code: 'id_gaps',
            message: `Operation id${missing.length === 1 ? '' : 's'} ${listIds(missing)} ${missing.length === 1 ? 'is' : 'are'} missing from the plan table, so the tree may be incomplete. Check that the copy includes every row.`,
        });
    }
    const orphanPredicates = [...new Set(d.predicateIds)].filter((id) => !ids.has(id)).sort((a, b) => a - b);
    if (orphanPredicates.length > 0) {
        warnings.push({
            code: 'predicate_unknown_ids',
            message: `Predicate Information refers to operation id${orphanPredicates.length === 1 ? '' : 's'} ${listIds(orphanPredicates)} that ${orphanPredicates.length === 1 ? 'is' : 'are'} not in the plan, so ${orphanPredicates.length === 1 ? 'that predicate is' : 'those predicates are'} not shown.`,
        });
    }
    return warnings;
}
// ---------------------------------------------------------------------------------------------
// Sections nobody consumed (DBMS_XPLAN text)
// ---------------------------------------------------------------------------------------------
/** Section titles DBMS_XPLAN / SQL*Plus print that are read, or are known noise. */
const KNOWN_SECTION_TITLE = /^(Plan hash value|SQL_ID|EXPLAINED SQL STATEMENT|PLAN_TABLE_OUTPUT|Explained|Execution Plan|Statistics|Predicate Information|Query Block Name|Query Block Registry|Outline Data|Peeked Binds|Column Projection Information|Hint Report|Remote SQL Information|Result Cache Information|Other XML|Dynamic sampling|Sql Plan Directive|Reoptimized|Adaptive plan|Notes?)\b/i;
const IDENTIFIED_BY_TITLE = /^\s*([A-Z][^|()]{2,80}?)\s*\((?:[^)]*\bidentified by\b[^)]*)\)\s*:?\s*$/;
const TITLE_LINE = /^\s*([A-Z][A-Za-z0-9 _/.'-]{2,60}?):?\s*$/;
const DASHES_LINE = /^\s*-{3,}\s*$/;
/** Titles of report sections after the plan table that no parser reads. */
export function findUnreadSections(lines, fromIndex) {
    const titles = [];
    for (let i = Math.max(fromIndex + 1, 0); i < lines.length; i++) {
        const line = lines[i];
        if (line.trimStart().startsWith('|'))
            continue;
        const identified = IDENTIFIED_BY_TITLE.exec(line);
        let title = identified ? identified[1].trim() : null;
        if (!title && DASHES_LINE.test(lines[i + 1] ?? '')) {
            const underlined = TITLE_LINE.exec(line);
            if (underlined)
                title = underlined[1].trim();
        }
        if (title && !KNOWN_SECTION_TITLE.test(title))
            titles.push(title);
    }
    return [...new Set(titles)];
}
export function unreadSectionsWarning(titles) {
    if (titles.length === 0)
        return null;
    const shown = titles.slice(0, 4).map((t) => `"${t}"`).join(', ');
    return {
        code: 'unread_sections',
        message: `${titles.length === 1 ? 'A report section was' : `${titles.length} report sections were`} not recognised and ignored: ${shown}${titles.length > 4 ? ', …' : ''}. The plan table itself is unaffected.`,
    };
}
// ---------------------------------------------------------------------------------------------
// XML wrapper / truncation
// ---------------------------------------------------------------------------------------------
/** Where the XML document can start: its declaration, else a known root element. */
const XML_START = /<\?xml\b|<(?:report|sql_monitor_report|sql_monitor|plan_monitor|plan)[\s>/]/i;
/** Name of the first element after any declaration / comments / doctype, or null. */
function rootElementName(xml) {
    let rest = xml;
    for (;;) {
        const next = rest
            .replace(/^\s*<\?[\s\S]*?\?>/, '')
            .replace(/^\s*<!--[\s\S]*?-->/, '')
            .replace(/^\s*<!DOCTYPE[^>]*>/i, '');
        if (next === rest)
            break;
        rest = next;
    }
    return /^\s*<([A-Za-z_][\w.:-]*)/.exec(rest)?.[1] ?? null;
}
/** Index of the last `</root>` closing tag (not `</root_something>`), or -1. */
function lastClosingTag(xml, root) {
    const pattern = new RegExp(`</${root.replace(/\./g, '\\.')}\\s*>`, 'g');
    let index = -1;
    for (let match = pattern.exec(xml); match; match = pattern.exec(xml))
        index = match.index;
    return index;
}
/** Cut SQL*Plus noise off both ends of an XML document. Text without recognisable XML is returned untouched. */
export function stripXmlWrapper(input) {
    const start = input.search(XML_START);
    if (start < 0)
        return { xml: input, leading: '', trailing: '' };
    const leading = input.slice(0, start);
    let xml = input.slice(start);
    let trailing = '';
    const root = rootElementName(xml);
    if (root) {
        const close = lastClosingTag(xml, root);
        const closeEnd = close >= 0 ? xml.indexOf('>', close) : -1;
        if (closeEnd >= 0) {
            trailing = xml.slice(closeEnd + 1);
            xml = xml.slice(0, closeEnd + 1);
        }
    }
    return { xml, leading, trailing };
}
/** True when the document opens but never closes its root element — a cut-off CLOB. */
export function looksTruncatedXml(input) {
    if (input.search(XML_START) < 0)
        return false;
    const { xml } = stripXmlWrapper(input);
    const root = rootElementName(xml);
    if (!root)
        return true;
    return lastClosingTag(xml, root) < 0 && !new RegExp(`<${root}\\b[^>]*/>\\s*$`).test(xml);
}
export function truncatedXmlWarning() {
    return { code: 'truncated_xml', message: TRUNCATED_REPORT_MESSAGE };
}
/** Info-level notice that SQL*Plus output around the XML was dropped so it could be parsed. */
export function xmlWrapperWarning(wrapper) {
    const leading = wrapper.leading.trim();
    const trailing = wrapper.trailing.trim();
    if (!leading && !trailing)
        return null;
    const parts = [];
    if (leading)
        parts.push(`before the XML: ${truncateLine(leading.split('\n')[0])}`);
    if (trailing)
        parts.push(`after it: ${truncateLine(trailing.split('\n')[0])}`);
    return {
        code: 'xml_wrapper_ignored',
        severity: 'info',
        message: 'Ignored SQL*Plus output around the XML report (command echo, headings or a row-count line).',
        detail: parts.join('\n'),
    };
}
