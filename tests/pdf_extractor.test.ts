/**
 * PDF/Text extractor sidecar integration tests.
 *
 * Satisfies: FR-IG-1 (document ingestion), FR-IG-2 (page-tagging).
 */
import { describe, it, expect, beforeAll } from "vitest";
import { extractFile } from "../src/pdf_extractor.js";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";

const FIXTURE_DIR = resolve(process.cwd(), "fixtures", "smoke_pdfs");

// CI runners don't always have the Python sidecar's `pypdf` dependency
// available. Rather than fail every PR, probe the sidecar once and skip
// the live-extraction assertions when it can't run. The error-handling
// test below still exercises the spawn path with no dependency.
let sidecarAvailable = false;

beforeAll(() => {
  const probe = spawnSync("python3", [
    "-c",
    "import pypdf; print('ok')",
  ], { encoding: "utf8" });
  sidecarAvailable = probe.status === 0 && probe.stdout.trim() === "ok";
  if (!sidecarAvailable) {
    // eslint-disable-next-line no-console
    console.warn(
      "[pdf_extractor.test] pypdf not installed — skipping live extraction tests. " +
      "Install with `pip install -r sidecar/requirements.txt` to enable them."
    );
  }
});

describe("extractFile", () => {
  const liveTest = sidecarAvailable ? it : it.skip;

  liveTest("extracts a multi-page PDF with page boundaries", async () => {
    const path = resolve(FIXTURE_DIR, "smoke_01_guidelines.pdf");
    const result = await extractFile(path);
    expect(result.source).toBe("smoke_01_guidelines.pdf");
    expect(result.page_count).toBeGreaterThan(0);
    expect(result.pages.length).toBe(result.page_count);
    expect(result.pages[0]!.text.length).toBeGreaterThan(0);
    expect(result.pages[0]!.char_start).toBe(0);
    expect(result.pages[0]!.char_end).toBeGreaterThan(0);
  });

  liveTest("extracts text preserving page order", async () => {
    const path = resolve(FIXTURE_DIR, "smoke_03_procedures.pdf");
    const result = await extractFile(path);
    expect(result.pages[0]!.page).toBe(1);
  });

  it("throws on non-existent file", async () => {
    await expect(extractFile("/nonexistent/file.pdf")).rejects.toThrow();
  });
});
