/**
 * Custom review rules: the deterministic, repo-owned layer on top of the
 * model's verdict. Rules live in the `rules` array of `.os-review.json` (see
 * review-options.ts) so they are versioned with the code they score:
 *
 *   {
 *     "rules": [
 *       {
 *         "name": "marketing-only",
 *         "when": { "allFilesMatch": ["apps/marketing/**", "**\/*.mdx"] },
 *         "then": { "result": { "verdict": "approve", "score": 5 },
 *                   "note": "Marketing-only change" }
 *       },
 *       {
 *         "name": "migration-needs-human",
 *         "when": { "anyFileMatches": ["**\/migrations/**"] },
 *         "then": { "maxConfidence": 3, "minRisk": "medium" }
 *       },
 *       {
 *         "name": "lockfile-only",
 *         "when": { "allFilesMatch": ["**\/bun.lock"], "maxChangedLines": 2000 },
 *         "then": { "skipReview": true }
 *       }
 *     ]
 *   }
 *
 * `when` conditions are ANDed; a rule needs at least one. File conditions match
 * the PR's changed paths with Bun.Glob. `labels`, `baseBranch`, `verdict` and
 * `risk` accept a value or a list (any of). `verdict`, `minConfidence`,
 * `maxConfidence` and `risk` read the MODEL's result, so a rule using them can
 * never skip a review (there is no model result before the review runs).
 *
 * `then` outcomes apply in file order, cumulatively, each against the
 * original model result for matching but the running scores for adjusting:
 * `confidence` sets, `confidenceDelta` adjusts, `minConfidence` floors,
 * `maxConfidence` caps (all clamped to 1-5); `risk` sets, `minRisk` raises,
 * `maxRisk` lowers; `verdict` replaces; `note` is shown on the PR;
 * `result` publishes an independent named verdict and/or 1-5 score without
 * changing model scores, findings, or merge gates;
 * `skipReview` stops the automatic review before it starts (label-forced and
 * manual reviews still run).
 *
 * Rules change scores and the verdict, never findings: a P0 the model found
 * still counts as blocking for the fix-round gates. The summary comment shows
 * the model's original score next to the rule-adjusted one so a rule that
 * papers over something stays visible.
 *
 * Pure module (zero imports) so its tests never touch server modules; review.ts
 * and webhook.ts own the I/O.
 */

export const RULE_VERDICTS = ["approve", "comment", "request_changes"] as const;
export type RuleVerdict = (typeof RULE_VERDICTS)[number];

export const RULE_RISKS = ["low", "medium", "high"] as const;
export type RuleRisk = (typeof RULE_RISKS)[number];

export interface ReviewRuleWhen {
  /** Every changed file matches one of these globs (and there is at least one file). */
  allFilesMatch?: string[];
  /** At least one changed file matches one of these globs. */
  anyFileMatches?: string[];
  /** No changed file matches any of these globs. */
  noFileMatches?: string[];
  minChangedLines?: number;
  maxChangedLines?: number;
  minFiles?: number;
  maxFiles?: number;
  /** PR carries at least one of these labels (case-insensitive). */
  labels?: string[];
  /** Base branch matches one of these globs. */
  baseBranch?: string[];
  /** Model verdict is one of these. */
  verdict?: RuleVerdict[];
  /** Model quality score bounds (inclusive). */
  minConfidence?: number;
  maxConfidence?: number;
  /** Model merge-risk level is one of these. */
  risk?: RuleRisk[];
}

/** A named policy result, independent of the model's scores and merge gates. */
export interface ReviewRuleResult {
  verdict?: RuleVerdict;
  score?: number;
}

export interface ReviewRuleThen {
  result?: ReviewRuleResult;
  confidence?: number;
  confidenceDelta?: number;
  minConfidence?: number;
  maxConfidence?: number;
  verdict?: RuleVerdict;
  risk?: RuleRisk;
  minRisk?: RuleRisk;
  maxRisk?: RuleRisk;
  skipReview?: boolean;
  note?: string;
}

export interface ReviewRule {
  name: string;
  when: ReviewRuleWhen;
  then: ReviewRuleThen;
}

/** What a rule can see about a PR. Model fields are absent before the review runs. */
export interface ReviewRuleContext {
  files: string[];
  additions: number;
  deletions: number;
  labels: string[];
  baseBranch: string;
  verdict?: string;
  confidence?: number;
  risk?: RuleRisk;
}

export interface ReviewScores {
  verdict?: string;
  confidence?: number;
  risk?: RuleRisk;
}

export interface AppliedRule {
  name: string;
  result?: ReviewRuleResult;
  /** Human-readable model score changes; empty for independent results or notes. */
  changes: string[];
  note?: string;
}

