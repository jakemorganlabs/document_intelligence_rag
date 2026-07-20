// Structured logger: JSON lines to stdout (§17.1, NFR-OB-1).
//
// Every stage emits one line with mandatory fields; per-stage extras are added
// as additional properties. Lets an operator reconstruct a query's journey
// from a single grep.
//
// Mandatory fields: trace_id, stage, status, latency_ms.
// Optional extras: query_id, model_id, tokens, similarity_top, gate_fired,
// input_tokens, output_tokens, total_tokens, repair_used, error.
export interface LogLine {
  trace_id: string;
  stage: string;
  status: "start" | "success" | "failure" | "abstain" | "error";
  latency_ms?: number;
  query_id?: string;
  model_id?: string;
  input_tokens?: number;
  output_tokens?: number;
  total_tokens?: number;
  similarity_top?: number;
  gate_fired?: string | null;
  repair_used?: boolean;
  error?: string;
  [key: string]: unknown;
}

let logSink: (line: LogLine) => void = defaultSink;

function defaultSink(line: LogLine): void {
  // eslint-disable-next-line no-console
  console.log(JSON.stringify(line));
}

export function setLogSink(sink: (line: LogLine) => void): void {
  logSink = sink;
}

export function resetLogSink(): void {
  logSink = defaultSink;
}

// Emit a structured log line. Falls back to a random UUID if trace_id is
// not provided.
export function logEvent(line: LogLine): void {
  const enriched = {
    ...line,
    trace_id: line.trace_id ?? generateTraceId(),
    ts: new Date().toISOString(),
  };
  logSink(enriched);
}

function generateTraceId(): string {
  return crypto.randomUUID();
}
