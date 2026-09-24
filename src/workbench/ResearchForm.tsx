import type { z } from "zod";
export type Choice = { id: string; hash?: string; label: string };
export const fieldLabel = (s: string) =>
  s
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/[-_]/g, " ")
    .replace(/^./, (c) => c.toUpperCase());
export function unwrap(schema: any): any {
  return ["optional", "default", "nullable"].includes(schema.def.type)
    ? unwrap(schema.def.innerType)
    : schema;
}
export function initialValue(schema: any, name = ""): any {
  if (schema.def.type === "optional") return undefined;
  const s = unwrap(schema),
    type = s.def.type;
  if (type === "literal") return [...s.def.values][0];
  if (type === "enum") return Object.values(s.def.entries)[0];
  if (type === "array") return [];
  if (type === "object")
    return Object.fromEntries(
      Object.entries(s.shape).map(([key, value]) => [
        key,
        initialValue(value, key),
      ]),
    );
  if (type === "number")
    return name === "annualisation"
      ? 252
      : name === "window"
        ? 20
        : name === "cap"
          ? 1
          : 0;
  if (type === "boolean") return false;
  if (name === "id") return crypto.randomUUID();
  return "";
}

/** True when a list item was added but never filled in: it has text fields
 * and every one is blank (generated ids aside), with no reference chosen.
 * Items made only of numbers/choices are never considered blank. */
function isBlankItem(schema: any, value: any): boolean {
  let texts = 0;
  const blank = (s: any, v: any, name = ""): boolean => {
    const u = unwrap(s),
      type = u.def.type;
    if (type === "object") {
      if (u.shape.id && u.shape.hash) {
        texts++;
        return !v?.hash;
      }
      return Object.entries(u.shape).every(([k, child]) => blank(child, v?.[k], k));
    }
    if (type === "string") {
      if (name === "id") return true;
      texts++;
      return !String(v ?? "").trim();
    }
    if (type === "array") return !(v ?? []).length;
    return true;
  };
  return blank(schema, value) && texts > 0;
}
/** Drop list items the user added but left completely empty, at any depth,
 * so a stray "+ add item" doesn't block saving. Partly filled items stay
 * and are validated normally. */
export function pruneBlankItems(schema: any, value: any): any {
  if (!schema || value === undefined || value === null) return value;
  const s = unwrap(schema),
    type = s.def.type;
  if (type === "array" && Array.isArray(value))
    return value.filter((item) => !isBlankItem(s.element, item)).map((item) => pruneBlankItems(s.element, item));
  if (type === "object" && typeof value === "object" && !Array.isArray(value))
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, s.shape[k] ? pruneBlankItems(s.shape[k], v) : v]),
    );
  if (type === "union" || type === "discriminatedUnion") return value;
  return value;
}

/** Renders a zod schema as a labelled, validated-on-save research form.
 * Exact references (`{id, hash}` objects) are chosen from saved versions only. */
