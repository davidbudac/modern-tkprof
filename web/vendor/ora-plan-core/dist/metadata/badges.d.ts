import type { MetadataObject } from './bundle.js';
export type MetadataBadgeKind = 'stale-stats' | 'missing-stats' | 'mismatch-no-histogram';
export interface MetadataBadge {
    kind: MetadataBadgeKind;
    reason: string;
}
export interface EvaluateBadgesInput {
    match: {
        key: string;
        object: MetadataObject;
    } | null;
    enabled?: Partial<Record<MetadataBadgeKind, boolean>>;
    cardinalitySeverity?: 'good' | 'warn' | 'bad';
    predicateColumns?: string[];
}
export declare function evaluateBadges(input: EvaluateBadgesInput): MetadataBadge[];
