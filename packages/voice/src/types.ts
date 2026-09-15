import type { ToolExecutionResult } from '../../core/src/executor.js';

export type VoiceProviderId = 'gemini' | 'openai';
export type VoiceEvent =
  | { type: 'state'; state: 'connecting' | 'ready' | 'closed'; provider: VoiceProviderId; message?: string }
  | { type: 'audio'; base64: string; sampleRate: number }
  | { type: 'transcript'; role: 'user' | 'assistant'; text: string; final: boolean; itemId: string }
  | { type: 'toolCall'; id: string; name: string; input: unknown }
  | { type: 'toolCancelled'; ids: string[] }
  | { type: 'turn'; phase: 'started' | 'completed' }
  | { type: 'interrupted'; source: 'provider' | 'local' }
  | { type: 'metric'; name: string; value: number; unit: 'ms' | 'count' }
  | { type: 'error'; message: string };

export interface VoiceTool {
  name: string;
  description: string;
  jsonSchema: Record<string, unknown>;
}
export interface VoiceSessionConfig {
  instructions: string;
  tools: VoiceTool[];
  /** Register before connecting so setup/error events cannot race subscriptions. */
  onEvent(event: VoiceEvent): void;
  /** OpenAI WebRTC extension; ignored by a PCM WebSocket provider. */
  sdpOffer?: string;
}
export interface RealtimeVoiceSession {
  readonly capabilities: {
    transport: 'websocket-pcm' | 'webrtc-sideband';
    inputSampleRate?: number;
    outputSampleRate?: number;
    resumption: boolean;
  };
  readonly sdpAnswer?: string;
  sendAudio(base64: string, sampleRate: number): Promise<void>;
  sendText(text: string): Promise<void>;
  sendToolResult(result: ToolExecutionResult): Promise<void>;
  interrupt(): Promise<void>;
  close(): Promise<void>;
}
export interface RealtimeVoiceProvider {
  connect(config: VoiceSessionConfig): Promise<RealtimeVoiceSession>;
}

/** Transport test seam; ws and protocol event types stay inside this package. */
export interface ProviderSocket {
  readonly readyState: number;
  readonly bufferedAmount: number;
  on(event: string, listener: (...args: any[]) => void): unknown;
  send(data: string, callback?: (error?: Error) => void): void;
  close(code?: number, reason?: string): void;
  terminate?(): void;
}
export type SocketFactory = (
  url: string,
  options?: { headers?: Record<string, string>; maxPayload?: number },
) => ProviderSocket;
