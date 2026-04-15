import { Server as SocketIOServer } from 'socket.io';

export type JobStatus = 'running' | 'completed' | 'failed';

export interface StreamChunk {
  seq: number;
  data: Record<string, unknown>;
}

export interface Job {
  id: string;
  chatId: number;
  userId: number;
  status: JobStatus;
  chunks: StreamChunk[];
  error: string | null;
  createdAt: number;
  completedAt: number | null;
}

const JOB_TTL_MS = 5 * 60 * 1000; // 5 minutes

const jobs = new Map<string, Job>();
let io: SocketIOServer | null = null;

export function init(ioServer: SocketIOServer): void {
  io = ioServer;
}

export function createJob(chatId: number, userId: number): Job {
  const job: Job = {
    id: crypto.randomUUID(),
    chatId,
    userId,
    status: 'running',
    chunks: [],
    error: null,
    createdAt: Date.now(),
    completedAt: null,
  };
  jobs.set(job.id, job);
  return job;
}

export function getJob(jobId: string): Job | undefined {
  return jobs.get(jobId);
}

export function appendChunk(jobId: string, data: Record<string, unknown>): void {
  const job = jobs.get(jobId);
  if (!job) return;

  const chunk: StreamChunk = { seq: job.chunks.length, data };
  job.chunks.push(chunk);

  io?.to(`job:${jobId}`).emit('chunk', chunk);
}

export function completeJob(jobId: string): void {
  const job = jobs.get(jobId);
  if (!job) return;

  job.status = 'completed';
  job.completedAt = Date.now();

  io?.to(`job:${jobId}`).emit('job_complete', { jobId });
}

export function failJob(jobId: string, error: string): void {
  const job = jobs.get(jobId);
  if (!job) return;

  job.status = 'failed';
  job.error = error;
  job.completedAt = Date.now();

  io?.to(`job:${jobId}`).emit('job_error', { jobId, error });
}

export function cleanupStaleJobs(): void {
  const now = Date.now();
  for (const [id, job] of jobs.entries()) {
    if (job.completedAt !== null && now - job.completedAt > JOB_TTL_MS) {
      jobs.delete(id);
    }
  }
}
