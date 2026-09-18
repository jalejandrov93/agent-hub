/**
 * C1.1 safe condition/value DSL — replaces every `new Function` / `eval`.
 *
 * Supported grammar (no function calls except `exists(...)`):
 *
 *   expr      := orExpr
 *   orExpr    := andExpr (OR andExpr)*
 *   andExpr   := unary (AND unary)*
 *   unary     := NOT unary | primary
 *   primary   := existsExpr | '(' expr ')' | comparison | operand
 *   existsExpr:= 'exists' '(' path ')'
 *   comparison:= operand compOp operand
 *   operand   := path | literal
 *   path      := 'steps' '.' ident ('.' ident)*
 *            |  'context' '.' ident ('.' ident)*
 *   literal   := string | number | true | false | null | undefined
 *   compOp    := '===' | '!==' | '==' | '!=' | '>=' | '<=' | '>' | '<'
 *
 * Keywords AND/OR/NOT are case-insensitive; &&, ||, ! also accepted.
 * Anything else (calls, assignments, template literals, property
 * dunder access, semicolons) is rejected with an Error.
 */

const BLOCKED_IDENTIFIERS = new Set([
  'constructor',
  '__proto__',
  'prototype',
  '__defineGetter__',
  '__defineSetter__',
  '__lookupGetter__',
  '__lookupSetter__',
  'eval',
  'function',
  'new',
  'this',
  'global',
  'globalThis',
  'process',
  'require',
  'import',
  'export',
  'window',
])