export interface ReviewRuleEvaluation {
  original: ReviewScores;
  final: ReviewScores;
  applied: AppliedRule[];
  /** Any applied rule changed a score or the verdict. */
  changed: boolean;
}

export interface NormalizedReviewRules {
  rules: ReviewRule[];
  /** Names (or positions) of entries dropped for being malformed. */
  rejected: string[];
}

const MAX_RULES = 50;
const MAX_NOTE_LENGTH = 200;

function stringList(value: unknown): string[] | undefined {
  const list = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? [value]
      : null;
  if (!list) return undefined;
  const out = list.filter(
    (v): v is string => typeof v === "string" && v.trim().length > 0,
  );
  return out.length ? out : undefined;
}

function enumList<T extends string>(
  value: unknown,
  allowed: readonly T[],
): T[] | undefined {
  const raw = stringList(value)?.map((v) => v.trim().toLowerCase());
  if (!raw) return undefined;
  const out = raw.filter((v): v is T =>
    (allowed as readonly string[]).includes(v),
  );
  return out.length === raw.length && out.length ? out : undefined;
}

function enumValue<T extends string>(
  value: unknown,
  allowed: readonly T[],
): T | undefined {
  if (typeof value !== "string") return undefined;
  const v = value.trim().toLowerCase();
  return (allowed as readonly string[]).includes(v) ? (v as T) : undefined;
}

function count(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : undefined;
}

function score(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? clampScore(Math.round(value))
    : undefined;
}

function delta(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value !== 0
    ? Math.round(value)
    : undefined;
}

function clampScore(n: number): number {
  return Math.min(5, Math.max(1, n));
}

function normalizeWhen(raw: unknown): ReviewRuleWhen | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const when: ReviewRuleWhen = {};
  const set = <K extends keyof ReviewRuleWhen>(
    key: K,
    value: ReviewRuleWhen[K] | undefined,
  ) => {
    if (value !== undefined) when[key] = value;
  };
  set("allFilesMatch", stringList(r.allFilesMatch));
  set("anyFileMatches", stringList(r.anyFileMatches));
  set("noFileMatches", stringList(r.noFileMatches));
  set("minChangedLines", count(r.minChangedLines));
  set("maxChangedLines", count(r.maxChangedLines));
  set("minFiles", count(r.minFiles));
  set("maxFiles", count(r.maxFiles));
  set("labels", stringList(r.labels));
  set("baseBranch", stringList(r.baseBranch));
  set("verdict", enumList(r.verdict, RULE_VERDICTS));
  set("minConfidence", score(r.minConfidence));
  set("maxConfidence", score(r.maxConfidence));
  set("risk", enumList(r.risk, RULE_RISKS));
  return Object.keys(when).length ? when : null;
}

function normalizeResult(raw: unknown): ReviewRuleResult | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const r = raw as Record<string, unknown>;
  const verdict = enumValue(r.verdict, RULE_VERDICTS);
  const value = score(r.score);
  if (verdict === undefined && value === undefined) return undefined;
  return {
    ...(verdict ? { verdict } : {}),
    ...(value !== undefined ? { score: value } : {}),
  };
}

function normalizeThen(raw: unknown): ReviewRuleThen | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const then: ReviewRuleThen = {};
  const set = <K extends keyof ReviewRuleThen>(
    key: K,
    value: ReviewRuleThen[K] | undefined,
  ) => {
    if (value !== undefined) then[key] = value;
  };
  set("result", normalizeResult(r.result));
  set("confidence", score(r.confidence));
  set("confidenceDelta", delta(r.confidenceDelta));
  set("minConfidence", score(r.minConfidence));
  set("maxConfidence", score(r.maxConfidence));
  set("verdict", enumValue(r.verdict, RULE_VERDICTS));
  set("risk", enumValue(r.risk, RULE_RISKS));
  set("minRisk", enumValue(r.minRisk, RULE_RISKS));
  set("maxRisk", enumValue(r.maxRisk, RULE_RISKS));
  if (r.skipReview === true) then.skipReview = true;
  if (typeof r.note === "string" && r.note.trim())
    then.note = r.note.trim().slice(0, MAX_NOTE_LENGTH);
  return Object.keys(then).length ? then : null;
}

