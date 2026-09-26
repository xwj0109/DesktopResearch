/** Pure helpers over zod form schemas, shared by the windows and the backend
 * (the backend saves ideas with the same blank-row rule as the Idea pane). */
export function unwrap(schema: any): any {
  return ["optional", "default", "nullable"].includes(schema.def.type)
    ? unwrap(schema.def.innerType)
    : schema;
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
