import type { ObjectRef } from '../shared/protocol';
import { fetchObject } from './api';
import { decryptObject, type VaultKey } from './crypto/vault';

export type Preview = { url: string; image: HTMLImageElement };
type Entry = {
  controller: AbortController;
  promise: Promise<Preview>;
  ready?: Preview;
};

// Chrome loads an <img> src in a later task, even after the element is removed.
// Revoking at once makes that load fail with ERR_FILE_NOT_FOUND.
const revokeLater = (url: string) => setTimeout(() => URL.revokeObjectURL(url), 1000);

// Decrypted viewing previews for the open viewer and its neighbours, kept as blob
// URLs with an Image that has already been decoded. Plaintext lives here only
// while the viewer is open: Gallery empties the cache when the viewer closes and
// when the vault locks.
export class PreviewCache {
  private entries = new Map<string, Entry>();
  // The preview the viewer last put on screen, so the next image can show it
  // dimmed while it loads instead of an empty frame.
  shown = '';
  constructor(private vault: VaultKey) {}

  peek(id: string) {
    return this.entries.get(id)?.ready;
  }

  load(ref: ObjectRef, priority: RequestPriority): Promise<Preview> {
    const existing = this.entries.get(ref.id);
    if (existing) return existing.promise;
    const entry = { controller: new AbortController() } as Entry;
    entry.promise = this.fetch(ref, priority, entry);
    this.entries.set(ref.id, entry);
    return entry.promise;
  }

  private async fetch(ref: ObjectRef, priority: RequestPriority, entry: Entry) {
    const { signal } = entry.controller;
    let url = '';
    try {
      const data = await fetchObject(ref.id, signal, priority);
      const plain = await decryptObject(this.vault, ref, data);
      signal.throwIfAborted();
      url = URL.createObjectURL(new Blob([plain], { type: 'image/webp' }));
      plain.fill(0);
      const image = new Image();
      image.src = url;
      // Decoding a 2048-pixel WebP takes long enough on a phone to show as a
      // stall, so it happens here, before the viewer asks for the image.
      await image.decode();
      signal.throwIfAborted();
      return (entry.ready = { url, image });
    } catch (e) {
      if (url) revokeLater(url);
      // A failed or evicted entry goes, so the next visit tries again.
      if (this.entries.get(ref.id) === entry) this.entries.delete(ref.id);
      throw e;
    }
  }

  // Drops every entry not in `ids`, cancelling the ones still loading.
  keep(ids: Set<string>) {
    for (const [id, entry] of this.entries) if (!ids.has(id)) this.evict(id, entry);
  }

  clear() {
    for (const [id, entry] of this.entries) this.evict(id, entry);
    this.shown = '';
  }

  private evict(id: string, entry: Entry) {
    this.entries.delete(id);
    entry.controller.abort();
    if (entry.ready) {
      entry.ready.image.removeAttribute('src');
      revokeLater(entry.ready.url);
    }
  }
}

// Offsets from the open image to prefetch, nearest first. The side the person is
// moving towards gets one more, and wins ties.
export function neighbours(direction: 1 | -1) {
  return [direction, -direction, 2 * direction, -2 * direction, 3 * direction];
}
