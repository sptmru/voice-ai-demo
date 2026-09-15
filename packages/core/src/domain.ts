import { z } from 'zod';

export const scenarioIds = [
  'carrier-incident',
  'caller-id',
  'international-disabled',
  'invalid-credentials',
  'account-balance',
  'number-routing',
  'unknown',
] as const;
export const scenarioSchema = z.enum(scenarioIds);
export type ScenarioId = z.infer<typeof scenarioSchema>;
export const scenarios: { id: ScenarioId; label: string; prompt: string }[] = [
  {
    id: 'carrier-incident',
    label: 'UK carrier incident',
    prompt:
      'Our outbound calls to UK numbers started failing this morning with SIP 403. Can you investigate and open a support ticket?',
  },
  {
    id: 'caller-id',
    label: 'Caller ID mismatch',
    prompt: 'Our outbound calls are failing with SIP 403. Please investigate.',
  },
  {
    id: 'international-disabled',
    label: 'International restrictions',
    prompt: 'UK outbound calls are rejected. Can you check the account?',
  },
  {
    id: 'invalid-credentials',
    label: 'Trunk authentication',
    prompt: 'Our SIP trunk is failing authentication and calls return 403.',
  },
  {
    id: 'account-balance',
    label: 'Account restriction',
    prompt: 'We cannot make outbound calls. Please check our service.',
  },
  {
    id: 'number-routing',
    label: 'Number routing',
    prompt: 'Incoming calls to our UK number are not reaching our trunk.',
  },
  {
    id: 'unknown',
    label: 'Needs an engineer',
    prompt: 'Calls intermittently fail with SIP 503. Please investigate and escalate if needed.',
  },
];
export interface Customer {
  id: string;
  company: string;
  name: string;
  email: string;
  phone: string;
  timezone: string;
}
export interface Account {
  id: string;
  customerId: string;
  plan: string;
  products: string[];
  status: 'active' | 'restricted';
  balance: number;
  internationalEnabled: boolean;
  ukEnabled: boolean;
}
export interface TelecomCall {
  id: string;
  customerId: string;
  startedAt: string;
  from: string;
  to: string;
  direction: 'inbound' | 'outbound';
  status: 'completed' | 'failed';
  sipCode: number;
  durationSec: number;
  trunkId: string;
  carrier: string;
}
export interface Trunk {
  id: string;
  customerId: string;
  name: string;
  registered: boolean;
  credentialsValid: boolean;
  callerIdVerified: boolean;
  callerId: string;
  region: string;
  credentialVersion: number;
}
export interface PhoneNumber {
  id: string;
  customerId: string;
  number: string;
  route: string | null;
  enabled: boolean;
}
export interface Incident {
  id: string;
  title: string;
  region: string;
  status: string;
  startedAt: string;
  description: string;
}
export interface Snapshot {
  account: Account;
  calls: TelecomCall[];
  trunk: Trunk;
  number: PhoneNumber;
  incidents: Incident[];
}
export const outcomeSchema = z.object({
  customer: z.string(),
  intent: z.enum(['technical_support', 'account_support']),
  severity: z.enum(['low', 'medium', 'high', 'critical']),
  product: z.string(),
  issue: z.string(),
  diagnosis: z.string(),
  resolved: z.boolean(),
  actions: z.array(z.string()),
  ticketId: z.string().nullable(),
  nextAction: z.string(),
});
export type CallOutcome = z.infer<typeof outcomeSchema>;
export type EventType =
  | 'customer.identified'
  | 'retrieval.started'
  | 'retrieval.completed'
  | 'tool.started'
  | 'tool.completed'
  | 'tool.failed'
  | 'confirmation.required'
  | 'confirmation.resolved'
  | 'support.state'
  | 'transcript'
  | 'voice.state'
  | 'voice.turn'
  | 'voice.metric'
  | 'call.outcome'
  | 'error'
  | 'memory.retrieved';
export interface AgentEvent {
  id: number;
  sessionId: string;
  correlationId: string;
  timestamp: string;
  type: EventType;
  payload: Record<string, unknown>;
  durationMs?: number;
}
export type EmitEvent = (
  type: EventType,
  payload: Record<string, unknown>,
  durationMs?: number,
  correlationId?: string,
) => Promise<AgentEvent>;
export interface SupportSession {
  id: string;
  customerId: string;
  scenarioId: ScenarioId;
  status: 'active' | 'completed';
  createdAt: string;
  endedAt: string | null;
  snapshot: Snapshot;
  outcome: CallOutcome | null;
  diagnosis: string | null;
}
export interface RetrievedChunk {
  chunkId: string;
  documentId: string;
  document: string;
  section: string;
  content: string;
  source: string;
  type: string;
  semanticScore: number;
  lexicalScore: number;
  combinedScore: number;
}
export interface KnowledgeDocument {
  id: string;
  title: string;
  source: string;
  type: string;
  chunkCount: number;
  createdAt: string;
}
export interface MemoryItem {
  id: string;
  kind: 'fact' | 'preference' | 'summary' | 'case';
  content: string;
  sourceSessionId: string | null;
  createdAt: string;
}
export interface PendingConfirmation {
  id: string;
  sessionId: string;
  toolName: string;
  input: Record<string, unknown>;
  status: 'pending' | 'approved' | 'rejected' | 'expired';
  expiresAt: string;
  result?: unknown;
}
export interface Ticket {
  id: string;
  sessionId: string;
  customerId: string;
  subject: string;
  description: string;
  severity: string;
  status: string;
  createdAt: string;
}

export interface Repository {
  getCustomer(id: string): Promise<Customer>;
  createSession(scenario: ScenarioId): Promise<SupportSession>;
  getSession(id: string): Promise<SupportSession>;
  listSessions(allowedIds?: string[]): Promise<SupportSession[]>;
  updateSession(
    id: string,
    patch: Partial<Pick<SupportSession, 'status' | 'endedAt' | 'diagnosis' | 'outcome' | 'snapshot'>>,
  ): Promise<void>;
  appendEvent(
    sessionId: string,
    type: EventType,
    payload: Record<string, unknown>,
    durationMs?: number,
    correlationId?: string,
  ): Promise<AgentEvent>;
  getEvents(sessionId: string, afterId?: number): Promise<AgentEvent[]>;
  createTicket(
    sessionId: string,
    input: { subject: string; description: string; severity: string },
  ): Promise<Ticket>;
  getTickets(sessionId: string): Promise<Ticket[]>;
  createAction(
    sessionId: string,
    kind: string,
    input: Record<string, unknown>,
    idempotencyKey: string,
  ): Promise<Record<string, unknown>>;
  getActions(sessionId: string): Promise<Record<string, unknown>[]>;
  createConfirmation(
    sessionId: string,
    toolName: string,
    input: Record<string, unknown>,
  ): Promise<PendingConfirmation>;
  getConfirmations(sessionId: string): Promise<PendingConfirmation[]>;
  resolveConfirmation(sessionId: string, id: string, approve: boolean): Promise<PendingConfirmation>;
  getMemory(customerId: string, query?: string): Promise<MemoryItem[]>;
  saveMemory(
    customerId: string,
    kind: MemoryItem['kind'],
    content: string,
    sessionId: string | null,
  ): Promise<void>;
}
export interface RetrievalService {
  search(query: string, limit?: number): Promise<RetrievedChunk[]>;
  ingest(input: { title: string; content: string; source: string; type: string }): Promise<KnowledgeDocument>;
  listDocuments(): Promise<KnowledgeDocument[]>;
}
