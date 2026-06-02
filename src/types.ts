// ─── Semgrep raw output ───────────────────────────────────────────────────────

export interface SemgrepRawResult {
  results: SemgrepFinding[];
  errors:  SemgrepError[];
  stats?:  { total_time?: number };
}

export interface SemgrepFinding {
  check_id: string;
  path:     string;
  start:    { line: number; col: number };
  end:      { line: number; col: number };
  extra: {
    message:   string;
    severity:  "ERROR" | "WARNING" | "INFO";
    lines?:    string;
    metadata?: {
      cwe?:        string[];
      owasp?:      string[];
      references?: string[];
      category?:   string;
      technology?: string[];
    };
  };
}

export interface SemgrepError {
  code:    number;
  level:   string;
  message: string;
  type:    string;
}

// ─── Normalised issue ─────────────────────────────────────────────────────────

export type Severity = "error" | "warning" | "info";

export interface Issue {
  ruleId:      string;
  path:        string;
  line:        number;
  col:         number;
  severity:    Severity;
  message:     string;
  sourceLine?: string;
  cwe?:        string[];
  owasp?:      string[];
  references?: string[];
}

// ─── Scan result ──────────────────────────────────────────────────────────────

export interface ScanResult {
  issues:     Issue[];
  skipped:    boolean;
  skipReason?: string;
  filesScanned: number;
  durationMs:  number;
  rulesets:    string[];
}

// ─── Config ───────────────────────────────────────────────────────────────────

export interface ScanConfig {
  /** Semgrep rulesets to run — defaults to auto-detected from stack */
  rulesets?: string[];
  /** Fail (exit 1) if any issue of these severities is found */
  failOn?:   Severity[];
  /** Max file size in KB to scan — default 500 */
  maxFileSizeKb?: number;
  /** Directories to exclude */
  exclude?:  string[];
  /** GITHUB_TOKEN for private repo PR access */
  githubToken?: string;
  /** Anthropic API key for the agent interface */
  anthropicKey?: string;
}

// ─── Agent tool response ──────────────────────────────────────────────────────

export interface ToolResponse {
  success:  boolean;
  result?:  ScanResult;
  markdown?: string;
  error?:   string;
}
