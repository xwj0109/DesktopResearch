import fs from "node:fs";
import zlib from "node:zlib";
import { ParquetWriter, fileWriter } from "hyparquet-writer";
import { asyncBufferFromFile, parquetMetadataAsync, parquetReadObjects } from "hyparquet";

/** Streaming Parquet output for data snapshots: typed columns, UTC-microsecond
 * timestamps (polars reads them as Datetime[μs, UTC]), zstd compression (Node's
 * built-in), row groups of 1M rows written as they fill so a tick day never
 * sits in memory twice. Readers: polars.scan_parquet("data/<name>/*.parquet"). */

export type ColType = "int64" | "float64" | "bool" | "string" | "timestamp";
export interface Column {
  name: string;
  type: ColType;
}
type Cell = string | number | bigint | boolean | null;

const zstd = (zlib as any).zstdCompressSync as ((b: Uint8Array) => Buffer) | undefined;
const codec = zstd ? ("ZSTD" as const) : ("SNAPPY" as const);
const compressors = zstd ? { ZSTD: (b: Uint8Array) => new Uint8Array(zstd(b)) } : undefined;
export const PARQUET_CODEC = codec;
/** Decompressors for reading Parquet (zstd from Node's zlib; snappy is built into the reader). */
const zstdDecompress = (zlib as any).zstdDecompressSync as ((b: Uint8Array) => Buffer) | undefined;
export const readCompressors = zstdDecompress ? { ZSTD: (input: Uint8Array) => new Uint8Array(zstdDecompress(input)) } : {};

const CHUNK = 500_000;
const ROW_GROUP = 1_000_000;

const schemaElement = (c: Column) => {
  const base = { name: c.name, repetition_type: "OPTIONAL" as const };
  switch (c.type) {
    case "int64":
      return { ...base, type: "INT64" as const };
    case "float64":
      return { ...base, type: "DOUBLE" as const };
    case "bool":
      return { ...base, type: "BOOLEAN" as const };
    case "string":
      return { ...base, type: "BYTE_ARRAY" as const, converted_type: "UTF8" as const };
    case "timestamp":
      return { ...base, type: "INT64" as const, logical_type: { type: "TIMESTAMP" as const, isAdjustedToUTC: true, unit: "MICROS" as const } };
  }
};

export class ParquetSink {
  private writer: ParquetWriter;
  private cols: Cell[][];
  rows = 0;
  constructor(
    readonly file: string,
    readonly columns: Column[],
  ) {
    this.writer = new ParquetWriter({
      writer: fileWriter(file),
      schema: [{ name: "root", num_children: columns.length }, ...columns.map(schemaElement)] as any,
      codec,
      ...(compressors ? { compressors } : {}),
    });
    this.cols = columns.map(() => []);
  }
  push(row: Cell[]) {
    for (let i = 0; i < this.columns.length; i++) this.cols[i].push(row[i] ?? null);
    this.rows++;
    if (this.cols[0].length >= CHUNK) this.flush();
  }
  private flush() {
    if (!this.cols[0].length) return;
    this.writer.write({ columnData: this.columns.map((c, i) => ({ name: c.name, data: this.cols[i] as any })), rowGroupSize: ROW_GROUP });
    this.cols = this.columns.map(() => []);
  }
  finish() {
    this.flush();
    this.writer.finish();
    return fs.statSync(this.file).size;
  }
}

/** Parse one CSV line (quoted fields, "" escapes). */
export function csvCells(line: string): string[] {
  if (!line.includes('"')) return line.split(",");
  const out: string[] = [];
  let cur = "",
    q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) {
      if (c === '"' && line[i + 1] === '"') (cur += '"'), i++;
      else if (c === '"') q = false;
      else cur += c;
    } else if (c === '"') q = true;
    else if (c === ",") out.push(cur), (cur = "");
    else cur += c;
  }
  out.push(cur);
  return out;
}

