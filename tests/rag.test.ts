import { describe, expect, it } from 'vitest';
import { chunkDocument, parseDocument } from '../packages/rag/src/parsing.js';

describe('knowledge parsing', () => {
  it('preserves headings and overlap without combining unrelated sections', () => {
    const chunks = chunkDocument(
      `# First\n${Array.from({ length: 50 }, (_, index) => `word${index}`).join(' ')}\n## Second\nAn independent short section.`,
      'Title',
      20,
      5,
    );
    expect(chunks[0].section).toBe('First');
    expect(chunks[1].content.split(' ').slice(0, 5)).toEqual(chunks[0].content.split(' ').slice(-5));
    expect(chunks.at(-1)).toEqual({ section: 'Second', content: 'An independent short section.' });
    expect(chunks.every((chunk) => chunk.content.split(' ').length <= 20)).toBe(true);
  });

  it('parses uploaded Markdown and rejects binary disguised as text', async () => {
    await expect(
      parseDocument(
        Buffer.from('# My guide\nA sufficiently detailed support instruction.'),
        'guide.md',
        'text/markdown',
      ),
    ).resolves.toMatchObject({ title: 'My guide', type: 'markdown' });
    await expect(parseDocument(Buffer.from([255, 254, 253]), 'guide.txt')).rejects.toThrow();
    await expect(parseDocument(Buffer.from('Not actually a pdf'), 'guide.pdf')).rejects.toThrow('signature');
    await expect(parseDocument(Buffer.from('plain text'), 'guide.exe')).rejects.toThrow('Only PDF');
  });

  it('rejects empty/scanned content and oversized extracted documents', async () => {
    await expect(parseDocument(Buffer.from(' '), 'empty.txt')).rejects.toThrow('too little');
    await expect(parseDocument(Buffer.from('x'.repeat(300_001)), 'huge.txt')).rejects.toThrow('300,000');
  });
});
