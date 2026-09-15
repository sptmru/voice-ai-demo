export type VoiceUiEvent = { type: string; [key: string]: unknown };
export type VoiceClientOptions = {
  url: string;
  provider: 'gemini' | 'openai';
  onEvent: (event: VoiceUiEvent) => void;
};

function toBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/** Browser audio lifecycle is isolated from tool execution and business state. */
export class BrowserVoiceClient {
  private socket?: WebSocket;
  private stream?: MediaStream;
  private capture?: AudioContext;
  private output?: AudioContext;
  private worklet?: AudioWorkletNode;
  private source?: MediaStreamAudioSourceNode;
  private gain?: GainNode;
  private playback = new Set<AudioBufferSourceNode>();
  private playAt = 0;
  private peer?: RTCPeerConnection;
  private remoteAudio?: HTMLAudioElement;
  private muted = false;
  private closed = false;
  private ready = false;
  private startTimer?: ReturnType<typeof setTimeout>;
  constructor(private options: VoiceClientOptions) {}

  async start(): Promise<void> {
    try {
      if (!navigator.mediaDevices?.getUserMedia)
        throw new Error('Microphone access requires localhost or HTTPS and a compatible browser.');
      this.options.onEvent({ type: 'state', state: 'requesting-microphone' });
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
      if (this.closed) {
        this.stream.getTracks().forEach((track) => track.stop());
        return;
      }
      this.stream.getAudioTracks().forEach((track) => {
        track.enabled = false;
      });
      this.options.onEvent({ type: 'state', state: 'connecting' });
      let sdpOffer: string | undefined;
      if (this.options.provider === 'openai') {
        this.peer = new RTCPeerConnection();
        this.remoteAudio = new Audio();
        this.remoteAudio.autoplay = true;
        this.peer.ontrack = (event) => {
          if (this.remoteAudio) {
            this.remoteAudio.srcObject = event.streams[0];
            void this.remoteAudio.play().catch(() =>
              this.options.onEvent({
                type: 'error',
                message: 'Browser blocked audio playback. Reconnect after interacting with the page.',
              }),
            );
          }
        };
        this.peer.onconnectionstatechange = () => {
          if (this.peer?.connectionState === 'failed' || this.peer?.connectionState === 'disconnected') {
            this.options.onEvent({
              type: 'error',
              message: 'WebRTC media disconnected. Reconnect to continue.',
            });
            void this.close();
          }
        };
        for (const track of this.stream.getTracks()) this.peer.addTrack(track, this.stream);
        // Provider data channel needed for Realtime; business tools only use server sideband.
        this.peer.createDataChannel('oai-events');
        const offer = await this.peer.createOffer();
        await this.peer.setLocalDescription(offer);
        sdpOffer = offer.sdp;
      } else {
        this.output = new AudioContext({ sampleRate: 24000 });
        await this.output.resume();
        this.capture = new AudioContext({ sampleRate: 16000 });
        await this.capture.audioWorklet.addModule('/audio-capture.js');
        if (this.closed) return;
        this.source = this.capture.createMediaStreamSource(this.stream);
        this.worklet = new AudioWorkletNode(this.capture, 'relay-capture', {
          processorOptions: { sampleRate: 16000 },
        });
        // Keep the worklet graph running with zero gain to prevent mic monitoring/echo.
        this.gain = this.capture.createGain();
        this.gain.gain.value = 0;
        this.source.connect(this.worklet).connect(this.gain).connect(this.capture.destination);
        this.worklet.port.onmessage = (event) => {
          if (!this.ready || this.muted || this.socket?.readyState !== WebSocket.OPEN) return;
          if (this.socket.bufferedAmount > 256000) {
            this.options.onEvent({
              type: 'error',
              message: 'Audio connection is too slow. Reconnect to continue.',
            });
            void this.close();
            return;
          }
          this.socket.send(
            JSON.stringify({ type: 'audio', data: toBase64(event.data as ArrayBuffer), sampleRate: 16000 }),
          );
        };
        await this.capture.resume();
      }
      if (this.closed) return;
      await new Promise<void>((resolve, reject) => {
        const socket = new WebSocket(this.options.url);
        this.socket = socket;
        let settled = false;
        const fail = (message: string) => {
          if (!settled) {
            settled = true;
            reject(new Error(message));
          } else this.options.onEvent({ type: 'error', message });
        };
        this.startTimer = setTimeout(() => {
          fail('Voice connection timed out. Check the provider key and model access.');
          void this.close();
        }, 25000);
        socket.onopen = () =>
          socket.send(
            JSON.stringify({
              type: 'start',
              provider: this.options.provider,
              ...(sdpOffer ? { sdpOffer } : {}),
            }),
          );
        socket.onerror = () => fail('Unable to open the voice connection.');
        socket.onclose = () => {
          if (!this.closed) {
            fail('Voice connection closed. Use Reconnect to start a new provider connection.');
            void this.close();
          }
        };
        socket.onmessage = (message) => {
          const event = JSON.parse(String(message.data)) as VoiceUiEvent;
          if (event.type === 'ready') {
            void (async () => {
              if (typeof event.sdpAnswer === 'string' && this.peer)
                await this.peer.setRemoteDescription({ type: 'answer', sdp: event.sdpAnswer });
              this.ready = true;
              this.stream?.getAudioTracks().forEach((track) => {
                track.enabled = !this.muted;
              });
              clearTimeout(this.startTimer);
              this.options.onEvent({ type: 'state', state: 'connected' });
              if (!settled) {
                settled = true;
                resolve();
              }
            })().catch((error) => {
              fail(error.message);
              void this.close();
            });
          } else if (event.type === 'audio' && typeof event.base64 === 'string')
            this.play(event.base64, Number(event.sampleRate) || 24000);
          else if (event.type === 'interrupted') this.clearPlayback();
          else if (event.type === 'error') {
            fail(String(event.message || 'Provider error'));
            if (!this.ready) void this.close();
          }
          this.options.onEvent(event);
        };
      });
    } catch (error) {
      await this.close();
      throw error;
    }
  }
  private play(data: string, sampleRate: number) {
    const context = this.output;
    if (!context || this.closed) return;
    const binary = atob(data);
    if (binary.length % 2) return;
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    const view = new DataView(bytes.buffer);
    const buffer = context.createBuffer(1, bytes.length / 2, sampleRate);
    const floats = buffer.getChannelData(0);
    for (let i = 0; i < floats.length; i++) floats[i] = view.getInt16(i * 2, true) / 32768;
    // Native-audio providers may generate faster than playback. A normal spoken
    // answer can exceed eight seconds; cap queued audio at a bounded minute.
    if (this.playAt - context.currentTime > 60) {
      this.clearPlayback();
      this.options.onEvent({
        type: 'error',
        message: 'Audio exceeded the one-minute playback buffer; the queue was cleared.',
      });
    }
    const node = context.createBufferSource();
    node.buffer = buffer;
    node.connect(context.destination);
    this.playAt = Math.max(this.playAt, context.currentTime + 0.015);
    node.start(this.playAt);
    this.playAt += buffer.duration;
    this.playback.add(node);
    node.onended = () => {
      this.playback.delete(node);
      node.disconnect();
    };
  }
  private clearPlayback() {
    for (const source of this.playback) {
      try {
        source.stop();
      } catch {
        /* already ended */
      }
    }
    this.playback.clear();
    this.playAt = 0;
  }
  mute(muted: boolean) {
    this.muted = muted;
    this.worklet?.port.postMessage({ muted });
    this.stream?.getAudioTracks().forEach((track) => {
      track.enabled = this.ready && !muted;
    });
  }
  interrupt() {
    this.clearPlayback();
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify({ type: 'interrupt' }));
  }
  sendText(text: string) {
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify({ type: 'text', text }));
  }
  async close() {
    if (this.closed) return;
    this.closed = true;
    this.ready = false;
    clearTimeout(this.startTimer);
    this.clearPlayback();
    this.worklet?.disconnect();
    this.source?.disconnect();
    this.gain?.disconnect();
    this.stream?.getTracks().forEach((track) => track.stop());
    this.peer?.close();
    if (this.remoteAudio) {
      this.remoteAudio.pause();
      this.remoteAudio.srcObject = null;
    }
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify({ type: 'stop' }));
    const socketClosed =
      this.socket && this.socket.readyState < WebSocket.CLOSING
        ? new Promise<void>((resolve) => {
            const timeout = setTimeout(resolve, 6000);
            this.socket!.addEventListener(
              'close',
              () => {
                clearTimeout(timeout);
                resolve();
              },
              { once: true },
            );
            // The server closes after settling already-started tools and releasing the session.
            if (this.socket!.readyState === WebSocket.CONNECTING) this.socket!.close();
          })
        : Promise.resolve();
    await Promise.all([
      this.capture?.state !== 'closed' ? this.capture?.close() : undefined,
      this.output?.state !== 'closed' ? this.output?.close() : undefined,
    ]);
    await socketClosed;
    this.socket?.close();
    this.options.onEvent({ type: 'state', state: 'closed' });
  }
}
