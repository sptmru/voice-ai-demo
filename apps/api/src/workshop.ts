import { canonicalRepairModel } from '../../../packages/core/src/repair-tools.js';
import { randomUUID } from 'node:crypto';
import multer from 'multer';
import type { Express, Request } from 'express';
import { z } from 'zod';
import type { Repository, EmitEvent } from '../../../packages/core/src/domain.js';
import type { SupportRuntime } from '../../../packages/core/src/runtime.js';
import { newToolCall } from '../../../packages/core/src/executor.js';
import { extractRepairPhoto, photoFields, imageMime } from '../../../packages/core/src/photo.js';

export function attachWorkshop(
  app: Express,
  deps: {
    repo: Repository;
    runtime: SupportRuntime;
    owned: (req: Request) => Promise<void>;
    lock: <T>(id: string, operation: () => Promise<T>) => Promise<T>;
    emit: (id: string) => EmitEvent;
    voiceActive: Set<string>;
    sendVoicePhoto: (id: string, bytes: Buffer) => Promise<void>;
  },
) {
  const { repo, runtime, owned, lock, emit, voiceActive } = deps;
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 5 * 1024 * 1024, files: 1, fields: 0 },
  });
  const active = async (id: string) => {
    const session = await repo.getSession(id);
    if (session.status !== 'active') throw Object.assign(new Error('Session has ended'), { status: 409 });
    return session;
  };
  const assistantActive = async (id: string) => {
    const session = await active(id);
    if (session.handoff)
      throw Object.assign(new Error('AI actions are paused during operator handoff'), { status: 409 });
    if (voiceActive.has(id))
      throw Object.assign(new Error('Disconnect voice before changing these details.'), { status: 409 });
    return session;
  };
  const photoUploads = new Set<string>();
  app.post(
    '/api/sessions/:id/voice/photos',
    async (req, _res, next) => {
      await owned(req);
      const id = String(req.params.id);
      const session = await active(id);
      if (session.handoff || !voiceActive.has(id))
        throw Object.assign(new Error('Connect voice before sending a photo.'), { status: 409 });
      if (!session.scenarioId.startsWith('repair-'))
        throw Object.assign(new Error('Photos are available for appliance repair.'), { status: 400 });
      if (photoUploads.has(id))
        throw Object.assign(new Error('A photo is already being sent.'), { status: 409 });
      photoUploads.add(id);
      // Release the reservation on upload errors and aborted requests as well.
      _res.once('close', () => photoUploads.delete(id));
      next();
    },
    upload.single('image'),
    async (req, res) => {
      const id = String(req.params.id);
      try {
        await owned(req);
        if (!req.file) throw Object.assign(new Error('Choose a photo to upload.'), { status: 400 });
        imageMime(req.file.buffer);
        await deps.sendVoicePhoto(id, req.file.buffer);
        res.status(201).json({ sent: true });
      } finally {
        photoUploads.delete(id);
      }
    },
  );
  app.post(
    '/api/sessions/:id/photos',
    async (req, res, next) => {
      await owned(req);
      await assistantActive(String(req.params.id));
      next();
    },
    upload.single('image'),
    async (req, res) => {
      const id = String(req.params.id);
      const extraction = await lock(id, async () => {
        await owned(req);
        const session = await assistantActive(id);
        if (!session.scenarioId.startsWith('repair-'))
          throw Object.assign(new Error('Photos are available for appliance repair.'), { status: 400 });
        if (!req.file) throw Object.assign(new Error('Choose a photo to upload.'), { status: 400 });
        const details = await extractRepairPhoto(req.file.buffer);
        const result = { id: randomUUID(), ...details };
        await emit(id)('support.state', { state: 'photo-review', photo: result });
        return result;
      });
      res.status(201).json(extraction);
    },
  );
  app.post('/api/sessions/:id/photos/:photoId/confirm', async (req, res) => {
    await owned(req);
    const id = String(req.params.id),
      photoId = z.string().uuid().parse(req.params.photoId);
    const details = photoFields
      .refine((v) => Object.keys(v).length > 0, 'Confirm at least one visible detail')
      .parse(req.body);
    const result = await lock(id, async () => {
      await owned(req);
      await assistantActive(id);
      const events = await repo.getEvents(id);
      if (!events.some((e) => e.payload.state === 'photo-review' && (e.payload.photo as any)?.id === photoId))
        throw Object.assign(new Error('Photo review not found'), { status: 404 });
      if (events.some((e) => e.payload.state === 'photo-confirmed' && e.payload.photoId === photoId))
        throw Object.assign(new Error('These photo details were already confirmed'), { status: 409 });
      const { errorCode, ...context } = details;
      const prior = (await repo.getSession(id)).snapshot.repair;
      const sameAppliance =
        (!context.appliance || context.appliance === prior?.appliance) &&
        (!context.model || canonicalRepairModel(context.model) === prior?.model);
      const symptom = context.issue ?? (sameAppliance ? prior?.issue : undefined);
      // Keep the user's existing symptom when the photo only adds a visible error code.
      // Prior merged descriptions may already be at the tool limit; keep the new code visible.
      const suffix = errorCode ? `Error ${errorCode}` : undefined;
      const issue = [symptom?.slice(0, suffix ? 600 - suffix.length - 2 : 600), suffix]
        .filter(Boolean)
        .join('; ');
      const execution = await runtime.executeTool(
        id,
        newToolCall('update_repair_context', { ...context, ...(issue ? { issue } : {}) }),
      );
      if (execution.status !== 'completed')
        throw Object.assign(new Error(execution.error || 'Could not save photo details'), { status: 400 });
      await emit(id)('support.state', { state: 'photo-confirmed', photoId, details });
      await emit(id)('transcript', {
        role: 'user',
        text: `Confirmed photo details: ${Object.entries(details)
          .map(([k, v]) => `${k}: ${v}`)
          .join(', ')}`,
        final: true,
        mode: 'photo',
      });
      return { session: await repo.getSession(id), details };
    });
    res.json(result);
  });
  app.get('/api/sessions/:id/repair-jobs', async (req, res) => {
    await owned(req);
    res.json({ jobs: (await repo.listRepairJobs?.(String(req.params.id))) ?? [] });
  });
  app.get('/api/sessions/:id/appointments', async (req, res) => {
    await owned(req);
    const appointment = await repo.getAppointment?.(String(req.params.id));
    res.json({ appointments: appointment ? [appointment] : [] });
  });
  app.post('/api/sessions/:id/available-slots', async (req, res) => {
    await owned(req);
    const id = String(req.params.id);
    const input = z
      .object({
        serviceId: z.string().min(1).max(80),
        date: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/)
          .optional(),
      })
      .strict()
      .parse(req.body);
    const result = await lock(id, async () => {
      await assistantActive(id);
      return runtime.executeTool(id, newToolCall('list_available_slots', input));
    });
    if (result.status === 'failed') throw Object.assign(new Error(result.error), { status: 400 });
    res.json(result.result);
  });
  app.post('/api/sessions/:id/appointment-change', async (req, res) => {
    await owned(req);
    const id = String(req.params.id);
    const input = z
      .object({
        action: z.enum(['cancel', 'reschedule']),
        appointmentId: z.string().min(1).max(100).optional(),
        start: z.string().datetime({ offset: true }).optional(),
        end: z.string().datetime({ offset: true }).optional(),
      })
      .strict()
      .parse(req.body);
    if (input.action === 'reschedule' && (!input.start || !input.end))
      throw Object.assign(new Error('Choose an available replacement time'), { status: 400 });
    const result = await lock(id, async () => {
      await assistantActive(id);
      const appointment = await repo.getAppointment?.(id, input.appointmentId);
      if (!appointment) throw Object.assign(new Error('Appointment not found'), { status: 404 });
      return runtime.executeTool(
        id,
        newToolCall(input.action === 'cancel' ? 'cancel_appointment' : 'reschedule_appointment', {
          appointmentId: appointment.id,
          expectedRevision: appointment.revision,
          ...(input.action === 'reschedule' ? { start: input.start, end: input.end } : {}),
        }),
      );
    });
    res.json(result);
  });
  app.post('/api/sessions/:id/repair-jobs/:jobId/approve', async (req, res) => {
    await owned(req);
    const id = String(req.params.id);
    const { expectedRevision } = z
      .object({ expectedRevision: z.number().int().min(0).optional() })
      .strict()
      .parse(req.body);
    const jobId = z.string().min(3).max(60).parse(req.params.jobId);
    const result = await lock(id, async () => {
      await active(id);
      const job = await repo.getRepairJob?.(id, jobId);
      if (expectedRevision !== undefined && job?.revision !== expectedRevision)
        throw Object.assign(new Error('The quote changed. Refresh and review it before approval.'), {
          status: 409,
        });
      if (!job || job.estimateAMD === undefined)
        throw Object.assign(new Error('A current repair quote is required'), { status: 409 });
      return runtime.executeTool(
        id,
        newToolCall('approve_repair_quote', {
          jobId,
          expectedRevision: job.revision,
          expectedEstimateAMD: job.estimateAMD,
        }),
      );
    });
    res.json(result);
  });
  app.post('/api/sessions/:id/repair-jobs/:jobId/transition', async (req, res) => {
    await owned(req);
    const id = String(req.params.id);
    const jobId = z.string().min(3).max(60).parse(req.params.jobId);
    const input = z
      .object({
        status: z.enum([
          'scheduled',
          'diagnosing',
          'awaiting_approval',
          'in_progress',
          'ready',
          'completed',
          'cancelled',
        ]),
        note: z.string().trim().min(3).max(2000),
        estimateAMD: z.number().int().nonnegative().optional(),
        readyAt: z.string().datetime({ offset: true }).optional(),
        expectedRevision: z.number().int().min(0),
      })
      .strict()
      .parse(req.body);
    const job = await lock(id, async () => {
      const session = await active(id);
      if (session.handoff?.status !== 'accepted')
        throw Object.assign(new Error('Accept the operator handoff before updating a repair.'), {
          status: 409,
        });
      if (!repo.transitionRepairJob)
        throw Object.assign(new Error('Repair records are unavailable'), { status: 503 });
      const result = await repo.transitionRepairJob(id, jobId, input, 'operator');
      await emit(id)('support.state', { state: 'repair-updated', job: result });
      return result;
    });
    res.json({ job });
  });
}
