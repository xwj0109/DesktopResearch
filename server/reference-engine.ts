import { setImmediate } from "node:timers/promises";
import { Fault, canonical, contentHash } from "./durable.ts";
import {
  exportSchema,
  type Row,
  type RunConfig,
  type RunOutput,
  type Metrics,
  type Point,
  type ExportPackage,
  type Ref,
  type Allocation,
  type AlignmentAnalysis,
  type conventionsSchema,
} from "../src/platform.ts";
import type { z } from "zod";
export const ENGINE_ID = "reference-close-v1" as const;
export const LIMITATIONS = [
  "Deterministic reference simulation; not execution of authored source files.",
  "Idealized prior-close rebalancing; close-known signals earn only the next close-to-close return.",
  "Unit notional long/short exposure; linear turnover fee/slippage; no financing, borrow, fills, liquidity, corporate-action or capacity model.",
  "No liquidation cost at the final close. Dates are observations, not exchange-calendar validation.",
];
export function inspectCSV(
  csv: string,
  contract: { columns: string; start: string; end: string },
) {
  const findings: string[] = [];
  const rows: Row[] = [];
  const warnings = [
    "Observed-date calendar: no exchange-calendar completeness validation or missing-value filling.",
  ];
  if (Buffer.byteLength(csv) > 2 * 1024 * 1024)
    return { rows, findings: ["CSV exceeds 2 MiB"], warnings };
  const lines = csv.replace(/\r\n/g, "\n").split("\n");
  if (lines.at(-1) === "") lines.pop();
  if (lines.length < 3 || lines.length > 10001)
    findings.push("Require 2–10000 dated observations");
  if (lines[0] !== contract.columns)
    findings.push("Header must exactly match " + contract.columns);
  const signal = contract.columns === "date,close,signal";
  let previous = "";
  for (let i = 1; i < Math.min(lines.length, 10001); i++) {
    if (findings.length >= 50) {
      findings.push("Validation stopped at 50 findings");
      break;
    }
    const fields = lines[i].split(",");
    const [date, close, rawSignal] = fields;
    if (fields.length !== (signal ? 3 : 2)) {
      findings.push(`Row ${i + 1}: wrong column count`);
      continue;
    }
    if (
      !/^\d{4}-\d{2}-\d{2}$/.test(date) ||
      !Number.isFinite(Date.parse(date + "T00:00:00Z")) ||
      new Date(date + "T00:00:00Z").toISOString().slice(0, 10) !== date
    ) {
      findings.push(`Row ${i + 1}: invalid ISO date`);
      continue;
    }
    if (date <= previous)
      findings.push(`Row ${i + 1}: duplicate or nonascending date`);
    previous = date;
    const numeric = (s: string) =>
      /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(s) &&
      Number.isFinite(Number(s));
    if (!numeric(close) || Number(close) <= 0) {
      findings.push(`Row ${i + 1}: close must be finite and positive`);
      continue;
    }
    if (signal && (!numeric(rawSignal) || Math.abs(Number(rawSignal)) > 1)) {
      findings.push(`Row ${i + 1}: signal must be finite in [-1,1]`);
      continue;
    }
    if (date < contract.start || date > contract.end)
      findings.push(`Row ${i + 1}: outside contract range`);
    rows.push({
      date,
      close: Number(close),
      ...(signal ? { signal: Number(rawSignal) } : {}),
    });
    if (findings.length >= 50) {
      findings.push("Validation stopped at 50 findings");
      break;
    }
  }
  if (rows[0]?.date !== contract.start || rows.at(-1)?.date !== contract.end)
    findings.push(
      "Dataset must cover exact requested range endpoints; no fill",
    );
  const gaps = rows
    .slice(1)
    .map((r, i) => (Date.parse(r.date) - Date.parse(rows[i].date)) / 86400000)
    .filter((n) => n > 1);
  if (gaps.length)
    warnings.push(
      `${gaps.length} multi-day intervals; longest ${Math.max(...gaps)} calendar days. Missing sessions are not inferred.`,
    );
  return { rows, findings, warnings };
}
// Center in offset space rather than subtracting a rounded absolute mean.
// Equal nonzero values must have exactly zero variance; no epsilon cutoff is
// used, so representable small differences remain genuine variation.
function centered(values: number[]) {
  const origin = values[0];
  if (values.every((v) => v === origin))
    return { mean: origin, deviations: values.map(() => 0), norm: 0 };
  const offsets = values.map((v) => v - origin);
  let average = 0, correction = 0;
  for (const offset of offsets) {
    const term = offset / values.length - correction;
    const next = average + term;
    correction = (next - average) - term;
    average = next;
  }
  const deviations = offsets.map((v) => v - average);
  return { mean: origin + average, deviations, norm: Math.hypot(...deviations) };
}
export function metrics(returns: number[], annualisation: number): Metrics {
  if (!returns.length) throw new Fault(400, "No realized returns");
  let equity = 1,
    peak = 1,
    maxDrawdown = 0;
  for (const r of returns) {
    if (!Number.isFinite(r) || r <= -1)
      throw new Fault(400, "Nonfinite or insolvent return");
    equity *= 1 + r;
    if (!Number.isFinite(equity) || equity <= 0)
      throw new Fault(400, "Nonfinite or insolvent equity");
    peak = Math.max(peak, equity);
    maxDrawdown = Math.max(maxDrawdown, 1 - equity / peak);
  }
  const { mean, norm } = centered(returns);
  const vol = returns.length > 1
    ? (norm / Math.sqrt(returns.length - 1)) * Math.sqrt(annualisation)
    : null;
  if (!Number.isFinite(mean) || (vol !== null && !Number.isFinite(vol)))
    throw new Fault(400, "Nonfinite statistics");
  return {
    samples: returns.length,
    totalReturn: equity - 1,
    annualizedVolatility: vol,
    maxDrawdown,
    mean,
  };
}
export async function simulate(
  rows: Row[],
  config: RunConfig,
  conventions: z.infer<typeof conventionsSchema>,
  cancelled: () => boolean = () => false,
): Promise<RunOutput> {
  if (rows.length > 10000) throw new Fault(413, "Observation bound exceeded");
  const selected = rows.filter(
    (r) => r.date >= config.start && r.date <= config.end,
  );
  if (
    selected.length < 2 ||
    selected[0].date !== config.start ||
    selected.at(-1)!.date !== config.end
  )
    throw new Fault(400, "Exact run endpoints must exist in dataset");
  if (
    config.rule === "exogenous" &&
    selected.some((r) => r.signal === undefined)
  )
    throw new Fault(400, "Exogenous rule requires signal column");
  const points: Point[] = [];
  let position = 0,
    equity = 1,
    peak = 1;
  const costRate = (config.feeBps + config.slippageBps) / 10000;
  // MA warmup starts inside the declared partition: no hidden prior data.
  for (let i = 1; i < selected.length; i++) {
    if (i % 128 === 1) {
      await setImmediate();
      if (cancelled()) throw new Fault(409, "Run cancelled");
    }
    let next = 1;
    if (config.rule === "exogenous") next = selected[i - 1].signal!;
    if (config.rule === "moving-average") {
      if (i < config.window) next = 0;
      else {
        let scale = 0;
        for (let j = i - config.window; j < i; j++)
          scale = Math.max(scale, selected[j].close);
        let sum = 0;
        for (let j = i - config.window; j < i; j++)
          sum += selected[j].close / scale;
        const mean = scale * (sum / config.window);
        if (!Number.isFinite(mean))
          throw new Fault(400, "Moving average exceeds numerical range");
        next = selected[i - 1].close > mean ? 1 : 0;
      }
    }
    const turnover = Math.abs(next - position),
      cost = turnover * costRate;
    const priceReturn = selected[i].close / selected[i - 1].close - 1;
    if (!Number.isFinite(priceReturn) || priceReturn <= -1)
      throw new Fault(400, "Close-to-close return outside supported numerical range");
    const r = next * priceReturn - cost;
    if (!Number.isFinite(r) || r <= -1)
      throw new Fault(
        400,
        "Reference simulation became nonfinite or insolvent",
      );
    equity *= 1 + r;
    if (!Number.isFinite(equity) || equity <= 0)
      throw new Fault(400, "Reference equity became nonfinite or insolvent");
    peak = Math.max(peak, equity);
    points.push({
      date: selected[i].date,
      periodStart: selected[i - 1].date,
      return: r,
      equity,
      drawdown: 1 - equity / peak,
      position: next,
      turnover,
      cost,
    });
    position = next;
  }
  if (cancelled()) throw new Fault(409, "Run cancelled");
  return {
    points,
    metrics: metrics(
      points.map((p) => p.return),
      conventions.annualisation,
    ),
    conventions,
    limitations: LIMITATIONS,
  };
}
export function validateExport(input: unknown): ExportPackage {
  if (Buffer.byteLength(JSON.stringify(input)) > 4 * 1024 * 1024)
    throw new Fault(413, "Export exceeds 4 MiB");
  const pkg = exportSchema.parse(input),
    b = pkg.body;
  if (contentHash(b) !== pkg.hash) throw new Fault(400, "Export hash mismatch");
  if (
    canonical(b.spec) !== canonical(b.config.spec) ||
    canonical(b.dataset) !== canonical(b.config.dataset) ||
    canonical(b.graph) !== canonical(b.config.graph) ||
    b.trialContext.partition !== b.config.partition ||
    b.costs.feeBps !== b.config.feeBps ||
    b.costs.slippageBps !== b.config.slippageBps
  )
    throw new Fault(400, "Inconsistent export provenance");
  if (
    b.trialContext.attempts !== b.trialContext.trials.length ||
    !b.trialContext.trials.some(
      (t) =>
        t.id === b.runId &&
        t.status === "completed" &&
        t.inputHash === b.inputHash,
    )
  )
    throw new Fault(400, "Inconsistent trial context");
  let prior = b.config.start,
    previousPosition = 0;
  for (const [index, p] of b.points.entries()) {
    if (b.config.rule === "buy-hold" && p.position !== 1)
      throw new Fault(400, "Buy-and-hold requires unit long exposure at every interval");
    if (b.config.rule === "moving-average") {
      if (p.position !== 0 && p.position !== 1)
        throw new Fault(400, "Moving-average exposure must be binary long/flat");
      if (index + 1 < b.config.window && p.position !== 0)
        throw new Fault(400, "Moving-average local warmup requires flat exposure");
    }
    if (p.position === 0 && p.return !== -p.cost)
      throw new Fault(400, "Flat exposure can earn only the negative turnover cost");
    if (p.position !== 0) {
      const impliedPriceReturn = (p.return + p.cost) / p.position;
      if (!Number.isFinite(impliedPriceReturn) || impliedPriceReturn <= -1)
        throw new Fault(400, "Export return is incompatible with finite positive close prices");
    }
    if (
      p.periodStart !== prior ||
      p.periodStart >= p.date ||
      p.date <= prior ||
      p.date > b.config.end
    )
      throw new Fault(400, "Export dates must be ascending in run range");
    prior = p.date;
    if (Math.abs(p.turnover - Math.abs(p.position - previousPosition)) > 1e-10)
      throw new Fault(400, "Inconsistent position turnover");
    previousPosition = p.position;
    if (
      Math.abs(
        p.cost - (p.turnover * (b.costs.feeBps + b.costs.slippageBps)) / 10000,
      ) > 1e-10
    )
      throw new Fault(400, "Inconsistent turnover cost");
  }
  if (prior !== b.config.end) throw new Fault(400, "Export missing final date");
  let equity = 1,
    peak = 1;
  const points = b.points.map((p) => {
    equity *= 1 + p.return;
    peak = Math.max(peak, equity);
    return { ...p, equity, drawdown: 1 - equity / peak };
  });
  const output = {
    points,
    metrics: metrics(
      b.points.map((p) => p.return),
      b.conventions.annualisation,
    ),
    conventions: b.conventions,
    limitations: LIMITATIONS,
  };
  if (contentHash(output) !== b.outputHash)
    throw new Fault(
      400,
      "Output hash does not reconcile with exported returns and declared engine",
    );
  return pkg;
}
export function allocate(
  vols: (number | null)[],
  settings: Allocation,
): number[] {
  const n = vols.length;
  if (n === 0 || n * settings.cap < 1 - 1e-12)
    throw new Fault(400, "Infeasible cap: sum of caps below one");
  if (settings.method === "manual") {
    const w = settings.weights;
    if (
      !w ||
      w.length !== n ||
      w.some((x) => !Number.isFinite(x) || x < 0 || x > settings.cap + 1e-12) ||
      Math.abs(w.reduce((a, b) => a + b, 0) - 1) > 1e-10
    )
      throw new Fault(
        400,
        "Manual weights must be nonnegative, obey caps and sum to one",
      );
    return w;
  }
  if (settings.weights)
    throw new Fault(400, "Weights only apply to manual allocation");
  if (
    settings.method === "inverse-volatility" &&
    vols.some((v) => v === null || v <= 0)
  )
    throw new Fault(
      400,
      "Inverse volatility undefined for insufficient samples or zero variance",
    );
  const minVol = settings.method === "inverse-volatility" ? Math.min(...vols as number[]) : 1;
  const scores = vols.map((v) => (settings.method === "equal" ? 1 : minVol / v!)),
    w = Array(n).fill(0) as number[];
  let free = scores.map((_, i) => i),
    remaining = 1;
  while (free.length) {
    const total = free.reduce((s, i) => s + scores[i], 0);
    if (!Number.isFinite(total) || total <= 0)
      throw new Fault(400, "Allocation exceeds supported numerical range");
    const capped = free.filter(
      (i) => (remaining * scores[i]) / total > settings.cap + 1e-12,
    );
    if (!capped.length) {
      for (const i of free) w[i] = (remaining * scores[i]) / total;
      break;
    }
    for (const i of capped) {
      w[i] = settings.cap;
      remaining -= settings.cap;
    }
    free = free.filter((i) => !capped.includes(i));
  }
  if (
    Math.abs(w.reduce((a, b) => a + b, 0) - 1) > 1e-10 ||
    w.some((v) => v < 0 || v > settings.cap + 1e-10)
  )
    throw new Fault(400, "Allocation failed reconciliation");
  return w;
}
export function analyze(
  packages: ExportPackage[],
  refs: Ref[],
  allocation: Allocation,
): AlignmentAnalysis {
  if (
    packages.length < 1 ||
    packages.length > 20 ||
    new Set(refs.map((r) => r.id)).size !== refs.length
  )
    throw new Fault(400, "Select 1–20 distinct import versions");
  const convention = canonical(packages[0].body.conventions);
  if (packages.some((p) => canonical(p.body.conventions) !== convention))
    throw new Fault(
      400,
      "Incompatible currency/frequency/calendar/timezone/capital/cost conventions",
    );
  const maps = packages.map(
      (p) => new Map(p.body.points.map((r) => [r.date, r.return])),
    ),
    dates = [...maps[0].keys()]
      .filter((d) => maps.every((m) => m.has(d)))
      .sort();
  if (dates.length < 2)
    throw new Fault(400, "Insufficient overlap: require two aligned returns");
  const starts = packages.map(
    (p) => new Map(p.body.points.map((r) => [r.date, r.periodStart])),
  );
  if (dates.some((d) => starts.some((m) => m.get(d) !== starts[0].get(d))))
    throw new Fault(
      400,
      "Incompatible aligned return intervals: equal end dates have different period starts",
    );
  const series = maps.map((m) => dates.map((d) => m.get(d)!)),
    annualisation = packages[0].body.conventions.annualisation,
    individual = series.map((s) => metrics(s, annualisation));
  const weights = allocate(
      individual.map((m) => m.annualizedVolatility),
      allocation,
    ),
    correlations: AlignmentAnalysis["correlations"] = [];
  for (let a = 0; a < series.length; a++)
    for (let b = a; b < series.length; b++) {
      const x = centered(series[a]), y = centered(series[b]);
      const value =
        x.norm === 0 || y.norm === 0
          ? null
          : Math.max(-1, Math.min(1, x.deviations.reduce(
              (sum, v, i) => sum + (v / x.norm) * (y.deviations[i] / y.norm), 0,
            )));
      correlations.push({
        a,
        b,
        n: dates.length,
        value,
        reason:
          value === null
            ? "Undefined: zero variance"
            : dates.length < 30
              ? "Small overlap; correlation is descriptive only"
              : null,
      });
    }
  let equity = 1,
    peak = 1;
  const points = dates.map((date, j) => {
    const r = weights.reduce((s, w, i) => s + w * series[i][j], 0);
    equity *= 1 + r;
    peak = Math.max(peak, equity);
    return {
      date,
      periodStart: starts[0].get(date)!,
      return: r,
      equity,
      drawdown: 1 - equity / peak,
      position: 1,
      turnover: 0,
      cost: 0,
    };
  });
  return {
    schema: "herdr-analysis-v1",
    imports: refs,
    dates,
    alignment: packages.map((p, i) => ({
      id: refs[i].id,
      original: p.body.points.length,
      retained: dates.length,
      dropped: p.body.points.length - dates.length,
    })),
    weights,
    allocation,
    individual,
    correlations,
    points,
    metrics: metrics(
      points.map((p) => p.return),
      annualisation,
    ),
    convention: "fixed-weight-rebalanced-diagnostic-blend",
    limitations: [
      "Intersection only; no fill. Each aligned observation is blended at constant weights.",
      "Standalone net returns; additional portfolio rebalance costs, netting, shared liquidity and margin are not simulated.",
      "Diagnostic return blend, not executable fills or proof of diversification.",
    ],
  };
}
