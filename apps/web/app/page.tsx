'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Activity,
  ArrowDownToLine,
  ArrowRight,
  AudioLines,
  BookOpen,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  CircleHelp,
  Clock3,
  FileText,
  Headphones,
  History,
  Layers3,
  LoaderCircle,
  MessageSquare,
  Mic,
  MicOff,
  Phone,
  PhoneOff,
  Plus,
  Radio,
  RotateCcw,
  Search,
  Send,
  ShieldCheck,
  Upload,
  Sparkles,
  Ticket,
  Trash2,
  Wrench,
  X,
  Zap,
} from 'lucide-react';
import { KnowledgeEvidence, SourceCard, type EvidenceResult } from './knowledge-evidence';
import {
  AppointmentCard,
  ConfirmationCards,
  DemoReadiness,
  PhotoIntake,
  RepairJobCard,
  type Readiness,
  type SessionMode,
  type WorkshopAppointment,
  type WorkshopJob,
} from './workshop-controls';
import { BrowserVoiceClient } from './voice-client';
import { Presentation, OperatorPanel, type Handoff, type DemoScenario } from './presentation';
import type {
  AgentEvent,
  Customer,
  KnowledgeDocument,
  MemoryItem,
  PendingConfirmation,
  RetrievedChunk,
  SupportSession,
  Ticket as SupportTicket,
} from '../../../packages/core/src/domain';

type Config = {
  scenarios: DemoScenario[];
  calendar?: { configured: boolean; provider?: string };
  voiceProvider: string;
  voiceUrl: string | null;
  providers: Record<string, { configured: boolean; model: string }>;
  textMode: string;
};
type Detail = {
  appointments?: WorkshopAppointment[];
  repairJobs?: WorkshopJob[];
  session: SupportSession;
  customer: Customer;
  events: AgentEvent[];
  tickets: SupportTicket[];
  actions: Record<string, unknown>[];
  confirmations: PendingConfirmation[];
  memory: MemoryItem[];
  handoff?: Handoff | null;
};
async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`/api${path}`, {
    ...init,
    headers: {
      ...(init?.body instanceof FormData ? {} : { 'Content-Type': 'application/json' }),
      ...init?.headers,
    },
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.error || `Request failed (${response.status})`);
  }
  if (response.status === 204) return undefined as T;
  const body = await response.json();
  if (body?.status === 'failed' && typeof body.error === 'string') throw new Error(body.error);
  return body as T;
}
type DeleteTarget = { kind: 'document' | 'session'; id: string; title: string };

function DeleteDialog({
  target,
  busy,
  error,
  onCancel,
  onDelete,
}: {
  target: DeleteTarget;
  busy: boolean;
  error: string;
  onCancel: () => void;
  onDelete: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    dialog.current?.showModal();
  }, []);
  return (
    <dialog
      ref={dialog}
      className="delete-dialog"
      aria-labelledby="delete-title"
      aria-describedby="delete-description"
      onCancel={(event) => {
        event.preventDefault();
        if (!busy) onCancel();
      }}
    >
      <span className="delete-symbol">
        <Trash2 size={24} />
      </span>
      <h2 id="delete-title">Delete {target.kind === 'document' ? 'document' : 'session'}?</h2>
      <p className="delete-name">{target.title}</p>
      <p id="delete-description">
        {target.kind === 'document'
          ? 'This removes the document and its searchable passages for everyone using this demo. Existing session transcripts keep their historical citations.'
          : 'This disconnects its voice call and permanently removes the session, events, tickets, actions and saved memory from this conversation.'}{' '}
        This cannot be undone.
      </p>
      {error && (
        <p className="delete-error" role="alert">
          {error}
        </p>
      )}
      <div className="dialog-actions">
        <button className="button outline" autoFocus disabled={busy} onClick={onCancel}>
          Cancel
        </button>
        <button className="button danger" disabled={busy} onClick={onDelete}>
          {busy ? <LoaderCircle size={15} className="spin" /> : <Trash2 size={15} />}
          {busy ? 'Deleting…' : `Delete ${target.kind}`}
        </button>
      </div>
    </dialog>
  );
}
const post = (body: unknown): RequestInit => ({ method: 'POST', body: JSON.stringify(body) });
const textValue = (value: unknown): string =>
  typeof value === 'string' ? value : value == null ? '' : JSON.stringify(value);
const labels: Record<string, string> = {
  'customer.identified': 'Customer identified',
  'retrieval.started': 'Searching knowledge base',
  'retrieval.completed': 'Knowledge retrieved',
  'tool.started': 'Running tool',
  'tool.completed': 'Tool completed',
  'tool.failed': 'Tool failed',
  'confirmation.required': 'Your confirmation is needed',
  'confirmation.resolved': 'Confirmation recorded',
  'support.state': 'Support case updated',
  'call.outcome': 'Call outcome saved',
  'memory.retrieved': 'Relevant memory loaded',
  'voice.state': 'Voice connection',
  'voice.turn': 'Conversation turn',
  'voice.metric': 'Voice timing',
  error: 'Something needs attention',
};
const toolLabel = (name: unknown) => textValue(name).replaceAll('_', ' ');
const elapsed = (seconds: number) =>
  `${Math.floor(seconds / 60)
    .toString()
    .padStart(2, '0')}:${(seconds % 60).toString().padStart(2, '0')}`;

function EventCard({ event }: { event: AgentEvent }) {
  const p = event.payload;
  const isRetrieval = event.type.startsWith('retrieval');
  const isError = event.type === 'error' || event.type === 'tool.failed';
  const Icon = isRetrieval
    ? Search
    : event.type.startsWith('tool')
      ? Wrench
      : event.type === 'call.outcome'
        ? CheckCircle2
        : event.type.startsWith('confirmation')
          ? ShieldCheck
          : event.type.startsWith('voice')
            ? AudioLines
            : Activity;
  return (
    <article className={`event-card ${isError ? 'event-error' : ''}`}>
      <span className={`event-icon ${isRetrieval ? 'purple' : ''}`}>
        <Icon size={16} />
      </span>
      <div className="event-content">
        <div className="event-title">
          <strong>{labels[event.type] || event.type}</strong>
          <time>
            {new Date(event.timestamp).toLocaleTimeString('en-GB', {
              hour: '2-digit',
              minute: '2-digit',
              second: '2-digit',
            })}
          </time>
        </div>
        {Boolean(p.toolName || p.name || p.tool) && (
          <div className="tool-name">{toolLabel(p.toolName || p.name || p.tool)}</div>
        )}
        {p.query != null && <p className="query">“{textValue(p.query)}”</p>}
        {p.message != null && <p>{textValue(p.message)}</p>}
        {p.company != null && <p>{textValue(p.company)}</p>}
        {p.state != null && <p>{toolLabel(p.state)}</p>}
        {event.durationMs != null && (
          <span className="duration">
            <Zap size={11} /> {Math.round(event.durationMs)} ms
          </span>
        )}
        <details>
          <summary>
            Inspect event <ChevronDown size={12} />
          </summary>
          <pre>{JSON.stringify(p, null, 2)}</pre>
          <span className="correlation">Correlation {event.correlationId.slice(0, 8)}</span>
        </details>
      </div>
    </article>
  );
}

