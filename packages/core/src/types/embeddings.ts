import type { MeasuredUsage } from './chat.js';

export interface EmbeddingsRequest {
  model: string;
  input: string | string[];
  dimensions?: number;
  encoding_format?: 'float' | 'base64';
  user?: string;
  gateway?: { test?: boolean; tags?: string[] };
}

export interface EmbeddingVector {
  object: 'embedding';
  index: number;
  embedding: number[];
}

export interface EmbeddingsResponse {
  object: 'list';
  data: EmbeddingVector[];
  model: string;
  usage?: MeasuredUsage;
  gateway?: {
    requestId: string;
    provider: string;
    model: string;
    latencyMs: number;
  };
}
