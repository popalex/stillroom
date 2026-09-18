import type { ImageEntry } from '../shared/protocol';
import { encryptObject, type VaultKey } from './crypto/vault';
import { uploadObject } from './api';

const MAX_PIXELS = 40_000_000;
function dimensions(bytes: Uint8Array, mime: string): [number, number] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (
    mime === 'image/png' &&
    bytes.length >= 24 &&
    view.getUint32(0) === 0x89504e47 &&
    view.getUint32(4) === 0x0d0a1a0a
  )
    return [view.getUint32(16), view.getUint32(20)];
  if (mime === 'image/jpeg' && bytes[0] === 0xff && bytes[1] === 0xd8) {
    let offset = 2;
    while (offset + 9 < bytes.length) {
      if (bytes[offset] !== 0xff) break;
      while (bytes[offset] === 0xff) offset++;
      const marker = bytes[offset++];
      if (marker === 0xda || marker === 0xd9) break;
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
      const length = view.getUint16(offset);
      if (length < 2 || offset + length > bytes.length) break;
      if ([0xc0, 0xc1, 0xc2].includes(marker))
        return [view.getUint16(offset + 5), view.getUint16(offset + 3)];
      offset += length;
    }
  }
  if (
    mime === 'image/webp' &&
    bytes.length >= 30 &&
    view.getUint32(0) === 0x52494646 &&
    view.getUint32(8) === 0x57454250
  ) {
    const chunk = new TextDecoder().decode(bytes.subarray(12, 16));
    if (chunk === 'VP8X') {
      if (bytes[20] & 2) throw new Error('Animated WebP is not supported.');
      return [
        1 + bytes[24] + (bytes[25] << 8) + (bytes[26] << 16),
        1 + bytes[27] + (bytes[28] << 8) + (bytes[29] << 16),
      ];
    }
    if (chunk === 'VP8 ' && bytes[23] === 0x9d && bytes[24] === 1 && bytes[25] === 0x2a)
      return [view.getUint16(26, true) & 0x3fff, view.getUint16(28, true) & 0x3fff];
    if (chunk === 'VP8L' && bytes[20] === 0x2f)
      return [
        1 + bytes[21] + ((bytes[22] & 0x3f) << 8),
        1 + (bytes[22] >> 6) + (bytes[23] << 2) + ((bytes[24] & 15) << 10),
      ];
  }
  throw new Error('Use a valid JPEG, PNG, or WebP image.');
}
function checkDimensions(width: number, height: number) {
  if (width < 1 || height < 1 || width * height > MAX_PIXELS)
    throw new Error('Images must be smaller than 40 megapixels.');
}
async function renderPreview(bitmap: ImageBitmap, edge: number) {
  const ratio = Math.min(1, edge / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(bitmap.width * ratio));
  canvas.height = Math.max(1, Math.round(bitmap.height * ratio));
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('This browser cannot prepare image previews.');
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  const blob = await new Promise<Blob>((resolve, reject) =>
    canvas.toBlob(
      (b) => (b ? resolve(b) : reject(new Error('Could not create a preview.'))),
      'image/webp',
      0.85,
    ),
  );
  canvas.width = canvas.height = 1;
  return new Uint8Array(await blob.arrayBuffer());
}
export async function importImage(
  file: File,
  category: string,
  vault: VaultKey,
  signal: AbortSignal,
  progress: (text: string) => void,
): Promise<ImageEntry> {
  if (file.size > 25 * 1024 * 1024 || file.size === 0)
    throw new Error('Each image must be between 1 byte and 25 MiB.');
  if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type))
    throw new Error('Choose JPEG, PNG, or WebP images.');
  const original = new Uint8Array(await file.arrayBuffer());
  checkDimensions(...dimensions(original, file.type));
  const bitmap = await createImageBitmap(file);
  let thumbnail: Uint8Array | undefined, preview: Uint8Array | undefined;
  const width = bitmap.width,
    height = bitmap.height;
  try {
    checkDimensions(width, height);
    thumbnail = await renderPreview(bitmap, 320);
    preview = await renderPreview(bitmap, 2048);
    const refs: Partial<Record<'original' | 'thumbnail' | 'preview', ImageEntry['original']>> = {};
    for (const [purpose, bytes] of [
      ['original', original],
      ['thumbnail', thumbnail],
      ['preview', preview],
    ] as const) {
      signal.throwIfAborted();
      progress(`Encrypting ${purpose}`);
      const encrypted = await encryptObject(vault, purpose, bytes);
      signal.throwIfAborted();
      progress(`Uploading ${purpose}`);
      await uploadObject(encrypted.ref.id, encrypted.data, signal);
      refs[purpose] = encrypted.ref;
      encrypted.data.fill(0);
    }
    return {
      id: crypto.randomUUID(),
      name: file.name.slice(0, 512),
      category,
      added: new Date().toISOString(),
      mime: file.type,
      width,
      height,
      bytes: file.size,
      original: refs.original!,
      thumbnail: refs.thumbnail!,
      preview: refs.preview!,
    };
  } finally {
    bitmap.close();
    original.fill(0);
    thumbnail?.fill(0);
    preview?.fill(0);
  }
}
export { dimensions };
