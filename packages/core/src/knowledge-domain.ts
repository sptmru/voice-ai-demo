import type { RetrievedChunk } from './domain.js';

export interface KnowledgeMetadata {
  domain: 'repair' | 'telecom' | 'general';
  version: string;
  policyKey?: string;
  status: 'active' | 'archived';
  effectiveFrom?: string;
  effectiveTo?: string;
  appliance?: string;
  models?: string[];
}
export interface RetrievalRequest {
  query: string;
  limit?: number;
  domain?: KnowledgeMetadata['domain'];
  context?: { appliance?: string; model?: string; previousQuery?: string };
  asOf?: string;
}
export type RetrievalStatus = 'supported' | 'clarify' | 'insufficient' | 'conflict';
export interface RetrievalResult {
  status: RetrievalStatus;
  query: string;
  rewrittenQuery: string;
  chunks: RetrievedChunk[];
  reason: string;
  timings?: Record<string, number>;
}
