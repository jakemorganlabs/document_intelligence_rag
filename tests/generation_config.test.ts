import { describe, expect, it } from "vitest";
import {
  defaultGenerationConfig,
  VALID_GENERATION_MODEL_PREFIXES,
  GENERATION_MODEL_ID,
  loadGenerationConfig,
} from "../src/generation_config.js";

describe("generation_config", () => {
  it("pins the generation model to Google Gemma via DeepInfra", () => {
    expect(defaultGenerationConfig.provider).toBe("deepinfra");
    expect(defaultGenerationConfig.model_id).toBe(
      "google/gemma-4-26B-A4B-it"
    );
    expect(GENERATION_MODEL_ID).toBe("google/gemma-4-26B-A4B-it");
  });

  it("accepts only google/gemma model prefixes", () => {
    const modelLower = defaultGenerationConfig.model_id.toLowerCase();
    let matched = false;
    for (const prefix of VALID_GENERATION_MODEL_PREFIXES) {
      if (modelLower.startsWith(prefix)) matched = true;
    }
    expect(matched).toBe(true);
  });

  it("rejects non-deepinfra provider overrides", () => {
    expect(() =>
      loadGenerationConfig({
        provider: "openai" as "deepinfra",
        model_id: "gpt-4",
      })
    ).toThrow(/provider must be "deepinfra"/);
  });

  it("rejects non-gemma model overrides", () => {
    expect(() =>
      loadGenerationConfig({ model_id: "gpt-4" })
    ).toThrow(/must be "google\/gemma-4-26B-A4B-it"/);

    expect(() =>
      loadGenerationConfig({ model_id: "openai/gpt-4o" })
    ).toThrow(/must be "google\/gemma-4-26B-A4B-it"/);
  });
});
