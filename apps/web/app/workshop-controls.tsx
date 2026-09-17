'use client';

import { useEffect, useState } from 'react';
import { prepareVoicePhoto } from './voice-photo';
import {
  CalendarDays,
  Camera,
  CheckCircle2,
  ChevronDown,
  ClipboardList,
  LoaderCircle,
  Mic,
  RefreshCw,
  ShieldCheck,
} from 'lucide-react';
import type { AgentEvent, PendingConfirmation } from '../../../packages/core/src/domain';

export type SessionMode = 'rehearsal' | 'live';
export type Readiness = {
  database?: { ready: boolean; message?: string };
  search?: { ready: boolean; documentCount?: number; message?: string };
  providers?: Record<string, { configured: boolean }>;
  text?: { configured: boolean; provider?: string };
  calendar?: { configured: boolean; provider?: string };
  vision?: { configured: boolean; provider?: string };
};
export type WorkshopAppointment = {
  id: string;
  sessionId: string;
  serviceId: string;
  provider: 'google' | 'demo';
  eventId: string;
  htmlLink?: string;
  start: string;
  end: string;
  status: 'booked' | 'cancelled';
  revision: number;
};
export type WorkshopJob = {
  id: string;
  sessionId: string;
  customerId: string;
  appliance: string;
  model: string;
  issue: string;
  status:
    'scheduled' | 'diagnosing' | 'awaiting_approval' | 'in_progress' | 'ready' | 'completed' | 'cancelled';
  note: string;
  estimateAMD?: number;
  diagnosisCreditAMD?: number;
  readyAt?: string | null;
  appointmentId?: string;
  revision: number;
  history: { status: string; note: string; at: string; actor: string }[];
};
type Request = <T>(path: string, init?: RequestInit) => Promise<T>;
type Action = (action: () => Promise<void>) => Promise<void>;
const post = (body: unknown): RequestInit => ({ method: 'POST', body: JSON.stringify(body) });
const errorMessage = (error: unknown) =>
  error instanceof Error ? error.message : 'The action could not be completed.';
const humanize = (value: string) => value.replaceAll('_', ' ').replaceAll('-', ' ');
const formatTime = (value: string, timeZone: string) =>
  new Date(value).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short', timeZone });

