import type { ParsedPlan } from '../types.js';
import type { MetadataBundle, MetadataObject } from '../metadata/bundle.js';
import type { AdvisorThresholds } from './config.js';
export type FindingSeverity = 'info' | 'warning' | 'critical';
export interface Finding {
    ruleId: string;
    severity: FindingSeverity;
    nodeIds: number[];
    title: string;
    explanation: string;
    suggestion: string;
}
export type FindObjectFn = (objectName: string | undefined) => {
    key: string;
    object: MetadataObject;
} | null;
export interface RuleContext {
    plan: ParsedPlan;
    bundle: MetadataBundle | null;
    thresholds: AdvisorThresholds;
    findObject: FindObjectFn;
    usedIndexKeys: Set<string>;
}
export interface AdvisorRule {
    id: string;
    requiresMetadata?: boolean;
    requiresActualStats?: boolean;
    evaluate(ctx: RuleContext): Finding[];
}
export interface AdvisorReport {
    findings: Finding[];
    findingsByNodeId: Map<number, Finding[]>;
    counts: Record<FindingSeverity, number>;
    maxSeverityByNodeId: Map<number, FindingSeverity>;
}
