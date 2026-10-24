function note(ruleId, title, explanation, suggestion) {
    // Plan-level: the Note section describes the statement, not a single operation.
    return { ruleId, severity: 'info', nodeIds: [], title, explanation, suggestion };
}
/** Plan-level findings derived from the DBMS_XPLAN "Note" section. */
export const planNotesRule = {
    id: 'plan-notes',
    evaluate(ctx) {
        const notes = ctx.plan.notes;
        if (!notes)
            return [];
        const findings = [];
        const raw = notes.rawLines.join('\n');
        if (notes.dynamicSampling) {
            const level = notes.dynamicSamplingLevel !== undefined ? ` (level ${notes.dynamicSamplingLevel})` : '';
            findings.push(note('note-dynamic-sampling', 'Dynamic sampling used', `The optimizer sampled the data at parse time${level} instead of relying on stored statistics. That normally means an object has missing or stale statistics (typical for global temporary tables and freshly loaded tables), or the predicates were too complex for the statistics to estimate. The estimates, and so the plan, depend on a small random sample and can differ between parses.`, 'Gather statistics on the objects involved (or set representative statistics on temporary tables) so the plan no longer depends on a parse-time sample.'));
        }
        if (notes.planDirectives) {
            findings.push(note('note-sql-plan-directive', 'SQL plan directive used', 'One or more SQL plan directives influenced this plan. The optimizer creates directives when an earlier execution showed a cardinality misestimate, and uses them to sample more data (dynamic sampling) or build extended statistics. A directive means this statement, or one with the same predicates, was misestimated in the past.', 'Look at DBA_SQL_PLAN_DIRECTIVES for the directive and its object/columns, and create the extended statistics (column group or expression) it points to so the misestimate is fixed permanently.'));
        }
        if (notes.adaptivePlan) {
            findings.push(note('note-adaptive-plan', 'Adaptive plan', 'This is an adaptive plan: the optimizer prepared alternatives (typically nested loops versus hash join) and picked one at execution time from the row counts it actually saw. Operations marked inactive were not used. The final plan can differ from the initial one, and the choice itself shows that the optimizer did not trust its cardinality estimate.', 'Show the full plan with the +ADAPTIVE format to see the alternatives, and if the join method flips between runs, fix the underlying estimate (statistics, histograms, extended statistics).'));
        }
        if (notes.sqlProfile) {
            findings.push(note('note-sql-profile', `SQL profile in use: ${notes.sqlProfile}`, `SQL profile "${notes.sqlProfile}" was applied to this statement. A profile stores corrections to the optimizer's estimates, so this plan is steered by them rather than by the current statistics alone, and the profile can become stale as data changes.`, 'Check when the profile was created (DBA_SQL_PROFILES) and whether it still matches the data; drop and regenerate it if the table contents have changed materially.'));
        }
        if (notes.sqlPlanBaseline) {
            findings.push(note('note-sql-baseline', `SQL plan baseline in use: ${notes.sqlPlanBaseline}`, `SQL plan baseline "${notes.sqlPlanBaseline}" was used for this statement. Only accepted plans in the baseline can be chosen, so the plan is pinned: a better plan the optimizer finds will not be used until it is evolved and accepted.`, 'If the pinned plan is not the one you want, look at the baseline with DBA_SQL_PLAN_BASELINES and evolve or drop it; if it is the intended plan, no action is needed.'));
        }
        const patch = raw.match(/SQL patch "([^"]+)"/i);
        if (patch) {
            findings.push(note('note-sql-patch', `SQL patch in use: ${patch[1]}`, `SQL patch "${patch[1]}" was applied to this statement. A patch injects hints (or other directives) without changing the SQL text, so the plan reflects those hints rather than purely the optimizer's own choice.`, 'Check the hints in DBA_SQL_PATCHES and drop the patch once the underlying problem is fixed, since hints can become wrong as data and the schema change.'));
        }
        if (notes.outline) {
            findings.push(note('note-stored-outline', `Stored outline in use: ${notes.outline}`, `Stored outline "${notes.outline}" was used for this statement. Outlines freeze the plan with hints and are deprecated in favour of SQL plan baselines.`, 'Migrate to a SQL plan baseline if the plan should stay pinned, otherwise drop the outline.'));
        }
        if (notes.cardinalityFeedback || notes.statisticsFeedback) {
            findings.push(note('note-cardinality-feedback', 'Cardinality feedback used', 'This plan was re-optimised using statistics collected during an earlier execution (cardinality / statistics feedback), which means the first plan was built on a bad estimate. The corrected plan is only used while the cursor stays in the shared pool.', 'Find the original misestimate (a wrong E-Rows low in the plan) and fix it with statistics, histograms or extended statistics so the first plan is already right.'));
        }
        return findings;
    },
};
