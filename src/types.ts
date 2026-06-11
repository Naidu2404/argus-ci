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
export type QualityEngine = "oxlint" | "ruff" | "golangci-lint" | "rubocop" | "pmd" | "phpstan";

/** Project-level checkers (use repo's own config) */
export type ProjectEngine = "eslint" | "tsc" | "prettier";

/** Dependency vulnerability engines */
export type DepsEngine = "npm-audit" | "pip-audit" | "bundler-audit" | "cargo-audit" | "dependabot";

/** External analysis services */
export type ExternalEngine = "sonar" | "ai";

export type ScanEngine = SecurityEngine | QualityEngine | ProjectEngine | DepsEngine | ExternalEngine;

export interface Issue {
  ruleId:          string;
  path:            string;
  line:            number;
  col:             number;
  severity:        Severity;
  message:         string;
  sourceLine?:     string;
  fixSuggestion?:  string;   // AI-generated fix hint
  cwe?:            string[];
  owasp?:          string[];
  references?:     string[];
  engine:          ScanEngine;
}

// ─── Scan result ──────────────────────────────────────────────────────────────

export interface ScanResult {
  issues:          Issue[];
  skipped:         boolean;
  skipReason?:     string;
  filesScanned:    number;
  durationMs:      number;
  rulesets:        string[];
  engines:         ScanEngine[];   // which scanners actually ran
  skippedEngines?: Record<string, string>;  // engine → skip reason (e.g. "sonar" → "SONAR_PROJECT_KEY not set")
}

// ─── Config ───────────────────────────────────────────────────────────────────

export interface ScanConfig {
  rulesets?:      string[];
  failOn?:        Severity[];
  maxFileSizeKb?: number;
  exclude?:       string[];
  githubToken?:   string;
  anthropicKey?:  string;
  /** Run Bearer deep scan (default: true for staged/branch/PR) */
  runBearer?:     boolean;
  /** Run the language-specific quality linter (Oxlint/Ruff/etc.) */
  runQuality?:    boolean;
  /** Override which quality engine to use (auto-detected if omitted) */
  qualityEngine?: QualityEngine;
  /** Run project-level checks: ESLint (repo config) + tsc --noEmit + Prettier */
  runProject?:    boolean;
  /** Run dependency vulnerability scan: npm audit / pip-audit / Dependabot */
  runDeps?:       boolean;
  /** Run SonarQube/SonarCloud analysis (requires SONAR_TOKEN) */
  runSonar?:      boolean;
  /** Override Sonar project key (default: read from env SONAR_PROJECT_KEY) */
  sonarProjectKey?: string;
  /** Enrich findings with AI fix suggestions (requires GROQ_API_KEY or ANTHROPIC_API_KEY) */
  runAI?:         boolean;
  /** Internal: when true, quality engine scans the whole directory instead of individual files */
  _isRepoScan?:   boolean;
}

// ─── Trace code ───────────────────────────────────────────────────────────────

export type TraceKind =
  | "console"        // console.log/warn/error/debug
  | "debugger"       // debugger statement
  | "todo-comment"   // TODO / FIXME / HACK / XXX
  | "commented-code" // large blocks of commented-out code
  | "dead-import";   // import used nowhere in the file

export interface TraceItem {
  path:            string;
  line:            number;
  endLine?:        number;
  kind:            TraceKind;
  sourceLine:      string;
  safeToRemove:    boolean;
  removeNote?:     string;   // why it might need review
}

export interface TraceResult {
  items:           TraceItem[];
  filesScanned:    number;
  safeCount:       number;
  reviewCount:     number;
}

// ─── Argus credential config (~/.argus-ci.json) ───────────────────────────────

export interface ArgusConfig {
  groqApiKey?:        string;
  anthropicApiKey?:   string;
  githubToken?:       string;
  sonarToken?:        string;
  sonarProjectKey?:   string;
  sonarServerUrl?:    string;
  sonarOrganization?: string;
}

// ─── Agent tool response ──────────────────────────────────────────────────────

export interface ToolResponse {
  success:   boolean;
  result?:   ScanResult;
  markdown?: string;
  error?:    string;
}