export function DemoReadiness(props: {
  mode: SessionMode;
  onMode: (mode: SessionMode) => void;
  activeMode?: SessionMode;
  provider: string;
  onProvider: (value: 'gemini' | 'openai') => void;
  readiness?: Readiness;
  loading: boolean;
  error: string;
  busy: boolean;
  onRefresh: () => void;
}) {
  const [microphone, setMicrophone] = useState('Not checked');
  const [checkingMic, setCheckingMic] = useState(false);
  useEffect(() => {
    if (!navigator.mediaDevices?.getUserMedia) setMicrophone('Unavailable in this browser');
  }, []);
  async function checkMicrophone() {
    setCheckingMic(true);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      stream.getTracks().forEach((track) => track.stop());
      setMicrophone('Permission granted');
    } catch (error) {
      setMicrophone(
        error instanceof DOMException && error.name === 'NotAllowedError'
          ? 'Permission denied — use text or allow microphone access'
          : 'Microphone unavailable — text still works',
      );
    } finally {
      setCheckingMic(false);
    }
  }
  const readiness = props.readiness;
  return (
    <section className="workshop-setup" aria-label="Demo setup">
      <div className="workshop-mode-row">
        <fieldset className="workshop-mode" disabled={props.busy}>
          <legend>{props.activeMode ? 'Mode for the next session' : 'Session mode'}</legend>
          <label className={props.mode === 'rehearsal' ? 'selected' : ''}>
            <input
              type="radio"
              name="session-mode"
              checked={props.mode === 'rehearsal'}
              onChange={() => props.onMode('rehearsal')}
            />
            Rehearsal <small>Local bookings</small>
          </label>
          <label className={props.mode === 'live' ? 'selected' : ''}>
            <input
              type="radio"
              name="session-mode"
              checked={props.mode === 'live'}
              onChange={() => props.onMode('live')}
            />
            Live <small>Google Calendar</small>
          </label>
        </fieldset>
        <p>
          {props.activeMode ? (
            <>
              Current session:{' '}
              <strong>
                {props.activeMode === 'live' ? 'Live · Google Calendar' : 'Rehearsal · local bookings'}
              </strong>
              . Changing this selection applies to your next session.
            </>
          ) : props.mode === 'rehearsal' ? (
            'Practice the conversation and booking flow with local appointments. Configured AI providers can still power the conversation.'
          ) : (
            'Confirmed bookings and appointment changes use the connected Google Calendar.'
          )}
        </p>
      </div>
      <details className="workshop-readiness">
        <summary>
          <ShieldCheck size={16} /> Check demo readiness <ChevronDown size={14} />
        </summary>
        <div className="readiness-grid">
          <div>
            <strong>Knowledge search</strong>
            <span>
              {!readiness
                ? 'Not checked'
                : readiness.search?.ready
                  ? `${readiness.search.documentCount ?? ''} indexed documents ready`.trim()
                  : readiness.search?.message || 'Not ready'}
            </span>
          </div>
          <div>
            <strong>Text conversation</strong>
            <span>
              {!readiness
                ? 'Not checked'
                : readiness.text?.configured
                  ? `${readiness.text.provider || 'AI provider'} configured`
                  : 'Guided text demo available'}
            </span>
          </div>
          <div>
            <label htmlFor="setup-voice-provider">Conversation voice provider</label>
            <select
              id="setup-voice-provider"
              value={props.provider}
              disabled={props.busy}
              onChange={(event) => props.onProvider(event.target.value as 'gemini' | 'openai')}
            >
              <option value="gemini">Gemini</option>
              <option value="openai">OpenAI</option>
            </select>
            <span>
              {!readiness
                ? 'Not checked'
                : readiness.providers?.[props.provider]?.configured
                  ? 'Configured · connection checked on start'
                  : 'Not configured · text still works'}
            </span>
          </div>
          <div>
            <strong>Calendar</strong>
            <span>
              {props.mode === 'rehearsal'
                ? 'Local rehearsal appointments'
                : !readiness
                  ? 'Not checked'
                  : readiness.calendar?.configured
                    ? 'Google Calendar configured · checked when booking'
                    : 'Google Calendar not configured'}
            </span>
          </div>
          <div>
            <strong>Photo reading</strong>
            <span>
              {!readiness
                ? 'Not checked'
                : readiness.vision?.configured
                  ? 'Configured · review required before saving'
                  : 'Not configured · describe the appliance in text'}
            </span>
          </div>
          <div>
            <strong>Microphone</strong>
            <span role="status">{microphone}</span>
            <button
              type="button"
              className="button outline"
              disabled={checkingMic || props.busy}
              onClick={() => void checkMicrophone()}
            >
              {checkingMic ? <LoaderCircle size={14} className="spin" /> : <Mic size={14} />}Check microphone
            </button>
          </div>
        </div>
        {props.error && (
          <p className="workshop-inline-error" role="alert">
            {props.error}
          </p>
        )}
        <button
          type="button"
          className="button outline"
          disabled={props.loading || props.busy}
          onClick={props.onRefresh}
        >
          <RefreshCw size={14} className={props.loading ? 'spin' : ''} />
          {props.loading ? 'Checking…' : 'Refresh readiness'}
        </button>
      </details>
    </section>
  );
}

