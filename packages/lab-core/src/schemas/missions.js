import { z } from 'zod';
import {
  generationSchema, revisionSchema, slugSchema,
  sourceSchema, timestampSchema,
} from './shared.js';
import { operationTypeSchema } from './operations.js';

export const PREDICATE_IDS = Object.freeze([
  'evidence.logs-read', 'service.running', 'service.health-verified',
  'service.expected-port', 'service.version-verified',
]);

const objectiveDefinitionSchema = z.strictObject({
  id: slugSchema,
  label: z.string().min(1).max(160),
  predicateId: z.enum(PREDICATE_IDS),
  required: z.boolean(),
});

const guidanceSchema = z.array(z.string().min(1).max(400)).min(1);

export const labManifestSchema = z.strictObject({
  schemaVersion: z.literal(1),
  id: slugSchema,
  kind: z.enum(['mission', 'exploration']).optional(),
  title: z.string().min(1).max(120),
  description: z.string().min(1).max(1000),
  difficulty: z.enum(['beginner', 'intermediate']),
  estimatedMinutes: z.int().min(1).max(120),
  supportedModes: z.array(z.enum(['demo', 'local'])).min(1).max(2)
    .refine((items) => new Set(items).size === items.length, 'Duplicate execution mode.'),
  fixtureId: slugSchema,
  fixtureOptions: z.array(slugSchema).min(1).max(8).optional(),
  allowedOperations: z.array(operationTypeSchema).min(1).max(12)
    .refine((items) => new Set(items).size === items.length, 'Duplicate operation type.'),
  objectives: z.array(objectiveDefinitionSchema).max(20)
    .refine((items) => new Set(items.map((item) => item.id)).size === items.length,
      'Duplicate objective ID.'),
  hints: guidanceSchema.max(5).optional(),
  solution: guidanceSchema.max(10).optional(),
}).superRefine((lab, context) => {
  const exploration = lab.kind === 'exploration';
  if (!exploration && lab.objectives.length === 0) {
    context.addIssue({ code: 'custom', message: 'Missions require at least one objective.' });
  }
  if (exploration && lab.objectives.length > 0) {
    context.addIssue({ code: 'custom', message: 'Free exploration has no objectives.' });
  }
  if (lab.fixtureOptions && !lab.fixtureOptions.includes(lab.fixtureId)) {
    context.addIssue({ code: 'custom', message: 'The default fixture must be one of the fixture options.' });
  }
});

export const objectiveEvidenceSchema = z.strictObject({
  eventId: z.string().min(1).max(512),
  generation: generationSchema,
  revision: revisionSchema,
  source: sourceSchema,
  observedAt: timestampSchema,
  explanation: z.string().min(1).max(1000),
});

export const missionCompletionSchema = z.strictObject({
  eventId: z.string().min(1).max(512),
  generation: generationSchema,
  revision: revisionSchema,
  completedAt: timestampSchema,
});

export const missionProgressSchema = z.strictObject({
  id: slugSchema,
  status: z.enum(['not-started', 'in-progress', 'completed']),
  objectives: z.array(z.strictObject({
    id: slugSchema,
    status: z.enum(['pending', 'satisfied', 'invalidated']),
    evidence: objectiveEvidenceSchema.nullable(),
  })).max(20).refine((items) => new Set(items.map((item) => item.id)).size === items.length,
    'Duplicate objective progress ID.'),
  completion: missionCompletionSchema.nullable(),
}).superRefine((mission, context) => {
  for (const objective of mission.objectives) {
    if (objective.status === 'satisfied' && objective.evidence === null) {
      context.addIssue({ code: 'custom', message: 'Satisfied objectives require evidence.' });
    }
  }
  if ((mission.status === 'completed') !== (mission.completion !== null)) {
    context.addIssue({ code: 'custom', message: 'Completed missions require exactly one completion record.' });
  }
});
