import { findImplicitConversions } from "../predicates.js";
export const implicitConversionRule = {
    id: 'implicit-conversion',
    evaluate(ctx) {
        const findings = [];
        for (const node of ctx.plan.allNodes) {
            const hits = findImplicitConversions(node.accessPredicates, node.filterPredicates);
            if (hits.length === 0)
                continue;
            const fragments = hits.map((h) => `${h.fn}(${h.column}) in ${h.source}`).join('; ');
            findings.push({
                ruleId: 'implicit-conversion',
                severity: 'warning',
                nodeIds: [node.id],
                title: `Implicit type conversion on ${node.operation}`,
                explanation: `Predicate contains an implicit or wrapping conversion: ${fragments}. This can prevent the optimizer from using an index range scan on the affected column(s) and forces a full scan of the conversion result.`,
                suggestion: 'Rewrite the predicate so the column is unwrapped (avoid comparing a column against a mismatched-type literal or bind), or verify the index still applies with the conversion in place.',
            });
            if (findings.length >= ctx.thresholds.maxFindingsPerRule)
                break;
        }
        return findings;
    },
};