const TIME_NAME = /(^|_)(time|timestamp)$|^(open_time|close_time|calc_time|create_time|transact_time|event_time|transaction_time)$/i;
/** Microseconds since the epoch from ms/μs/s numbers or "YYYY-MM-DD[ HH:MM:SS]" text. */
export function toMicros(v: string): bigint | null {
  if (!v) return null;
  if (/^\d+$/.test(v)) {
    const n = BigInt(v);
    return v.length >= 16 ? n : v.length >= 12 ? n * 1000n : n * 1_000_000n;
  }
  const t = Date.parse(/Z|[+-]\d\d:?\d\d$/.test(v) ? v : `${v.replace(" ", "T")}Z`);
  return Number.isNaN(t) ? null : BigInt(t) * 1000n;
}
/** Column types from names and a sample row: times → timestamp, ids and counts → int64,
 * true/false → bool, numbers → float64, anything else → string. */
export function inferColumns(names: string[], sample: string[]): Column[] {
  return names.map((name, i) => {
    const v = (sample[i] ?? "").trim();
    if (TIME_NAME.test(name) && toMicros(v) !== null) return { name, type: "timestamp" };
    if (/^(true|false)$/i.test(v)) return { name, type: "bool" };
    if (/(^|_)(id|count|trades|hours|hour)$|^(id|count)$/i.test(name) && /^-?\d+$/.test(v)) return { name, type: "int64" };
    if (v === "" || /^-?\d*\.?\d+(e[-+]?\d+)?$/i.test(v)) return { name, type: /^(symbol|underlying|type|strike|date|base_asset|quote_asset)$/i.test(name) ? "string" : "float64" };
    return { name, type: "string" };
  });
}
/** A CSV cell as the column's type (empty → null). */
export function cellOf(type: ColType, v: string): Cell {
  if (v === "" || v === undefined) return null;
  switch (type) {
    case "timestamp":
      return toMicros(v);
    case "int64":
      return /^-?\d+$/.test(v) ? BigInt(v) : null;
    case "float64": {
      const n = Number(v);
      return Number.isFinite(n) ? n : null;
    }
    case "bool":
      return /^true$/i.test(v);
    default:
      return v;
  }
}
/** A typed value back to text for previews (timestamps as ISO). */
export const showCell = (type: ColType, v: Cell) =>
  v === null ? "" : type === "timestamp" ? new Date(Number(v) / 1000).toISOString() : String(v);

/** Preview of an existing Parquet file (registered by the user): schema, row count,
 * first/last rows, and a thinned value series when the file is not huge. */
export async function parquetPreview(file: string) {
  const buf = await asyncBufferFromFile(file);
  const meta = await parquetMetadataAsync(buf);
  const rows = Number(meta.num_rows);
  const columns = meta.schema.slice(1).filter((s: any) => !s.num_children).map((s: any) => s.name as string);
  const fmt = (r: Record<string, unknown>) =>
    columns.map((c) => {
      const v = r[c];
      return v instanceof Date ? v.toISOString() : typeof v === "bigint" ? v.toString() : v === null || v === undefined ? "" : String(v);
    });
  const opts = { file: buf, compressors: readCompressors as any };
  const head = (await parquetReadObjects({ ...opts, rowStart: 0, rowEnd: Math.min(rows, 20) })).map(fmt);
  const tail = rows > 20 ? (await parquetReadObjects({ ...opts, rowStart: Math.max(0, rows - 20), rowEnd: rows })).map(fmt) : head;
  const lower = columns.map((c) => c.toLowerCase());
  let vi = ["close", "price", "value", "index_value"].map((n) => lower.indexOf(n)).find((i) => i >= 0) ?? -1;
  if (vi < 0) vi = columns.length - 1;
  const series: [string, number][] = [];
  if (rows <= 2_000_000 && columns.length) {
    const step = Math.max(1, Math.ceil(rows / 2000));
    const data = await parquetReadObjects({ ...opts, columns: [columns[0], columns[vi]] });
    for (let i = 0; i < data.length; i += step) {
      const t = data[i][columns[0]],
        v = Number(data[i][columns[vi]]);
      if (Number.isFinite(v)) series.push([t instanceof Date ? t.toISOString() : String(t), v]);
    }
  }
  return { rows, columns, head, tail, series, valueColumn: columns[vi] ?? "" };
}
