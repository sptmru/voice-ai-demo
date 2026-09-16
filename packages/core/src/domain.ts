import type { KnowledgeMetadata, RetrievalRequest, RetrievalResult } from './knowledge-domain.js';
export type {
  KnowledgeMetadata,
  RetrievalRequest,
  RetrievalResult,
  RetrievalStatus,
} from './knowledge-domain.js';
import { z } from 'zod';

export const repairScenarioIds = ['repair-advice', 'repair-booking', 'repair-status'] as const;
export const scenarioIds = [
  ...repairScenarioIds,
  'appointment-booking',
  'lead-qualification',
  'order-support',
  'carrier-incident',
  'caller-id',
  'international-disabled',
  'invalid-credentials',
  'account-balance',
  'number-routing',
  'unknown',
] as const;
export const telecomScenarioIds = scenarioIds.filter(
  (id) => ![...repairScenarioIds, 'appointment-booking', 'lead-qualification', 'order-support'].includes(id),
) as Exclude<
  (typeof scenarioIds)[number],
  (typeof repairScenarioIds)[number] | 'appointment-booking' | 'lead-qualification' | 'order-support'
>[];
export const scenarioSchema = z.enum(scenarioIds);
export type ScenarioId = z.infer<typeof scenarioSchema>;
export const scenarios: {
  id: ScenarioId;
  label: string;
  prompt: string;
  category?: string;
  description?: string;
  result?: string;
  quickPrompts?: string[];
}[] = [
  {
    id: 'repair-advice',
    label: 'Appliance troubleshooting',
    category: 'Relay Workshop',
    description: 'Understand repair policies and prepare for diagnosis.',
    result: 'A sourced answer and a clear next step',
    prompt: 'My Relay Wash W100 washing machine will not drain and shows E21. What should I do?',
    quickPrompts: [
      'What is the repair warranty?',
      'How much does diagnosis cost?',
      'Book a workshop appointment',
      'Talk to an operator',
    ],
  },
  {
    id: 'repair-booking',
    label: 'Book a repair',
    category: 'Relay Workshop',
    description: 'Tell us about the appliance and choose an available time.',
    result: 'Google Calendar booking or a local demo appointment',
    prompt: 'I want to book a diagnosis for my Relay Wash W100 washing machine. It will not drain.',
    quickPrompts: ['Show available times', 'Choose option 1', 'Talk to an operator'],
  },
  {
    id: 'repair-status',
    label: 'Check repair status',
    category: 'Relay Workshop',
    description: 'Look up a demo repair and understand the next step.',
    result: 'Verified repair status without an invented completion date',
    prompt: 'Check REP-1042',
    quickPrompts: ['Check REP-1042', 'What is the repair warranty?', 'Talk to an operator'],
  },
  {
    id: 'appointment-booking',
    label: 'Book a consultation',
    category: 'Appointments',
    description: 'Find a service and choose an available time.',
    result: 'Calendar booking and conversation summary',
    prompt: 'I would like to book a consultation. What times are available?',
    quickPrompts: ['Show available times', 'Book option 1', 'Talk to a person'],
  },
  {
    id: 'lead-qualification',
    label: 'Qualify a sales lead',
    category: 'Sales',
    description: 'Turn an inquiry into a qualified lead and a meeting.',
    result: 'Saved lead with need, budget and timeline',
    prompt: 'We want a voice agent for incoming calls. Can we discuss our project?',
    quickPrompts: [
      'Need: automate incoming calls; Budget: $5000; Timeline: next month',
      'Book a meeting',
      'Talk to a person',
    ],
  },
  {
    id: 'order-support',
    label: 'Help with an order',
    category: 'Retail',
    description: 'Look up a demo order and request a delivery change.',
    result: 'Verified order status and saved delivery request',
    prompt: 'Where is my order ORD-1042? Can I change delivery?',
    quickPrompts: [
      'Where is order ORD-1042?',
      'Change delivery to 25 Market Street, London',
      'Confirm delivery change',
      'Talk to a person',
    ],
  },
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
export interface BusinessState {
  services: { id: string; name: string; durationMinutes: number }[];
  orders: {
    id: string;
    customerId: string;
    items: string[];
    status: 'processing' | 'shipped' | 'delivered';
    deliveryAddress: string;
    estimatedDelivery: string;
  }[];
  serviceId?: string;
  pendingBooking?: { serviceId: string; start: string; end: string };
  offeredSlots?: { start: string; end: string }[];
  calendarProvider?: 'google' | 'demo';
  calendarTimeZone?: string;
  lead?: { need?: string; budget?: string; timeline?: string };
  selectedOrderId?: string;
  pendingDeliveryAddress?: string;
}
export interface RepairState {
  appliance?: 'washing-machine' | 'dishwasher' | 'refrigerator';
  model?: string;
  issue?: string;
  previousQuery?: string;
  address?: string;
  region?: string;
  bookingRequested?: boolean;
  selectedJobId?: string;
  services: {
    id: string;
    name: string;
    durationMinutes: number;
    priceAMD: number;
    creditAgainstRepair: boolean;
    location: 'workshop' | 'home';
  }[];
  jobs: {
    id: string;
    customerId: string;
    appliance: string;
    model: string;
    status: 'awaiting_approval' | 'in_progress' | 'ready';
    note: string;
    estimateAMD?: number;
    diagnosisCreditAMD?: number;
    readyAt: string | null;
  }[];
}
export interface Snapshot {
  repair?: RepairState;
  business?: BusinessState;
  account: Account;
  calls: TelecomCall[];
  trunk: Trunk;
  number: PhoneNumber;
  incidents: Incident[];
}
export const outcomeSchema = z.object({
  customer: z.string(),
  intent: z.enum([
    'repair_support',
    'technical_support',
    'account_support',
    'appointment_booking',
    'lead_qualification',
    'order_support',
  ]),
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
  | 'handoff.requested'
  | 'handoff.accepted'
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
export interface HandoffState {
  status: 'waiting' | 'accepted';
  reason: string;
  summary: string;
  requestedAt: string;
  acceptedAt?: string;
}
export interface SupportSession {
  handoff?: HandoffState;
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
  metadata?: KnowledgeMetadata;
  page?: number;
  headingPath?: string[];
  rerankScore?: number;
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
  metadata?: KnowledgeMetadata;
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
  deleteSession(id: string): Promise<boolean>;
  updateSession(
    id: string,
    patch: Partial<
      Pick<SupportSession, 'status' | 'endedAt' | 'diagnosis' | 'outcome' | 'snapshot' | 'handoff'>
    >,
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
  retrieve?(request: RetrievalRequest): Promise<RetrievalResult>;
  search(query: string, limit?: number): Promise<RetrievedChunk[]>;
  ingest(input: {
    title: string;
    content: string;
    source: string;
    type: string;
    metadata?: Partial<KnowledgeMetadata>;
  }): Promise<KnowledgeDocument>;
  listDocuments(): Promise<KnowledgeDocument[]>;
  deleteDocument(id: string): Promise<boolean>;
}
