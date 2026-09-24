import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  analyze,
  validateExport,
  allocate,
  inspectCSV,
} from "../server/reference-engine.ts";
import { contentHash } from "../server/durable.ts";
import { externalPackage } from "./platform-fixtures.ts";
const refs = (a: { hash: string }, b: { hash: string }) => [
  { id: randomUUID(), hash: a.hash },
  { id: randomUUID(), hash: b.hash },
];
test("same end date with different return intervals blocks alignment rather than quietly mixing horizons", () => {
  const a = externalPackage(
      ["2026-01-02", "2026-01-03", "2026-01-06"],
      [0.1, -0.1, 0.05],
    ),
    b = externalPackage(
      ["2026-01-02", "2026-01-04", "2026-01-06"],
      [0.02, -0.02, 0.01],
    );
  validateExport(a);
  validateExport(b);
  assert.throws(
    () => analyze([a, b], refs(a, b), { method: "equal", cap: 1 }),
    /different period starts/,
  );
});
test("correlation avoids variance-product overflow and does not erase small nonzero variation", () => {
  for (const returns of [
    [1e150, 1e149],
    [1e-16, -1e-16],
  ]) {
    const a = externalPackage(["2026-01-02", "2026-01-03"], returns),
      b = externalPackage(["2026-01-02", "2026-01-03"], returns);
    const result = analyze([a, b], refs(a, b), {
      method: "inverse-volatility",
      cap: 1,
    });
    assert.ok(
      Math.abs(
        result.correlations.find((c) => c.a === 0 && c.b === 1)!.value! - 1,
      ) < 1e-12,
    );
    assert.ok(Math.abs(result.weights[0] - 0.5) < 1e-12);
  }
});
test("observed-date quality reports gaps explicitly; CSV inspection does not fill", () => {
  const result = inspectCSV("date,close\n2026-01-01,100\n2026-01-05,101", {
    columns: "date,close",
    start: "2026-01-01",
    end: "2026-01-05",
  });
  assert.deepEqual(result.findings, []);
  assert.equal(result.rows.length, 2);
  assert.ok(result.warnings.some((w) => w.includes("longest 4 calendar days")));
  assert.ok(result.warnings.some((w) => w.includes("no exchange-calendar")));
});
test("exports reject internally forged position turnover even when a wrapper hash is recomputed", () => {
  const pkg = externalPackage(["2026-01-02", "2026-01-03"], [0.1, -0.1]);
  pkg.body.points[1].turnover = 0.5;
  pkg.hash = contentHash(pkg.body);
  assert.throws(() => validateExport(pkg), /position turnover/);
  assert.throws(
    () => allocate([null, 0.1], { method: "inverse-volatility", cap: 1 }),
    /undefined/,
  );
});
