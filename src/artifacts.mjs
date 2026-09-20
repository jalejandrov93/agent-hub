import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { paths } from './config.mjs'

export const ARTIFACT_SEGMENT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

function isValidSegment(val) {
  return typeof val === 'string' && ARTIFACT_SEGMENT_PATTERN.test(val) && !val.includes('..')
}

function assertValidSegment(val, fieldName = 'segment') {
  if (!isValidSegment(val)) {
    throw new Error(`invalid ${fieldName}: ${val}`)
  }
}

export function artifactsDir({ workflowId, stepId } = {}, env = process.env) {
  assertValidSegment(workflowId, 'workflowId')
  assertValidSegment(stepId, 'stepId')
  const base = paths(env).runsDir
  const dir = path.join(base, workflowId, stepId, 'artifacts')
  const resolved = path.resolve(dir)
  const resolvedBase = path.resolve(base) + path.sep
  if (!resolved.startsWith(resolvedBase)) {
    throw new Error(`path traversal detected: ${resolved}`)
  }
  return dir
}

export function artifactPath({ workflowId, stepId, name } = {}, env = process.env) {
  assertValidSegment(workflowId, 'workflowId')
  assertValidSegment(stepId, 'stepId')
  assertValidSegment(name, 'name')
  const base = paths(env).runsDir
  const dir = artifactsDir({ workflowId, stepId }, env)
  const fullPath = path.join(dir, name)
  const resolved = path.resolve(fullPath)
  const resolvedBase = path.resolve(base) + path.sep
  if (!resolved.startsWith(resolvedBase)) {
    throw new Error(`path traversal detected: ${resolved}`)
  }
  return fullPath
}

export function artifactRef(workflowId, stepId, name) {
  assertValidSegment(workflowId, 'workflowId')
  assertValidSegment(stepId, 'stepId')
  assertValidSegment(name, 'name')
  return 'artifact://' + workflowId + '/' + stepId + '/' + name
}

export function parseArtifactRef(ref) {
  if (typeof ref !== 'string' || !ref.startsWith('artifact://')) {
    return null
  }
  const rest = ref.slice('artifact://'.length)
  const parts = rest.split('/')
  if (parts.length !== 3) {
    return null
  }
  const [workflowId, stepId, name] = parts
  if (!isValidSegment(workflowId) || !isValidSegment(stepId) || !isValidSegment(name)) {
    return null
  }
  return { workflowId, stepId, name }
}

function normalizeRefOrSpec(refOrSpec) {
  if (typeof refOrSpec === 'string') {
    const parsed = parseArtifactRef(refOrSpec)
    if (!parsed) {
      throw new Error('invalid artifact ref: ' + refOrSpec)
    }
    return { spec: parsed, ref: refOrSpec }
  }
  if (typeof refOrSpec === 'object' && refOrSpec !== null) {
    const { workflowId, stepId, name } = refOrSpec
    assertValidSegment(workflowId, 'workflowId')
    assertValidSegment(stepId, 'stepId')
    assertValidSegment(name, 'name')
    return {
      spec: { workflowId, stepId, name },
      ref: artifactRef(workflowId, stepId, name)
    }
  }
  throw new Error('invalid artifact ref or spec: ' + refOrSpec)
}

export function writeArtifact({ workflowId, stepId, name, content }, env = process.env) {
  const filePath = artifactPath({ workflowId, stepId, name }, env)
  const dir = path.dirname(filePath)
  fs.mkdirSync(dir, { recursive: true })

  if (typeof content !== 'string' && !Buffer.isBuffer(content)) {
    throw new Error('content must be a string or Buffer')
  }

  const buf = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8')
  const tmp = path.join(dir, `.${name}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`)
  fs.writeFileSync(tmp, buf)
  fs.renameSync(tmp, filePath)

  const bytes = buf.byteLength
  const sha256 = crypto.createHash('sha256').update(buf).digest('hex')
  const ref = artifactRef(workflowId, stepId, name)

  return { ref, path: filePath, bytes, sha256 }
}

export function readArtifact(refOrSpec, env = process.env) {
  const { spec, ref } = normalizeRefOrSpec(refOrSpec)
  const filePath = artifactPath(spec, env)
  let buf
  try {
    buf = fs.readFileSync(filePath)
  } catch (err) {
    if (err.code === 'ENOENT') {
      throw new Error('artifact not found: ' + ref)
    }
    throw err
  }
  const content = buf.toString('utf8')
  const bytes = buf.byteLength
  const sha256 = crypto.createHash('sha256').update(buf).digest('hex')
  return { ref, path: filePath, content, bytes, sha256 }
}

export function existsArtifact(refOrSpec, env = process.env) {
  const { spec } = normalizeRefOrSpec(refOrSpec)
  const filePath = artifactPath(spec, env)
  return fs.existsSync(filePath)
}

export function listArtifacts({ workflowId, stepId } = {}, env = process.env) {
  assertValidSegment(workflowId, 'workflowId')
  assertValidSegment(stepId, 'stepId')
  const dir = artifactsDir({ workflowId, stepId }, env)
  if (!fs.existsSync(dir)) {
    return []
  }
  const entries = fs.readdirSync(dir, { withFileTypes: true })
  const result = []
  for (const ent of entries) {
    if (ent.isFile() && isValidSegment(ent.name)) {
      const fullPath = path.join(dir, ent.name)
      const stat = fs.statSync(fullPath)
      result.push({
        name: ent.name,
        ref: artifactRef(workflowId, stepId, ent.name),
        path: fullPath,
        bytes: stat.size
      })
    }
  }
  result.sort((a, b) => a.name.localeCompare(b.name))
  return result
}

export function collectManifest({ workflowId, stepId, declared = [] } = {}, env = process.env) {
  assertValidSegment(workflowId, 'workflowId')
  assertValidSegment(stepId, 'stepId')
  const present = []
  const missing = []
  const artifacts = {}

  for (const name of declared) {
    assertValidSegment(name, 'name')
    const ref = artifactRef(workflowId, stepId, name)
    const filePath = artifactPath({ workflowId, stepId, name }, env)
    let exists = false
    let bytes = 0
    let sha256 = null

    try {
      if (fs.existsSync(filePath)) {
        const buf = fs.readFileSync(filePath)
        exists = true
        bytes = buf.byteLength
        sha256 = crypto.createHash('sha256').update(buf).digest('hex')
      }
    } catch {
      // In case of read/stat errors, treat as missing
    }

    if (exists) {
      present.push(name)
    } else {
      missing.push(name)
    }

    artifacts[name] = { ref, exists, bytes, sha256 }
  }

  return { declared: [...declared], present, missing, artifacts }
}

export function resolveArtifactRefs(text, { env = process.env, maxBytesPerRef = 65536 } = {}) {
  if (typeof text !== 'string') {
    return { text: '', refs: [], missing: [] }
  }

  const refs = []
  const missing = []
  const tokenRegex = /artifact:\/\/[^\s"'`]+/g

  const replacedText = text.replace(tokenRegex, (match) => {
    const parsed = parseArtifactRef(match)
    if (!parsed) {
      missing.push(match)
      return match
    }
    try {
      const art = readArtifact(parsed, env)
      let content = art.content
      let truncated = false
      if (art.bytes > maxBytesPerRef) {
        truncated = true
        const buf = Buffer.from(content, 'utf8')
        content = buf.subarray(0, maxBytesPerRef).toString('utf8') + '\n...[artifact truncated]'
      }
      refs.push({ ref: match, bytes: art.bytes, truncated })
      return content
    } catch {
      missing.push(match)
      return match
    }
  })

  return { text: replacedText, refs, missing }
}
