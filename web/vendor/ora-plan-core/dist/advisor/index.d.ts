export type { FindingSeverity, Finding, RuleContext, AdvisorRule, AdvisorReport, FindObjectFn } from './types.js';
export { DEFAULT_THRESHOLDS, type AdvisorThresholds } from './config.js';
export { runAdvisor } from './engine.js';
export { findImplicitConversions, type ConversionHit } from './predicates.js';
export { ALL_RULES } from './rules/index.js';
