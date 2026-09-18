export class ApiError extends Error { constructor(public status: number, message: string) { super(message); } }
export async function api<T>(path: string, method = 'GET', body?: unknown, signal?: AbortSignal): Promise<T> {
  const result = await fetch(`/api${path}`, {
    method, credentials: 'same-origin', cache: 'no-store', signal,
    headers: { 'x-vault-request': '1', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!result.ok) {
    const error = await result.json().catch(() => ({}));
    throw new ApiError(result.status, error.error || 'The request failed.');
  }
  return result.json() as Promise<T>;
}
export async function uploadObject(id: string, data: Uint8Array, signal: AbortSignal) {
  const response = await fetch(`/api/objects/${id}`, { method: 'PUT', credentials: 'same-origin', signal,
    headers: { 'Content-Type': 'application/octet-stream', 'x-vault-request': '1' }, body: new Uint8Array(data) });
  if (!response.ok) throw new ApiError(response.status, (await response.json()).error || 'Upload failed.');
}
export async function fetchObject(id: string, signal: AbortSignal) {
  const response = await fetch(`/api/objects/${id}`, { credentials: 'same-origin', cache: 'no-store', signal });
  if (!response.ok) throw new ApiError(response.status, 'Could not load this image. Sign in again if your session expired.');
  return new Uint8Array(await response.arrayBuffer());
}