type PhotoExtraction = {
  id: string;
  appliance?: string;
  model?: string;
  errorCode?: string;
  issue?: string;
  uncertainties?: string[];
};
export function PhotoIntake(props: {
  sessionId: string;
  busy: boolean;
  enabled: boolean;
  voiceConnected: boolean;
  events: AgentEvent[];
  request: Request;
  onAction: Action;
  onRefresh: () => Promise<void>;
}) {
  const [file, setFile] = useState<File>();
  const [preview, setPreview] = useState('');
  const [extraction, setExtraction] = useState<PhotoExtraction>();
  const [reviewed, setReviewed] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState('');
  const [stage, setStage] = useState<'reading' | 'saving' | 'sending' | undefined>();
  const [sent, setSent] = useState(false);
  const disabled = props.busy || !!stage;
  useEffect(() => {
    if (extraction || file) return;
    const latest = [...props.events].reverse().find((event) => event.payload.state === 'photo-review');
    const photo = latest?.payload.photo as PhotoExtraction | undefined;
    if (photo?.id) {
      setExtraction(photo);
      setSaved(
        props.events.some(
          (event) => event.payload.state === 'photo-confirmed' && event.payload.photoId === photo.id,
        ),
      );
    }
  }, [props.events, extraction, file]);
  useEffect(() => {
    if (!file) {
      setPreview('');
      return;
    }
    const url = URL.createObjectURL(file);
    setPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);
  function selectFile(value?: File) {
    setSent(false);
    setError('');
    setExtraction(undefined);
    setReviewed(false);
    setSaved(false);
    if (
      value &&
      (!['image/jpeg', 'image/png', 'image/webp'].includes(value.type) || value.size > 5 * 1024 * 1024)
    ) {
      setError('Choose a JPEG, PNG, or WebP image smaller than 5 MB.');
      setFile(undefined);
      return;
    }
    setFile(value);
  }
  async function sendToVoice() {
    if (!file || disabled) return;
    setStage('sending');
    setError('');
    setSent(false);
    try {
      const body = new FormData();
      body.append('image', await prepareVoicePhoto(file), 'appliance.jpg');
      await props.request(`/sessions/${props.sessionId}/voice/photos`, { method: 'POST', body });
      setSent(true);
    } catch (error) {
      setError(errorMessage(error));
    } finally {
      setStage(undefined);
    }
  }
  async function analyze() {
    if (!file) return;
    await props.onAction(async () => {
      setStage('reading');
      setError('');
      setSaved(false);
      try {
        const body = new FormData();
        body.append('image', file);
        const result = await props.request<PhotoExtraction>(`/sessions/${props.sessionId}/photos`, {
          method: 'POST',
          body,
        });
        setExtraction(result);
        setReviewed(false);
      } catch (error) {
        setError(errorMessage(error));
      } finally {
        setStage(undefined);
      }
    });
  }
  async function confirm() {
    if (!extraction || !reviewed) return;
    await props.onAction(async () => {
      setStage('saving');
      setError('');
      try {
        await props.request(
          `/sessions/${props.sessionId}/photos/${extraction.id}/confirm`,
          post({
            appliance: extraction.appliance?.trim() || undefined,
            model: extraction.model?.trim() || undefined,
            errorCode: extraction.errorCode?.trim() || undefined,
            issue: extraction.issue?.trim() || undefined,
          }),
        );
        await props.onRefresh();
        setSaved(true);
      } catch (error) {
        setError(errorMessage(error));
      } finally {
        setStage(undefined);
      }
    });
  }
  return (
    <details className="photo-intake">
      <summary>
        <Camera size={16} /> Add a label or error-code photo <ChevronDown size={14} />
      </summary>
      <p>
        {props.voiceConnected
          ? 'Share a photo of your appliance, model label or error display with the agent during your call.'
          : 'Use a clear photo of the model label or display. Check and edit the extracted details before adding them to the conversation.'}
      </p>
      {!props.enabled && !props.voiceConnected && (
        <p className="workshop-muted">
          Photo reading is not configured. You can type the model and error code in the conversation.
        </p>
      )}
      {props.voiceConnected && (
        <p className="workshop-muted">
          Send the photo directly to your voice agent and keep talking. The image is not stored by the app.
        </p>
      )}
      <input
        aria-label="Appliance photo"
        type="file"
        accept="image/jpeg,image/png,image/webp"
        capture="environment"
        disabled={disabled || (!props.enabled && !props.voiceConnected)}
        onChange={(event) => selectFile(event.target.files?.[0])}
      />
      {file && props.voiceConnected && (
        <button className="button outline" disabled={disabled || sent} onClick={() => void sendToVoice()}>
          {stage === 'sending' ? <LoaderCircle size={14} className="spin" /> : <Camera size={14} />}
          {stage === 'sending' ? 'Sending photo…' : sent ? 'Photo sent' : 'Send photo to voice agent'}
        </button>
      )}
      {sent && (
        <p role="status">Photo sent to your voice agent. You can keep talking or choose another photo.</p>
      )}
      {preview && (
        <img className="photo-preview" src={preview} alt="Selected appliance label or error display" />
      )}
      {file && !extraction && !props.voiceConnected && (
        <button className="button outline" disabled={disabled} onClick={() => void analyze()}>
          {stage === 'reading' ? <LoaderCircle size={14} className="spin" /> : <Camera size={14} />}
          {stage === 'reading' ? 'Reading photo…' : 'Read photo'}
        </button>
      )}
      {error && (
        <p className="workshop-inline-error" role="alert">
          {error}
        </p>
      )}
      {extraction && !props.voiceConnected && (
        <div className="photo-review">
          <strong>Review extracted details</strong>
          {!preview && (
            <p>
              The original photo is not stored. Check these values against your appliance label or display.
            </p>
          )}
          {extraction.uncertainties?.length ? (
            <ul>
              {extraction.uncertainties.map((item, index) => (
                <li key={index}>{item}</li>
              ))}
            </ul>
          ) : (
            <p>Photo reading can make mistakes. Confirm only what you can verify.</p>
          )}
          <div className="workshop-form-grid">
            {(['appliance', 'model', 'errorCode', 'issue'] as const).map((field) => (
              <label key={field}>
                {field === 'errorCode'
                  ? 'Error code'
                  : field === 'issue'
                    ? 'Reported issue'
                    : field === 'model'
                      ? 'Model'
                      : 'Appliance'}
                {field === 'appliance' ? (
                  <select
                    value={extraction.appliance || ''}
                    disabled={disabled || saved}
                    onChange={(event) => {
                      setExtraction({ ...extraction, appliance: event.target.value });
                      setReviewed(false);
                    }}
                  >
                    <option value="">Not identified</option>
                    <option value="washing-machine">Washing machine</option>
                    <option value="dishwasher">Dishwasher</option>
                    <option value="refrigerator">Refrigerator</option>
                  </select>
                ) : (
                  <input
                    value={extraction[field] || ''}
                    disabled={disabled || saved}
                    onChange={(event) => {
                      setExtraction({ ...extraction, [field]: event.target.value });
                      setReviewed(false);
                    }}
                  />
                )}
              </label>
            ))}
          </div>
          {!saved && (
            <label className="review-checkbox">
              <input
                type="checkbox"
                checked={reviewed}
                disabled={disabled}
                onChange={(event) => setReviewed(event.target.checked)}
              />
              I checked these details against the label or display.
            </label>
          )}
          {saved ? (
            <p className="workshop-success" role="status">
              <CheckCircle2 size={16} />
              Reviewed details saved to this session.
            </p>
          ) : (
            <button
              className="button primary"
              disabled={
                disabled ||
                !reviewed ||
                ![extraction.appliance, extraction.model, extraction.errorCode, extraction.issue].some(
                  (value) => value?.trim(),
                )
              }
              onClick={() => void confirm()}
            >
              {stage === 'saving' ? 'Saving…' : 'Use reviewed details'}
            </button>
          )}
        </div>
      )}
    </details>
  );
}

export function ConfirmationCards(props: {
  confirmations: PendingConfirmation[];
  busy: boolean;
  mode: SessionMode;
  timeZone: string;
  onResolve: (id: string, approve: boolean) => void;
}) {
  return (
    <>
      {props.confirmations
        .filter((item) => item.status === 'pending')
        .map((confirmation) => {
          const input = confirmation.input;
          const booking = ['reschedule_appointment', 'cancel_appointment'].includes(confirmation.toolName);
          const quote = confirmation.toolName === 'approve_repair_quote';
          const title = quote
            ? 'Approve the repair quote?'
            : confirmation.toolName === 'cancel_appointment'
              ? 'Cancel this appointment?'
              : confirmation.toolName === 'reschedule_appointment'
                ? 'Move this appointment?'
                : 'Approve a sensitive action';
          return (
            <section className="confirmation workshop-confirmation" key={confirmation.id} aria-label={title}>
              <ShieldCheck size={20} />
              <h3>{title}</h3>
              {booking && (
                <p>
                  {props.mode === 'live'
                    ? 'This changes your Google Calendar booking after confirmation.'
                    : 'This changes your local rehearsal appointment after confirmation.'}
                </p>
              )}
              {quote && (
                <p>
                  Approving this quote authorizes the workshop to start the agreed repair. Review the current
                  estimate in the repair card.
                </p>
              )}
              {typeof input.jobId === 'string' && <p>Repair {input.jobId}</p>}
              {quote && typeof input.expectedEstimateAMD === 'number' && (
                <p>
                  Repair estimate: <strong>{input.expectedEstimateAMD.toLocaleString('en-GB')} AMD</strong>
                </p>
              )}
              {typeof input.start === 'string' && (
                <p>
                  New time: <strong>{formatTime(input.start, props.timeZone)}</strong> ({props.timeZone})
                </p>
              )}
              <small>Expires {new Date(confirmation.expiresAt).toLocaleTimeString()}</small>
              <div>
                <button
                  className="button outline"
                  disabled={props.busy}
                  onClick={() => props.onResolve(confirmation.id, false)}
                >
                  Keep unchanged
                </button>
                <button
                  className="button primary"
                  disabled={props.busy}
                  onClick={() => props.onResolve(confirmation.id, true)}
                >
                  {quote
                    ? 'Confirm quote approval'
                    : confirmation.toolName === 'cancel_appointment'
                      ? 'Confirm cancellation'
                      : 'Confirm reschedule'}
                </button>
              </div>
            </section>
          );
        })}
    </>
  );
}

export function AppointmentCard(props: {
  appointment: WorkshopAppointment;
  sessionId: string;
  busy: boolean;
  timeZone: string;
  enabled: boolean;
  request: Request;
  onAction: Action;
  onRefresh: () => Promise<void>;
}) {
  const [changing, setChanging] = useState(false);
  const [date, setDate] = useState('');
  const [slots, setSlots] = useState<{ start: string; end: string }[]>();
  const [timeZone, setTimeZone] = useState(props.timeZone);
  const [selected, setSelected] = useState('');
  const [error, setError] = useState('');
  async function loadSlots() {
    await props.onAction(async () => {
      setError('');
      setSlots(undefined);
      setSelected('');
      try {
        const result = await props.request<{ slots: { start: string; end: string }[]; timeZone: string }>(
          `/sessions/${props.sessionId}/available-slots`,
          post({ serviceId: props.appointment.serviceId, date: date || undefined }),
        );
        setSlots(result.slots);
        setTimeZone(result.timeZone);
        await props.onRefresh();
      } catch (error) {
        setError(errorMessage(error));
      }
    });
  }
  async function requestChange(action: 'cancel' | 'reschedule') {
    const slot = slots?.find((item) => item.start === selected);
    if (action === 'reschedule' && !slot) return;
    await props.onAction(async () => {
      setError('');
      try {
        await props.request(
          `/sessions/${props.sessionId}/appointment-change`,
          post({
            action,
            appointmentId: props.appointment.id,
            ...(slot && action === 'reschedule' ? slot : {}),
          }),
        );
        await props.onRefresh();
        setChanging(false);
      } catch (error) {
        setError(errorMessage(error));
      }
    });
  }
  return (
    <section className="panel workshop-record" aria-label="Current appointment">
      <div className="panel-heading">
        <h2>
          <CalendarDays size={17} />
          Appointment
        </h2>
        <span className="demo-badge">
          {props.appointment.provider === 'google' ? 'Google Calendar' : 'Local rehearsal'}
        </span>
      </div>
      <div className="workshop-record-body">
        <strong>{formatTime(props.appointment.start, props.timeZone)}</strong>
        <p>
          {props.timeZone} · {humanize(props.appointment.serviceId)}
        </p>
        <p className="workshop-status">{props.appointment.status === 'cancelled' ? 'Cancelled' : 'Booked'}</p>
        {props.enabled && props.appointment.status === 'booked' && (
          <div className="workshop-button-row">
            <button className="button outline" disabled={props.busy} onClick={() => setChanging(!changing)}>
              Reschedule appointment
            </button>
            <button
              className="button outline"
              disabled={props.busy}
              onClick={() => void requestChange('cancel')}
            >
              Cancel appointment
            </button>
          </div>
        )}
        {changing && (
          <div className="appointment-change">
            <label>
              Preferred date
              <input
                aria-label="Reschedule date"
                type="date"
                value={date}
                disabled={props.busy}
                onChange={(event) => {
                  setDate(event.target.value);
                  setSlots(undefined);
                  setSelected('');
                }}
              />
            </label>
            <button
              className="button outline"
              disabled={props.busy || !date}
              onClick={() => void loadSlots()}
            >
              Find replacement times
            </button>
            {slots && !slots.length && (
              <p role="status">No available times on this date. Choose another date.</p>
            )}
            {!!slots?.length && (
              <>
                <label>
                  Available times
                  <select
                    aria-label="Replacement appointment time"
                    value={selected}
                    disabled={props.busy}
                    onChange={(event) => setSelected(event.target.value)}
                  >
                    <option value="">Choose a time</option>
                    {slots.map((slot) => (
                      <option key={slot.start} value={slot.start}>
                        {formatTime(slot.start, timeZone)} ({timeZone})
                      </option>
                    ))}
                  </select>
                </label>
                <button
                  className="button primary"
                  disabled={props.busy || !selected}
                  onClick={() => void requestChange('reschedule')}
                >
                  Review reschedule
                </button>
              </>
            )}
          </div>
        )}
        {error && (
          <p className="workshop-inline-error" role="alert">
            {error}
          </p>
        )}
      </div>
    </section>
  );
}

const jobStatusLabels: Record<WorkshopJob['status'], string> = {
  scheduled: 'Scheduled',
  diagnosing: 'In diagnosis',
  awaiting_approval: 'Awaiting quote approval',
  in_progress: 'Repair in progress',
  ready: 'Ready for collection',
  completed: 'Completed',
  cancelled: 'Cancelled',
};
const nextStatuses: Record<WorkshopJob['status'], WorkshopJob['status'][]> = {
  scheduled: ['diagnosing'],
  diagnosing: ['awaiting_approval'],
  awaiting_approval: ['diagnosing'],
  in_progress: ['ready'],
  ready: ['completed'],
  completed: [],
  cancelled: [],
};
export function RepairJobCard(props: {
  job: WorkshopJob;
  sessionId: string;
  busy: boolean;
  operator?: boolean;
  customerActions?: boolean;
  timeZone: string;
  request: Request;
  onAction: Action;
  onRefresh: () => Promise<void>;
}) {
  const [status, setStatus] = useState<WorkshopJob['status']>('diagnosing');
  const [note, setNote] = useState('');
  const [estimate, setEstimate] = useState('');
  const [readyAtLocal, setReadyAtLocal] = useState('');
  const [error, setError] = useState('');
  const [review, setReview] = useState(false);
  useEffect(() => {
    setStatus(nextStatuses[props.job.status][0] || props.job.status);
    setReview(false);
    setEstimate(props.job.estimateAMD?.toString() || '');
  }, [props.job.status, props.job.revision, props.job.estimateAMD]);
  async function approveQuote() {
    await props.onAction(async () => {
      setError('');
      try {
        await props.request(
          `/sessions/${props.sessionId}/repair-jobs/${props.job.id}/approve`,
          post({ expectedRevision: props.job.revision }),
        );
        await props.onRefresh();
      } catch (error) {
        setError(errorMessage(error));
      }
    });
  }
  async function transition() {
    await props.onAction(async () => {
      setError('');
      try {
        await props.request(
          `/sessions/${props.sessionId}/repair-jobs/${props.job.id}/transition`,
          post({
            status,
            note: note.trim(),
            estimateAMD: status === 'awaiting_approval' ? Number(estimate) : undefined,
            readyAt: status === 'ready' && readyAtLocal ? new Date(readyAtLocal).toISOString() : undefined,
            expectedRevision: props.job.revision,
          }),
        );
        await props.onRefresh();
        setNote('');
        setReview(false);
      } catch (error) {
        setError(errorMessage(error));
        setReview(false);
      }
    });
  }
  return (
    <section className="panel workshop-record" aria-label={`Repair job ${props.job.id}`}>
      <div className="panel-heading">
        <h2>
          <ClipboardList size={17} />
          {props.job.id}
        </h2>
        <span className="status-pill">{jobStatusLabels[props.job.status]}</span>
      </div>
      <div className="workshop-record-body">
        <h3>{props.job.model || humanize(props.job.appliance)}</h3>
        <p>{props.job.issue}</p>
        <p>{props.job.note}</p>
        {props.job.estimateAMD != null && (
          <dl className="repair-estimate">
            <div>
              <dt>Repair estimate</dt>
              <dd>{props.job.estimateAMD.toLocaleString('en-GB')} AMD</dd>
            </div>
            {props.job.diagnosisCreditAMD != null && (
              <div>
                <dt>Diagnosis credit</dt>
                <dd>{props.job.diagnosisCreditAMD.toLocaleString('en-GB')} AMD</dd>
              </div>
            )}
          </dl>
        )}
        <p>
          {props.job.readyAt
            ? `Confirmed ready time: ${formatTime(props.job.readyAt, props.timeZone)} (${props.timeZone})`
            : props.job.status === 'ready'
              ? 'Ready for collection. Contact the workshop to arrange pickup.'
              : props.job.status === 'completed'
                ? 'Repair completed.'
                : 'No confirmed completion date.'}
        </p>
        {props.customerActions && props.job.status === 'awaiting_approval' && (
          <button className="button primary" disabled={props.busy} onClick={() => void approveQuote()}>
            Review quote approval
          </button>
        )}
        {props.operator && !!nextStatuses[props.job.status].length && (
          <form
            className="repair-update"
            onSubmit={(event) => {
              event.preventDefault();
              setReview(true);
            }}
          >
            <h4>Update repair progress</h4>
            <label>
              Next status
              <select
                aria-label={`Next status for ${props.job.id}`}
                value={status}
                disabled={props.busy || review}
                onChange={(event) => setStatus(event.target.value as WorkshopJob['status'])}
              >
                {nextStatuses[props.job.status].map((item) => (
                  <option key={item} value={item}>
                    {jobStatusLabels[item]}
                  </option>
                ))}
              </select>
            </label>
            {status === 'awaiting_approval' && (
              <label>
                Estimate (AMD)
                <input
                  aria-label={`Estimate for ${props.job.id}`}
                  type="number"
                  min="0"
                  step="1"
                  required
                  value={estimate}
                  disabled={props.busy || review}
                  onChange={(event) => setEstimate(event.target.value)}
                />
              </label>
            )}
            {status === 'ready' && (
              <label>
                Confirmed ready time (optional, your local time)
                <input
                  aria-label={`Confirmed ready time for ${props.job.id}`}
                  type="datetime-local"
                  value={readyAtLocal}
                  disabled={props.busy || review}
                  onChange={(event) => setReadyAtLocal(event.target.value)}
                />
                <small>{Intl.DateTimeFormat().resolvedOptions().timeZone}</small>
              </label>
            )}
            <label>
              Note for the customer
              <textarea
                aria-label={`Repair note for ${props.job.id}`}
                required
                maxLength={1000}
                rows={2}
                value={note}
                disabled={props.busy || review}
                onChange={(event) => setNote(event.target.value)}
              />
            </label>
            {!review ? (
              <button className="button outline" disabled={props.busy || !note.trim()}>
                Review update
              </button>
            ) : (
              <div className="operator-update-review">
                <p>
                  Change {props.job.id} to <strong>{jobStatusLabels[status]}</strong>
                  {status === 'awaiting_approval' ? ` with an estimate of ${estimate} AMD` : ''}. This update
                  is visible to the customer.
                </p>
                <div className="workshop-button-row">
                  <button
                    type="button"
                    className="button outline"
                    disabled={props.busy}
                    onClick={() => setReview(false)}
                  >
                    Edit update
                  </button>
                  <button
                    type="button"
                    className="button primary"
                    disabled={props.busy}
                    onClick={() => void transition()}
                  >
                    Save repair update
                  </button>
                </div>
              </div>
            )}
            {props.job.status === 'awaiting_approval' && (
              <p className="workshop-muted">Only the customer can approve the quote and start the repair.</p>
            )}
          </form>
        )}
        {error && (
          <p className="workshop-inline-error" role="alert">
            {error}
          </p>
        )}
        <details className="repair-history">
          <summary>
            Repair history <ChevronDown size={13} />
          </summary>
          <ol>
            {props.job.history.map((item, index) => (
              <li key={index}>
                <strong>{humanize(item.status)}</strong>
                <p>{item.note}</p>
                <small>
                  {formatTime(item.at, props.timeZone)} · {item.actor}
                </small>
              </li>
            ))}
          </ol>
        </details>
      </div>
    </section>
  );
}
