import { buildPlanFromRows } from "./jsonPlanParser.js";
import { normalizeNewlines } from "./values.js";
/**
 * Parser for V$SQL_PLAN / V$SQL_PLAN_STATISTICS_ALL query results exported as CSV:
 * SQL*Plus `SET MARKUP CSV ON`, SQLcl `set sqlformat csv`, SQL Developer's CSV export,
 * plus tab-separated grid copies and `;`-delimited (European locale) exports.
 *
 * The header row carries the view's column names (ID, PARENT_ID, OPERATION, ...); each
 * record becomes one row object that the shared row-to-tree builder (jsonPlanParser) reads.
 */
const DELIMITERS = [',', ';', '\t'];
/** The header must show up within this many non-empty lines (SQL*Plus may print a prompt or banner first). */
const HEADER_SEARCH_LINES = 5;
const KEY_COLUMNS_FOR_SPLIT = ['INST_ID', 'SQL_ID', 'CHILD_NUMBER', 'PLAN_HASH_VALUE'];
/**
 * Read one RFC-4180 record starting at `pos`. A quote opens a quoted field only at the start of
 * a field; inside one, `""` is a literal quote and delimiters / newlines are data.
 * Expects `\n` line endings.
 */
function readRecord(text, pos, delimiter) {
    const cells = [];
    const n = text.length;
    let field = '';
    let i = pos;
    let atFieldStart = true;
    let unterminated = false;
    while (i < n) {
        const ch = text[i];
        if (atFieldStart && ch === '"') {
            i++;
            let closed = false;
            while (i < n) {
                if (text[i] === '"') {
                    if (text[i + 1] === '"') {
                        field += '"';
                        i += 2;
                        continue;
                    }
                    i++;
                    closed = true;
                    break;
                }
                field += text[i++];
            }
            if (!closed)
                unterminated = true;
            atFieldStart = false;
            continue;
        }
        if (ch === delimiter) {
            cells.push(field);
            field = '';
            atFieldStart = true;
            i++;
            continue;
        }
        if (ch === '\n')
            break;
        field += ch;
        atFieldStart = false;
        i++;
    }
    cells.push(field);
    return { cells, end: i, next: i < n ? i + 1 : n, unterminated };
}
function normalizeHeaderCell(cell) {
    return cell.trim().toUpperCase();
}
function isPlanHeader(header) {
    return header.includes('ID') && header.includes('OPERATION') && (header.includes('PARENT_ID') || header.includes('DEPTH'));
}
/** Find the header line (and its delimiter) within the first few non-empty lines. */
function findHeader(text) {
    let pos = 0;
    let seen = 0;
    while (pos < text.length && seen < HEADER_SEARCH_LINES) {
        let lineEnd = text.indexOf('\n', pos);
        if (lineEnd < 0)
            lineEnd = text.length;
        const line = text.slice(pos, lineEnd);
        const lead = line.length - line.trimStart().length;
        if (line.trim() !== '') {
            seen++;
            for (const delimiter of DELIMITERS) {
                // A header never spans lines, so reading the line on its own is exact.
                const { cells } = readRecord(line, lead, delimiter);
                const header = cells.map(normalizeHeaderCell);
                if (isPlanHeader(header)) {
                    return { delimiter, start: pos + lead, end: lineEnd, next: Math.min(lineEnd + 1, text.length), header };
                }
            }
        }
        pos = lineEnd + 1;
    }
    return null;
}
/** BOM off, line endings normalised to `\n`. */
function prepare(input) {
    return normalizeNewlines(input.replace(/^\uFEFF/, ''));
}
function readTable(input) {
    const text = prepare(input);
    const found = findHeader(text);
    if (!found)
        return null;
    const records = [];
    let pos = found.next;
    let unterminatedAt;
    while (pos < text.length) {
        const { cells, end, next, unterminated } = readRecord(text, pos, found.delimiter);
        if (unterminated) {
            // The quote swallowed the rest of the file: that record is garbage, drop it.
            unterminatedAt = pos;
            break;
        }
        if (!(cells.length === 1 && cells[0].trim() === '')) {
            records.push({ cells, start: pos, end });
        }
        pos = next;
    }
    return { text, delimiter: found.delimiter, header: found.header, headerText: text.slice(found.start, found.end), records, unterminatedAt };
}
const INTEGER = /^\s*\d+\s*$/;
/** SQL*Plus / SQLcl chatter after the data: "3 rows selected.", "Elapsed: ...", prompts, or a single stray cell. */
function isNoise(record, header) {
    const { cells } = record;
    if (cells.length === 1)
        return true;
    if (cells.every((c) => c.trim() === ''))
        return true;
    // Header repeated (SQL*Plus PAGESIZE, concatenated exports)
    return cells.length === header.length && cells.every((c, i) => normalizeHeaderCell(c) === header[i]);
}
const DECIMAL_COMMA = /^\s*-?\d{1,3}(\.\d{3})*,\d+\s*$|^\s*-?\d+,\d+\s*$/;
const THOUSANDS_DOT = /^\s*-?\d{1,3}(\.\d{3})+\s*$/;
/**
 * `;`-delimited exports often use the European locale (`1,5` = 1.5, `1.234` = 1234). Decided per
 * file: one decimal-comma cell makes `.` a thousands separator and `,` the decimal point. Without
 * one, a dotted-thousands-looking cell (`1.234`) is genuinely ambiguous: left as is, and reported.
 */
