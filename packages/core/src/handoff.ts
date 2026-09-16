import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import type { EmitEvent, HandoffState, Repository } from './domain.js';
import type { ToolDefinition } from './tools.js';
import { sanitize } from './redaction.js';

/** A factual handoff packet, built from saved evidence, never model-invented context. */
export async function requestHandoff(repo: Repository, sessionId: string, reason: string, emit: EmitEvent) {
  const session = await repo.getSession(sessionId);
  if (session.status !== 'active') throw Object.assign(new Error('Session has ended'), { status: 409 });
  if (session.handoff) return session.handoff;
  const [customer, events, actions] = await Promise.all([
    repo.getCustomer(session.customerId),
    repo.getEvents(sessionId),
    repo.getActions(sessionId),
  ]);
  const recent = events
    .filter((event) => event.type === 'transcript')
    .slice(-6)
    .map((event) => `${event.payload.role}: ${String(event.payload.text).slice(0, 500)}`);
  const handoff: HandoffState = {
    status: 'waiting',
    reason: String(sanitize(reason)).slice(0, 2000),
    summary: String(
      sanitize(
        [
          `${customer.name} · ${customer.company} · ${session.scenarioId}`,
          session.outcome
            ? `Result: ${session.outcome.diagnosis}\nNext step: ${session.outcome.nextAction}`
            : 'Conversation still in progress.',
          actions.length
            ? `Saved actions: ${actions.map((action) => `${action.kind} (${action.id})`).join(', ')}`
            : 'No actions saved yet.',
          ...recent,
        ].join('\n'),
      ),
    ).slice(0, 6000),
    requestedAt: new Date().toISOString(),
  };
  await repo.updateSession(sessionId, { handoff });
  await emit('handoff.requested', { handoff });
  return handoff;
}

export function createHandoffTools(): ToolDefinition[] {
  const inputSchema = z.object({ reason: z.string().trim().min(1).max(2000) }).strict();
  return [
    {
      name: 'request_human_handoff',
      description:
        'Pass this conversation and saved context to the local demo operator queue when the customer requests a person or you cannot continue. AI stops after handoff. This is a browser text handoff, not a telephone transfer.',
      inputSchema,
      jsonSchema: zodToJsonSchema(inputSchema, { $refStrategy: 'none' }) as Record<string, unknown>,
      permission: 'write',
      execute: (input, context) =>
        requestHandoff(context.repo, context.session.id, input.reason, context.emit),
    },
  ];
}
