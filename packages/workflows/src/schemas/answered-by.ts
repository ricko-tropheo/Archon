import { z } from 'zod';

/**
 * The resolved actor an answer was authorized for, recorded as an additive audit fact
 * beside `answeredVia`/`answeredAt`. `operator` is the CLI/daemon principal, `user` is
 * an Archon user id (never a raw chat platform id), and `unidentified` is the existing
 * chat identity-lookup fallback. Nothing routes workflow behavior on it: authorization
 * has already happened before the write, and this only records who it authorized.
 */
export const answeredBySchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('operator') }),
  z.strictObject({ kind: z.literal('user'), userId: z.string().min(1) }),
  z.strictObject({ kind: z.literal('unidentified') }),
]);
export type AnsweredBy = z.infer<typeof answeredBySchema>;
