import { describe, expect, it, vi } from 'vitest';
import { ApiError, uploadObject } from '../../src/api';

const ok = () => new Response(null, { status: 201 });
const busy = () =>
  new Response(JSON.stringify({ error: 'Wait for the current uploads to finish.' }), {
    status: 429,
    headers: { 'content-type': 'application/json' },
  });

describe('object upload', () => {
  it('waits and retries when the server is at its upload limit', async () => {
    const responses = [busy(), busy(), ok()];
    const fetchMock = vi.fn(async () => responses.shift()!);
    vi.stubGlobal('fetch', fetchMock);
    const waits: number[] = [];
    await uploadObject('a'.repeat(8), new Uint8Array([1]), new AbortController().signal, (ms) => {
      waits.push(ms);
      return Promise.resolve();
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(waits).toEqual([400, 800]);
    vi.unstubAllGlobals();
  });
  it('gives up with the server message after the last attempt', async () => {
    const fetchMock = vi.fn(async () => busy());
    vi.stubGlobal('fetch', fetchMock);
    await expect(
      uploadObject('a'.repeat(8), new Uint8Array([1]), new AbortController().signal, () =>
        Promise.resolve(),
      ),
    ).rejects.toThrow('Wait for the current uploads to finish.');
    expect(fetchMock).toHaveBeenCalledTimes(4);
    vi.unstubAllGlobals();
  });
  it('does not retry other failures', async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ error: 'Image exceeds the upload limit.' }), {
          status: 413,
          headers: { 'content-type': 'application/json' },
        }),
    );
    vi.stubGlobal('fetch', fetchMock);
    await expect(
      uploadObject('a'.repeat(8), new Uint8Array([1]), new AbortController().signal, () =>
        Promise.resolve(),
      ),
    ).rejects.toMatchObject({ status: 413 } satisfies Partial<ApiError>);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    vi.unstubAllGlobals();
  });
  it('stops retrying once the batch is aborted', async () => {
    const fetchMock = vi.fn(async () => busy());
    vi.stubGlobal('fetch', fetchMock);
    const controller = new AbortController();
    await expect(
      uploadObject('a'.repeat(8), new Uint8Array([1]), controller.signal, () => {
        controller.abort();
        return Promise.resolve();
      }),
    ).rejects.toThrow();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    vi.unstubAllGlobals();
  });
});
