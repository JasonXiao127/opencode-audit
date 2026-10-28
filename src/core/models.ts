// Model identity helpers. Pure logic, no I/O.

/** provider/model base without variant, e.g. "opencode/nemotron-3-ultra-free". */
export function baseKey(key: string): string {
  return key.split("#")[0] ?? key;
}

/**
 * Family guess for independence checks: provider + first model-name segment.
 * "openrouter/meta-llama/llama-3.1-8b" and "openrouter/meta-llama/llama-3.1-70b"
 * share a family; different providers never do.
 */
export function familyOf(key: string): string {
  const base = baseKey(key);
  const slash = base.indexOf("/");
  const provider = slash >= 0 ? base.slice(0, slash) : "";
  const rest = slash >= 0 ? base.slice(slash + 1) : base;
  const lastSeg = rest.split("/").pop() ?? rest;
  const first = lastSeg.split(/[-_]/)[0] ?? lastSeg;
  return `${provider}/${first}`.toLowerCase();
}

/** "provider/id[#variant]" -> ModelRef. */
export function parseModelKey(key: string): { providerID: string; id: string; variant?: string } {
  const [base, variant] = key.split("#");
  const slash = (base ?? key).indexOf("/");
  if (slash < 0) return { providerID: "", id: base ?? key, ...(variant ? { variant } : {}) };
  return {
    providerID: base.slice(0, slash),
    id: base.slice(slash + 1),
    ...(variant ? { variant } : {}),
  };
}
