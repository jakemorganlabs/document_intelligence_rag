// PDF/Text extractor client: spawns the Python sidecar (FR-IG-1, FR-IG-2).
import { spawn } from "node:child_process";
import { resolve } from "node:path";

export interface ExtractedPage {
  page: number;
  text: string;
  char_start: number;
  char_end: number;
}

export interface ExtractionResult {
  source: string;
  page_count: number;
  pages: ExtractedPage[];
}

const SIDECAR_PATH = resolve(
  process.cwd(),
  "sidecar",
  "extract.py"
);

// Extract text from a file (PDF, .txt, .md) by spawning the Python sidecar.
// Returns page-tagged text with character offsets.
//
// filePath: absolute or relative path to the file.
export function extractFile(filePath: string): Promise<ExtractionResult> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn("python3", [SIDECAR_PATH, filePath]);
    let stdout = "";
    let stderr = "";

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");

    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });

    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });

    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`Extractor exited ${code}: ${stderr || stdout}`));
        return;
      }
      try {
        const parsed: ExtractionResult = JSON.parse(stdout);
        resolvePromise(parsed);
      } catch (e) {
        reject(new Error(`Failed to parse extractor output: ${(e as Error).message}`));
      }
    });

    child.on("error", (err) => {
      reject(new Error(`Failed to spawn extractor: ${err.message}`));
    });
  });
}
