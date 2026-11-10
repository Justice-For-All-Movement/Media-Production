// Registry of the five production pipelines.
import type { Pipeline, ProjectKind } from './types.ts';
import { writtenPipeline } from './written.ts';

export const PIPELINES: Partial<Record<ProjectKind, Pipeline>> = { written: writtenPipeline };
