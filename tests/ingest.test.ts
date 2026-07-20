// Ingest orchestrator unit tests. Mock-based, no live DB (FR-IG-1..6,
// FR-EM-1..4).
import { describe, it, expect, vi, beforeEach, type MockedObject } from "vitest";
import { ingestFile } from "../src/ingest.js";
import type { PoolClient } from "pg";

function makeMockClient(): MockedObject<PoolClient> & PoolClient {
  return {
    query: vi.fn().mockResolvedValue({ rows: [] }),
    release: vi.fn(),
    copyFrom: vi.fn(),
    copyTo: vi.fn(),
    pauseDrain: vi.fn(),
    resumeDrain: vi.fn(),
    on: vi.fn(),
    once: vi.fn(),
    emit: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    off: vi.fn(),
    removeAllListeners: vi.fn(),
    setMaxListeners: vi.fn(),
    getMaxListeners: vi.fn(),
    listeners: vi.fn(),
    rawListeners: vi.fn(),
    listenerCount: vi.fn(),
    prependListener: vi.fn(),
    prependOnceListener: vi.fn(),
    eventNames: vi.fn(),
    connect: vi.fn(),
    end: vi.fn(),
    host: "localhost",
    port: 5432,
    database: "docintel",
    user: "postgres",
    password: "postgres",
    ssl: false,
    // mock all minimal PoolClient fields
  } as unknown as MockedObject<PoolClient> & PoolClient;
}

describe("ingestFile (mock)", () => {
  let client: ReturnType<typeof makeMockClient>;

  beforeEach(() => {
    client = makeMockClient();
  });

  it("marks corrupted/unreadable files as failed without throwing", async () => {
    const result = await ingestFile("/nonexistent/file.pdf", client as unknown as PoolClient);
    expect(result.status).toBe("failed");
    expect(result.reason).toContain("Cannot read file");
  });

  it("returns a structured IngestResult on failure", async () => {
    const result = await ingestFile("/bad/path.txt", client as unknown as PoolClient);
    expect(result.documentId).toBeNull();
    expect(result.chunksTotal).toBe(0);
    expect(result.pageCount).toBe(0);
  });
});
