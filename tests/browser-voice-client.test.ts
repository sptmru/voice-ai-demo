import { afterEach, describe, expect, it, vi } from 'vitest';
import { BrowserVoiceClient } from '../apps/web/app/voice-client.js';

afterEach(() => vi.unstubAllGlobals());

describe('browser voice startup cleanup', () => {
  it('cancels pending startup and makes repeated close calls await the same shutdown', async () => {
    const stop = vi.fn();
    const stream = { getTracks: () => [track], getAudioTracks: () => [track] };
    const track = { stop, enabled: true };
    vi.stubGlobal('navigator', { mediaDevices: { getUserMedia: async () => stream } });
    vi.stubGlobal(
      'Audio',
      class {
        autoplay = false;
        pause() {}
      },
    );
    vi.stubGlobal(
      'RTCPeerConnection',
      class {
        addTrack() {}
        createDataChannel() {}
        close() {}
        async createOffer() {
          return { sdp: 'fixture-offer' };
        }
        async setLocalDescription() {}
      },
    );
    let socket: FakeSocket | undefined;
    class FakeSocket extends EventTarget {
      static OPEN = 1;
      static CONNECTING = 0;
      static CLOSING = 2;
      readyState = 1;
      onopen?: () => void;
      constructor() {
        super();
        socket = this;
        queueMicrotask(() => this.onopen?.());
      }
      send() {} // Provider never sends ready; close ack is controlled by the test.
      close() {
        this.readyState = 3;
        this.dispatchEvent(new Event('close'));
      }
    }
    vi.stubGlobal('WebSocket', FakeSocket);
    const client = new BrowserVoiceClient({ url: 'ws://local/voice', provider: 'openai', onEvent: vi.fn() });
    const startResult = client.start().then(
      () => 'resolved',
      (error: Error) => error.message,
    );
    await vi.waitFor(() => expect(socket).toBeDefined());
    const closing = client.close();
    expect(client.close()).toBe(closing);
    expect(stop).toHaveBeenCalledOnce();
    let finished = false;
    void closing.then(() => {
      finished = true;
    });
    await Promise.resolve();
    expect(finished).toBe(false);
    socket!.close();
    await closing;
    expect(await startResult).toBe('Voice connection cancelled.');
  });

  it('stops a microphone stream that arrives after the client was closed', async () => {
    let allow!: (value: unknown) => void;
    const stop = vi.fn();
    vi.stubGlobal('navigator', {
      mediaDevices: {
        getUserMedia: () =>
          new Promise((resolve) => {
            allow = resolve;
          }),
      },
    });
    const client = new BrowserVoiceClient({ url: 'ws://local/voice', provider: 'openai', onEvent: vi.fn() });
    const preparing = client.prepare();
    await client.close();
    allow({ getTracks: () => [{ stop }] });
    await preparing;
    expect(stop).toHaveBeenCalledOnce();
  });
});
