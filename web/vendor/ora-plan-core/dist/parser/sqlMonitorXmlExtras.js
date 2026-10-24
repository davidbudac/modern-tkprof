/**
 * Extras from the real Oracle SQL Monitor XML: adaptive-plan flags, quoted aliases, plan
 * `<info>` entries, outline hints and per-session parallel stats. Pure functions over the
 * parsed `Document` / `Element`s.
 */
/**
 * `"O"@"SEL$1"` -> `O@SEL$1`, the spelling DBMS_XPLAN's text Query Block / Alias section uses.
 * Doubled quotes inside a quoted identifier are not unescaped (Oracle aliases essentially never
 * contain them).
 */
export function normalizeObjectAlias(alias) {
    const text = alias?.replace(/"/g, '').trim();
    return text ? text : undefined;
}
/** `<operation skp="1">`: the operation was skipped (not chosen) by an adaptive plan. */
export function isSkippedOperation(op) {
    return op.getAttribute('skp') === '1';
}
// ---------------------------------------------------------------------------------------------
// <info> entries and the Note section
// ---------------------------------------------------------------------------------------------
/**
 * Collect every `<info type="...">value</info>` under the `<plan>` element (Oracle puts them in
 * the first operation's `<other_xml>`). A type that repeats keeps each distinct value, joined
 * with ", " (e.g. `nodeid/pflags`). Order follows the document.
 */
export function parsePlanInfo(doc) {
    const plan = doc.querySelector('plan');
    if (!plan)
        return undefined;
    const values = new Map();
    plan.querySelectorAll('info').forEach((info) => {
        const type = info.getAttribute('type');
        if (!type)
            return;
        const value = info.textContent?.trim() ?? '';
        const list = values.get(type);
        if (!list)
            values.set(type, [value]);
        else if (!list.includes(value))
            list.push(value);
    });
    if (values.size === 0)
        return undefined;
    const result = {};
    values.forEach((list, type) => {
        result[type] = list.join(', ');
    });
    return result;
}
/** `y`, `yes`, `true`, `1` (and any other non-empty value that isn't a clear "no"). */
function isAffirmative(value) {
    if (value === undefined)
        return false;
    const v = value.trim().toLowerCase();
    return v !== '' && !['n', 'no', 'false', '0', 'off'].includes(v);
}
/** Strip the CDATA-preserved double quotes Oracle puts around names (`"PLANVIZ"`). */
function unquote(value) {
    return value.replace(/^"(.*)"$/, '$1');
}
/**
 * Fill the same `PlanNotes` fields the DBMS_XPLAN "Note" section would from the `<info>`
 * entries that map onto it, and synthesise the corresponding Note lines (worded as DBMS_XPLAN
 * words them, so line-based consumers such as the advisor's plan-notes rule keep working).
 * Returns undefined when nothing maps.
 *
 * Mapped types: dynamic_sampling (value = level), adaptive_plan, cardinality_feedback,
 * statistics_feedback, sql_profile, sql_patch, baseline (SQL plan baseline), outline, and
 * dop + dop_reason ("Degree of Parallelism is N because of ...").
 *
 * Only `dynamic_sampling`, `dop`, `dop_reason` and the raw `has_user_tab`/`db_version`/... types
 * appear in the bundled captures; the others follow Oracle's documented/known shape and are
 * matched defensively.
 */
export function planNotesFromInfo(info) {
    if (!info)
        return undefined;
    const rawLines = [];
    const notes = { rawLines };
    const dynamic = info['dynamic_sampling'];
    if (isAffirmative(dynamic)) {
        notes.dynamicSampling = true;
        const level = /^\d+$/.test(dynamic.trim()) ? parseInt(dynamic.trim(), 10) : undefined;
        if (level !== undefined)
            notes.dynamicSamplingLevel = level;
        rawLines.push(`dynamic statistics used: dynamic sampling${level !== undefined ? ` (level=${level})` : ''}`);
    }
    if (isAffirmative(info['cardinality_feedback'])) {
        notes.cardinalityFeedback = true;
        rawLines.push('cardinality feedback used for this statement');
    }
    if (isAffirmative(info['statistics_feedback'])) {
        notes.statisticsFeedback = true;
        rawLines.push('statistics feedback used for this statement');
    }
    if (isAffirmative(info['adaptive_plan'])) {
        notes.adaptivePlan = true;
        rawLines.push('this is an adaptive plan');
    }
    const profile = info['sql_profile'];
    if (profile && isAffirmative(profile)) {
        notes.sqlProfile = unquote(profile);
        rawLines.push(`SQL profile "${notes.sqlProfile}" used for this statement`);
    }
    const patch = info['sql_patch'];
    if (patch && isAffirmative(patch)) {
        // PlanNotes has no sqlPatch field; the advisor's plan-notes rule reads it from the lines.
        rawLines.push(`SQL patch "${unquote(patch)}" used for this statement`);
    }
    const baseline = info['baseline'];
    if (baseline && isAffirmative(baseline)) {
        notes.sqlPlanBaseline = unquote(baseline);
        rawLines.push(`SQL plan baseline "${notes.sqlPlanBaseline}" used for this statement`);
    }
    const outline = info['outline'];
    if (outline && isAffirmative(outline)) {
        notes.outline = unquote(outline);
        rawLines.push(`outline "${notes.outline}" used for this statement`);
    }
    const dop = info['dop'];
    const dopReason = info['dop_reason'];
    if (dop && dopReason) {
        rawLines.push(`Degree of Parallelism is ${dop} because of ${dopReason}`);
    }
    return rawLines.length > 0 ? notes : undefined;
}
// ---------------------------------------------------------------------------------------------
// Outline hints
// ---------------------------------------------------------------------------------------------
/** `<outline_data><hint>…</hint></outline_data>` hints in document order, one per entry. */
export function parseOutlineHints(doc) {
    const plan = doc.querySelector('plan');
    if (!plan)
        return undefined;
    const hints = [];
    plan.querySelectorAll('outline_data > hint').forEach((hint) => {
        const text = hint.textContent?.trim();
        if (text)
            hints.push(text);
    });
    return hints.length > 0 ? hints : undefined;
}
function intAttr(el, name) {
    const raw = el.getAttribute(name);
    if (raw === null || raw.trim() === '')
        return undefined;
    const n = parseInt(raw, 10);
    return Number.isNaN(n) ? undefined : n;
}
function statNumber(statsEl, name) {
    if (!statsEl)
        return undefined;
    for (const stat of Array.from(statsEl.querySelectorAll('stat'))) {
        if (stat.getAttribute('name') !== name)
            continue;
        const text = stat.textContent?.trim();
        if (!text)
            return undefined;
        const n = parseFloat(text);
        return Number.isNaN(n) ? undefined : n;
    }
    return undefined;
}
/** Microsecond stat -> milliseconds. */
function statMs(statsEl, name) {
    const us = statNumber(statsEl, name);
    return us === undefined ? undefined : us / 1000;
}
/**
 * Parse `<parallel_info>`: one `<session>` per PX server (plus the coordinator), each with
 * `<stats type="monitor">` in microseconds. A session carries `server_group` / `server_set` /
 * `server_num` for PX servers; the coordinator (`process_name="PX Coordinator"`) has none.
 * Absent stats stay undefined. Returns undefined when the report has no `<parallel_info>`.
 */
export function parseParallelInfo(doc) {
    const info = doc.querySelector('parallel_info');
    if (!info)
        return undefined;
    const servers = [];
    info.querySelectorAll('session').forEach((session) => {
        const name = session.getAttribute('process_name')?.trim();
        if (!name)
            return;
        const stats = session.querySelector('stats[type="monitor"]');
        const server = { name };
        const set = intAttr(session, 'server_set');
        const group = intAttr(session, 'server_group');
        const serverNum = intAttr(session, 'server_num');
        if (set !== undefined)
            server.set = set;
        else if (group === undefined && serverNum === undefined)
            server.isCoordinator = true;
        if (group !== undefined)
            server.group = group;
        if (serverNum !== undefined)
            server.serverNum = serverNum;
        const fields = [
            ['instance', intAttr(session, 'inst_id')],
            ['sessionId', intAttr(session, 'session_id')],
            ['sessionSerial', intAttr(session, 'session_serial')],
            ['elapsedMs', statMs(stats, 'elapsed_time')],
            ['cpuMs', statMs(stats, 'cpu_time')],
            ['ioWaitMs', statMs(stats, 'user_io_wait_time')],
            ['otherWaitMs', statMs(stats, 'other_wait_time')],
            ['bufferGets', statNumber(stats, 'buffer_gets')],
            ['readReqs', statNumber(stats, 'read_reqs')],
            ['readBytes', statNumber(stats, 'read_bytes')],
        ];
        for (const [key, value] of fields) {
            if (value !== undefined)
                server[key] = value;
        }
        servers.push(server);
    });
    const target = doc.querySelector('target');
    const childInt = (name) => {
        const text = target?.querySelector(`:scope > ${name}`)?.textContent?.trim();
        if (!text)
            return undefined;
        const n = parseInt(text, 10);
        return Number.isNaN(n) ? undefined : n;
    };
    return {
        servers,
        dop: intAttr(info, 'dop'),
        serverSets: intAttr(info, 'server_set_count'),
        serverGroups: intAttr(info, 'server_group_count'),
        serversRequested: childInt('servers_requested'),
        serversAllocated: childInt('servers_allocated'),
    };
}
function skewOf(values) {
    if (values.length === 0)
        return undefined;
    const max = Math.max(...values);
    const avg = values.reduce((a, b) => a + b, 0) / values.length;
    return { max, avg, ratio: avg > 0 ? max / avg : undefined };
}
/**
 * Per server set (the coordinator is excluded), the max-to-average ratio of elapsed time and
 * buffer gets across that set's servers. Oracle omits zero-valued stats, so a server without
 * the stat counts as 0 once at least one server in its set reported it; a set where no server
 * reported a metric has no entry for it. Sets are returned in ascending order.
 */
export function pxSkew(servers) {
    if (!servers)
        return [];
    const bySet = new Map();
    for (const server of servers) {
        if (server.isCoordinator || server.set === undefined)
            continue;
        const list = bySet.get(server.set);
        if (list)
            list.push(server);
        else
            bySet.set(server.set, [server]);
    }
    return [...bySet.keys()]
        .sort((a, b) => a - b)
        .map((set) => {
        const members = bySet.get(set);
        const pick = (key) => 
        // A server without the stat did none of that work (Oracle omits zeroes): count it as 0
        // as long as at least one server in the set reported it.
        members.some((m) => m[key] !== undefined) ? members.map((m) => m[key] ?? 0) : [];
        return {
            set,
            serverCount: members.length,
            elapsed: skewOf(pick('elapsedMs')),
            bufferGets: skewOf(pick('bufferGets')),
        };
    });
}
