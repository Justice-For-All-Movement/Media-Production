// Registry of the five production pipelines.
import type { Pipeline, ProjectKind } from './types.ts';
import { writtenPipeline } from './written.ts';
import { imagePipeline } from './image.ts';
import { audioPipeline } from './audio.ts';

export const PIPELINES: Partial<Record<ProjectKind, Pipeline>> = { written: writtenPipeline, image: imagePipeline, audio: audioPipeline };
