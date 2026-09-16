'use client';

import { BookOpen, ChevronDown, FileText } from 'lucide-react';
import type { RetrievedChunk } from '../../../packages/core/src/domain';

export type EvidenceResult = {
  status?: 'supported' | 'clarify' | 'insufficient' | 'conflict';
  query?: string;
  rewrittenQuery?: string;
  chunks: RetrievedChunk[];
  reason?: string;
};

const evidenceLabels: Record<string, string> = {
  supported: 'Supporting sources found',
  clarify: 'More detail needed',
  insufficient: 'Not enough evidence to answer',
  conflict: 'Sources disagree',
};
const evidenceDescriptions: Record<string, string> = {
  supported: 'We found current information for this question. Open a source to check the details.',
  clarify:
    'Tell us the appliance, model, or a little more about your question so we can find the right information.',
  insufficient: 'The knowledge base does not have enough relevant information yet. A specialist can help.',
  conflict: 'We found conflicting terms for this question. A specialist needs to check them.',
};

export function SourceCard({ source, technical = false }: { source: RetrievedChunk; technical?: boolean }) {
  const version = source.metadata?.version;
  const location = [source.headingPath?.join(' / ') || source.section, source.page ? `p. ${source.page}` : '']
    .filter(Boolean)
    .join(' · ');
  return (
    <details className="source-card">
      <summary>
        <span className="source-icon">
          <FileText size={15} />
        </span>
        <span>
          <strong>{source.document}</strong>
          <small>
            {location}
            {version ? ` · version ${version}` : ''}
          </small>
        </span>
        <ChevronDown size={14} />
      </summary>
      <p>{source.content}</p>
      <small className="source-origin">{source.source}</small>
      {source.metadata?.effectiveFrom && (
        <small className="source-origin">Effective from {source.metadata.effectiveFrom}</small>
      )}
      {technical && (
        <div className="source-scores">
          <span>
            Semantic <b>{source.semanticScore.toFixed(3)}</b>
          </span>
          <span>
            Lexical <b>{source.lexicalScore.toFixed(3)}</b>
          </span>
          <span>
            RRF <b>{source.combinedScore.toFixed(4)}</b>
          </span>
          <small>Search ranking scores, not answer confidence.</small>
        </div>
      )}
    </details>
  );
}

export function KnowledgeEvidence({
  result,
  technical = false,
}: {
  result: EvidenceResult;
  technical?: boolean;
}) {
  return (
    <section className={`knowledge-evidence ${result.status || 'retrieved'}`} aria-label="Answer sources">
      <div className="evidence-heading">
        <BookOpen size={18} />
        <h3>{result.status ? evidenceLabels[result.status] : 'Retrieved sources'}</h3>
      </div>
      {result.query && <p className="evidence-query">{result.query}</p>}
      {technical && result.reason ? (
        <p className="evidence-reason">{result.reason}</p>
      ) : result.status ? (
        <p className="evidence-reason">{evidenceDescriptions[result.status]}</p>
      ) : null}
      {result.status && result.status !== 'supported' && (
        <p className="evidence-caution">
          These sources do not support a complete answer. The agent will ask a follow-up or offer help from a
          specialist.
        </p>
      )}
      {result.rewrittenQuery && result.rewrittenQuery !== result.query && (
        <details className="evidence-context">
          <summary>How conversation context was used</summary>
          <p>{result.rewrittenQuery}</p>
        </details>
      )}
      {result.chunks.map((chunk) => (
        <SourceCard key={chunk.chunkId} source={chunk} technical={technical} />
      ))}
    </section>
  );
}
