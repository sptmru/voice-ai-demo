import { createRequire } from 'node:module';
import { extname } from 'node:path';

export interface TextChunk {
  section: string;
  content: string;
  headingPath: string[];
  page?: number;
}

/** Preserve section ancestry, PDF pages and table header context in each bounded chunk. */
export function chunkDocument(
  content: string,
  title: string,
  maxWords = 180,
  overlapWords = 35,
): TextChunk[] {
  if (maxWords < 20 || overlapWords < 0 || overlapWords >= maxWords) throw new Error('Invalid chunk size');
  const chunks: TextChunk[] = [];
  let headings: string[] = [title];
  let page: number | undefined;
  let words: string[] = [];
  let tableHeader = '';
  const push = () => {
    if (words.length)
      chunks.push({
        section: headings.at(-1) ?? title,
        content: words.join(' '),
        headingPath: [...headings],
        ...(page ? { page } : {}),
      });
  };
  const flush = () => {
    push();
    words = [];
  };
  for (const line of content.replace(/\r\n?/g, '\n').split('\n')) {
    const marker = /^<!-- page:(\d+) -->$/.exec(line.trim());
    if (marker) {
      flush();
      page = Number(marker[1]);
      tableHeader = '';
      continue;
    }
    const heading = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
    if (heading) {
      flush();
      headings = headings.slice(0, heading[1].length - 1);
      headings.push(heading[2]);
      tableHeader = '';
      continue;
    }
    const isTable = /^\s*\|.+\|\s*$/.test(line);
    if (isTable && !tableHeader) tableHeader = line.trim();
    if (!isTable && line.trim()) tableHeader = '';
    const tokens = line.trim().split(/\s+/).filter(Boolean);
    for (const token of tokens) {
      words.push(token);
      if (words.length >= maxWords) {
        push();
        const header = tableHeader
          .split(/\s+/)
          .filter(Boolean)
          .slice(0, Math.floor(maxWords / 3));
        words = isTable ? [...header] : overlapWords ? words.slice(-overlapWords) : [];
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
    type PdfPage = {
      pageIndex?: number;
      pageNumber?: number;
      getTextContent(
        options: Record<string, boolean>,
      ): Promise<{ items: { str: string; transform: number[] }[] }>;
    };
    const parsePdf = createRequire(import.meta.url)('pdf-parse/lib/pdf-parse.js') as (
      data: Buffer,
      options: { max: number; pagerender(page: PdfPage): Promise<string> },
    ) => Promise<{ text: string; numpages: number }>;
    let pageCounter = 0;
    const parsed = await parsePdf(buffer, {
      max: 100,
      pagerender: async (page) => {
        const number = page.pageNumber ?? (page.pageIndex !== undefined ? page.pageIndex + 1 : ++pageCounter);
        const data = await page.getTextContent({
          normalizeWhitespace: false,
          disableCombineTextItems: false,
        });
        let previousY: number | undefined;
        let text = '';
        for (const item of data.items) {
          text +=
            previousY !== undefined && previousY !== item.transform[5] ? `\n${item.str}` : ` ${item.str}`;
          previousY = item.transform[5];
        }
        return `\n<!-- page:${number} -->\n${text}`;
      },
    });
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
  if (content.replace(/<!-- page:\d+ -->/g, '').trim().length < 20)
    throw new Error('Document has too little extractable text; scanned PDFs require OCR before upload');
  if (content.length > 300_000) throw new Error('Extracted document exceeds 300,000 characters');
  return {
    content,
    type,
    title: /^#\s+(.+)$/m.exec(content)?.[1]?.trim() ?? filename.replace(/\.[^.]+$/, ''),
  };
}
