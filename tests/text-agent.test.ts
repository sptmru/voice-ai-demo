import { describe, it, expect, vi } from 'vitest';
import {
  createTextAgent,
  modelConfig,
  modelRequest,
  type TextTurn,
} from '../packages/core/src/text-agent.js';
import { extractRepairPhoto, imageMime } from '../packages/core/src/photo.js';
import { createTools } from '../packages/core/src/tools.js';
import { scenarioSnapshot } from '../packages/db/src/fixtures.js';
const config = { provider: 'openai' as const, apiKey: 'test-secret', model: 'test-model' };
const json = (data: unknown) =>
  new Response(JSON.stringify(data), { status: 200, headers: { 'content-type': 'application/json' } });
const message = (text: string) => ({
  output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] }],
});
const turn = (): TextTurn => ({
  session: {
    id: 's',
    customerId: 'c',
    scenarioId: 'repair-advice',
    mode: 'rehearsal',
    status: 'active',
    createdAt: new Date().toISOString(),
    endedAt: null,
    outcome: null,
    diagnosis: null,
    snapshot: scenarioSnapshot('repair-advice'),
  },
  events: [
    {
      id: 1,
      sessionId: 's',
      type: 'transcript',
      timestamp: new Date().toISOString(),
      correlationId: 'x',
      payload: { role: 'user', text: 'What warranty do you offer?', final: true },
    },
  ],
  tools: createTools(),
  execute: vi.fn(async (call) => ({
    id: call.id,
    name: call.name,
    status: 'completed' as const,
    result: {
      status: 'supported',
      chunks: [{ document: 'Warranty', section: 'Repairs', content: '90 days' }],
    },
  })),
  emit: vi.fn(async () => ({}) as any),
});

describe('conversational text provider contracts', () => {
  it('uses no credentials in fully local mode and reports missing explicit providers', () => {
    expect(modelConfig('text', { TEXT_PROVIDER: 'deterministic', OPENAI_API_KEY: 'real' })).toBeUndefined();
    expect(modelConfig('vision', { VISION_PROVIDER: 'off', GEMINI_API_KEY: 'real' })).toBeUndefined();
    expect(modelConfig('text', { TEXT_PROVIDER: 'openai', GEMINI_API_KEY: 'real' })).toBeUndefined();
    expect(modelConfig('text', { GEMINI_API_KEY: 'test' })).toMatchObject({ provider: 'gemini' });
  });
  it('round-trips tool results, retains history, disables storage and restricts tools', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        json({
          output: [
            {
              type: 'function_call',
              call_id: 'call_1',
              name: 'search_knowledge_base',
              arguments: '{"query":"repair warranty","limit":3}',
            },
          ],
        }),
      )
      .mockResolvedValueOnce(json(message('Repairs have a 90-day warranty. Sources: Warranty — Repairs.')));
    const context = turn();
    const answer = await createTextAgent(config, fetcher)!.respond(context);
    expect(answer).toContain('90-day');
    expect(context.execute).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        name: 'search_knowledge_base',
        input: { query: 'repair warranty', limit: 3 },
      }),
    );
    const body = JSON.parse(fetcher.mock.calls[1][1]!.body as string);
    expect(body.store).toBe(false);
    expect(body.tools.some((t: any) => t.name === 'reset_trunk_credentials')).toBe(false);
    expect(body.input).toContainEqual(
      expect.objectContaining({
        type: 'function_call_output',
        call_id: 'call_1',
        output: expect.stringContaining('90 days'),
      }),
    );
    expect(body.instructions).toContain('rehearsal');
  });
  it('does not execute hallucinated tool names and never treats malformed args as commands', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        json({
          output: [{ type: 'function_call', call_id: 'c', name: 'reset_trunk_credentials', arguments: '{}' }],
        }),
      )
      .mockResolvedValueOnce(json(message('Please use the repair tools.')));
    const context = turn();
    await createTextAgent(config, fetcher)!.respond(context);
    expect(context.execute).not.toHaveBeenCalled();
    expect(JSON.parse(fetcher.mock.calls[1][1]!.body as string).input.at(-1).output).toContain('failed');
  });
  it('stops subsequent provider calls on human handoff', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(
      json({
        output: [
          {
            type: 'function_call',
            call_id: 'h',
            name: 'request_human_handoff',
            arguments: '{"reason":"customer request"}',
          },
          { type: 'function_call', call_id: 'b', name: 'book_appointment', arguments: '{}' },
        ],
      }),
    );
    const context = turn();
    expect(await createTextAgent(config, fetcher)!.respond(context)).toContain('operator queue');
    expect(context.execute).toHaveBeenCalledTimes(1);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('preserves Gemini thought signatures for tool followup but never surfaces private thought text', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        json({
          candidates: [
            {
              content: {
                parts: [
                  { functionCall: { name: 'get_repair_catalog', args: {} }, thoughtSignature: 'opaque' },
                ],
              },
            },
          ],
        }),
      )
      .mockResolvedValueOnce(
        json({
          candidates: [
            {
              content: {
                parts: [{ thought: true, text: 'private' }, { text: 'Workshop diagnosis costs 5000 AMD.' }],
              },
            },
          ],
        }),
      );
    const answer = await createTextAgent({ ...config, provider: 'gemini' }, fetcher)!.respond(turn());
    expect(answer).not.toContain('private');
    const body = JSON.parse(fetcher.mock.calls[1][1]!.body as string);
    expect(body.contents.at(-2).parts[0].thoughtSignature).toBe('opaque');
    expect(body.contents.at(-1).parts[0].functionResponse.name).toBe('get_repair_catalog');
  });
  it('bounds tool loops and redacts provider error bodies', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () =>
      json({
        output: [{ type: 'function_call', call_id: 'r', name: 'get_repair_catalog', arguments: '{}' }],
      }),
    );
    await expect(createTextAgent(config, fetcher)!.respond(turn())).rejects.toThrow('step limit');
    expect(fetcher).toHaveBeenCalledTimes(8);
    await expect(
      modelRequest(config, {}, vi.fn().mockResolvedValue(new Response('test-secret', { status: 401 }))),
    ).rejects.toThrow('HTTP 401');
  });
});

describe('appliance photo extraction', () => {
  const png = () => {
    const b = Buffer.alloc(30);
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(b);
    b.writeUInt32BE(20, 16);
    b.writeUInt32BE(20, 20);
    return b;
  };
  it('validates bytes rather than trusting filenames and rejects excessive pixel size', () => {
    expect(() => imageMime(Buffer.from('<svg>not a raster image</svg>'))).toThrow('PNG');
    const b = png();
    b.writeUInt32BE(100000, 16);
    expect(() => imageMime(b)).toThrow('dimensions');
  });
  it('returns only reviewable fields with uncertainty and never accepts unknown output keys', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      json(
        message(
          JSON.stringify({
            model: 'W100',
            errorCode: 'E21',
            uncertainties: ['Appliance type is not visible.'],
          }),
        ),
      ),
    );
    expect(await extractRepairPhoto(png(), config, fetcher)).toEqual({
      model: 'W100',
      errorCode: 'E21',
      uncertainties: ['Appliance type is not visible.'],
    });
    const body = JSON.parse(fetcher.mock.calls[0][1]!.body as string);
    expect(body.input[0].content[1].image_url).toMatch(/^data:image\/png;base64,/);
    expect(body.store).toBe(false);
    fetcher.mockResolvedValueOnce(json(message('{"model":"W100","command":"book now","uncertainties":[]}')));
    await expect(extractRepairPhoto(png(), config, fetcher)).rejects.toThrow('reliably');
  });
});
