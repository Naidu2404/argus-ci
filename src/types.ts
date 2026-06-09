// ─── Semgrep / Opengrep raw output ───────────────────────────────────────────

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
      cwe?:        string | string[];
      owasp?:      string | string[];
      references?: string | string[];
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

// ─── Bearer raw output ────────────────────────────────────────────────────────

export interface BearerRawResult {
  critical?: BearerFinding[];
  high?:     BearerFinding[];
  medium?:   BearerFinding[];
  low?:      BearerFinding[];
  warning?:  BearerFinding[];
}

export interface BearerFinding {
  rule_id:          string;
  rule_display_id?: string;
  description:      string;
  severity:         string;
  filename:         string;
  full_filename?:   string;
  line_number:      number;
  column_number?:   number;
  code_extract?:    string;
  cwe_ids?:         string[];
}

// ─── Normalised issue ─────────────────────────────────────────────────────────

export type Severity = "error" | "warning" | "info";

/** Security scanners */
export type SecurityEngine = "opengrep" | "semgrep" | "bearer";

/** Code quality linters — one per language ecosystem */
export type QualityEngine = "oxlint" | "ruff" | "golangci-lint" | "rubocop" | "pmd";

export type ScanEngine = SecurityEngine | QualityEngine;

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
  engine:      ScanEngine;
}

// ─── Scan result ──────────────────────────────────────────────────────────────

export interface ScanResult {
  issues:       Issue[];
  skipped:      boolean;
  skipReason?:  string;
  filesScanned: number;
  durationMs:   number;
  rulesets:     string[];
  engines:      ScanEngine[];   // which scanners actually ran
}

// ─── Config ───────────────────────────────────────────────────────────────────

export interface ScanConfig {
  rulesets?:      string[];
  failOn?:        Severity[];
  maxFileSizeKb?: number;
  exclude?:       string[];
  githubToken?:   string;
  anthropicKey?:  string;
  /** Run Bearer deep scan in addition to Opengrep (default: true for staged/branch/PR, false for single file) */
  runBearer?:     boolean;
  /** Run the language-specific quality linter (Oxlint/Ruff/golangci-lint/etc.) — default: same as runBearer */
  runQuality?:    boolean;
  /** Override which quality engine to use (auto-detected from stack if omitted) */
  qualityEngine?: QualityEngine;
  /** Internal: when true, quality engine scans the whole directory instead of individual files */
  _isRepoScan?:   boolean;
}

// ─── Agent tool response ──────────────────────────────────────────────────────

export interface ToolResponse {
  success:   boolean;
  result?:   ScanResult;
  markdown?: string;
  error?:    string;
}
