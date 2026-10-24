import type { ParsedPlan } from '../types.js';
import type { MetadataBundle } from '../metadata/bundle.js';
import { type AdvisorThresholds } from './config.js';
import type { AdvisorReport } from './types.js';
export declare function runAdvisor(plan: ParsedPlan, bundle: MetadataBundle | null, thresholds?: AdvisorThresholds): AdvisorReport;