/** Pure validation: malformed entries are dropped and reported, never thrown. */
export function normalizeReviewRules(raw: unknown): NormalizedReviewRules {
  const rejected: string[] = [];
  if (!Array.isArray(raw)) return { rules: [], rejected };
  const rules: ReviewRule[] = [];
  const seen = new Set<string>();
  raw.slice(0, MAX_RULES).forEach((entry, index) => {
    const r =
      entry && typeof entry === "object"
        ? (entry as Record<string, unknown>)
        : null;
    const name =
      typeof r?.name === "string" && r.name.trim()
        ? r.name.trim()
        : `#${index + 1}`;
    const when = normalizeWhen(r?.when);
    const then = normalizeThen(r?.then);
    if (!r || !when || !then || seen.has(name)) {
      rejected.push(name);
      return;
    }
    seen.add(name);
    rules.push({ name, when, then });
  });
  return { rules, rejected };
}

function globMatches(path: string, globs: string[]): boolean {
  return globs.some((g) => {
    try {
      return new Bun.Glob(g).match(path);
    } catch {
      return false;
    }
  });
}

const RISK_ORDER: Record<RuleRisk, number> = { low: 0, medium: 1, high: 2 };

/** Does `when` read the model's result? Such rules cannot match before the review. */
export function ruleNeedsModelResult(rule: ReviewRule): boolean {
  const w = rule.when;
  return (
    w.verdict !== undefined ||
    w.minConfidence !== undefined ||
    w.maxConfidence !== undefined ||
    w.risk !== undefined
  );
}

export function ruleMatches(rule: ReviewRule, ctx: ReviewRuleContext): boolean {
  const w = rule.when;
  const files = ctx.files;
  if (w.allFilesMatch) {
    if (!files.length) return false;
    if (!files.every((f) => globMatches(f, w.allFilesMatch!))) return false;
  }
  if (w.anyFileMatches && !files.some((f) => globMatches(f, w.anyFileMatches!)))
    return false;
  if (w.noFileMatches && files.some((f) => globMatches(f, w.noFileMatches!)))
    return false;
  const lines = ctx.additions + ctx.deletions;
  if (w.minChangedLines !== undefined && lines < w.minChangedLines)
    return false;
  if (w.maxChangedLines !== undefined && lines > w.maxChangedLines)
    return false;
  if (w.minFiles !== undefined && files.length < w.minFiles) return false;
  if (w.maxFiles !== undefined && files.length > w.maxFiles) return false;
  if (w.labels) {
    const have = new Set(ctx.labels.map((l) => l.trim().toLowerCase()));
    if (!w.labels.some((l) => have.has(l.trim().toLowerCase()))) return false;
  }
  if (w.baseBranch && !globMatches(ctx.baseBranch, w.baseBranch)) return false;
  if (w.verdict) {
    const v = (ctx.verdict || "").toLowerCase();
    if (!(w.verdict as string[]).includes(v)) return false;
  }
  if (w.minConfidence !== undefined || w.maxConfidence !== undefined) {
    if (typeof ctx.confidence !== "number") return false;
    if (w.minConfidence !== undefined && ctx.confidence < w.minConfidence)
      return false;
    if (w.maxConfidence !== undefined && ctx.confidence > w.maxConfidence)
      return false;
  }
  if (w.risk && (!ctx.risk || !w.risk.includes(ctx.risk))) return false;
  return true;
}

/**
 * The first rule that skips the automatic review for this PR, decided before
 * any model runs. Rules that read the model's result never match here.
 */
export function preflightSkipRule(
  rules: ReviewRule[],
  ctx: ReviewRuleContext,
): ReviewRule | null {
  return (
    rules.find(
      (r) =>
        r.then.skipReview && !ruleNeedsModelResult(r) && ruleMatches(r, ctx),
    ) || null
  );
}

const VERDICT_LABEL = (v: string | undefined) =>
  v ? v.replace(/_/g, " ") : "none";

/**
 * Apply every matching rule to the model's scores. Matching reads the model's
 * original result; outcomes accumulate in file order. `skipReview` is a
 * preflight-only outcome and is ignored here.
 */
