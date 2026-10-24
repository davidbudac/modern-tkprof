/**
 * Parsers for the trailing sections of DBMS_XPLAN text output that attach data to plan
 * operations by Id: "Predicate Information" and "Query Block Name / Object Alias".
 * Shared by the DBMS_XPLAN and SQL Monitor text parsers.
 */
/** `  15 - access("X"=1` — a predicate for an operation id. */
const PREDICATE_START = /^\s*(\d+)\s*-\s*(access|filter|storage)\s*\(/i;
/** `       filter("X"=1` — a further predicate for the id of the line above (no Id printed). */
const IDLESS_PREDICATE_START = /^\s*(access|filter|storage)\s*\(/i;
/** Headers of the sections that follow the predicates. */
const SECTION_HEADER = /^\s*(Column Projection Information|Hint Report|Outline Data|Query Block|Remote SQL|Peeked Binds|Predicate Information|Other XML|Dynamic sampling|Sql Plan Directive)\b|^\s*Note\s*$/i;
/** Strip the double quotes Oracle puts around identifiers (`"E"@"SEL$1"` → `E@SEL$1`). */
function unquote(text) {
    return text.replace(/"/g, '');
}
/**
 * Feed one chunk of predicate text to an open predicate. Returns true once its outer
 * parenthesis closes (the text up to it has been added to `parts`). Parentheses inside
 * single- or double-quoted strings are not counted; quote state carries across lines
 * because DBMS_XPLAN wraps long predicates anywhere, including inside a literal.
 */
function feed(open, chunk) {
    for (let i = 0; i < chunk.length; i++) {
        const ch = chunk[i];
        if (open.inSingle) {
            if (ch === "'")
                open.inSingle = false;
        }
        else if (open.inDouble) {
            if (ch === '"')
                open.inDouble = false;
        }
        else if (ch === "'") {
            open.inSingle = true;
        }
        else if (ch === '"') {
            open.inDouble = true;
        }
        else if (ch === '(') {
            open.depth++;
        }
        else if (ch === ')') {
            open.depth--;
            if (open.depth === 0) {
                open.parts.push(chunk.slice(0, i).trim());
                return true;
            }
        }
    }
    open.parts.push(chunk.trim());
    return false;
}
/**
 * Parse the "Predicate Information" section into per-operation access / filter / storage
 * predicate text (outer `access(` … `)` stripped, wrapped lines joined with one space).
 *
 * - `<id> - access|filter|storage(` starts a predicate for that id;
 * - an Id-less line beginning with `access(`, `filter(` or `storage(` starts another
 *   predicate for the current id;
 * - any other non-empty line continues the open predicate;
 * - a predicate ends when its parentheses balance (quoted text excluded);
 * - the same type twice for one id is joined with ` AND `;
 * - the next section header ends the section.
 */
export function parsePredicateSection(lines) {
    const result = new Map();
    const start = lines.findIndex((line) => /^\s*Predicate Information/i.test(line));
    if (start === -1)
        return result;
    let open = null;
    let currentId = null;
    const store = (predicate) => {
        const text = predicate.parts.filter(Boolean).join(' ');
        if (!text)
            return;
        const entry = result.get(predicate.id) ?? {};
        entry[predicate.type] = entry[predicate.type] ? `${entry[predicate.type]} AND ${text}` : text;
        result.set(predicate.id, entry);
    };
    const begin = (id, type, rest) => {
        currentId = id;
        open = { id, type, parts: [], depth: 1, inSingle: false, inDouble: false };
        if (feed(open, rest)) {
            store(open);
            open = null;
        }
    };
    for (let i = start + 1; i < lines.length; i++) {
        const line = lines[i];
        const trimmed = line.trim();
        if (!open && (trimmed === '' || /^[-=]+$/.test(trimmed)))
            continue;
        // The next section ends this one (an unbalanced predicate keeps what it collected).
        if (SECTION_HEADER.test(line) || (/^[A-Z].*:$/i.test(trimmed) && !/^\d+\s*-/.test(trimmed)))
            break;
        if (open) {
            if (trimmed === '')
                continue;
            if (feed(open, trimmed)) {
                store(open);
                open = null;
            }
            continue;
        }
        const withId = line.match(PREDICATE_START);
        if (withId) {
            begin(parseInt(withId[1], 10), withId[2].toLowerCase(), line.slice(withId[0].length));
            continue;
        }
        const idless = line.match(IDLESS_PREDICATE_START);
        if (idless && currentId !== null) {
            begin(currentId, idless[1].toLowerCase(), line.slice(idless[0].length));
        }
    }
    if (open)
        store(open);
    return result;
}
/**
 * Parse the "Query Block Name / Object Alias" section into per-operation query block and
 * object alias (`   2 - SET$1        / O@SEL$1`). Quotes around names are stripped so the
 * values agree with the SQL Monitor XML parser.
 */
export function parseQueryBlockSection(lines) {
    const result = new Map();
    const start = lines.findIndex((line) => /^\s*Query Block Name\s*\/\s*Object Alias/i.test(line));
    if (start === -1)
        return result;
    let seenData = false;
    for (let i = start + 1; i < lines.length; i++) {
        const line = lines[i];
        const trimmed = line.trim();
        if (trimmed === '' || /^[-=]+$/.test(trimmed)) {
            if (seenData && trimmed === '')
                break;
            continue; // blank lines and the dashes between the header and the first row
        }
        const match = line.match(/^\s*(\d+)\s*-\s*(\S+)(?:\s*\/\s*(\S+))?/);
        if (!match)
            break; // next section (or an empty one)
        seenData = true;
        result.set(parseInt(match[1], 10), {
            queryBlock: unquote(match[2]),
            objectAlias: match[3] ? unquote(match[3]) : undefined,
        });
    }
    return result;
}
