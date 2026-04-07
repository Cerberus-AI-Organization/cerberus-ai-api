import http from 'http';
import https from 'https';
import { Server as SocketIOServer, Socket } from 'socket.io';
import jwt from 'jsonwebtoken';
import * as JobManager from './JobManager';

const JWT_SECRET = process.env.JWT_SECRET!;

export function initWebSocket(server: http.Server | https.Server): SocketIOServer {
  const io = new SocketIOServer(server, {
    cors: {
      origin: (origin, callback) => {
        const allowedOrigin = process.env.CORS_URL;
        if (!origin || origin === allowedOrigin) {
          callback(null, true);
        } else {
          callback(new Error('CORS blocked'));
        }
      },
      credentials: true,
    },
  });

  io.use((socket, next) => {
    const token = socket.handshake.auth?.token as string | undefined;
    if (!token) {
      return next(new Error('No token provided'));
    }
    jwt.verify(token, JWT_SECRET, (err, user) => {
      if (err) return next(new Error('Invalid token'));
      (socket as any).user = user;
      next();
    });
  });

  io.on('connection', (socket: Socket) => {
    const user = (socket as any).user as { id: number };
    console.log(`User ${user.id} connected`);

    socket.on('subscribe', async ({ jobId }: { jobId: string }) => {
      const job = JobManager.getJob(jobId);
      console.log(`User ${user.id} subscribed to job ${jobId}`);

      if (!job) {
        socket.emit('job_error', { jobId, error: 'Job not found' });
        return;
      }

      if (job.userId !== user.id) {
        socket.emit('job_error', { jobId, error: 'Unauthorized' });
        return;
      }

      await socket.join(`job:${jobId}`);

      // Replay all accumulated chunks
      for (const chunk of job.chunks) {
        socket.emit('chunk', chunk);
      }

      const lastSeq = job.chunks.length > 0 ? job.chunks[job.chunks.length - 1].seq : -1;
      socket.emit('sync_complete', { lastSeq });

      if (job.status === 'completed') {
        socket.emit('job_complete', { jobId });
      } else if (job.status === 'failed') {
        socket.emit('job_error', { jobId, error: job.error ?? 'Unknown error' });
      }
    });

    socket.on('unsubscribe', async ({ jobId }: { jobId: string }) => {
      await socket.leave(`job:${jobId}`);
    });
  });

  return io;
}
