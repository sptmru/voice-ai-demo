import { createServer } from 'node:http';
import { pool, PostgresRepository } from '../../../packages/db/src/index.js';
import { RagService } from '../../../packages/rag/src/index.js';
import { createApp, logger } from './app.js';
import { attachVoiceBridge } from './voice.js';
import { attachKnowledgeUpload } from './knowledge.js';

const repo = new PostgresRepository(pool);
const rag = new RagService(pool);
const services = createApp(repo, rag, pool);
const { app, errorHandler } = services;
const server = createServer(app);
const voice = attachVoiceBridge({ server, pool, repo, ...services });
services.setConfirmationNotifier(voice.notifyConfirmation);
services.setVoiceStopper(voice.closeSession);
services.setVoicePhotoSender(voice.sendPhoto);
attachKnowledgeUpload(app, rag);
app.use(errorHandler);
const port = Number(process.env.PORT || 3101);
server.listen(port, process.env.HOST || '127.0.0.1', () => logger.info({ port }, 'Relay API ready'));
for (const signal of ['SIGTERM', 'SIGINT'])
  process.on(signal, () => {
    void voice.close();
    server.close(() => void pool.end().then(() => process.exit(0)));
    setTimeout(() => process.exit(0), 5000).unref();
  });