function rejectUnsafe(src) {
  if (typeof src !== 'string') throw new Error('DSL expression must be a string')
  if (src.includes('`')) throw new Error('DSL rejects backticks')
  if (src.includes(';')) throw new Error('DSL rejects semicolons')
  if (/(^|[^=!<>])=(?!=)/.test(src)) throw new Error('DSL rejects assignment (=)')
  if (/\b(constructor|__proto__|prototype)\b/.test(src)) {
    throw new Error('DSL rejects prototype-polluting identifiers')
  }
  if (/=>/.test(src)) throw new Error('DSL rejects arrow functions')
  if (/\b(new|function|eval|require|import|export|delete|typeof|instanceof|in|void|yield|await)\b/.test(src)) {
    throw new Error('DSL rejects keywords used for code escape')
  }
  // Function-call parens: a word char / ] / quote directly before '('.
  // Grouping parens (preceded by operator/start) and exists( are the only
  // legal parens; exists( is stripped before this check by the caller path.
  const withoutExists = src.replace(/\bexists\s*\(/g, '')
  if (/[A-Za-z0-9_$\]'"]\s*\(/.test(withoutExists)) {
    throw new Error('DSL rejects call parentheses')
  }
}

function tokenize(src) {
  const tokens = []
  let i = 0
  const push = (type, value) => tokens.push({ type, value })
  while (i < src.length) {
    const c = src[i]
    if (/\s/.test(c)) { i++; continue }
    // Multi-char operators first
    const rest3 = src.slice(i, i + 3)
    const rest2 = src.slice(i, i + 2)
    if (rest3 === '===') { push('op', '==='); i += 3; continue }
    if (rest3 === '!==') { push('op', '!=='); i += 3; continue }
    if (rest2 === '==') { push('op', '=='); i += 2; continue }
    if (rest2 === '!=') { push('op', '!='); i += 2; continue }
    if (rest2 === '&&') { push('op', 'AND'); i += 2; continue }
    if (rest2 === '||') { push('op', 'OR'); i += 2; continue }
    if (rest2 === '>=') { push('op', '>='); i += 2; continue }
    if (rest2 === '<=') { push('op', '<='); i += 2; continue }
    if (c === '>') { push('op', '>'); i++; continue }
    if (c === '<') { push('op', '<'); i++; continue }
    if (c === '!') { push('op', 'NOT'); i++; continue }
    if (c === '(') { push('lparen', '('); i++; continue }
    if (c === ')') { push('rparen', ')'); i++; continue }
    if (c === '.') { push('dot', '.'); i++; continue }
    if (c === ',' ) { push('comma', ','); i++; continue }
    if (c === '"' || c === "'") {
      let j = i + 1
      let out = ''
      while (j < src.length && src[j] !== c) {
        if (src[j] === '\\' && j + 1 < src.length) {
          const n = src[j + 1]
          if (n === 'n') out += '\n'
          else if (n === 't') out += '\t'
          else out += n
          j += 2
        } else {
          out += src[j]
          j++
        }
      }
      if (j >= src.length) throw new Error('DSL unterminated string literal')
      push('string', out)
      i = j + 1
      continue
    }
    if (/[0-9]/.test(c) || (c === '-' && /[0-9]/.test(src[i + 1] ?? ''))) {
      const m = src.slice(i).match(/^-?\d+(\.\d+)?/)
      if (!m) throw new Error(`DSL bad number at offset ${i}`)
      push('number', Number(m[0]))
      i += m[0].length
      continue
    }
    if (/[A-Za-z_$]/.test(c)) {
      const m = src.slice(i).match(/^[A-Za-z_$][A-Za-z0-9_$]*/)
      const word = m[0]
      const upper = word.toUpperCase()
      if (upper === 'AND' || upper === 'OR' || upper === 'NOT') push('op', upper)
      else if (word === 'true') push('boolean', true)
      else if (word === 'false') push('boolean', false)
      else if (word === 'null') push('null', null)
      else if (word === 'undefined') push('undefined', undefined)
      else if (word === 'exists') push('exists', word)
      else if (word === 'steps' || word === 'context') push('root', word)
      else push('ident', word)
      i += word.length
      continue
    }
    throw new Error(`DSL unexpected character "${c}" at offset ${i}`)
  }
  return tokens
}

function safeGet(root, segments) {
  let cur = root
  for (const seg of segments) {
    if (BLOCKED_IDENTIFIERS.has(seg)) throw new Error(`DSL blocked identifier: ${seg}`)
    if (cur == null) return undefined
    if (typeof cur !== 'object') return undefined
    if (!Object.prototype.hasOwnProperty.call(cur, seg)) return undefined
    cur = cur[seg]
  }
  return cur
}

function looseEqual(a, b, strict) {
  // eslint-disable-next-line eqeqeq
  return strict ? a === b : a == b
}

export function createParser(tokens, scope) {
  let pos = 0
  const peek = () => tokens[pos] ?? null
  const next = () => tokens[pos++] ?? null

  function parseExpr() { return parseOr() }

  function parseOr() {
    let left = parseAnd()
    while (peek()?.type === 'op' && peek().value === 'OR') {
      next()
      const right = parseAnd()
      left = Boolean(left) || Boolean(right)
    }
    return left
  }

  function parseAnd() {
    let left = parseUnary()
    while (peek()?.type === 'op' && peek().value === 'AND') {
      next()
      const right = parseUnary()
      left = Boolean(left) && Boolean(right)
    }
    return left
  }

  function parseUnary() {
    const t = peek()
    if (t?.type === 'op' && t.value === 'NOT') {
      next()
      return !parseUnary()
    }
    return parsePrimary()
  }

  function parsePrimary() {
    const t = peek()
    if (!t) throw new Error('DSL unexpected end of expression')
    if (t.type === 'lparen') {
      next()
      const v = parseExpr()
      const c = next()
      if (!c || c.type !== 'rparen') throw new Error('DSL missing closing paren')
      return v
    }
    if (t.type === 'exists') {
      next()
      const lp = next()
      if (!lp || lp.type !== 'lparen') throw new Error('DSL exists() needs parens')
      const v = parseOperandValue()
      const rp = next()
      if (!rp || rp.type !== 'rparen') throw new Error('DSL exists() missing closing paren')
      return v !== undefined && v !== null
    }
    // comparison or bare operand: parse operand, then optional compOp + operand
    const left = parseOperandValue()
    const op = peek()
    if (op?.type === 'op' && ['==', '!=', '===', '!==', '>', '>=', '<', '<='].includes(op.value)) {
      next()
      const right = parseOperandValue()
      switch (op.value) {
        case '==': return looseEqual(left, right, false)
        case '!=': return !looseEqual(left, right, false)
        case '===': return left === right
        case '!==': return left !== right
        case '>': return left > right
        case '>=': return left >= right
        case '<': return left < right
        case '<=': return left <= right
        default: throw new Error(`DSL unknown operator ${op.value}`)
      }
    }
    return left
  }

  function parseOperandValue() {
    const t = peek()
    if (!t) throw new Error('DSL unexpected end of expression')
    if (t.type === 'string' || t.type === 'number' || t.type === 'boolean' || t.type === 'null' || t.type === 'undefined') {
      next()
      return t.value ?? (t.type === 'undefined' ? undefined : t.value)
    }
    if (t.type === 'root') {
      return parsePath()
    }
    if (t.type === 'lparen') {
      next()
      const v = parseExpr()
      const c = next()
      if (!c || c.type !== 'rparen') throw new Error('DSL missing closing paren')
      return v
    }
    if (t.type === 'op' && t.value === 'NOT') {
      next()
      return !parseUnary()
    }
    if (t.type === 'exists') {
      // exists() as operand
      next()
      const lp = next()
      if (!lp || lp.type !== 'lparen') throw new Error('DSL exists() needs parens')
      const v = parseOperandValue()
      const rp = next()
      if (!rp || rp.type !== 'rparen') throw new Error('DSL exists() missing closing paren')
      return v !== undefined && v !== null
    }
    throw new Error(`DSL unexpected token "${t.value}"`)
  }

  function parsePath() {
    const root = next() // steps | context
    const base = root.value === 'steps' ? scope.steps : scope.context
    const segments = []
    while (peek()?.type === 'dot') {
      next()
      const id = next()
      if (!id || (id.type !== 'ident' && id.type !== 'root' && id.type !== 'exists')) {
        throw new Error('DSL expected identifier after dot')
      }
      if (BLOCKED_IDENTIFIERS.has(id.value)) throw new Error(`DSL blocked identifier: ${id.value}`)
      segments.push(id.value)
    }
    if (segments.length === 0) throw new Error(`DSL bare "${root.value}" is not a value`)
    return safeGet(base, segments)
  }

  return {
    parseExpr,
    get pos() { return pos },
    get length() { return tokens.length },
  }
}

/**
 * Evaluates a DSL expression and returns its raw value.
 * @param {string} src
 * @param {{ steps?: object, context?: object }} scope
 */
export function evaluateValue(src, scope = {}) {
  rejectUnsafe(src)
  const tokens = tokenize(src)
  if (tokens.length === 0) throw new Error('DSL empty expression')
  const parser = createParser(tokens, { steps: scope.steps ?? {}, context: scope.context ?? {} })
  const value = parser.parseExpr()
  if (parser.pos !== parser.length) {
    throw new Error('DSL trailing tokens after expression')
  }
  return value
}

/**
 * Evaluates a DSL condition string to boolean. Empty/blank => true.
 * Unparseable or unsafe => throws (callers decide fallback).
 */
export function evaluateConditionSafe(conditionStr, scope = {}) {
  if (!conditionStr || typeof conditionStr !== 'string' || conditionStr.trim() === '') return true
  return Boolean(evaluateValue(conditionStr, scope))
}
