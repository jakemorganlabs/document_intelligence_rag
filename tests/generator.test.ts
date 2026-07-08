import { describe, expect, it, vi } from "vitest";
import { generateGroundedAnswer } from "../src/generator.js";

describe("generator", () => {
  const originalEnv = process.env;

  it("parses JSON response from Gemma via DeepInfra", async () => {
    process.env = {
      ...originalEnv,
      DEEPINFRA_API_KEY: "test-key",
      DEEPINFRA_BASE_URL: "https://api.test.local",
    };

    const mockResponse = {
      choices: [
        {
          message: {
            content:
              '{"status":"answered","answer":"test answer","citations":[{"chunk_id":"c-1","source":"doc.pdf","page":1,"snippet":"test snippet"}]}',
          },
        },
      ],
      usage: { prompt_tokens: 120, completion_tokens: 45, total_tokens: 165 },
    };

    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(mockResponse),
    } as Response);

    const result = await generateGroundedAnswer({ prompt: "test prompt" });
    expect(result.answer.status).toBe("answered");
    expect(result.answer.citations).toHaveLength(1);
    expect(result.inputTokens).toBe(120);
    expect(result.outputTokens).toBe(45);
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);

    process.env = originalEnv;
    vi.restoreAllMocks();
  });

  it("strips markdown fences from response", async () => {
    process.env = {
      ...originalEnv,
      DEEPINFRA_API_KEY: "test-key",
      DEEPINFRA_BASE_URL: "https://api.test.local",
    };

    const mockWithFence = {
      choices: [
        {
          message: {
            content:
              '```json\n{"status":"answered","answer":"a","citations":[]}\n```',
          },
        },
      ],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    };

    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(mockWithFence),
    } as Response);

    const result = await generateGroundedAnswer({ prompt: "test" });
    expect(result.answer.status).toBe("answered");

    process.env = originalEnv;
    vi.restoreAllMocks();
  });

  it("returns insufficient_evidence on JSON parse failure", async () => {
    process.env = {
      ...originalEnv,
      DEEPINFRA_API_KEY: "test-key",
      DEEPINFRA_BASE_URL: "https://api.test.local",
    };

    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          choices: [{ message: { content: "not-json" } }],
          usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
        }),
    } as Response);

    const result = await generateGroundedAnswer({ prompt: "test" });
    expect(result.answer.status).toBe("insufficient_evidence");

    process.env = originalEnv;
    vi.restoreAllMocks();
  });
});