function normalizeLocaleNumbers(records) {
    let decimalComma = false;
    let thousandsDot = false;
    for (const { cells } of records) {
        for (const c of cells) {
            if (DECIMAL_COMMA.test(c))
                decimalComma = true;
            else if (THOUSANDS_DOT.test(c))
                thousandsDot = true;
        }
    }
    if (!decimalComma)
        return { ambiguous: thousandsDot };
    for (const record of records) {
        record.cells = record.cells.map((c) => DECIMAL_COMMA.test(c) || THOUSANDS_DOT.test(c) ? c.trim().replace(/\./g, '').replace(',', '.') : c);
    }
    return { ambiguous: false };
}
function truncateLine(line, max = 90) {
    const trimmed = line.trim();
    return trimmed.length > max ? `${trimmed.slice(0, max - 1)}…` : trimmed;
}
export const csvPlanParser = {
    canParse(input) {
        return findHeader(prepare(input)) !== null;
    },
    parse(input) {
        const table = readTable(input);
        if (!table)
            return buildPlanFromRows([], 'csv');
        const idIndex = table.header.indexOf('ID');
        const rows = [];
        const seenIds = new Set();
        const duplicateIds = new Set();
        const rejected = [];
        const dataRecords = table.records.filter((r) => !isNoise(r, table.header) && INTEGER.test(r.cells[idIndex] ?? ''));
        const { ambiguous } = table.delimiter === ';' ? normalizeLocaleNumbers(dataRecords) : { ambiguous: false };
        for (const record of table.records) {
            if (isNoise(record, table.header))
                continue;
            const idCell = record.cells[idIndex] ?? '';
            if (!INTEGER.test(idCell)) {
                rejected.push(record);
                continue;
            }
            const id = parseInt(idCell, 10);
            if (seenIds.has(id)) {
                duplicateIds.add(id);
                continue;
            }
            seenIds.add(id);
            const row = {};
            table.header.forEach((name, i) => {
                // The row builder lower-cases keys, so the upper-cased header names match.
                row[name] = record.cells[i] ?? '';
            });
            rows.push(row);
        }
        const plan = buildPlanFromRows(rows, 'csv');
        const warnings = [];
        if (rejected.length > 0) {
            const n = rejected.length;
            warnings.push({
                code: 'unparsed_rows',
                message: `${n} CSV row${n === 1 ? '' : 's'} had no numeric ID and ${n === 1 ? 'was' : 'were'} skipped, so ${n === 1 ? 'it is' : 'they are'} missing from the tree. Check that the export is complete and was not reformatted.`,
                detail: rejected.slice(0, 3).map((r) => truncateLine(table.text.slice(r.start, r.end))).join('\n'),
            });
        }
        if (duplicateIds.size > 0) {
            const ids = [...duplicateIds].sort((a, b) => a - b);
            const shown = ids.slice(0, 10).join(', ') + (ids.length > 10 ? ` … (+${ids.length - 10} more)` : '');
            warnings.push({
                code: 'duplicate_ids',
                message: `Operation id${ids.length === 1 ? '' : 's'} ${shown} appear${ids.length === 1 ? 's' : ''} more than once, so the export holds several plans (SQL_IDs or child cursors). Only the first row of each id was read; export one plan at a time (WHERE sql_id = … AND child_number = …).`,
            });
        }
        if (ambiguous) {
            warnings.push({
                code: 'ambiguous_numbers',
                message: 'Some numbers look like 1.234 in a ;-delimited file, which is 1234 in European locales and 1.234 otherwise. They were read as plain decimals; if the export uses a decimal comma, check the values or export with a . decimal separator.',
            });
        }
        if (table.unterminatedAt !== undefined) {
            warnings.push({
                code: 'truncated_csv',
                message: 'The CSV ends inside a quoted field, so the tail looks truncated (or a quote is unbalanced) and the last row was skipped. Export the full result again.',
                detail: truncateLine(table.text.slice(table.unterminatedAt, table.unterminatedAt + 200)),
            });
        }
        if (warnings.length > 0)
            plan.warnings = [...(plan.warnings ?? []), ...warnings];
        return plan;
    },
};
/**
 * Split a CSV holding several plans (SQL_ID / CHILD_NUMBER / PLAN_HASH_VALUE) into one text per
 * plan, each with the original header. Returns `[input]` when there is a single plan (or no
 * column to tell plans apart) and `[]` when the input is not a plan CSV.
 */
export function splitCsvPlanBatches(input) {
    const table = readTable(input);
    if (!table)
        return [];
    const idIndex = table.header.indexOf('ID');
    const keyIndexes = KEY_COLUMNS_FOR_SPLIT.map((name) => table.header.indexOf(name)).filter((i) => i >= 0);
    if (keyIndexes.length === 0)
        return [input];
    const groups = new Map();
    let lastGroup;
    const orphans = [];
    for (const record of table.records) {
        if (isNoise(record, table.header))
            continue;
        if (!INTEGER.test(record.cells[idIndex] ?? '')) {
            // Keep rows with a non-numeric ID with their plan so the per-plan parse can warn about them.
            const raw = table.text.slice(record.start, record.end);
            if (lastGroup)
                lastGroup.push(raw);
            else
                orphans.push(raw);
            continue;
        }
        const key = keyIndexes.map((i) => (record.cells[i] ?? '').trim()).join('\u0000');
        const raw = table.text.slice(record.start, record.end);
        const group = groups.get(key);
        if (group) {
            group.push(raw);
            lastGroup = group;
        }
        else {
            const created = [...orphans.splice(0), raw];
            groups.set(key, created);
            lastGroup = created;
        }
    }
    if (groups.size <= 1)
        return [input];
    return [...groups.values()].map((raws) => [table.headerText, ...raws].join('\n'));
}
