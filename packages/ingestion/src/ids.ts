// Fixed namespace for point ids; changing it changes every point id.
const POINT_NAMESPACE = "6f1d5a52-3c4e-4c1b-9b5e-0d3f6a7b8c91";

// The source node's id is the bare name; every other id contains a ":", so they cannot collide.
export const sourceId = (source: string) => source;

export const nodeId = (source: string, path: string) => `${source}:${path}`;

export const chunkId = (sectionId: string, index: number) => `${sectionId}:${index}`;

// Qdrant point ids must be UUIDs or integers; the readable chunk id stays in the payload.
export const pointId = (id: string) => Bun.randomUUIDv5(id, POINT_NAMESPACE);
