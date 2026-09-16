import { describe, expect, it } from 'vitest';
import type { RetrievedChunk } from '../packages/core/src/domain.js';
import {
  assessEvidence,
  isEffective,
  hasRequestedMeasurement,
  canonicalKnowledgeModel,
  normalizeMetadata,
  resolveRetrievalQuery,
  resolveRerankingQuery,
} from '../packages/rag/src/evidence.js';
import { chunkDocument } from '../packages/rag/src/parsing.js';
const chunk = (patch: Partial<RetrievedChunk> = {}): RetrievedChunk => ({
  chunkId: 'one',
  documentId: 'one',
  document: 'Warranty',
  section: 'Repair warranty',
  content: '90 days',
  source: 'docs/warranty',
  type: 'markdown',
  semanticScore: 0.88,
  lexicalScore: 0.1,
  combinedScore: 0.03,
  rerankScore: 0.9,
  metadata: { domain: 'repair', version: '2026.09', policyKey: 'warranty', status: 'active' },
  ...patch,
});
describe('evidence decisions', () => {
  it('rejects nearest neighbours that do not provide sufficiently relevant evidence', () => {
    expect(
      assessEvidence('unrelated', 'unrelated', [chunk({ semanticScore: 0.68, rerankScore: 0.01 })]),
    ).toMatchObject({ status: 'insufficient', chunks: [] });
    expect(
      assessEvidence('unrelated', 'unrelated', [chunk({ semanticScore: 0.91, rerankScore: 0.02 })]).status,
    ).toBe('insufficient');
  });
  it('returns only admitted sources, preserving a source locator and model score', () => {
    const result = assessEvidence('warranty', 'warranty', [
      chunk({ page: 4, headingPath: ['Policy', 'Warranty'] }),
      chunk({ semanticScore: 0.61 }),
    ]);
    expect(result.status).toBe('supported');
    expect(result.chunks).toHaveLength(1);
    expect(result.chunks[0]).toMatchObject({
      page: 4,
      headingPath: ['Policy', 'Warranty'],
      rerankScore: 0.9,
    });
  });
  it('requires review of overlapping authoritative versions rather than silently choosing one', () => {
    const old = chunk({
      documentId: 'old',
      metadata: { domain: 'repair', version: '2026.08', policyKey: 'warranty', status: 'active' },
    });
    expect(assessEvidence('warranty', 'warranty', [chunk(), old]).status).toBe('conflict');
    expect(assessEvidence('warranty', 'warranty', [chunk(), chunk({ chunkId: 'second' })]).status).toBe(
      'supported',
    );
  });
  it('resolves a follow-up using known context and preserves exact model identifiers', () => {
    const result = resolveRetrievalQuery({
      query: 'А гарантия?',
      context: { model: 'W100', appliance: 'washing-machine', previousQuery: 'Не сливает воду' },
    });
    expect(result.ambiguous).toBe(false);
    expect(result.query).toContain('W100');
    expect(result.query).toContain('А гарантия?');
    expect(resolveRetrievalQuery({ query: 'А эта модель?' }).ambiguous).toBe(true);
    expect(resolveRetrievalQuery({ query: 'Как подготовиться к визиту мастера?' }).ambiguous).toBe(false);
  });
  it('clarifies error codes without a model and inherits the actual code without old symptoms', () => {
    expect(resolveRetrievalQuery({ query: 'Что означает ошибка E21?' }).ambiguous).toBe(true);
    expect(resolveRetrievalQuery({ query: 'What does error E21 mean?' }).ambiguous).toBe(true);
    expect(resolveRetrievalQuery({ query: 'Relay Wash W100 shows error E21' }).ambiguous).toBe(false);
    const result = resolveRetrievalQuery({
      query: 'А что означает этот код?',
      context: { model: 'W100', previousQuery: 'W100 shows E21 and water is stuck' },
    });
    expect(result.query).toContain('E21');
    expect(result.query).not.toContain('water is stuck');
    const warranty = resolveRetrievalQuery({
      query: 'А гарантия?',
      context: { model: 'W100', previousQuery: 'W100 shows E21 and water is stuck' },
    });
    expect(warranty.query).not.toContain('E21');
    expect(canonicalKnowledgeModel('Relay Wash W100')).toBe('W100');
  });
  it('keeps the current policy question dominant over a known model in reranking', () => {
    const request = {
      query: 'А гарантия на этот ремонт?',
      context: {
        appliance: 'washing-machine',
        model: 'W100',
        previousQuery: 'Relay Wash W100 не сливает воду',
      },
    };
    expect(resolveRetrievalQuery(request).query).toContain('W100');
    expect(resolveRerankingQuery(request)).toBe(request.query);
    expect(
      resolveRerankingQuery({
        query: 'What should I prepare for the visit?',
        context: { ...request.context, previousQuery: 'I want a home visit' },
      }),
    ).toContain('home visit');
    expect(
      resolveRerankingQuery({
        query: 'А что означает этот код?',
        context: { ...request.context, previousQuery: 'W100 E21' },
      }),
    ).toContain('E21');
  });
  it('does not admit a technical specification based only on a matching model', () => {
    expect(
      hasRequestedMeasurement('What is the drum capacity in litres of W100?', 'W100 has error E21.'),
    ).toBe(false);
    expect(
      hasRequestedMeasurement(
        'What is the drum capacity in litres of W100?',
        'The drum has capacity 40 litres.',
      ),
    ).toBe(true);
    expect(
      hasRequestedMeasurement(
        'Какова мощность компрессора в ваттах?',
        'Мощность компрессора составляет 200 ватт.',
      ),
    ).toBe(true);
    expect(
      assessEvidence('What is its weight?', 'What is its weight?', [
        chunk({ content: 'The appliance W100 has a drain problem.' }),
      ]).status,
    ).toBe('insufficient');
  });
  it('validates metadata dates and excludes archived, future and expired documents', () => {
    expect(() => normalizeMetadata({ effectiveFrom: '2026-02-30' })).toThrow();
    expect(() => normalizeMetadata({ effectiveFrom: '2026-10-01', effectiveTo: '2026-09-01' })).toThrow();
    for (const metadata of [
      { status: 'archived' as const },
      { effectiveFrom: '2027-01-01' },
      { effectiveTo: '2026-09-15' },
    ])
      expect(isEffective(normalizeMetadata(metadata), '2026-09-16')).toBe(false);
    expect(isEffective(normalizeMetadata({ effectiveFrom: '2026-09-16' }), '2026-09-16')).toBe(true);
  });
});
describe('structured evidence excerpts', () => {
  it('keeps PDF page boundaries and heading ancestry', () => {
    const chunks = chunkDocument(
      '# Appliance\n## Safety\n<!-- page:2 -->\nDisconnect the appliance before service.\n<!-- page:3 -->\nCall a specialist for any damaged cable.',
      'Guide',
    );
    expect(chunks).toHaveLength(2);
    expect(chunks.map((item) => item.page)).toEqual([2, 3]);
    expect(chunks.every((item) => item.headingPath.join(' > ') === 'Appliance > Safety')).toBe(true);
    expect(chunks.some((item) => item.content.includes('<!--'))).toBe(false);
  });
  it('repeats table headers in split table excerpts so values retain their meaning', () => {
    const content =
      '# Services\n| Service | Duration |\n| --- | --- |\n' +
      Array.from({ length: 15 }, (_, i) => `| Consultation${i} | 30 minutes |`).join('\n');
    const chunks = chunkDocument(content, 'Services', 20, 3);
    expect(chunks.length).toBeGreaterThan(2);
    expect(chunks.every((item) => item.content.includes('Service | Duration'))).toBe(true);
    expect(chunks.every((item) => item.content.split(' ').length <= 20)).toBe(true);
  });
});
