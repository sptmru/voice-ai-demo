import { createHash } from 'node:crypto';
import { basename } from 'node:path';
import type { Express } from 'express';
import multer from 'multer';
import { rateLimit } from 'express-rate-limit';
import { z } from 'zod';
import { parseDocument } from '../../../packages/rag/src/index.js';
import type { RetrievalService } from '../../../packages/core/src/domain.js';

import { knowledgeMetadataSchema } from '../../../packages/rag/src/evidence.js';

export function attachKnowledgeUpload(app: Express, rag: RetrievalService) {
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 5 * 1024 * 1024, files: 1, fields: 3 },
  });
  let indexing = false;
  app.post(
    '/api/knowledge/upload',
    rateLimit({ windowMs: 60000, limit: 10, standardHeaders: 'draft-8', legacyHeaders: false }),
    upload.single('file'),
    async (req, res) => {
      if (!req.file) {
        res.status(400).json({ error: 'Choose a PDF, Markdown or text file.' });
        return;
      }
      if (indexing) {
        res.status(429).json({ error: 'Another document is being indexed. Please retry shortly.' });
        return;
      }
      const title = z
        .string()
        .trim()
        .min(1)
        .max(160)
        .optional()
        .parse(req.body.title || undefined);
      let metadataInput: unknown = {};
      if (req.body.metadata) {
        try {
          metadataInput = JSON.parse(req.body.metadata);
        } catch {
          res.status(400).json({ error: 'Metadata must be valid JSON.' });
          return;
        }
      } else if (req.body.domain) metadataInput = { domain: req.body.domain };
      const metadata = knowledgeMetadataSchema.parse(metadataInput);
      const filename = basename(req.file.originalname)
        .replace(/[^\w.\- ]/g, '_')
        .slice(0, 180);
      if (!/\.(pdf|md|markdown|txt)$/i.test(filename)) {
        res.status(415).json({ error: 'Supported formats: PDF, Markdown and plain text.' });
        return;
      }
      indexing = true;
      const started = Date.now();
      try {
        let parsed: Awaited<ReturnType<typeof parseDocument>>;
        try {
          parsed = await parseDocument(req.file.buffer, filename, req.file.mimetype);
        } catch (error) {
          res
            .status(422)
            .json({ error: error instanceof Error ? error.message : 'Document could not be parsed.' });
          return;
        }
        const digest = createHash('sha256').update(req.file.buffer).digest('hex').slice(0, 16);
        const document = await rag.ingest({
          ...parsed,
          title: title || parsed.title,
          source: `uploads/${digest}/${filename}`,
          metadata,
        });
        res.status(201).json({ document, durationMs: Date.now() - started, status: 'indexed' });
      } finally {
        indexing = false;
      }
    },
  );
}
