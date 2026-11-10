// Registry of the five production pipelines.
import type { Pipeline, ProjectKind } from './types.ts';
import { writtenPipeline } from './written.ts';
import { imagePipeline } from './image.ts';
import { audioPipeline } from './audio.ts';
import { videoPipeline } from './video.ts';
import { interactivePipeline } from './interactive.ts';

export const PIPELINES: Record<ProjectKind, Pipeline> = { written: writtenPipeline, image: imagePipeline, audio: audioPipeline, video: videoPipeline, interactive: interactivePipeline };
