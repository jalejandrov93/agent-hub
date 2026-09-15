/**
 * Scan text bottom-up for the last line that looks like a standalone JSON
 * object and parse it. Mirrors agy-run.sh's `grep -o '^{.*}$' | tail -1`:
 * agy prints diagnostics before its final JSON envelope.
 */
export function extractLastJsonLine(text) {
  const lines = text.split(/\r?\n/)
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim()
    if (line.startsWith('{') && line.endsWith('}')) {
      try {
        return JSON.parse(line)
      } catch {
        // not actually JSON (e.g. a log line that happens to start/end with braces) — keep scanning
      }
    }
  }
  return null
}

/** Parse a JSONL stream, silently skipping non-JSON noise lines. */
export function parseJsonl(text) {
  const events = []
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed.startsWith('{')) continue
    try {
      events.push(JSON.parse(trimmed))
    } catch {
      // skip a malformed or truncated line
    }
  }
  return events
}
