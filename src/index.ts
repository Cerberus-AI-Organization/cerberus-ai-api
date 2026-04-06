import express, { Request, Response } from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import http from 'http';
import https from 'https';
import fs from 'fs';
import { initDatabase } from './core/init/initDatabase';
import { initNodes } from './core/init/initNodes';
import { syncKnowledge } from './core/init/initKnowledge';
import { refreshNodeStatuses } from './controllers/computeNodeController';
import { Knowledge, KNOWLEDGE_SYNC_HOURS } from './core/rag/knowledge';
import authRoutes from './routes/authRoutes';
import userRoutes from './routes/usersRoutes';
import computeNodeRoutes from './routes/computeNodesRoutes';
import ollamaRoutes from './routes/ollamaRoutes';
import chatRoutes from './routes/chatRoutes';
import knowledgeRoutes from './routes/knowledgeRoutes';

dotenv.config();

if (!process.env.JWT_SECRET) {
  throw new Error('⛔ JWT_SECRET is not set in .env');
}

const app = express();

app.use(cors({
  origin: (origin, callback) => {
    const allowedOrigin = process.env.CORS_URL;
    if (!origin || origin === allowedOrigin) {
      callback(null, true);
    } else {
      console.log(`❌ CORS Blocked for: ${origin}`);
      callback(new Error('CORS blocked'));
    }
  },
  credentials: true,
}));
app.use(express.json());

function runKnowledgeSync() {
  syncKnowledge()
    .then(() => console.info('✅  Knowledge sync completed'))
    .catch(err => console.error('❌  Knowledge sync failed:', err));
}

async function scheduleKnowledgeSync() {
  await Knowledge.instance.init();
  console.log('✅  Knowledge initialized');

  if (KNOWLEDGE_SYNC_HOURS.length === 0) {
    console.log('⚠️ Knowledge sync disabled');
    return;
  }

  console.log(`📅 Knowledge sync scheduled at hours: ${KNOWLEDGE_SYNC_HOURS.join(', ')}`);

  const isEmpty = await Knowledge.instance.isEmpty();
  if (isEmpty) {
    console.info('📭 No knowledge found, running initial sync...');
    runKnowledgeSync();
  } else {
    console.info('📚 Knowledge already exists, skipping initial sync');
  }

  let lastTriggeredKey = '';
  setInterval(() => {
    const now = new Date();
    const hour = now.getHours();
    const key = `${now.toDateString()}-${hour}`;

    if (now.getMinutes() === 0 && KNOWLEDGE_SYNC_HOURS.includes(hour) && lastTriggeredKey !== key) {
      lastTriggeredKey = key;
      console.info(`🔄 Knowledge sync triggered at ${hour}:00`);
      runKnowledgeSync();
    }
  }, 60 * 1000);
}

function registerRoutes(app: express.Application) {
  app.get('/', (_req: Request, res: Response) => {
    res.json({ message: 'Cerberus AI API is running' });
  });

  app.use('/auth', authRoutes);
  app.use('/users', userRoutes);
  app.use('/compute-nodes', computeNodeRoutes);
  app.use('/compute-nodes', ollamaRoutes);
  app.use('/chats', chatRoutes);
  app.use('/knowledge', knowledgeRoutes);
}

function startServer(app: express.Application) {
  const PORT = process.env.PORT || 8080;
  const sslKey = process.env.SSL_KEY_PATH;
  const sslCert = process.env.SSL_CERT_PATH;

  if (sslKey && sslCert && fs.existsSync(sslKey) && fs.existsSync(sslCert)) {
    const httpsOptions = { key: fs.readFileSync(sslKey), cert: fs.readFileSync(sslCert) };
    https.createServer(httpsOptions, app).listen(PORT, () => {
      console.log(`🔒 HTTPS Server running on https://localhost:${PORT}`);
    });
  } else {
    http.createServer(app).listen(PORT, () => {
      console.log(`🔓 HTTP Server running on http://localhost:${PORT}`);
    });
  }
}

async function main() {
  await initDatabase();
  console.log('✅  DB initialized');

  await refreshNodeStatuses();
  await initNodes();
  setInterval(refreshNodeStatuses, 15 * 1000);

  await scheduleKnowledgeSync();

  registerRoutes(app);
  startServer(app);
}

main().then(() => console.log('API Start Finished'));