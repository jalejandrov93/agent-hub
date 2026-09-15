import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

/**
 * Write JSON atomically: serialize to a unique temp file in the same
 * directory as the target, then rename() over it. rename() within one
 * filesystem is atomic on POSIX, so a concurrent reader (the MCP process and
 * the separately running dashboard process both write these files) never
 * observes a partial/truncated file, and a crash mid-write leaves only the
 * orphaned temp file behind, never a corrupted target.
 */
export function writeJsonAtomic(file, data) {
  const dir = path.dirname(file)
  fs.mkdirSync(dir, { recursive: true })
  const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`)
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8')
  fs.renameSync(tmp, file)
}