export function ResearchForm({
  schema,
  value,
  onChange,
  choices = [],
  name = "",
  depth = 0,
}: {
  schema: z.ZodType | any;
  value: any;
  onChange: (v: any) => void;
  choices?: Choice[];
  name?: string;
  depth?: number;
}) {
  const s = unwrap(schema),
    type = s.def.type,
    label = fieldLabel(name);
  if (type === "unknown")
    return (
      <label className="fld">
        {label}
        <textarea
          className="codeish"
          rows={8}
          value={
            typeof value === "string"
              ? value
              : JSON.stringify(value ?? {}, null, 2)
          }
          onChange={(e) => {
            try {
              onChange(JSON.parse(e.target.value));
            } catch {
              onChange(e.target.value);
            }
          }}
        />
        <small>
          Paste the complete exported proposal package. Validation happens
          before saving.
        </small>
      </label>
    );
  if (schema.def.type === "optional" && value === undefined)
    return (
      <button
        type="button"
        className="optional-add"
        onClick={() => onChange(initialValue(s, name))}
      >
        + add {label.toLowerCase()}
      </button>
    );
  if (type === "object" && s.shape.id && s.shape.hash)
    return (
      <label className="fld">
        {label}
        <select
          value={value?.id && value?.hash ? `${value.id}:${value.hash}` : ""}
          onChange={(e) => {
            const [id, hash] = e.target.value.split(":");
            onChange({ id, hash });
          }}
        >
          <option value="">
            {choices.some((c) => c.hash) ? "Choose a source or saved record…" : "Nothing to reference yet: import a paper in Sources"}
          </option>
          {choices
            .filter((c) => c.hash)
            .map((c) => (
              <option key={c.id + c.hash} value={`${c.id}:${c.hash}`}>
                {c.label}
              </option>
            ))}
        </select>
        <small>
          {value?.hash
            ? value.hash.slice(0, 16) + "… · exact version"
            : "Pick a paper from Sources or a saved record"}
        </small>
      </label>
    );
  if (type === "object") {
    const fields = Object.entries(s.shape)
      .filter(([key]) => key !== "type")
      .map(([key, child]) => (
        <ResearchForm
          key={key}
          schema={child}
          name={key}
          value={value?.[key]}
          choices={choices}
          depth={depth + 1}
          onChange={(v) => onChange({ ...value, [key]: v })}
        />
      ));
    return name ? (
      <fieldset>
        <legend>{label}</legend>
        {fields}
      </fieldset>
    ) : (
      <div className="form">{fields}</div>
    );
  }
  if (type === "array")
    return (
      <fieldset>
        <legend>{label}</legend>
        {(value ?? []).map((item: any, index: number) => (
          <div className="array-item" key={index}>
            <ResearchForm
              schema={s.element}
              value={item}
              name={String(index + 1)}
              choices={choices}
              depth={depth + 1}
              onChange={(v) =>
                onChange(
                  value.map((old: any, i: number) => (i === index ? v : old)),
                )
              }
            />
            <button
              type="button"
              className="btn small ghost"
              aria-label={`Move ${label.toLowerCase()} item ${index + 1} up`}
              disabled={index === 0}
              onClick={() => {
                const next = [...value];
                [next[index - 1], next[index]] = [next[index], next[index - 1]];
                onChange(next);
              }}
            >
              ↑
            </button>
            <button
              type="button"
              className="btn small ghost"
              aria-label={`Move ${label.toLowerCase()} item ${index + 1} down`}
              disabled={index === value.length - 1}
              onClick={() => {
                const next = [...value];
                [next[index + 1], next[index]] = [next[index], next[index + 1]];
                onChange(next);
              }}
            >
              ↓
            </button>
            <button
              type="button"
              className="btn small ghost"
              aria-label={`Remove ${label.toLowerCase()} item ${index + 1}`}
              onClick={() =>
                onChange(value.filter((_: any, i: number) => i !== index))
              }
            >
              ×
            </button>
          </div>
        ))}
        <button
          type="button"
          className="optional-add"
          onClick={() => onChange([...(value ?? []), initialValue(s.element)])}
        >
          + add {label.toLowerCase()} item
        </button>
      </fieldset>
    );
  if (type === "literal")
    return (
      <label className="fld">
        {label}
        <output>{String(value ?? initialValue(s))}</output>
      </label>
    );
  if (type === "enum")
    return (
      <label className="fld">
        {label}
        <select
          value={value ?? initialValue(s)}
          onChange={(e) => onChange(e.target.value)}
        >
          {Object.values(s.def.entries).map((v) => (
            <option key={String(v)} value={String(v)}>
              {fieldLabel(String(v))}
            </option>
          ))}
        </select>
      </label>
    );
  if (type === "boolean")
    return (
      <label className="fld inline">
        <input
          type="checkbox"
          checked={!!value}
          onChange={(e) => onChange(e.target.checked)}
        />
        {label}
      </label>
    );
  if (type === "number")
    return (
      <label className="fld">
        {label}
        <input
          type="number"
          step="any"
          value={value ?? ""}
          onChange={(e) =>
            onChange(e.target.value === "" ? undefined : Number(e.target.value))
          }
        />
      </label>
    );
  if (["handoff", "runId", "targetStrategyId"].includes(name))
    return (
      <label className="fld">
        {label}
        <select value={value ?? ""} onChange={(e) => onChange(e.target.value)}>
          <option value="">Select a saved record</option>
          {choices.map((c, i) => (
            <option key={c.id + String(i)} value={c.id}>
              {c.label}
            </option>
          ))}
        </select>
      </label>
    );
  if (name === "id")
    return (
      <label className="fld">
        {label}
        <input value={value ?? ""} onChange={(e) => onChange(e.target.value)} />
        <small>Stable record identity</small>
      </label>
    );
  return (
    <label className="fld">
      {label}
      {["start", "end"].includes(name) ? (
        <input
          type="date"
          value={value ?? ""}
          onChange={(e) => onChange(e.target.value)}
        />
      ) : (
        <textarea
          className={["source", "csv"].includes(name) ? "codeish" : ""}
          rows={name === "source" || name === "csv" ? 12 : 2}
          value={typeof value === "string" ? value : ""}
          onChange={(e) => onChange(e.target.value)}
        />
      )}
    </label>
  );
}