export default function Home() {
  const [config, setConfig] = useState<Config>();
  const [detail, setDetail] = useState<Detail>();
  const [events, setEvents] = useState<AgentEvent[]>([]);
  const [scenario, setScenario] = useState('repair-advice');
  const [mode, setMode] = useState<SessionMode>('rehearsal');
  const [readiness, setReadiness] = useState<Readiness>();
  const [readinessLoading, setReadinessLoading] = useState(false);
  const [readinessError, setReadinessError] = useState('');
  const [tab, setTab] = useState<'demo' | 'workspace' | 'knowledge' | 'history' | 'operator'>('demo');
  const [technicalDetails, setTechnicalDetails] = useState(false);
  const [operatorInput, setOperatorInput] = useState('');
  const [operatorQueue, setOperatorQueue] = useState<Detail[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [connection, setConnection] = useState('offline');
  const [documents, setDocuments] = useState<KnowledgeDocument[]>([]);
  const [sessions, setSessions] = useState<SupportSession[]>([]);
  const [search, setSearch] = useState('');
  const [uploadStatus, setUploadStatus] = useState('');
  const [uploading, setUploading] = useState(false);
  const [uploadFile, setUploadFile] = useState<File | null>(null);
  const [searchResults, setSearchResults] = useState<EvidenceResult>();
  const [knowledgeDomain, setKnowledgeDomain] = useState('repair');
  const [uploadDomain, setUploadDomain] = useState('repair');
  const [uploadMetadata, setUploadMetadata] = useState('');
  const [seconds, setSeconds] = useState(0);
  const [voiceState, setVoiceState] = useState('idle');
  const [voiceProvider, setVoiceProvider] = useState<'gemini' | 'openai'>('gemini');
  const [muted, setMuted] = useState(false);
  const [partialTranscript, setPartialTranscript] = useState('');
  const [deleteTarget, setDeleteTarget] = useState<DeleteTarget | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState('');
  const operationRef = useRef(false);
  const activeSessionRef = useRef<string | undefined>(undefined);
  const voiceRef = useRef<BrowserVoiceClient | null>(null);
  const voiceConnected = voiceState === 'connected';
  const voiceBusy = ['requesting-microphone', 'connecting'].includes(voiceState);
  useEffect(
    () => () => {
      void voiceRef.current?.close();
    },
    [],
  );
  const transcriptEnd = useRef<HTMLDivElement>(null);
  const activityRef = useRef<HTMLDivElement>(null);
  const followActivity = useRef(true);
  const refreshVersion = useRef(0);
  const sessionId = detail?.session.id;
  const finished = detail?.session.status === 'completed';
  const handoff = detail?.handoff || null;
  const refresh = useCallback(async (id: string) => {
    const version = ++refreshVersion.current;
    const value = await api<Detail>(`/sessions/${id}`);
    if (version === refreshVersion.current && activeSessionRef.current === id) {
      setDetail(value);
      setEvents(value.events);
      if (value.handoff) {
        const client = voiceRef.current;
        voiceRef.current = null;
        setVoiceState('idle');
        setPartialTranscript('');
        void client?.close();
      }
    }
    return value;
  }, []);

  const refreshReadiness = useCallback(async () => {
    setReadinessLoading(true);
    setReadinessError('');
    try {
      setReadiness(await api<Readiness>('/readiness'));
    } catch (error) {
      setReadinessError(error instanceof Error ? error.message : 'Readiness could not be checked.');
    } finally {
      setReadinessLoading(false);
    }
  }, []);
  useEffect(() => {
    void refreshReadiness();
  }, [refreshReadiness]);
  useEffect(() => {
    if (!readiness?.search?.message?.includes('Warming up') || readinessLoading) return;
    const timer = setTimeout(() => void refreshReadiness(), 2000);
    return () => clearTimeout(timer);
  }, [readiness, readinessLoading, refreshReadiness]);
  useEffect(() => {
    api<Config>('/config')
      .then((value) => {
        setConfig(value);
        setVoiceProvider(value.voiceProvider === 'openai' ? 'openai' : 'gemini');
      })
      .catch((e) => setError(e.message));
    api<KnowledgeDocument[]>('/knowledge')
      .then(setDocuments)
      .catch((e) => setError(e.message));
  }, []);
  useEffect(() => {
    if (!sessionId) return;
    const source = new EventSource(`/api/sessions/${sessionId}/events`);
    let refreshTimer: ReturnType<typeof setTimeout> | undefined;
    const scheduleRefresh = () => {
      clearTimeout(refreshTimer);
      refreshTimer = setTimeout(() => {
        void refresh(sessionId).catch((e) => {
          if (activeSessionRef.current === sessionId) setError(e.message);
        });
      }, 150);
    };
    source.onopen = () => {
      if (activeSessionRef.current !== sessionId) return;
      setConnection('live');
      void refresh(sessionId).catch((e) => {
        if (activeSessionRef.current === sessionId) setError(e.message);
      });
    };
    source.onerror = () => {
      if (activeSessionRef.current === sessionId) setConnection('reconnecting');
    };
    source.addEventListener('agent', (event) => {
      if (activeSessionRef.current !== sessionId) return;
      const data = JSON.parse((event as MessageEvent).data) as AgentEvent;
      setEvents((old) =>
        old.some((item) => item.id === data.id) ? old : [...old, data].sort((a, b) => a.id - b.id),
      );
      if (String(data.type).startsWith('handoff.')) {
        const client = voiceRef.current;
        voiceRef.current = null;
        setVoiceState('idle');
        setPartialTranscript('');
        void client?.close();
      }
      if (data.type === 'call.outcome')
        setDetail((old) =>
          old?.session.id === sessionId
            ? {
                ...old,
                session: { ...old.session, outcome: data.payload.outcome as SupportSession['outcome'] },
              }
            : old,
        );
      if (
        [
          'call.outcome',
          'confirmation.required',
          'confirmation.resolved',
          'support.state',
          'handoff.requested',
          'handoff.accepted',
          'repair.updated',
          'appointment.updated',
          'photo.confirmed',
        ].includes(data.type) ||
        data.type === 'transcript' ||
        data.type === 'tool.completed'
      )
        scheduleRefresh();
    });
    return () => {
      clearTimeout(refreshTimer);
      source.close();
      setConnection('offline');
    };
  }, [sessionId, refresh]);
  useEffect(() => {
    if (!detail) return;
    const tick = () =>
      setSeconds(
        Math.max(
          0,
          Math.floor(
            ((detail.session.endedAt ? new Date(detail.session.endedAt).getTime() : Date.now()) -
              new Date(detail.session.createdAt).getTime()) /
              1000,
          ),
        ),
      );
    tick();
    const timer = setInterval(tick, 1000);
    return () => clearInterval(timer);
  }, [detail]);
  useEffect(() => {
    if (activityRef.current && followActivity.current)
      activityRef.current.scrollTop = activityRef.current.scrollHeight;
  }, [events.length]);
  useEffect(() => {
    transcriptEnd.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }, [events.length]);

  async function run(action: () => Promise<void>) {
    if (operationRef.current) return;
    operationRef.current = true;
    setBusy(true);
    setError('');
    try {
      await action();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Something went wrong');
    } finally {
      operationRef.current = false;
      setBusy(false);
    }
  }
  async function start(textOnly = false) {
    await run(async () => {
      if (mode === 'live' && !(readiness?.calendar?.configured ?? config?.calendar?.configured))
        throw new Error(
          'Live mode requires a configured Google Calendar. Choose Rehearsal for local bookings.',
        );
      const previousVoice = voiceRef.current;
      voiceRef.current = null;
      setVoiceState('idle');
      const client =
        !textOnly && config?.providers[voiceProvider]?.configured ? createVoiceClient() : undefined;
      // Request permission/unlock audio within the click; no provider connection until the session exists.
      if (client) void client.prepare().catch(() => {});
      try {
        await previousVoice?.close();
        if (sessionId && !finished) await api(`/sessions/${sessionId}/end`, post({}));
        const { session } = await api<{ session: SupportSession }>(
          '/sessions',
          post({ scenarioId: scenario, mode }),
        );
        activeSessionRef.current = session.id;
        followActivity.current = true;
        setEvents([]);
        setInput('');
        setPartialTranscript('');
        await refresh(session.id);
        if (tab !== 'workspace') setTab('demo');
        if (client) await connectVoice(session.id, client);
      } catch (error) {
        await client?.close();
        throw error;
      }
    });
  }
  async function send(text: string) {
    if (!sessionId || !text.trim() || busy || voiceBusy || finished) return;
    setInput('');
    if (voiceConnected && !handoff) {
      voiceRef.current?.sendText(text);
      return;
    }
    await run(async () => {
      await api(`/sessions/${sessionId}/messages`, post({ text }));
      await refresh(sessionId);
    });
  }
  async function resolveConfirmation(id: string, approve: boolean) {
    if (!sessionId) return;
    await run(async () => {
      try {
        await api(`/sessions/${sessionId}/confirmations/${id}`, post({ approve }));
      } finally {
        await refresh(sessionId);
      }
    });
  }
  async function refreshCurrent() {
    if (sessionId) await refresh(sessionId);
  }
  async function end() {
    if (sessionId)
      await run(async () => {
        await voiceRef.current?.close();
        voiceRef.current = null;
        await api(`/sessions/${sessionId}/end`, post({}));
        await refresh(sessionId);
      });
  }
  async function uploadDocument() {
    if (!uploadFile || uploading) return;
    if (uploadFile.size > 5 * 1024 * 1024) {
      setError('Documents must be smaller than 5 MB.');
      return;
    }
    setUploading(true);
    setError('');
    setUploadStatus('Parsing, embedding, and indexing…');
    try {
      const form = new FormData();
      form.append('file', uploadFile);
      const metadata = uploadMetadata.trim() ? JSON.parse(uploadMetadata) : {};
      if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata))
        throw new Error('Metadata must be a JSON object.');
      form.append('metadata', JSON.stringify({ ...metadata, domain: uploadDomain }));
      form.append('domain', uploadDomain);
      const result = await api<{ document: KnowledgeDocument; durationMs: number }>('/knowledge/upload', {
        method: 'POST',
        body: form,
      });
      setDocuments(await api('/knowledge'));
      setUploadStatus(
        `${result.document.title} is searchable — ${result.document.chunkCount} chunks indexed in ${(result.durationMs / 1000).toFixed(1)}s.`,
      );
      setUploadFile(null);
    } catch (error) {
      setUploadStatus('');
      setError(error instanceof Error ? error.message : 'Upload failed');
    } finally {
      setUploading(false);
    }
  }
  async function toggleVoice() {
    if (voiceConnected || voiceBusy) {
      await voiceRef.current?.close();
      voiceRef.current = null;
      return;
    }
    if (!sessionId || finished || handoff) return;
    await connectVoice(sessionId);
  }
  function createVoiceClient() {
    setError('');
    setMuted(false);
    setPartialTranscript('');
    const client = new BrowserVoiceClient({
      url: '',
      provider: voiceProvider,
      onEvent: (event) => {
        if (voiceRef.current !== client) return;
        if (event.type === 'state')
          setVoiceState(event.state === 'ready' ? 'connected' : String(event.state));
        if (event.type === 'error') {
          setError(String(event.message));
          setVoiceState('error');
        }
        if (event.type === 'transcript')
          setPartialTranscript(
            event.final ? '' : `${event.role === 'user' ? 'You' : 'Relay'}: ${String(event.text)}`,
          );
        if (event.type === 'interrupted') setPartialTranscript('');
      },
    });
    voiceRef.current = client;
    return client;
  }
  async function connectVoice(id: string, client = createVoiceClient()) {
    const base = config?.voiceUrl || `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}`;
    try {
      await client.start(`${base.replace(/\/$/, '')}/api/sessions/${id}/voice`);
    } catch (e) {
      if (voiceRef.current !== client) return;
      setVoiceState('error');
      setError(`${e instanceof Error ? e.message : 'Voice failed'}. You can reconnect or continue in text.`);
    }
  }
  async function openSession(id: string, destination: 'workspace' | 'operator' | 'demo' = 'workspace') {
    await run(async () => {
      await voiceRef.current?.close();
      voiceRef.current = null;
      setVoiceState('idle');
      setPartialTranscript('');
      activeSessionRef.current = id;
      const d = await refresh(id);
      setEvents(d.events);
      setScenario(d.session.scenarioId);
      setTab(destination);
    });
  }
  async function handoffAction(accept = false) {
    if (!sessionId) return;
    await run(async () => {
      const client = voiceRef.current;
      voiceRef.current = null;
      setVoiceState('idle');
      setPartialTranscript('');
      await client?.close();
      await api(
        `/sessions/${sessionId}/handoff${accept ? '/accept' : ''}`,
        post(accept ? {} : { reason: 'The customer requested a team member.' }),
      );
      await refresh(sessionId);
    });
  }
  async function sendOperatorMessage() {
    if (!sessionId || !operatorInput.trim()) return;
    await run(async () => {
      await api(`/sessions/${sessionId}/operator/messages`, post({ text: operatorInput }));
      setOperatorInput('');
      await refresh(sessionId);
    });
  }
  function requestDelete(target: DeleteTarget) {
    setDeleteError('');
    setDeleteTarget(target);
  }
  async function deleteItem() {
    if (!deleteTarget || deleting || operationRef.current) return;
    const target = deleteTarget;
    setDeleting(true);
    setDeleteError('');
    try {
      if (target.kind === 'session' && target.id === activeSessionRef.current) {
        await voiceRef.current?.close();
        voiceRef.current = null;
      }
      await api(`/${target.kind === 'document' ? 'knowledge' : 'sessions'}/${target.id}`, {
        method: 'DELETE',
      });
      if (target.kind === 'document') {
        setDocuments((old) => old.filter((doc) => doc.id !== target.id));
        // A removed source can invalidate the evidence assessment, so ask for a fresh search.
        setSearchResults((old) =>
          old
            ? {
                query: old.query,
                chunks: [],
                reason: 'Source deleted. Search again to check the remaining documents.',
              }
            : undefined,
        );
        setUploadStatus('');
      } else {
        setSessions((old) => old.filter((session) => session.id !== target.id));
        if (activeSessionRef.current === target.id) {
          activeSessionRef.current = undefined;
          ++refreshVersion.current;
          setDetail(undefined);
          setEvents([]);
          setInput('');
          setSeconds(0);
          setVoiceState('idle');
          setPartialTranscript('');
        } else {
          setDetail(
            (old) =>
              old && { ...old, memory: old.memory.filter((item) => item.sourceSessionId !== target.id) },
          );
        }
      }
      setDeleteTarget(null);
    } catch (error) {
      setDeleteError(error instanceof Error ? error.message : 'Deletion failed');
    } finally {
      setDeleting(false);
    }
  }
  async function showTab(value: typeof tab) {
    setTab(value);
    if (value === 'operator') await run(async () => setOperatorQueue(await api('/operator/queue')));
    if (value === 'history') await run(async () => setSessions(await api('/sessions')));
    if (value === 'knowledge') await run(async () => setDocuments(await api('/knowledge')));
  }
  const transcript = events.filter((e) => e.type === 'transcript');
  const activity = events.filter((e) => e.type !== 'transcript');
  const retrieved = events
    .filter((e) => e.type === 'retrieval.completed')
    .flatMap((e) => (e.payload.chunks || e.payload.results || e.payload.sources || []) as RetrievedChunk[]);
  const sources = [...new Map(retrieved.map((s) => [s.chunkId, s])).values()];
  const outcome = detail?.session.outcome;
  const toolEvents = events.filter((e) => e.type === 'tool.completed');
  const durations = toolEvents.map((e) => e.durationMs || 0);
  const voiceMetrics = events.filter((e) => e.type === 'voice.metric');
  const actions = detail?.actions || [];
  const pending = detail?.confirmations.filter((c) => c.status === 'pending') || [];
  const currentMode: SessionMode = detail?.session.mode || 'rehearsal';
  const currentTimeZone = detail?.session.snapshot.business?.calendarTimeZone || 'UTC';
  const confirmations = (
    <ConfirmationCards
      confirmations={pending}
      busy={busy}
      mode={currentMode}
      timeZone={currentTimeZone}
      onResolve={(id, approve) => void resolveConfirmation(id, approve)}
    />
  );
  const repairRecords = (operator = false) =>
    detail?.repairJobs?.map((job) => (
      <RepairJobCard
        key={`${operator ? 'operator' : 'customer'}:${job.id}`}
        job={job}
        sessionId={detail.session.id}
        busy={busy}
        operator={operator && handoff?.status === 'accepted' && !finished}
        customerActions={!operator && !finished}
        timeZone={currentTimeZone}
        request={api}
        onAction={run}
        onRefresh={refreshCurrent}
      />
    ));
  const appointmentRecords = detail?.appointments?.map((appointment) => (
    <AppointmentCard
      key={`${appointment.id}:${appointment.revision}`}
      appointment={appointment}
      sessionId={detail.session.id}
      busy={busy || voiceConnected || voiceBusy}
      timeZone={currentTimeZone}
      enabled={!finished && !handoff}
      request={api}
      onAction={run}
      onRefresh={refreshCurrent}
    />
  ));

  const chosenScenario = config?.scenarios.find((s) => s.id === scenario);

  return (
    <div className="app-shell">
      <aside className="rail">
        <a href="/" className="brand-mark" aria-label="Relay home">
          <AudioLines size={25} />
        </a>
        <div className="rail-nav">
          <button
            className={tab === 'workspace' ? 'active' : ''}
            onClick={() => void showTab('workspace')}
            aria-label="Support workspace"
          >
            <Headphones size={21} />
          </button>
          <button
            className={tab === 'knowledge' ? 'active' : ''}
            onClick={() => void showTab('knowledge')}
            aria-label="Knowledge base"
          >
            <BookOpen size={21} />
          </button>
          <button
            className={tab === 'history' ? 'active' : ''}
            onClick={() => void showTab('history')}
            aria-label="Session history"
          >
            <History size={21} />
          </button>
        </div>
        <div className="rail-bottom">
          <span className="avatar small">SA</span>
        </div>
      </aside>
      <main>
        <header className="topbar">
          <div className="wordmark">
            relay<span> / </span>
            <span>Relay Workshop</span>
          </div>
          <div className="topbar-right">
            <span className="environment">
              <span className="dot" /> Local demo
            </span>
            <a href="https://github.com" hidden>
              Source
            </a>
            <span className="topbar-separator" />
            <span className="company-mark">R</span>
            <span>Appliance repair</span>
          </div>
        </header>
        <div className="page-heading">
          <div>
            <div className="eyebrow">VOICE AI · BUSINESS DEMO</div>
            <h1>
              {tab === 'demo'
                ? 'Appliance repair, with a clear next step.'
                : tab === 'operator'
                  ? 'Pick up with the full picture.'
                  : tab === 'workspace'
                    ? 'Every conversation. In context.'
                    : tab === 'knowledge'
                      ? 'Answers start with evidence.'
                      : 'A record of every resolution.'}
            </h1>
            <p>
              {tab === 'demo'
                ? 'Understand an appliance problem, book a technician, or check your repair status.'
                : tab === 'operator'
                  ? 'Review the context and continue in text. The AI pauses when a handoff is requested.'
                  : tab === 'workspace'
                    ? 'A support engineer with the right tools, and nothing to hide.'
                    : tab === 'knowledge'
                      ? 'Repair terms, guidance, and warranty information with sources you can inspect.'
                      : 'Revisit conversations, actions, sources, and the next step.'}
            </p>
          </div>
          <span className="version-chip">
            <Sparkles size={13} /> Agent workspace
          </span>
        </div>
        <nav className="tabs" aria-label="Workspace views">
          <button className={tab === 'demo' ? 'selected' : ''} onClick={() => void showTab('demo')}>
            <Sparkles size={16} /> Demo
          </button>
          <button className={tab === 'workspace' ? 'selected' : ''} onClick={() => void showTab('workspace')}>
            <Radio size={16} /> Live workspace
          </button>
          <button className={tab === 'knowledge' ? 'selected' : ''} onClick={() => void showTab('knowledge')}>
            <BookOpen size={16} /> Knowledge base <span className="count">{documents.length}</span>
          </button>
          <button className={tab === 'history' ? 'selected' : ''} onClick={() => void showTab('history')}>
            <History size={16} /> Session history
          </button>
          <button className={tab === 'operator' ? 'selected' : ''} onClick={() => void showTab('operator')}>
            <Headphones size={16} /> Operator desk
          </button>
          <span className="tabs-note">
            <ShieldCheck size={14} /> Observable actions. No hidden reasoning.
          </span>
        </nav>
        {error && (
          <div className="error-banner" role="alert">
            <CircleHelp size={18} />
            <span>{error}</span>
            {sessionId && (
              <button
                className="button outline"
                onClick={() =>
                  void run(async () => {
                    const result = await refresh(sessionId);
                    setEvents(result.events);
                  })
                }
              >
                Refresh session
              </button>
            )}
            <button aria-label="Dismiss error" onClick={() => setError('')}>
              <X size={16} />
            </button>
          </div>
        )}
        {(tab === 'demo' || tab === 'workspace') && (
          <DemoReadiness
            mode={mode}
            onMode={setMode}
            activeMode={detail && !finished ? currentMode : undefined}
            provider={voiceProvider}
            onProvider={setVoiceProvider}
            readiness={readiness}
            loading={readinessLoading}
            error={readinessError}
            busy={busy || voiceBusy || voiceConnected}
            onRefresh={() => void refreshReadiness()}
          />
        )}
        {tab === 'demo' && (
          <Presentation
            confirmations={confirmations}
            records={
              <>
                {appointmentRecords}
                {repairRecords()}
              </>
            }
            intake={
              sessionId && !finished && !handoff && detail?.session.scenarioId.startsWith('repair-') ? (
                <PhotoIntake
                  key={sessionId}
                  sessionId={sessionId}
                  busy={busy || voiceBusy}
                  enabled={!!readiness?.vision?.configured}
                  voiceConnected={voiceConnected}
                  events={events}
                  request={api}
                  onAction={run}
                  onRefresh={refreshCurrent}
                />
              ) : undefined
            }
            scenarios={config?.scenarios || []}
            scenario={scenario}
            onScenario={setScenario}
            detail={detail}
            events={events}
            busy={busy}
            ready={!!config}
            input={input}
            onInput={setInput}
            onStart={(textOnly) => void start(textOnly)}
            onSend={(text) => void send(text)}
            onEnd={() => void end()}
            voiceState={voiceState}
            voiceAvailable={!!config?.providers[voiceProvider]?.configured}
            muted={muted}
            onMute={() => {
              setMuted(!muted);
              voiceRef.current?.mute(!muted);
            }}
            onToggleVoice={() => void toggleVoice()}
            partialTranscript={partialTranscript}
            seconds={seconds}
            onHandoff={() => void handoffAction()}
            onOpenOperator={() => void showTab('operator')}
            technicalDetails={technicalDetails}
            onTechnicalDetails={() => setTechnicalDetails(!technicalDetails)}
          />
        )}
        {tab === 'operator' && (
          <OperatorPanel
            repairRecords={repairRecords(true)}
            queue={operatorQueue}
            detail={detail}
            events={events}
            busy={busy}
            onRefresh={() => void showTab('operator')}
            onOpen={(id) => void openSession(id, 'operator')}
            onAccept={() => void handoffAction(true)}
            input={operatorInput}
            onInput={setOperatorInput}
            onSend={() => void sendOperatorMessage()}
            onEnd={() => void end()}
          />
        )}
        {(tab === 'workspace' || (tab === 'demo' && technicalDetails)) && (
          <div className={tab === 'demo' ? 'technical-workspace' : undefined}>
            <section className="scenario-bar">
              <div className="scenario-select">
                <span className="scenario-symbol">
                  <Layers3 size={18} />
                </span>
                <label htmlFor="scenario">Demo scenario</label>
                <select
                  id="scenario"
                  value={scenario}
                  onChange={(e) => setScenario(e.target.value)}
                  disabled={busy}
                >
                  {config?.scenarios.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.label}
                    </option>
                  )) || <option>Loading scenarios…</option>}
                </select>
              </div>
              <div className="scenario-actions">
                <span className="policy-chip">
                  <span className="dot" />{' '}
                  {config?.providers[voiceProvider]?.configured ? 'Voice on start' : 'Text session'}
                </span>
                <button className="button outline" onClick={() => void start()} disabled={busy || !config}>
                  {sessionId ? <RotateCcw size={14} /> : <Plus size={14} />}
                  {sessionId ? 'Reset session' : 'Start session'}
                </button>
              </div>
            </section>
            <div className="workspace-grid">
              <section className="panel conversation">
                <div className="panel-heading">
                  <h2>
                    <Headphones size={16} /> Conversation
                  </h2>
                  <span className={`status-pill ${sessionId && !finished ? 'green' : ''}`}>
                    {sessionId ? (finished ? 'Completed' : 'In session') : 'Ready'}
                  </span>
                </div>
                <div className="caller">
                  <span className="avatar">AC</span>
                  <div>
                    <strong>{detail?.customer.company || 'Acme Ltd'}</strong>
                    <span>{detail?.customer.name || 'Alex Morgan'} · Technical lead</span>
                    <small>{detail?.customer.phone || '+44 20 7946 0321'}</small>
                  </div>
                  <span className="verified" title="Fictional seeded customer">
                    <ShieldCheck size={18} />
                  </span>
                </div>
                <div className="call-console">
                  <div className={`waveform ${busy ? 'speaking' : ''}`} aria-hidden="true">
                    {Array.from({ length: 39 }, (_, i) => (
                      <i
                        key={i}
                        style={{
                          height: `${8 + Math.sin(i * 1.7) ** 2 * (i > 7 && i < 32 ? 29 : 10)}px`,
                          animationDelay: `${i * 35}ms`,
                        }}
                      />
                    ))}
                  </div>
                  <div className="call-time">
                    {elapsed(seconds)}
                    <span>
                      {sessionId
                        ? finished
                          ? 'Session ended'
                          : voiceConnected
                            ? muted
                              ? 'Microphone muted'
                              : 'Voice session active'
                            : voiceBusy
                              ? 'Connecting voice…'
                              : busy
                                ? 'Agent is working'
                                : 'Text session active'
                        : 'Ready when you are'}
                    </span>
                  </div>
                  <div className="call-controls">
                    <button
                      className="round-button"
                      disabled={!voiceConnected}
                      onClick={() => {
                        setMuted(!muted);
                        voiceRef.current?.mute(!muted);
                      }}
                      aria-label={muted ? 'Unmute microphone' : 'Mute microphone'}
                    >
                      {muted ? <MicOff size={18} /> : <Mic size={18} />}
                    </button>
                    <button
                      className={`round-button ${sessionId && !finished ? 'hangup' : 'call-start'}`}
                      onClick={() => void (sessionId && !finished ? end() : start())}
                      disabled={busy || !config}
                      aria-label={sessionId && !finished ? 'End session' : 'Start call session'}
                    >
                      {sessionId && !finished ? <PhoneOff size={19} /> : <Phone size={19} />}
                    </button>
                    <span className="text-mode">
                      {voiceConnected ? <AudioLines size={14} /> : <MessageSquare size={14} />}
                      {voiceConnected
                        ? voiceProvider === 'gemini'
                          ? 'Gemini Live'
                          : 'OpenAI Realtime'
                        : 'Text mode'}
                    </span>
                  </div>
                  <div className="voice-options">
                    <label className="sr-only" htmlFor="voice-provider">
                      Voice provider
                    </label>
                    <select
                      id="voice-provider"
                      value={voiceProvider}
                      onChange={(e) => setVoiceProvider(e.target.value as 'gemini' | 'openai')}
                      disabled={voiceConnected || voiceBusy}
                    >
                      <option value="gemini">Gemini Live</option>
                      <option value="openai">OpenAI Realtime</option>
                    </select>
                    <button
                      className="button outline"
                      disabled={
                        !sessionId ||
                        finished ||
                        !!handoff ||
                        busy ||
                        !config?.providers[voiceProvider]?.configured
                      }
                      onClick={() => void toggleVoice()}
                    >
                      {voiceBusy ? <LoaderCircle size={13} className="spin" /> : <AudioLines size={13} />}
                      {voiceConnected
                        ? 'Disconnect voice'
                        : voiceState === 'error' || voiceState === 'closed'
                          ? 'Reconnect voice'
                          : 'Connect voice'}
                    </button>
                  </div>
                  {!config?.providers[voiceProvider]?.configured && (
                    <p className="voice-hint">
                      Add {voiceProvider === 'gemini' ? 'GEMINI_API_KEY' : 'OPENAI_API_KEY'} to .env to enable
                      voice.
                    </p>
                  )}
                  {voiceConnected && (
                    <button className="interrupt-button" onClick={() => voiceRef.current?.interrupt()}>
                      Stop playback
                    </button>
                  )}
                </div>
                <div className="transcript-label">
                  <span>LIVE TRANSCRIPT</span>
                  <span className="tiny-dot" />{' '}
                  {connection === 'live'
                    ? 'Connected'
                    : connection === 'reconnecting'
                      ? 'Reconnecting…'
                      : 'Waiting'}
                </div>
                <div className="transcript" aria-live="polite" aria-relevant="additions text">
                  {!transcript.length && (
                    <div className="conversation-empty">
                      <span className="assistant-orb">
                        <AudioLines size={25} />
                      </span>
                      <h3>Your support engineer is ready.</h3>
                      <p>Start a session, describe the issue, and watch the investigation unfold.</p>
                    </div>
                  )}
                  {transcript.map((e) => (
                    <div
                      key={e.id}
                      className={`transcript-turn ${e.payload.role === 'user' ? 'user-turn' : 'agent-turn'}`}
                    >
                      <div className="turn-author">
                        <span>
                          {e.payload.role === 'user'
                            ? 'YOU'
                            : e.payload.role === 'operator'
                              ? 'TEAM MEMBER'
                              : 'RELAY AGENT'}
                        </span>
                        <time>
                          {new Date(e.timestamp).toLocaleTimeString('en-GB', {
                            hour: '2-digit',
                            minute: '2-digit',
                          })}
                        </time>
                      </div>
                      <p>{textValue(e.payload.text)}</p>
                    </div>
                  ))}
                  {partialTranscript && <p className="partial-transcript">{partialTranscript}</p>}
                  {busy && sessionId && (
                    <div className="working-indicator">
                      <LoaderCircle size={14} className="spin" />{' '}
                      {voiceBusy ? 'Connecting voice…' : 'Checking the evidence…'}
                    </div>
                  )}
                  <div ref={transcriptEnd} />
                </div>
                {sessionId &&
                  !finished &&
                  transcript.filter((e) => e.payload.role === 'user').length === 0 && (
                    <button
                      className="starter-prompt"
                      onClick={() =>
                        void send(chosenScenario?.prompt || 'Please investigate our outbound calls.')
                      }
                      disabled={busy}
                    >
                      <Sparkles size={14} />
                      <span>Try: {chosenScenario?.prompt || 'Investigate outbound calls'}</span>
                      <ArrowRight size={14} />
                    </button>
                  )}
                <form
                  className="composer"
                  onSubmit={(e) => {
                    e.preventDefault();
                    void send(input);
                  }}
                >
                  <label className="sr-only" htmlFor="message">
                    Message the support agent
                  </label>
                  <textarea
                    id="message"
                    rows={2}
                    placeholder={
                      sessionId ? 'Describe the issue or ask a question…' : 'Start a session to begin…'
                    }
                    value={input}
                    onChange={(e) => setInput(e.target.value)}
                    disabled={!sessionId || finished || busy}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && !e.shiftKey) {
                        e.preventDefault();
                        void send(input);
                      }
                    }}
                  />
                  <button
                    aria-label="Send message"
                    disabled={!sessionId || finished || busy || !input.trim()}
                  >
                    <Send size={17} />
                  </button>
                </form>
                <div className="composer-note">
                  Enter to send <span>Shift + Enter for a new line</span>
                </div>
              </section>
              <section className="panel activity">
                <div className="panel-heading">
                  <h2>
                    <Activity size={16} /> Agent activity
                  </h2>
                  <span className="live-label">
                    <span className={`dot ${busy ? 'pulse' : ''}`} /> {busy ? 'Working' : 'Live trace'}
                  </span>
                </div>
                <div className="activity-caption">Every tool call, source, and action — as it happens.</div>
                <div
                  className="activity-scroll"
                  ref={activityRef}
                  onScroll={() => {
                    const node = activityRef.current;
                    if (node)
                      followActivity.current = node.scrollHeight - node.clientHeight - node.scrollTop < 80;
                  }}
                >
                  {!activity.length && (
                    <div className="trace-empty">
                      <div className="trace-illustration">
                        <div>
                          <Search size={18} />
                        </div>
                        <span />
                        <div>
                          <Wrench size={18} />
                        </div>
                        <span />
                        <div>
                          <Check size={18} />
                        </div>
                      </div>
                      <h3>Follow the investigation.</h3>
                      <p>
                        Events appear here as the agent checks your account, retrieves documentation, and
                        takes action.
                      </p>
                      <div className="trace-key">
                        <span>
                          <span className="dot" /> Tools
                        </span>
                        <span>
                          <span className="dot purple-dot" /> Knowledge
                        </span>
                        <span>
                          <span className="dot grey-dot" /> Workflow
                        </span>
                      </div>
                    </div>
                  )}
                  {activity.map((event) => (
                    <EventCard key={event.id} event={event} />
                  ))}
                  {tab === 'workspace' && confirmations}
                </div>
                <div className="trace-footer">
                  <span>
                    <span className="dot" /> {activity.length} events captured
                  </span>
                  <span>
                    Persisted locally <ShieldCheck size={12} />
                  </span>
                </div>
              </section>
              <aside className="context-column">
                <section className="panel context-panel">
                  <div className="panel-heading">
                    <h2>
                      <Layers3 size={16} /> Customer context
                    </h2>
                    <span className="small-tag">CRM</span>
                  </div>
                  <div className="context-body">
                    <div className="account-title">
                      <strong>{detail?.customer.company || 'Acme Ltd'}</strong>
                      <span className="plan">{detail?.session.snapshot.account.plan || 'Business'}</span>
                    </div>
                    <p className="account-subtitle">
                      {detail?.session.snapshot.account.id || 'Account loaded when the session starts'}
                    </p>
                    <div className="context-row">
                      <span>Product</span>
                      <b>SIP Trunking</b>
                    </div>
                    <div className="context-row">
                      <span>Account status</span>
                      <b
                        className={
                          detail?.session.snapshot.account.status === 'restricted' ? 'text-red' : 'text-green'
                        }
                      >
                        {detail?.session.snapshot.account.status || '—'}
                      </b>
                    </div>
                    <div className="context-row">
                      <span>International calling</span>
                      <b>
                        {detail
                          ? detail.session.snapshot.account.internationalEnabled
                            ? 'Enabled'
                            : 'Disabled'
                          : '—'}
                      </b>
                    </div>
                    <div className="context-row">
                      <span>UK destinations</span>
                      <b>
                        {detail ? (detail.session.snapshot.account.ukEnabled ? 'Enabled' : 'Disabled') : '—'}
                      </b>
                    </div>
                  </div>
                </section>
                <section className="panel context-panel">
                  <div className="panel-heading">
                    <h2>
                      <BookOpen size={16} /> Retrieved knowledge
                    </h2>
                    <span className="count">{sources.length}</span>
                  </div>
                  <div className="context-body sources">
                    {sources.length ? (
                      sources.map((source) => <SourceCard key={source.chunkId} source={source} technical />)
                    ) : (
                      <div className="context-empty">
                        <Search size={20} />
                        <p>
                          Relevant sources will appear here.
                          <br />
                          <span>Grounded in your documentation.</span>
                        </p>
                      </div>
                    )}
                  </div>
                </section>
                <section className="panel context-panel">
                  <div className="panel-heading">
                    <h2>
                      <Ticket size={16} /> Support case
                    </h2>
                    {detail?.tickets[0] && <span className="status-pill amber">Open</span>}
                  </div>
                  <div className="context-body">
                    {outcome ? (
                      <>
                        <div className="diagnosis-label">CURRENT DIAGNOSIS</div>
                        <h3 className="diagnosis">{outcome.diagnosis}</h3>
                        <div className="case-tags">
                          <span>{outcome.severity} severity</span>
                          <span>{outcome.resolved ? 'Resolved' : 'Follow-up needed'}</span>
                        </div>
                        {detail?.tickets.map((ticket) => (
                          <div className="ticket-link" key={ticket.id}>
                            <Ticket size={15} />
                            <strong>{ticket.id}</strong>
                            <ChevronRight size={15} />
                          </div>
                        ))}
                        <p className="next-step">
                          <span>NEXT ACTION</span>
                          {outcome.nextAction}
                        </p>
                      </>
                    ) : detail?.tickets.length ? (
                      <>
                        <p className="next-step">
                          Investigation in progress. The ticket is recorded; the structured outcome is still
                          being prepared.
                        </p>
                        {detail.tickets.map((ticket) => (
                          <div className="ticket-link" key={ticket.id}>
                            <Ticket size={15} />
                            <strong>{ticket.id}</strong>
                          </div>
                        ))}
                      </>
                    ) : (
                      <div className="context-empty">
                        <Ticket size={21} />
                        <p>
                          No case opened yet.
                          <br />
                          <span>Investigation comes first.</span>
                        </p>
                      </div>
                    )}
                  </div>
                </section>
                {!!detail?.memory.length && (
                  <section className="panel context-panel">
                    <div className="panel-heading">
                      <h2>
                        <History size={16} /> Customer memory
                      </h2>
                    </div>
                    <div className="context-body">
                      {detail.memory.slice(0, 4).map((m) => (
                        <p key={m.id} className="memory-item">
                          <span>{m.kind}</span>
                          {m.content}
                        </p>
                      ))}
                    </div>
                  </section>
                )}
              </aside>
            </div>
            <div className="metrics-strip">
              <div>
                <span className="metric-icon">
                  <Wrench size={17} />
                </span>
                <span>
                  Tools executed<strong>{toolEvents.length}</strong>
                </span>
              </div>
              <div>
                <span className="metric-icon">
                  <BookOpen size={17} />
                </span>
                <span>
                  Sources retrieved<strong>{sources.length}</strong>
                </span>
              </div>
              <div>
                <span className="metric-icon">
                  <Zap size={17} />
                </span>
                <span>
                  Mean tool duration
                  <strong>
                    {durations.length
                      ? `${Math.round(durations.reduce((a, b) => a + b, 0) / durations.length)} ms`
                      : '—'}
                  </strong>
                </span>
              </div>
              <div>
                <span className="metric-icon">
                  <ShieldCheck size={17} />
                </span>
                <span>
                  System of record<strong>PostgreSQL + pgvector</strong>
                </span>
              </div>
            </div>
            {outcome && (
              <section className="outcome-panel">
                <div className="outcome-header">
                  <div>
                    <div className="eyebrow">{finished ? 'AFTER-CALL REPORT' : 'STRUCTURED OUTCOME'}</div>
                    <h2>
                      {outcome.resolved ? 'Issue resolved.' : 'A clear diagnosis. A concrete next step.'}
                    </h2>
                  </div>
                  <button
                    className="button outline"
                    onClick={() => {
                      const blob = new Blob(
                        [
                          JSON.stringify(
                            {
                              session: detail?.session,
                              events,
                              sources,
                              tickets: detail?.tickets,
                              actions: detail?.actions,
                            },
                            null,
                            2,
                          ),
                        ],
                        { type: 'application/json' },
                      );
                      const url = URL.createObjectURL(blob);
                      const a = document.createElement('a');
                      a.href = url;
                      a.download = `relay-session-${sessionId}.json`;
                      a.click();
                      URL.revokeObjectURL(url);
                    }}
                  >
                    <ArrowDownToLine size={15} /> Export report
                  </button>
                </div>
                <div className="outcome-grid">
                  <div>
                    <small>ISSUE</small>
                    <p>{outcome.issue}</p>
                  </div>
                  <div>
                    <small>DIAGNOSIS</small>
                    <p>{outcome.diagnosis}</p>
                  </div>
                  <div>
                    <small>NEXT ACTION</small>
                    <p>{outcome.nextAction}</p>
                  </div>
                </div>
                <div className="report-details">
                  <section>
                    <h3>Actions & escalation</h3>
                    {actions.length ? (
                      actions.map((action) => (
                        <div className="report-action" key={String(action.id)}>
                          <CheckCircle2 size={14} />
                          <span>
                            <strong>{toolLabel(action.kind)}</strong>
                            <small>
                              {textValue(
                                (action.input as Record<string, unknown> | undefined)?.reason ||
                                  (action.input as Record<string, unknown> | undefined)?.requestedAt ||
                                  action.status,
                              )}
                            </small>
                          </span>
                          <span className="small-tag">Recorded locally</span>
                        </div>
                      ))
                    ) : (
                      <p>No follow-up, callback, reset or escalation recorded.</p>
                    )}
                  </section>
                  <section>
                    <h3>Voice measurements</h3>
                    {voiceMetrics.length ? (
                      voiceMetrics.map((metric) => (
                        <div className="metric-row" key={metric.id}>
                          <span>{toolLabel(metric.payload.name)}</span>
                          <b>
                            {Math.round(Number(metric.payload.value))} {textValue(metric.payload.unit)}
                          </b>
                        </div>
                      ))
                    ) : (
                      <p>No voice latency measured in this session.</p>
                    )}
                    <small>
                      First-input timing includes speech duration. Tool and retrieval timings are recorded
                      independently in the trace.
                    </small>
                  </section>
                </div>
                <details className="outcome-json">
                  <summary>
                    Inspect validated outcome <ChevronDown size={14} />
                  </summary>
                  <pre>{JSON.stringify(outcome, null, 2)}</pre>
                </details>
              </section>
            )}
          </div>
        )}
        {tab === 'knowledge' && (
          <section className="knowledge-view">
            <div className="knowledge-intro">
              <span className="assistant-orb">
                <BookOpen size={25} />
              </span>
              <div>
                <h2>Workshop knowledge you can check.</h2>
                <p>
                  Check answers against the documents. Include the appliance type or model for specific terms.
                </p>
              </div>
            </div>
            <label className="knowledge-domain-label" htmlFor="knowledge-domain">
              Knowledge domain
            </label>
            <select
              id="knowledge-domain"
              className="knowledge-domain"
              value={knowledgeDomain}
              onChange={(e) => {
                setKnowledgeDomain(e.target.value);
                setSearchResults(undefined);
              }}
            >
              <option value="repair">Appliance repair</option>
              <option value="telecom">Telecom support</option>
              <option value="general">General documents</option>
            </select>
            <form
              className="knowledge-search"
              onSubmit={(e) => {
                e.preventDefault();
                void run(async () => {
                  const result = await api<EvidenceResult | RetrievedChunk[]>(
                    '/knowledge/search',
                    post({ query: search, domain: knowledgeDomain }),
                  );
                  setSearchResults(Array.isArray(result) ? { query: search, chunks: result } : result);
                });
              }}
            >
              <Search size={19} />
              <label className="sr-only" htmlFor="kb-search">
                Search knowledge
              </label>
              <input
                id="kb-search"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Try “What is the warranty on washing machine repairs?”"
              />
              <button className="button primary" disabled={busy || !search.trim()}>
                {busy ? <LoaderCircle size={15} className="spin" /> : 'Search knowledge'}
              </button>
            </form>
            {searchResults && (
              <div className="search-results">
                <KnowledgeEvidence result={searchResults} technical />
              </div>
            )}
            <div className="upload-panel">
              <div>
                <Upload size={21} />
                <div>
                  <h3>Give your agent something new to know.</h3>
                  <p>
                    Upload PDF, Markdown, or text. Up to 5 MB / 100 PDF pages. Scanned PDFs need OCR first.
                  </p>
                </div>
              </div>
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  void uploadDocument();
                }}
              >
                <label className="file-picker">
                  <input
                    type="file"
                    accept=".pdf,.md,.markdown,.txt"
                    disabled={uploading}
                    onChange={(e) => setUploadFile(e.target.files?.[0] || null)}
                    aria-label="Choose knowledge document"
                  />
                </label>
                <label className="upload-domain">
                  Domain
                  <select
                    aria-label="Upload document domain"
                    value={uploadDomain}
                    disabled={uploading}
                    onChange={(e) => setUploadDomain(e.target.value)}
                  >
                    <option value="repair">Appliance repair</option>
                    <option value="telecom">Telecom</option>
                    <option value="general">General documents</option>
                  </select>
                </label>
                <button className="button primary" disabled={uploading || !uploadFile}>
                  {uploading ? <LoaderCircle className="spin" size={14} /> : <Upload size={14} />}
                  {uploading ? 'Indexing…' : 'Upload & index'}
                </button>
              </form>
              <details className="upload-metadata">
                <summary>Document version and applicability</summary>
                <label htmlFor="upload-metadata">Metadata JSON (optional)</label>
                <textarea
                  id="upload-metadata"
                  value={uploadMetadata}
                  onChange={(e) => setUploadMetadata(e.target.value)}
                  disabled={uploading}
                  rows={3}
                  placeholder={'{"version":"1","status":"active","effectiveFrom":"2026-09-16"}'}
                />
                <p>
                  Choose the domain above. Use version, status, effectiveFrom, effectiveTo, policyKey,
                  appliance, and models to define when the document applies. Before replacing a document,
                  delete its old version or upload the same file with status: archived. Two active versions of
                  the same policyKey may require a specialist to review them.
                </p>
              </details>
              {uploadStatus && (
                <p className="upload-status" role="status">
                  {uploadStatus}
                </p>
              )}
            </div>
            <div className="document-grid">
              {documents.map((doc) => (
                <article className="document-card" key={doc.id}>
                  <button
                    className="delete-button document-delete"
                    disabled={busy || uploading}
                    aria-label={`Delete document ${doc.title}`}
                    title="Delete document"
                    onClick={() => requestDelete({ kind: 'document', id: doc.id, title: doc.title })}
                  >
                    <Trash2 size={17} />
                  </button>
                  <span className="document-icon">
                    <FileText size={22} />
                  </span>
                  <h3>{doc.title}</h3>
                  <p>{doc.source}</p>
                  {doc.metadata && (
                    <p className="document-metadata">
                      {[
                        doc.metadata.domain,
                        doc.metadata.version ? `Version ${doc.metadata.version}` : '',
                        doc.metadata.status,
                        doc.metadata.effectiveFrom ? `from ${doc.metadata.effectiveFrom}` : '',
                      ]
                        .filter(Boolean)
                        .join(' · ')}
                    </p>
                  )}
                  <div>
                    <span>{doc.type}</span>
                    <span>
                      {doc.chunkCount} chunks <CheckCircle2 size={13} />
                    </span>
                  </div>
                </article>
              ))}
              {!documents.length && (
                <p className="empty-documents">
                  No documents yet. Upload a document to give your agent knowledge to search.
                </p>
              )}
            </div>
          </section>
        )}
        {tab === 'history' && (
          <section className="history-view">
            {!sessions.length ? (
              <div className="trace-empty">
                <History size={30} />
                <h3>Your next conversation is the first.</h3>
                <p>Completed and active sessions from this browser will be saved here.</p>
                <button className="button primary" onClick={() => void showTab('workspace')}>
                  Open workspace <ArrowRight size={14} />
                </button>
              </div>
            ) : (
              sessions.map((s) => (
                <article className="history-entry" key={s.id}>
                  <button className="history-row" disabled={busy} onClick={() => void openSession(s.id)}>
                    <span className="history-icon">
                      <MessageSquare size={20} />
                    </span>
                    <div>
                      <strong>
                        {s.outcome?.issue ||
                          config?.scenarios.find((c) => c.id === s.scenarioId)?.label ||
                          s.scenarioId}
                      </strong>
                      <p>{s.diagnosis || 'Investigation in progress'}</p>
                    </div>
                    <span className="status-pill">{s.status}</span>
                    <time>{new Date(s.createdAt).toLocaleString()}</time>
                    <ChevronRight size={18} />
                  </button>
                  <button
                    className="delete-button session-delete"
                    disabled={busy}
                    aria-label={`Delete session ${s.id.slice(0, 8)}`}
                    title="Delete session"
                    onClick={() =>
                      requestDelete({
                        kind: 'session',
                        id: s.id,
                        title: `${s.outcome?.issue || config?.scenarios.find((c) => c.id === s.scenarioId)?.label || s.scenarioId} · ${new Date(s.createdAt).toLocaleString()}`,
                      })
                    }
                  >
                    <Trash2 size={17} />
                  </button>
                </article>
              ))
            )}
          </section>
        )}
        {deleteTarget && (
          <DeleteDialog
            target={deleteTarget}
            busy={deleting}
            error={deleteError}
            onCancel={() => setDeleteTarget(null)}
            onDelete={() => void deleteItem()}
          />
        )}
        <footer className="page-footer">
          <span>
            <AudioLines size={14} /> Built to make the work visible.
          </span>
          <span>Fictional business data · Google Calendar when connected · Real retrieval</span>
        </footer>
      </main>
    </div>
  );
}
