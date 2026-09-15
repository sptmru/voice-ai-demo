/** Shared persistence/observation redaction. Opaque record and provider call IDs remain intact. */
export function sanitize(value: unknown, depth = 0): unknown {
  if (depth > 12) return '[depth limit]';
  if (typeof value === 'string')
    return value
      .replace(/\b(?:sk-[\w-]{10,}|AIza[\w-]{20,})\b/g, '[REDACTED]')
      .replace(/(Bearer\s+)[\w.\-]+/gi, '$1[REDACTED]')
      .replace(/\b(password|secret|api[_-]?key|access[_-]?token)\s*[:=]\s*[^\s,;]+/gi, '$1=[REDACTED]')
      .slice(0, 12000);
  if (Array.isArray(value)) return value.slice(0, 100).map((item) => sanitize(item, depth + 1));
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [
        key,
        /^(?:password|secret|token|apiKey|authorization|credentials|privateKey|chainOfThought|reasoning)$/i.test(
          key,
        )
          ? '[REDACTED]'
          : key === 'id' || /^[a-zA-Z]+Id$/.test(key)
            ? child
            : sanitize(child, depth + 1),
      ]),
    );
  return value;
}
