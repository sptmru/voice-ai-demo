# Reindex existing knowledge

Retrieval only reads vectors with the configured embedding signature. After changing the embedding model, rebuild existing documents, including uploaded PDFs, before expecting those documents in search.

Use the same database and model environment as the API. Pause uploads and document edits while reindexing so a stale copy cannot overwrite a concurrent edit. This command updates knowledge records; it does not change sessions, bookings, or customer data.

```sh
docker compose -f compose.yaml -f compose.app.yaml run --rm api pnpm db:migrate
docker compose -f compose.yaml -f compose.app.yaml run --rm api pnpm rag:reindex --dry-run
docker compose -f compose.yaml -f compose.app.yaml run --rm api pnpm rag:reindex
```

`--dry-run` reads the candidate documents and checks that recoverable text exists. It does not load the model, generate embeddings, write records, or prove that model inference will succeed. It still requires the knowledge migration and database connection.

The command skips documents already using the current embedding signature. To rebuild all documents, for example after changing the chunker, use:

```sh
docker compose -f compose.yaml -f compose.app.yaml run --rm api pnpm rag:reindex --force
```

Each document is embedded before its transaction replaces the old chunks. The source, title, type, metadata, and document ID are preserved. Other documents are not removed. A failed document stops the command with a nonzero exit status; previous successful documents remain committed. Fix the error and rerun to resume, or use `--force` to rebuild those already processed.

New ingestions retain `original_content`, which is the parsed text supplied to the indexer, including available PDF page markers. Original PDF binaries are not stored in this field.

Older records may only contain stored chunks. The script reconstructs a text document in chunk order, restores section headings, and retains overlapping text rather than guessing which words to delete. It prints a warning for each such document. This cannot recover the original page layout, original table formatting, or heading hierarchy. For faithful citations, reupload the original document; make sure its earlier record is replaced or removed to avoid conflicting active versions. If reconstruction exceeds the input limit or no usable text remains, the script stops and requires the original file.

The script does not migrate databases automatically. Running it against a deployment is an explicit operational action; the feature's local test run does not reindex a public demo.
