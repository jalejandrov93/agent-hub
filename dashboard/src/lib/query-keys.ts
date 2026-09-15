/** Central query-key registry so every consumer (queries.ts, sse.ts, views) invalidates the same keys. */
export const qk = {
  state: ["state"] as const,
  config: ["config"] as const,
  metrics: ["metrics"] as const,
  proposals: ["proposals"] as const,
  learnings: ["learnings"] as const,
}