export function applyReviewRules(
  rules: ReviewRule[],
  ctx: ReviewRuleContext,
): ReviewRuleEvaluation {
  const original: ReviewScores = {
    verdict: ctx.verdict,
    confidence: ctx.confidence,
    risk: ctx.risk,
  };
  const final: ReviewScores = { ...original };
  const applied: AppliedRule[] = [];

  for (const rule of rules) {
    if (!ruleMatches(rule, ctx)) continue;
    const t = rule.then;
    const before: ReviewScores = { ...final };

    if (t.confidence !== undefined) final.confidence = t.confidence;
    if (t.confidenceDelta !== undefined && typeof final.confidence === "number")
      final.confidence = clampScore(final.confidence + t.confidenceDelta);
    if (t.minConfidence !== undefined)
      final.confidence = Math.max(final.confidence ?? 1, t.minConfidence);
    if (t.maxConfidence !== undefined)
      final.confidence = Math.min(final.confidence ?? 5, t.maxConfidence);
    if (t.verdict) final.verdict = t.verdict;
    if (t.risk) final.risk = t.risk;
    if (
      t.minRisk &&
      (!final.risk || RISK_ORDER[final.risk] < RISK_ORDER[t.minRisk])
    )
      final.risk = t.minRisk;
    if (
      t.maxRisk &&
      final.risk &&
      RISK_ORDER[final.risk] > RISK_ORDER[t.maxRisk]
    )
      final.risk = t.maxRisk;

    const changes: string[] = [];
    if (before.confidence !== final.confidence)
      changes.push(
        `quality ${before.confidence ?? "none"} → ${final.confidence}`,
      );
    if (before.verdict !== final.verdict)
      changes.push(
        `verdict ${VERDICT_LABEL(before.verdict)} → ${VERDICT_LABEL(final.verdict)}`,
      );
    if (before.risk !== final.risk)
      changes.push(`risk ${before.risk ?? "none"} → ${final.risk}`);
    if (!changes.length && !t.note && !t.result) continue;
    applied.push({
      name: rule.name,
      changes,
      ...(t.result ? { result: { ...t.result } } : {}),
      ...(t.note ? { note: t.note } : {}),
    });
  }

  const changed =
    original.verdict !== final.verdict ||
    original.confidence !== final.confidence ||
    original.risk !== final.risk;
  return { original, final, applied, changed };
}

/** Changed file paths from a unified diff, deleted and renamed files included. */
export function diffFilePaths(patch: string): string[] {
  const paths: string[] = [];
  const seen = new Set<string>();
  const add = (raw: string) => {
    let p = raw.trim();
    if (p.startsWith('"') && p.endsWith('"')) p = p.slice(1, -1);
    if (p.startsWith("b/")) p = p.slice(2);
    else if (p.startsWith("a/")) p = p.slice(2);
    if (p && p !== "/dev/null" && !seen.has(p)) {
      seen.add(p);
      paths.push(p);
    }
  };
  for (const line of patch.split("\n")) {
    if (line.startsWith("diff --git ")) {
      // `diff --git a/<path> b/<path>`: take the b side, which survives
      // renames and deletions (a deleted file has no `+++` path).
      const m = line.match(/^diff --git "?a\/.* "?b\/(.*?)"?$/);
      if (m) add(m[1]);
    } else if (line.startsWith("+++ ")) {
      add(line.slice(4));
    }
  }
  return paths;
}

/** Summary-comment section listing the rules that fired and what each changed. */
export function reviewRulesSection(
  evaluation: ReviewRuleEvaluation | null,
): string {
  if (!evaluation?.applied.length) return "";
  const results = evaluation.applied.filter((r) => r.result);
  const adjustments = evaluation.applied.filter(
    (r) => r.changes.length || !r.result,
  );
  const sections: string[] = [];
  if (results.length) {
    const labels: Record<RuleVerdict, string> = {
      approve: "approved",
      comment: "comment",
      request_changes: "changes requested",
    };
    const lines = results.map((r) => {
      const result = r.result!;
      const what = [
        result.verdict ? labels[result.verdict] : undefined,
        result.score !== undefined ? `${result.score}/5` : undefined,
        r.note,
      ]
        .filter(Boolean)
        .join(" · ");
      return `- **${r.name}**: ${what}`;
    });
    sections.push(
      [
        "\n\n📏 **Custom rule results**",
        "Independent policy results; not the AI verdict or merge approval.",
        ...lines,
      ].join("\n"),
    );
  }
  if (adjustments.length) {
    const lines = adjustments.map((r) => {
      const what = [r.changes.join(", "), r.result ? undefined : r.note]
        .filter(Boolean)
        .join(". ");
      return `- **${r.name}**${what ? `: ${what}` : ""}`;
    });
    sections.push(["\n\n📏 **Rules applied**", ...lines].join("\n"));
  }
  return sections.join("");
}

/** Header suffixes: final score with the model's original in parentheses when a rule changed it. */
export function ruleScoreSuffixes(evaluation: ReviewRuleEvaluation | null): {
  verdict: string;
  confidence: string;
  risk: string;
} {
  if (!evaluation?.changed) return { verdict: "", confidence: "", risk: "" };
  const { original, final } = evaluation;
  return {
    verdict:
      original.verdict !== final.verdict
        ? ` (model: ${VERDICT_LABEL(original.verdict)})`
        : "",
    confidence:
      original.confidence !== final.confidence
        ? typeof original.confidence === "number"
          ? ` (model ${original.confidence}/5)`
          : " (rule)"
        : "",
    risk:
      original.risk !== final.risk
        ? original.risk
          ? ` (model ${original.risk})`
          : " (rule)"
        : "",
  };
}
