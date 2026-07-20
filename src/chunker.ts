// Chunker: pure, token-aware text splitter (§10.2, FR-IG-2/3).
//
// Uses the embedding model tokenizer (cl100k_base / text-embedding-3-small).
// No clocks, no RNG. Identical input yields identical output (FR-IG-5).
import { get_encoding, type Tiktoken } from "tiktoken";
import chunkingDefaults from "../config/chunking.json" with { type: "json" };
import type { Chunk, ChunkInput } from "../types/index.js";

export interface ChunkingConfig {
  version: string;
  target_tokens: number;
  overlap_tokens: number;
  boundary_pref: Array<"heading" | "paragraph" | "sentence">;
  min_chunk_tokens: number;
  embed_model: string;
  tokenizer: string;
}

type BoundaryType = "heading" | "paragraph" | "sentence" | "arbitrary";

interface TextUnit {
  text: string;
  page: number;
  section: string | null;
  charStart: number;
  charEnd: number;
  boundaryType: BoundaryType;
}

const HEADING_MARKDOWN = /^#{1,6}\s+.+/;
const HEADING_ALLCAPS = /^[A-Z0-9][A-Z0-9\s.\-/]{2,80}$/;

function loadEncoder(tokenizer: string): Tiktoken {
  return get_encoding(tokenizer as "cl100k_base");
}

function countTokens(text: string, encoder: Tiktoken): number {
  return encoder.encode(text).length;
}

function decodeTokens(tokens: ReturnType<Tiktoken["encode"]>, encoder: Tiktoken): string {
  return new TextDecoder().decode(encoder.decode(tokens));
}

function overlapPrefix(text: string, overlapTokens: number, encoder: Tiktoken): string {
  const tokens = encoder.encode(text);
  if (tokens.length <= overlapTokens) {
    return text;
  }
  const overlapSlice = tokens.subarray(tokens.length - overlapTokens);
  return decodeTokens(overlapSlice, encoder);
}

function isHeading(line: string): boolean {
  const trimmed = line.trim();
  if (trimmed.length === 0) {
    return false;
  }
  return HEADING_MARKDOWN.test(trimmed) || HEADING_ALLCAPS.test(trimmed);
}

function splitSentences(text: string): string[] {
  const parts = text.split(/(?<=[.!?])\s+/).map((part) => part.trim()).filter(Boolean);
  return parts.length > 0 ? parts : [text.trim()];
}

function parsePageUnits(pageText: string, page: number, pageOffset: number): TextUnit[] {
  const units: TextUnit[] = [];
  let currentSection: string | null = null;
  const paragraphs = pageText.split(/\n\s*\n/);

  for (const paragraph of paragraphs) {
    const trimmed = paragraph.trim();
    if (trimmed.length === 0) {
      continue;
    }

    const paragraphStart = pageText.indexOf(paragraph, 0);
    const baseStart = pageOffset + (paragraphStart >= 0 ? paragraphStart : 0);

    if (isHeading(trimmed)) {
      currentSection = trimmed.replace(/^#{1,6}\s+/, "").trim();
      units.push({
        text: trimmed,
        page,
        section: currentSection,
        charStart: baseStart,
        charEnd: baseStart + trimmed.length,
        boundaryType: "heading",
      });
      continue;
    }

    const sentences = splitSentences(trimmed);
    let cursor = baseStart;

    for (const sentence of sentences) {
      const sentenceIndex = paragraph.indexOf(sentence, cursor - baseStart);
      const charStart =
        sentenceIndex >= 0 ? pageOffset + sentenceIndex : cursor;
      const charEnd = charStart + sentence.length;

      units.push({
        text: sentence,
        page,
        section: currentSection,
        charStart,
        charEnd,
        boundaryType: "sentence",
      });
      cursor = charEnd;
    }
  }

  return units;
}

function buildUnits(input: ChunkInput): TextUnit[] {
  const units: TextUnit[] = [];
  let pageOffset = 0;

  for (const page of input.pages) {
    units.push(...parsePageUnits(page.text, page.page, pageOffset));
    pageOffset += page.text.length + 1;
  }

  if (units.length === 0 && input.pages.length > 0) {
    const page = input.pages[0]!;
    units.push({
      text: page.text.trim(),
      page: page.page,
      section: null,
      charStart: 0,
      charEnd: page.text.length,
      boundaryType: "arbitrary",
    });
  }

  return units;
}

function finalizeChunk(
  units: TextUnit[],
  source: string,
  chunkIndex: number,
  encoder: Tiktoken
): Chunk {
  const text = units.map((unit) => unit.text).join(" ").trim();
  const first = units[0]!;
  const last = units[units.length - 1]!;

  return {
    chunk_index: chunkIndex,
    source,
    page: first.page,
    section: first.section,
    char_start: first.charStart,
    char_end: last.charEnd,
    text,
    token_count: countTokens(text, encoder),
  };
}

function packUnits(
  units: TextUnit[],
  source: string,
  config: ChunkingConfig,
  encoder: Tiktoken
): Chunk[] {
  const chunks: Chunk[] = [];
  let bucket: TextUnit[] = [];
  let bucketText = "";
  let chunkIndex = 0;

  const flush = (): void => {
    if (bucket.length === 0) {
      return;
    }
    chunks.push(finalizeChunk(bucket, source, chunkIndex, encoder));
    chunkIndex += 1;
    bucket = [];
    bucketText = "";
  };

  for (const unit of units) {
    const candidateText =
      bucketText.length === 0 ? unit.text : `${bucketText} ${unit.text}`;
    const candidateTokens = countTokens(candidateText, encoder);

    if (bucket.length > 0 && candidateTokens > config.target_tokens) {
      const finishedText = bucketText;
      flush();

      const overlap = overlapPrefix(finishedText, config.overlap_tokens, encoder);
      bucket = [];
      bucketText = "";

      if (overlap.length > 0) {
        bucket.push({
          text: overlap,
          page: unit.page,
          section: unit.section,
          charStart: unit.charStart,
          charEnd: unit.charStart + overlap.length,
          boundaryType: "arbitrary",
        });
        bucketText = overlap;
      }

      bucket.push(unit);
      bucketText =
        bucketText.length === 0 ? unit.text : `${bucketText} ${unit.text}`;
      continue;
    }

    bucket.push(unit);
    bucketText = candidateText;
  }

  flush();

  if (chunks.length >= 2) {
    let last = chunks[chunks.length - 1]!;
    while (chunks.length >= 2 && last.token_count < config.min_chunk_tokens) {
      const previous = chunks[chunks.length - 2]!;
      const mergedText = `${previous.text} ${last.text}`.trim();
      const merged: Chunk = {
        ...previous,
        char_end: last.char_end,
        text: mergedText,
        token_count: countTokens(mergedText, encoder),
      };
      chunks.splice(chunks.length - 2, 2, merged);
      last = chunks[chunks.length - 1]!;
    }
  }

  return chunks;
}

export function chunkDocument(
  input: ChunkInput,
  config: ChunkingConfig = chunkingDefaults as ChunkingConfig
): Chunk[] {
  const encoder = loadEncoder(config.tokenizer);
  try {
    const units = buildUnits(input);
    if (units.length === 0) {
      return [];
    }
    return packUnits(units, input.source, config, encoder);
  } finally {
    encoder.free();
  }
}

export { countTokens, loadEncoder };
