import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Pool } from 'pg';
import { reconstructLegacyContent, reindexKnowledge } from '../scripts/reindex-knowledge.js';

const { ingest } = vi.hoisted(() => ({ ingest: vi.fn() }));
vi.mock('../packages/rag/src/index.js', () => ({
  EMBEDDING_SIGNATURE: 'current-model',
  RagService: class {
    ingest = ingest;
  },
}));

afterEach(() => vi.restoreAllMocks());

describe('legacy document reconstruction', () => {
  it('retains ordered text and overlap instead of silently discarding repeated passages', () => {
    const result = reconstructLegacyContent('Repair guide', [
      { section: 'Warranty', content: 'Repair warranty lasts 90 days. Repeated boundary.' },
      { section: 'Warranty', content: 'Repeated boundary. Keep the receipt.' },
      { section: 'Limits', content: 'Water damage requires inspection.\nPreserve this line.' },
    ]);
    expect(result).toBe(
      '# Repair guide\n\n## Warranty\n\nRepair warranty lasts 90 days. Repeated boundary.\n\nRepeated boundary. Keep the receipt.\n\n## Limits\n\nWater damage requires inspection.\nPreserve this line.',
    );
    expect(result).not.toContain('page:');
  });

  it('rejects missing stored content and does not invent page locations', () => {
    expect(() => reconstructLegacyContent('Empty', [])).toThrow('upload the original');
    expect(() => reconstructLegacyContent('Empty', [{ section: 'Page 3', content: ' ' }])).toThrow();
    expect(
      reconstructLegacyContent('Legacy\nPDF', [{ section: 'Safety\nnotice', content: 'Call a specialist.' }]),
    ).toBe('# Legacy PDF\n\n## Safety notice\n\nCall a specialist.');
  });
});

describe('reindex operational behavior', () => {
  const document = {
    id: 'doc-1',
    title: 'Guide',
    source: 'uploads/guide.pdf',
    type: 'pdf',
    embedding_model: 'old-model',
    original_content: '<!-- page:2 -->\nExact parsed input',
    metadata: { domain: 'repair', status: 'active', version: '2', policyKey: 'warranty' },
  };
  it('preserves original page markers and metadata and skips already-current documents', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    ingest.mockReset().mockResolvedValue({ chunkCount: 1 });
    const query = vi.fn().mockResolvedValue({
      rows: [document, { ...document, id: 'doc-2', embedding_model: 'current-model' }],
    });
    const result = await reindexKnowledge({ query } as unknown as Pool);
    expect(result).toEqual({ indexed: 1, skipped: 1, reconstructed: 0, dryRun: false });
    expect(query).toHaveBeenCalledTimes(1);
    expect(ingest).toHaveBeenCalledExactlyOnceWith({
      title: document.title,
      source: document.source,
      type: document.type,
      metadata: document.metadata,
      content: document.original_content,
      force: undefined,
    });
  });
  it('dry-run --force visits current documents without writing or embedding', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    ingest.mockReset();
    const query = vi.fn().mockResolvedValue({ rows: [{ ...document, embedding_model: 'current-model' }] });
    const result = await reindexKnowledge({ query } as unknown as Pool, { dryRun: true, force: true });
    expect(result).toEqual({ indexed: 1, skipped: 0, reconstructed: 0, dryRun: true });
    expect(ingest).not.toHaveBeenCalled();
  });
  it('stops on failed inference and reports earlier commits without processing later documents', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    ingest
      .mockReset()
      .mockResolvedValueOnce({ chunkCount: 1 })
      .mockRejectedValueOnce(new Error('model unavailable'));
    const query = vi.fn().mockResolvedValue({
      rows: [document, { ...document, source: 'second' }, { ...document, source: 'third' }],
    });
    await expect(reindexKnowledge({ query } as unknown as Pool)).rejects.toThrow(
      'stopped at second after 1 indexed documents',
    );
    expect(ingest).toHaveBeenCalledTimes(2);
    expect(log.mock.calls.flat().join(' ')).not.toContain('Reindex complete');
  });
});
