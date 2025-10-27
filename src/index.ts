import express, { Request, Response } from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import http from 'http';
import https from 'https';
import fs from 'fs';
import { databaseInit } from './core/databaseInit';
import authRoutes from './routes/auth';
import userRoutes from './routes/users';
import computeNodeRoutes from './routes/computeNodes';
import ollamaRoutes from './routes/ollama';
import chatRoutes from './routes/chat';
import {refreshNodeStatuses} from "./controllers/computeNodeController";

dotenv.config();
const app = express();

app.use(cors({origin: process.env.CORS_URL, credentials: true}));
app.use(express.json());

if (!process.env.JWT_SECRET) {
  throw new Error("⛔ JWT_SECRET is not set in .env");
}

databaseInit().then(() => {
    console.log('✅  DB initialized');

    // Routes
    app.get('/', (req: Request, res: Response) => {
        res.json({ message: 'Cerberus AI API is running' });
    });

    app.use('/auth', authRoutes);
    app.use('/users', userRoutes);
    app.use('/compute-nodes', computeNodeRoutes);
    app.use('/compute-nodes', ollamaRoutes);
    app.use('/chats', chatRoutes);

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

    // Refresh compute-nodes statuses every 60 seconds
    refreshNodeStatuses().then(r => {
        setInterval(refreshNodeStatuses, 60 * 1000);
    })
});