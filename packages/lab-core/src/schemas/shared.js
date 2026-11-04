import { z } from 'zod';

export const identifierSchema = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/);
export const slugSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{0,79}$/);
export const timestampSchema = z.iso.datetime();
export const generationSchema = z.int().positive();
export const revisionSchema = z.int().nonnegative();
export const portSchema = z.int().min(1024).max(65535);
export const sourceSchema = z.enum(['simulator', 'docker', 'process', 'probe', 'emulator']);
export const sessionStatusSchema = z.enum([
  'initializing', 'active', 'resetting', 'degraded', 'ending', 'ended',
]);
export const operationErrorSchema = z.strictObject({
  code: z.string().regex(/^[A-Z][A-Z0-9_]{0,79}$/),
  message: z.string().min(1).max(2000),
  retryable: z.boolean(),
});
