import express, {Request, Response} from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import http from 'http';
import https from 'https';
import fs from 'fs';
import {initDatabase} from './core/init/initDatabase';
import authRoutes from './routes/authRoutes';
import userRoutes from './routes/usersRoutes';
import computeNodeRoutes from './routes/computeNodesRoutes';
import ollamaRoutes from './routes/ollamaRoutes';
import chatRoutes from './routes/chatRoutes';
import {refreshNodeStatuses} from "./controllers/computeNodeController";
import {initKnowledge, syncKnowledge} from "./core/init/initKnowledge";
import knowledgeRoutes from "./routes/knowledgeRoutes";
import {Knowledge, KNOWLEDGE_UPDATE_INTERVAL} from "./core/rag/knowledge";
import {initNodes} from "./core/init/initNodes";

dotenv.config();
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
  credentials: true
}));
app.use(express.json());

if (!process.env.JWT_SECRET) {
  throw new Error("⛔ JWT_SECRET is not set in .env");
}

async function main(app: express.Application) {
  // Initialize database
  await initDatabase();
  console.log('✅  DB initialized');

  // Refresh compute-nodes statuses every 15 seconds
  await refreshNodeStatuses()
  await initNodes()
  setInterval(refreshNodeStatuses, 15 * 1000);

  // Initialize knowledge
  if (KNOWLEDGE_UPDATE_INTERVAL > 0) {
    initKnowledge().then(() => {
      console.log('✅  Knowledge initialized');
    }).catch(err => {
      console.error('❌  Knowledge failed to initialize:', err);
    });
    setInterval(syncKnowledge, KNOWLEDGE_UPDATE_INTERVAL);
  } else {
    console.log("⚠️ Knowledge update disabled")
  }

  createServer(app);
}

function createServer(app: express.Application) {
  // Routes
  app.get('/', (req: Request, res: Response) => {
    res.json({message: 'Cerberus AI API is running'});
  });

  app.use('/auth', authRoutes);
  app.use('/users', userRoutes);
  app.use('/compute-nodes', computeNodeRoutes);
  app.use('/compute-nodes', ollamaRoutes);
  app.use('/chats', chatRoutes);
  app.use('/knowledge', knowledgeRoutes);

  const PORT = process.env.PORT || 8080;

  // SSL certificate and server setup
  const sslKey = process.env.SSL_KEY_PATH;
  const sslCert = process.env.SSL_CERT_PATH;

  if (sslKey && sslCert && fs.existsSync(sslKey) && fs.existsSync(sslCert)) {
    // Start HTTPS server
    const httpsOptions = {
      key: fs.readFileSync(sslKey),
      cert: fs.readFileSync(sslCert)
    };
    https.createServer(httpsOptions, app).listen(PORT, () => {
      console.log(`🔒 HTTPS Server running on https://localhost:${PORT}`);
    });
  } else {
    // Start HTTP server
    http.createServer(app).listen(PORT, () => {
      console.log(`🔓 HTTP Server running on http://localhost:${PORT}`);
    });
  }
}

main(app).then(() => {
  console.log("API Start Finished")
});