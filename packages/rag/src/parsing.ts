import { createRequire } from 'node:module';
import { extname } from 'node:path';

export interface TextChunk {
  section: string;
  content: string;
}

/** Section boundaries are preserved. Long sections overlap by one paragraph or 40 words. */
export function chunkDocument(
  content: string,
  title: string,
  maxWords = 180,
  overlapWords = 35,
): TextChunk[] {
  if (maxWords < 20 || overlapWords < 0 || overlapWords >= maxWords) throw new Error('Invalid chunk size');
  const chunks: TextChunk[] = [];
  let section = title;
  let words: string[] = [];
  function flush(): void {
    if (words.length) chunks.push({ section, content: words.join(' ') });
    words = [];
  }
  for (const line of content.replace(/\r\n?/g, '\n').split('\n')) {
    const heading = /^#{1,6}\s+(.+?)\s*#*\s*$/.exec(line);
    if (heading) {
      flush();
      section = heading[1];
      continue;
    }
    const tokens = line.trim().split(/\s+/).filter(Boolean);
    for (const token of tokens) {
      words.push(token);
      if (words.length === maxWords) {
        chunks.push({ section, content: words.join(' ') });
        words = overlapWords ? words.slice(-overlapWords) : [];
      }
    }
  }
  flush();
  return chunks;
}

export async function parseDocument(
  buffer: Buffer,
  filename: string,
  mimeType?: string,
): Promise<{ content: string; type: string; title: string }> {
  const extension = extname(filename).toLowerCase();
  if (!['.pdf', '.md', '.markdown', '.txt'].includes(extension))
    throw new Error('Only PDF, Markdown and plain text documents are supported');
  let content: string;
  let type: string;
  if (extension === '.pdf') {
    if (buffer.subarray(0, 5).toString() !== '%PDF-') throw new Error('Invalid PDF file signature');
    // The package entry point runs a debug fixture for some ESM import paths; use its parser directly.
    const parsePdf = createRequire(import.meta.url)('pdf-parse/lib/pdf-parse.js') as (
      data: Buffer,
      options: { max: number },
    ) => Promise<{ text: string; numpages: number }>;
    const parsed = await parsePdf(buffer, { max: 100 });
    if (parsed.numpages > 100) throw new Error('PDF exceeds the 100-page limit');
    content = parsed.text;
    type = 'pdf';
  } else {
    if (mimeType && !['text/plain', 'text/markdown', 'application/octet-stream'].includes(mimeType))
      throw new Error('Text document MIME type is unsupported');
    content = new TextDecoder('utf-8', { fatal: true }).decode(buffer);
    type = extension === '.txt' ? 'text' : 'markdown';
  }
  content = content.replace(/\u0000/g, '').trim();
  if (!content || content.length < 20)
    throw new Error('Document has too little extractable text; scanned PDFs require OCR before upload');
  if (content.length > 300_000) throw new Error('Extracted document exceeds 300,000 characters');
  return {
    content,
    type,
    title: /^#\s+(.+)$/m.exec(content)?.[1]?.trim() ?? filename.replace(/\.[^.]+$/, ''),
  };
}
