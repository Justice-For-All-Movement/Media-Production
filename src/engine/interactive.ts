import { DomainError } from '../contracts.ts';
import type { Doc } from './types.ts';
export async function buildInteractivePreview(_doc: Doc, _asset: (assetId: string, version?: number) => Promise<{ bytes: Uint8Array; mediaType: string; filename: string; credit: string } | null>): Promise<string> { throw new DomainError('unavailable', 'not built yet'); }
