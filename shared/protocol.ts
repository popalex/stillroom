import { z } from 'zod';

export const idSchema = z.string().uuid();
const base64 = (max: number) => z.string().min(4).max(max).regex(/^[A-Za-z0-9+/]+={0,2}$/);
export const boxSchema = z.object({ iv: z.string().length(16).regex(/^[A-Za-z0-9+/]+$/), data: base64(256) }).strict();
export const refSchema = z.object({
  id: idSchema, vaultId: idSchema, purpose: z.enum(['original', 'thumbnail', 'preview', 'catalog']),
  iv: z.string().length(16).regex(/^[A-Za-z0-9+/]+$/), key: boxSchema,
}).strict();
export const packetSchema = z.object({ v: z.literal(1), ref: refSchema, data: base64(2_000_000) }).strict();
export const envelopeSchema = z.object({
  v: z.literal(1), vaultId: idSchema,
  kdf: z.object({ algorithm: z.literal('argon2id'), salt: base64(24), memory: z.literal(67108864), ops: z.literal(3) }).strict(),
  passphrase: boxSchema, recovery: boxSchema,
}).strict();
export type Box = z.infer<typeof boxSchema>;
export type ObjectRef = z.infer<typeof refSchema>;
export type Packet = z.infer<typeof packetSchema>;
export type Envelope = z.infer<typeof envelopeSchema>;
export type Role = 'admin' | 'viewer';
export type ImageEntry = {
  id: string; name: string; category: string; added: string; mime: string;
  width: number; height: number; bytes: number;
  original: ObjectRef; thumbnail: ObjectRef; preview: ObjectRef;
};
export type Catalog = { v: 1; categories: string[]; images: ImageEntry[] };
export type Status = { registered: boolean; user: null | { id: string; label: string; role: Role; ip: string }; vaultExists: boolean };

