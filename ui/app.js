/**
 * dbx-mybatis-tool — 解析 MyBatis / MyBatis-Plus 的 DEBUG 日志，
 * 把 Parameters 行中的参数回填到 Preparing SQL 的 ? 占位符，得到可直接执行的 SQL。
 *
 * 解析引擎为纯函数（parseLog / parseParams / fillSql 等）并 export，
 * 便于在 Node 中运行测试：node test/run.mjs
 */

// ---------- 类型渲染 ----------

const NUMERIC_TYPES = /^(Integer|Long|Short|Byte|Double|Float|BigDecimal|BigInteger|Number|int|long|short|byte|double|float)$/;
const BOOLEAN_TYPES = /^(Boolean|boolean)$/;
// Java 日期/时间类型渲染为 ANSI 字面量（DATE '...' / TIMESTAMP '...'）：
// Oracle 在函数参数位置（如 trunc(?)）不会把 'string' 隐式转为 DATE，普通引号形式会报 ORA-00932；
// String 类型仍渲染为 'value'（to_date(?, 'fmt') 这类吃字符串的场景不受影响）。
const DATE_TYPES = /^(Date|LocalDate|Year|YearMonth|MonthDay)$/;
const TIMESTAMP_TYPES = /^(Timestamp|LocalDateTime|OffsetDateTime|ZonedDateTime|Instant)$/;
const TIME_TYPES = /^(Time|LocalTime)$/;

function shortType(type) {
  return type ? String(type).split('.').pop() : '';
}

// Java 时间类型的 toString 可能是 ISO 格式（带 T 和时区偏移），归一化为 SQL 字面量形式
function normalizeTemporal(value) {
  return String(value).replace('T', ' ').replace(/(Z|[+-]\d{2}:\d{2})$/, '');
}

export function renderParam(p) {
  if (p.isNull) return 'NULL';
  const t = shortType(p.type);
  if (!t) return String(p.value); // 解析失败的原样残段
  if (NUMERIC_TYPES.test(t) || BOOLEAN_TYPES.test(t)) return String(p.value);
  if (DATE_TYPES.test(t)) return `DATE '${normalizeTemporal(p.value)}'`;
  if (TIMESTAMP_TYPES.test(t)) return `TIMESTAMP '${normalizeTemporal(p.value)}'`;
  if (TIME_TYPES.test(t)) return `TIME '${normalizeTemporal(p.value)}'`;
  return `'${String(p.value).replace(/'/g, "''")}'`;
}

// ---------- 参数列表解析 ----------

/**
 * 解析 "==> Parameters:" 之后的内容，形如：
 *   2026-10-06 00:00:00(String), 0(Long), null, 950321300499333120(Long)
 * 值本身可能含逗号，因此不能用 split(',')；逐段匹配「值 + (类型) + 行尾/逗号」。
 * MyBatis 对 null 参数输出裸 "null"（不带类型括号）。
 */
export function parseParams(text) {
  const params = [];
  let malformed = false;
  const s = String(text == null ? '' : text).trim();
  let i = 0;
  const n = s.length;
  while (i < n) {
    while (i < n && /\s/.test(s[i])) i++;
    if (i >= n) break;
    if (s.startsWith('null', i)) {
      const after = i + 4;
      if (after === n || s[after] === ',') {
        params.push({ value: null, type: null, isNull: true });
        i = after === n ? n : after + 1;
        continue;
      }
    }
    const m = s.slice(i).match(/^([\s\S]*?)\(\s*([A-Za-z_$][\w$.]*?)\s*\)(?=\s*(?:,|$))/);
    if (m) {
      params.push({ value: m[1], type: m[2], isNull: false });
      i += m[0].length;
      if (s[i] === ',') i++;
    } else {
      // 兜底：剩余内容无法按参数模式解析时原样保留，交由警告提示
      params.push({ value: s.slice(i).trim(), type: null, isNull: false, raw: true });
      malformed = true;
      break;
    }
  }
  return { params, malformed };
}

// ---------- 占位符统计与回填 ----------

/** 统计 ? 数量，跳过 '...' 字符串字面量（含 '' 转义）。 */
export function countPlaceholders(sql) {
  let count = 0;
  let i = 0;
  const n = sql.length;
  while (i < n) {
    if (sql[i] === "'") {
      i++;
      while (i < n) {
        if (sql[i] === "'") {
          if (sql[i + 1] === "'") { i += 2; continue; }
          i++;
          break;
        }
        i++;
      }
      continue;
    }
    if (sql[i] === '?') count++;
    i++;
  }
  return count;
}

/** 把参数按顺序回填到 ?（跳过 '...' 字面量内的 ?）。 */
export function fillSql(sql, params) {
  let out = '';
  let pi = 0;
  let missing = false;
  let i = 0;
  const n = sql.length;
  while (i < n) {
    const ch = sql[i];
    if (ch === "'") {
      out += ch;
      i++;
      while (i < n) {
        out += sql[i];
        if (sql[i] === "'") {
          if (sql[i + 1] === "'") { out += sql[i + 1]; i += 2; continue; }
          i++;
          break;
        }
        i++;
      }
      continue;
    }
    if (ch === '?') {
      if (pi < params.length) {
        out += renderParam(params[pi]);
        pi++;
      } else {
        out += '?';
        missing = true;
      }
      i++;
      continue;
    }
    out += ch;
    i++;
  }
  return { sql: out, used: pi, missing };
}

// ---------- MyBatis XML → SQL ----------

const STATEMENT_TAGS = new Set(['select', 'insert', 'update', 'delete']);

function decodeEntities(s) {
  return s.replace(/&(#x[0-9a-fA-F]+|#\d+|lt|gt|amp|quot|apos);/g, (m, e) => {
    if (e === 'lt') return '<';
    if (e === 'gt') return '>';
    if (e === 'amp') return '&';
    if (e === 'quot') return '"';
    if (e === 'apos') return "'";
    const code = e[1] === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
    return Number.isFinite(code) ? String.fromCodePoint(code) : m;
  });
}

function findTagEnd(src, start) {
  let quote = '';
  for (let i = start + 1; i < src.length; i++) {
    const ch = src[i];
    if (quote) { if (ch === quote) quote = ''; continue; }
    if (ch === '"' || ch === "'") { quote = ch; continue; }
    if (ch === '>') return i;
  }
  return src.length;
}

function skipDeclaration(src, start) {
  let quote = '';
  let bracket = 0;
  for (let i = start + 2; i < src.length; i++) {
    const ch = src[i];
    if (quote) { if (ch === quote) quote = ''; continue; }
    if (ch === '"' || ch === "'") { quote = ch; continue; }
    if (ch === '[') { bracket++; continue; }
    if (ch === ']') { bracket = Math.max(0, bracket - 1); continue; }
    if (ch === '>' && !bracket) return i + 1;
  }
  return src.length;
}

function parseAttrs(text) {
  const attrs = {};
  const re = /([^\s=/>]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  let m;
  while ((m = re.exec(text))) attrs[m[1]] = decodeEntities(m[2] == null ? m[3] : m[2]);
  return attrs;
}

/** 容错的轻量 XML 解析：注释/CDATA/DOCTYPE/自闭合标签；不校验嵌套。 */
function parseXml(src) {
  const root = { name: '#root', attrs: {}, children: [] };
  const stack = [root];
  const top = () => stack[stack.length - 1];
  const pushText = (text, decode = true) => {
    const value = decode ? decodeEntities(text) : text;
    if (value) top().children.push({ text: value });
  };
  let i = 0;
  const n = src.length;
  while (i < n) {
    const lt = src.indexOf('<', i);
    if (lt === -1) { pushText(src.slice(i)); break; }
    if (lt > i) pushText(src.slice(i, lt));
    if (src.startsWith('<!--', lt)) {
      const end = src.indexOf('-->', lt + 4);
      i = end === -1 ? n : end + 3;
      continue;
    }
    if (src.startsWith('<![CDATA[', lt)) {
      const end = src.indexOf(']]>', lt + 9);
      pushText(src.slice(lt + 9, end === -1 ? n : end), false);
      i = end === -1 ? n : end + 3;
      continue;
    }
    if (src.startsWith('<?', lt)) {
      const end = src.indexOf('?>', lt + 2);
      i = end === -1 ? n : end + 2;
      continue;
    }
    if (src.startsWith('<!', lt)) { i = skipDeclaration(src, lt); continue; }
    if (src.startsWith('</', lt)) {
      const end = src.indexOf('>', lt);
      if (end === -1) break;
      const name = src.slice(lt + 2, end).trim();
      for (let k = stack.length - 1; k > 0; k--) {
        if (stack[k].name === name) { stack.length = k; break; }
      }
      i = end + 1;
      continue;
    }
    const end = findTagEnd(src, lt);
    const raw = src.slice(lt + 1, end);
    const selfClosing = /\/\s*$/.test(raw);
    const nameMatch = raw.match(/^\s*([\w:.-]+)/);
    if (!nameMatch) { i = end + 1; continue; }
    const node = { name: nameMatch[1], attrs: {}, children: [] };
    node.attrs = parseAttrs(raw.slice(nameMatch[0].length).replace(/\/\s*$/, ''));
    top().children.push(node);
    if (!selfClosing) stack.push(node);
    i = end + 1;
  }
  return root;
}

// ---------- OGNL 子集求值（test / bind / ${} / #{}） ----------

const OGNL_CMP = {
  '==': 'eq', eq: 'eq', '!=': 'ne', ne: 'ne',
  '>': 'gt', gt: 'gt', '>=': 'ge', ge: 'ge',
  '<': 'lt', lt: 'lt', '<=': 'le', le: 'le',
};

function tokenizeExpr(src) {
  const tokens = [];
  const s = String(src);
  let i = 0;
  while (i < s.length) {
    const ch = s[i];
    if (/\s/.test(ch)) { i++; continue; }
    let m;
    if ((m = s.slice(i).match(/^\d+(?:\.\d+)?/))) { tokens.push({ t: 'num', v: Number(m[0]) }); i += m[0].length; continue; }
    if (ch === "'" || ch === '"') {
      let j = i + 1;
      let value = '';
      while (j < s.length) {
        if (s[j] === ch) {
          if (s[j + 1] === ch) { value += ch; j += 2; continue; }
          j++;
          break;
        }
        value += s[j++];
      }
      tokens.push({ t: 'str', v: value });
      i = j;
      continue;
    }
    if ((m = s.slice(i).match(/^(==|!=|>=|<=|&&|\|\||[><+\-*/()[\],.!])/))) { tokens.push({ t: 'op', v: m[0] }); i += m[0].length; continue; }
    if ((m = s.slice(i).match(/^[A-Za-z_$][\w$]*/))) { tokens.push({ t: 'id', v: m[0] }); i += m[0].length; continue; }
    throw new Error(`无法识别 "${ch}"`);
  }
  return tokens;
}

function parseExpression(src) {
  const tokens = tokenizeExpr(src);
  let pos = 0;
  const peek = () => tokens[pos];
  const isWord = (t, word) => Boolean(t) && t.t === 'id' && t.v === word;
  const isOp = (t, op) => Boolean(t) && t.t === 'op' && t.v === op;
  const eat = (fn) => { const t = peek(); if (t && fn(t)) { pos++; return t; } return null; };

  function parseOr() {
    let node = parseAnd();
    while (eat((t) => isWord(t, 'or') || isOp(t, '||'))) node = { type: 'or', left: node, right: parseAnd() };
    return node;
  }
  function parseAnd() {
    let node = parseNot();
    while (eat((t) => isWord(t, 'and') || isOp(t, '&&'))) node = { type: 'and', left: node, right: parseNot() };
    return node;
  }
  function parseNot() {
    if (eat((t) => isWord(t, 'not') || isOp(t, '!'))) return { type: 'not', value: parseNot() };
    return parseCmp();
  }
  function parseCmp() {
    const left = parseAdd();
    const t = peek();
    if (t && (t.t === 'op' || t.t === 'id') && OGNL_CMP[t.v]) {
      pos++;
      return { type: 'cmp', op: OGNL_CMP[t.v], left, right: parseAdd() };
    }
    return left;
  }
  function parseAdd() {
    let node = parseMul();
    let t;
    while ((t = eat((x) => isOp(x, '+') || isOp(x, '-')))) node = { type: 'arith', op: t.v, left: node, right: parseMul() };
    return node;
  }
  function parseMul() {
    let node = parsePrimary();
    let t;
    while ((t = eat((x) => isOp(x, '*') || isOp(x, '/')))) node = { type: 'arith', op: t.v, left: node, right: parsePrimary() };
    return node;
  }
  function parsePrimary() {
    const t = peek();
    if (!t) throw new Error('表达式为空');
    if (t.t === 'num' || t.t === 'str') { pos++; return { type: 'lit', value: t.v }; }
    if (isOp(t, '(')) {
      pos++;
      const node = parseOr();
      if (!eat((x) => isOp(x, ')'))) throw new Error('缺少 )');
      return node;
    }
    if (isOp(t, '-')) { pos++; return { type: 'neg', value: parsePrimary() }; }
    if (t.t === 'id') {
      pos++;
      if (t.v === 'null') return { type: 'lit', value: null };
      if (t.v === 'true') return { type: 'lit', value: true };
      if (t.v === 'false') return { type: 'lit', value: false };
      let node = { type: 'ident', name: t.v };
      while (isOp(peek(), '.')) {
        pos++;
        const nameTok = peek();
        if (!nameTok || nameTok.t !== 'id') throw new Error('缺少属性名');
        pos++;
        if (eat((x) => isOp(x, '('))) {
          const args = [];
          if (!isOp(peek(), ')')) {
            do { args.push(parseOr()); } while (eat((x) => isOp(x, ',')));
          }
          if (!eat((x) => isOp(x, ')'))) throw new Error('缺少 )');
          node = { type: 'call', object: node, name: nameTok.v, args };
        } else {
          node = { type: 'prop', object: node, name: nameTok.v };
        }
      }
      return node;
    }
    throw new Error(`意外的符号 "${t.v}"`);
  }

  const ast = parseOr();
  if (pos < tokens.length) throw new Error(`多余的符号 "${tokens[pos].v}"`);
  return ast;
}

function evalAst(node, ctx) {
  switch (node.type) {
    case 'lit': return node.value;
    case 'ident': return ctx[node.name];
    case 'prop': {
      const object = evalAst(node.object, ctx);
      if (object == null) return undefined;
      if (node.name === 'size' || node.name === 'length') {
        return typeof object === 'string' || Array.isArray(object) ? object.length : undefined;
      }
      return object[node.name];
    }
    case 'call': {
      const object = evalAst(node.object, ctx);
      const args = node.args.map((arg) => evalAst(arg, ctx));
      if (node.name === 'equals') return object === args[0];
      if (node.name === 'contains') {
        if (Array.isArray(object)) return object.includes(args[0]);
        return typeof object === 'string' ? object.includes(String(args[0])) : false;
      }
      if (node.name === 'isEmpty') {
        return object == null || ((typeof object === 'string' || Array.isArray(object)) && object.length === 0);
      }
      if (node.name === 'size' || node.name === 'length') {
        if (object == null) return 0;
        return typeof object === 'string' || Array.isArray(object) ? object.length : Object.keys(object).length;
      }
      if (node.name === 'toString') return String(object);
      throw new Error(`不支持的方法 ${node.name}()`);
    }
    case 'not': return !evalAst(node.value, ctx);
    case 'neg': return -evalAst(node.value, ctx);
    case 'and': return Boolean(evalAst(node.left, ctx)) && Boolean(evalAst(node.right, ctx));
    case 'or': return Boolean(evalAst(node.left, ctx)) || Boolean(evalAst(node.right, ctx));
    case 'cmp': {
      const left = evalAst(node.left, ctx);
      const right = evalAst(node.right, ctx);
      if (node.op === 'eq') return left === right || (left == null && right == null);
      if (node.op === 'ne') return !(left === right || (left == null && right == null));
      if (left == null || right == null) return false;
      if (node.op === 'gt') return left > right;
      if (node.op === 'ge') return left >= right;
      if (node.op === 'lt') return left < right;
      return left <= right;
    }
    case 'arith': {
      const left = evalAst(node.left, ctx);
      const right = evalAst(node.right, ctx);
      if (node.op === '+' && (typeof left === 'string' || typeof right === 'string')) return String(left) + String(right);
      if (node.op === '-') return Number(left) - Number(right);
      if (node.op === '*') return Number(left) * Number(right);
      if (node.op === '/') return Number(left) / Number(right);
      return Number(left) + Number(right);
    }
    default:
      throw new Error(`未知表达式 ${node.type}`);
  }
}

function evalExpression(src, ctx) {
  return evalAst(parseExpression(src), ctx);
}

function getPath(ctx, path) {
  if (!path) return undefined;
  let value = ctx;
  for (const part of String(path).split('.')) {
    if (value == null) return undefined;
    value = value[part];
  }
  return value;
}

// ---------- XML 语句渲染 ----------

function renderLiteral(value) {
  if (value === null) return 'NULL';
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return `'${String(value).replace(/'/g, "''")}'`;
}

function warnOnce(env, message) {
  if (!env.seen.has(message)) {
    env.seen.add(message);
    env.warnings.push(message);
  }
}

function renderText(text, ctx, env) {
  return text.replace(/([#$])\{([^{}]*)\}/g, (match, kind, body) => {
    const expr = body.split(',')[0].trim();
    if (!expr) return match;
    let value;
    try {
      value = evalExpression(expr, ctx);
    } catch (e) {
      env.unresolved++;
      if (kind === '$') {
        warnOnce(env, `占位符 ${match} 无法解析（${e.message}），已原样保留。`);
        return match;
      }
      warnOnce(env, `占位符 ${match} 无法解析（${e.message}），已用 NULL 代替。`);
      return 'NULL';
    }
    if (value === undefined) {
      env.unresolved++;
      if (kind === '$') {
        // ${} 多用于表名/列名，替换成 NULL 会破坏语法，保持原样并告警
        warnOnce(env, `参数 ${expr} 未提供，${match} 原样保留。`);
        return match;
      }
      warnOnce(env, `参数 ${expr} 未提供，已用 NULL 代替。`);
      return 'NULL';
    }
    if (kind === '$') return value == null ? '' : String(value); // MyBatis: null → 空串
    env.inlined++;
    return renderLiteral(value);
  });
}

function evalTest(expr, ctx, env) {
  if (expr == null || !String(expr).trim()) return true;
  try {
    return Boolean(evalExpression(expr, ctx));
  } catch (e) {
    warnOnce(env, `test="${expr}" 无法解析（${e.message}），已按条件成立处理。`);
    return true;
  }
}

function applyOverride(text, spec, atStart) {
  if (!spec) return text;
  for (const part of spec.split('|')) {
    const override = part.trim();
    if (!override) continue;
    if (atStart && text.toLowerCase().startsWith(override.toLowerCase())) return text.slice(override.length).trimStart();
    if (!atStart && text.toLowerCase().endsWith(override.toLowerCase())) return text.slice(0, -override.length).trimEnd();
  }
  return text;
}

function renderForeach(node, ctx, env) {
  const collection = getPath(ctx, node.attrs.collection);
  if (collection == null) {
    warnOnce(env, `foreach 集合 "${node.attrs.collection || ''}" 无值，已跳过。`);
    return '';
  }
  let entries;
  if (Array.isArray(collection)) entries = collection.map((value, index) => [index, value]);
  else if (typeof collection === 'object') entries = Object.entries(collection);
  else entries = [[0, collection]];

  const itemName = node.attrs.item || 'item';
  const indexName = node.attrs.index || 'index';
  const parts = [];
  for (const [key, value] of entries) {
    const sub = { ...ctx, [itemName]: value, [indexName]: key };
    parts.push(renderNodes(node.children, sub, env).trim());
  }
  if (!parts.length) return '';
  return `${node.attrs.open || ''}${parts.join(node.attrs.separator == null ? '' : node.attrs.separator)}${node.attrs.close || ''}`;
}

function renderNodes(nodes, ctx, env) {
  let out = '';
  for (const node of nodes) {
    if (node.text !== undefined) {
      out += renderText(node.text, ctx, env);
      continue;
    }
    switch (node.name) {
      case 'if':
        if (evalTest(node.attrs.test, ctx, env)) out += renderNodes(node.children, ctx, env);
        break;
      case 'choose': {
        let matched = false;
        for (const child of node.children) {
          if (!child.name || matched) continue;
          if (child.name === 'when' && evalTest(child.attrs.test, ctx, env)) {
            out += renderNodes(child.children, ctx, env);
            matched = true;
          } else if (child.name === 'otherwise') {
            out += renderNodes(child.children, ctx, env);
            matched = true;
          }
        }
        break;
      }
      case 'where': {
        const inner = renderNodes(node.children, ctx, env).trim().replace(/^(and|or)\b\s*/i, '');
        if (inner) out += ` WHERE ${inner}`;
        break;
      }
      case 'set': {
        const inner = renderNodes(node.children, ctx, env).trim().replace(/,\s*$/, '');
        if (inner) out += ` SET ${inner}`;
        break;
      }
      case 'trim': {
        let inner = renderNodes(node.children, ctx, env).trim();
        inner = applyOverride(inner, node.attrs.prefixOverrides, true);
        inner = applyOverride(inner, node.attrs.suffixOverrides, false);
        // 与 MyBatis 一致：prefix/suffix 与内容之间插入空格
        if (inner) out += `${node.attrs.prefix || ''} ${inner} ${node.attrs.suffix || ''}`;
        break;
      }
      case 'foreach':
        out += renderForeach(node, ctx, env);
        break;
      case 'include': {
        const refid = node.attrs.refid;
        const fragment = refid && env.fragments.get(refid);
        if (!fragment) {
          warnOnce(env, `include 引用的 SQL 片段 "${refid || ''}" 未找到。`);
          break;
        }
        env.includeDepth = (env.includeDepth || 0) + 1;
        if (env.includeDepth > 10) {
          warnOnce(env, 'include 嵌套过深，已跳过。');
          env.includeDepth--;
          break;
        }
        out += renderNodes(fragment.children, ctx, env);
        env.includeDepth--;
        break;
      }
      case 'bind':
        if (node.attrs.name) {
          try {
            ctx[node.attrs.name] = evalExpression(node.attrs.value || '', ctx);
          } catch (e) {
            warnOnce(env, `bind ${node.attrs.name} 无法解析（${e.message}）。`);
          }
        }
        break;
      case 'selectKey':
      case 'sql':
        break;
      default:
        out += renderNodes(node.children, ctx, env);
    }
  }
  return out;
}

/** 合并空白，但保留单引号字符串字面量内部原样。 */
function squashSpaces(sql) {
  let out = '';
  let i = 0;
  const n = sql.length;
  while (i < n) {
    const ch = sql[i];
    if (ch === "'") {
      const start = i;
      i++;
      while (i < n) {
        if (sql[i] === "'") {
          if (sql[i + 1] === "'") { i += 2; continue; }
          i++;
          break;
        }
        i++;
      }
      out += sql.slice(start, i);
      continue;
    }
    if (/\s/.test(ch)) {
      while (i < n && /\s/.test(sql[i])) i++;
      out += ' ';
      continue;
    }
    out += ch;
    i++;
  }
  return out.trim();
}

/**
 * 解析 mapper XML 并渲染为可执行 SQL。
 * params 用于求值 <if test>、<foreach collection> 与 #{}；未提供的 #{} 用 NULL 代替。
 * 返回 { statements: [{ tag, id, sql, warnings, inlined, unresolved }], warnings }
 */
export function parseMapperXml(xmlText, params) {
  const root = parseXml(String(xmlText == null ? '' : xmlText));
  const fragments = new Map();
  (function collectFragments(node) {
    for (const child of node.children || []) {
      if (!child.name) continue;
      if (child.name === 'sql' && child.attrs.id) fragments.set(child.attrs.id, child);
      collectFragments(child);
    }
  })(root);

  const statementNodes = [];
  (function collectStatements(node) {
    for (const child of node.children || []) {
      if (!child.name) continue;
      if (STATEMENT_TAGS.has(child.name)) { statementNodes.push(child); continue; }
      if (child.name === 'sql') continue;
      collectStatements(child);
    }
  })(root);

  const warnings = [];
  if (!statementNodes.length) {
    warnings.push('未找到 <select>/<insert>/<update>/<delete> 语句，请粘贴完整的 mapper XML。');
  }
  const baseParams = params && typeof params === 'object' && !Array.isArray(params) ? params : {};

  const statements = statementNodes.map((node) => {
    const env = {
      warnings: [],
      seen: new Set(),
      inlined: 0,
      unresolved: 0,
      fragments,
      includeDepth: 0,
      warn(message) { warnOnce(this, message); },
    };
    const sql = squashSpaces(renderNodes(node.children, { ...baseParams }, env));
    return {
      tag: node.name,
      id: node.attrs.id || '',
      sql,
      warnings: env.warnings,
      inlined: env.inlined,
      unresolved: env.unresolved,
    };
  });
  return { statements, warnings };
}

// ---------- JSON 日志（logstash / 自定义 SqlLogger） ----------

const JSON_NUMBER = /^-?\d+(?:\.\d+)?$/;

/** 按逗号切分 "[a, b, c]"，忽略引号和嵌套括号内的逗号。 */
function splitParamList(text) {
  const s = String(text == null ? '' : text).trim();
  if (!s) return [];
  const inner = s.startsWith('[') && s.endsWith(']') ? s.slice(1, -1) : s;
  if (!inner.trim()) return [];
  const items = [];
  let buf = '';
  let quote = '';
  let depth = 0;
  for (const ch of inner) {
    if (quote) {
      buf += ch;
      if (ch === quote) quote = '';
      continue;
    }
    if (ch === "'" || ch === '"') { quote = ch; buf += ch; continue; }
    if (ch === '(' || ch === '[' || ch === '{') depth++;
    if (ch === ')' || ch === ']' || ch === '}') depth = Math.max(0, depth - 1);
    if (ch === ',' && !depth) { items.push(buf.trim()); buf = ''; continue; }
    buf += ch;
  }
  items.push(buf.trim());
  return items;
}

// Parameters 是 List.toString()，值不带类型：按字面量推断（数字/布尔/null 原样，其余加引号）
function paramFromItem(item) {
  const raw = item.trim();
  if (/^null$/i.test(raw)) return { value: null, type: null, isNull: true };
  let text = raw;
  if ((text.startsWith("'") && text.endsWith("'")) || (text.startsWith('"') && text.endsWith('"'))) {
    text = text.slice(1, -1);
  }
  if (JSON_NUMBER.test(text)) return { value: text, type: 'Long', isNull: false };
  if (/^(true|false)$/i.test(text)) return { value: text, type: 'Boolean', isNull: false };
  return { value: text, type: 'String', isNull: false };
}

function paramFromValue(value) {
  if (value == null) return { value: null, type: null, isNull: true };
  if (typeof value === 'number') return { value: String(value), type: 'Long', isNull: false };
  if (typeof value === 'boolean') return { value: String(value), type: 'Boolean', isNull: false };
  return { value: String(value), type: 'String', isNull: false };
}

/**
 * 识别形如 {... "SqlId": "...", "ExecuteSql": "...", "Parameters": "[admin01]"} 的 JSON 日志行。
 * 行首的 logback/Spring 前缀会被忽略。
 */
function parseSqlLoggerJson(line) {
  if (!line.includes('"ExecuteSql"')) return null;
  const start = line.indexOf('{');
  const end = line.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  let obj;
  try {
    obj = JSON.parse(line.slice(start, end + 1));
  } catch (e) {
    return null;
  }
  if (!obj || typeof obj !== 'object' || typeof obj.ExecuteSql !== 'string') return null;
  const raw = obj.Parameters;
  const params = Array.isArray(raw)
    ? raw.map(paramFromValue)
    : splitParamList(raw == null ? '' : String(raw)).map(paramFromItem);
  return {
    sql: obj.ExecuteSql,
    paramsText: null,
    presetParams: params,
    mapper: typeof obj.SqlId === 'string' ? obj.SqlId : '',
    timestamp: extractTimestamp(line),
    traceId: extractTraceId(line),
    total: null,
  };
}

// ---------- 日志行解析 ----------

function extractMapper(line) {
  // ==〉 箭头可能被日志采集系统清洗掉；Preparing: 之前的部分才是日志头
  const head = line.split('==>')[0].split(/Preparing:/)[0];
  let m = head.match(/([\w$]+(?:\.[\w$]+)*Mapper\.\w+)/);
  if (m) return m[1];
  m = head.match(/\|-([A-Za-z_][\w$]*(?:\.[\w$]+)*)\|/);
  if (m) return m[1];
  m = head.match(/([A-Za-z_][\w$]*(?:\.[A-Za-z_]\w*)+)/);
  return m ? m[1] : '';
}

function shortMapper(full) {
  if (!full) return '';
  const parts = full.split('.');
  return parts.length >= 2 ? parts[parts.length - 2] + '.' + parts[parts.length - 1] : full;
}

function extractTimestamp(line) {
  const m = line.match(/^(\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:\.\d+)?)/);
  return m ? m[1] : '';
}

function extractTraceId(line) {
  let m = line.match(/TRACEID:\[([^\]]*)\]/);
  if (m) return m[1];
  // SkyWalking / Sleuth 风格：INFO [service, traceId, spanId]
  m = line.match(/\b(?:TRACE|DEBUG|INFO|WARN|ERROR)\s+\[\s*[^,[\]]+\s*,\s*([0-9a-zA-Z-]{8,})\s*,/);
  return m ? m[1] : '';
}

/**
 * 解析整段日志。返回 { statements, warnings }，
 * 每个 statement：{ sql, params, filledSql, placeholders, mapper, mapperShort,
 *                   timestamp, traceId, total, hasParametersLine, warnings }
 */
export function parseLog(text, options) {
  const statements = [];
  const warnings = [];
  let current = null;

  for (const line of String(text || '').split(/\r?\n/)) {
    const jsonStatement = parseSqlLoggerJson(line);
    if (jsonStatement) {
      statements.push(jsonStatement);
      continue;
    }
    if (line.includes('"ExecuteSql"')) {
      const msg = '发现 JSON SQL 日志但无法解析，已跳过。';
      if (!warnings.includes(msg)) warnings.push(msg);
    }
    let m;
    if ((m = line.match(/(?:==>)?\s*\bPreparing:\s*([\s\S]*)$/))) {
      current = {
        sql: m[1].trim(),
        paramsText: null,
        mapper: extractMapper(line),
        timestamp: extractTimestamp(line),
        traceId: extractTraceId(line),
        total: null,
      };
      continue;
    }
    if ((m = line.match(/(?:==>)?\s*\bParameters:\s*([\s\S]*)$/))) {
      if (current) {
        current.paramsText = m[1].trim();
        statements.push(current);
        current = null;
      } else {
        warnings.push('发现参数行但缺少对应的 Preparing 行，已忽略。');
      }
      continue;
    }
    if ((m = line.match(/(?:<==)?\s*\bTotal:\s*(\d+)/))) {
      const last = statements[statements.length - 1];
      if (last && last.total === null) last.total = Number(m[1]);
      continue;
    }
  }
  if (current) statements.push(current); // 只有 Preparing、Parameters 缺失的残组

  const result = finalizeStatements(statements);
  if (options && options.quoteAll) quoteAllParams(result);
  return { statements: result, warnings };
}

/** 所有非 null 参数按字符串重新生成 SQL。 */
function quoteAllParams(statements) {
  for (const st of statements) {
    let changed = false;
    for (const p of st.params) {
      if (!p.isNull) { p.type = 'String'; changed = true; }
    }
    if (changed) st.filledSql = fillSql(st.sql, st.params).sql;
  }
}

/** 参数解析 + 回填 + 一致性告警，供内置解析和自定义格式共用。 */
function finalizeStatements(statements) {
  for (const st of statements) {
    const { params, malformed } = st.presetParams
      ? { params: st.presetParams, malformed: false }
      : parseParams(st.paramsText || '');
    st.params = params;
    st.placeholders = countPlaceholders(st.sql);
    const filled = fillSql(st.sql, params);
    st.filledSql = filled.sql;
    st.hasParametersLine = st.presetParams ? true : st.paramsText !== null;
    st.mapperShort = shortMapper(st.mapper);
    st.warnings = [];
    if (!st.hasParametersLine) {
      st.warnings.push('未找到对应的 Parameters 行，? 未被替换。');
    } else {
      if (malformed) {
        st.warnings.push('参数列表解析不完整，末尾一段按原样回填，请人工核对。');
      }
      if (filled.missing) {
        st.warnings.push(`参数 ${params.length} 个，少于占位符 ${st.placeholders} 个，剩余 ? 保持原样。`);
      } else if (params.length > st.placeholders) {
        st.warnings.push(`参数 ${params.length} 个，多于占位符 ${st.placeholders} 个，多余参数已忽略。`);
      }
    }
  }
  return statements;
}

// ---------- 自定义日志格式 ----------

const KNOWN_GROUPS = ['time', 'mapper', 'sql', 'parameters'];

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 把 "{mapper} ... {sql} ... {parameters}" 转成正则：
 * 占位符变成捕获组，其余文本按字面量匹配（单行内搜索，不要求整行）。
 * {sql} 等已知占位符会取值，其他 {名字} 仅用于跳过中间字段。
 */
function buildFormatRegex(format) {
  const src = String(format == null ? '' : format);
  const matches = Array.from(src.matchAll(/\{([A-Za-z_][\w]*)\}/g));
  const names = [];
  let pattern = '';
  let last = 0;
  matches.forEach((m, index) => {
    pattern += escapeRegExp(src.slice(last, m.index));
    const name = m[1];
    if (names.includes(name)) throw new Error(`占位符 {${name}} 重复`);
    names.push(name);
    // 末尾的占位符没有后续字面量约束，必须贪婪，否则匹配为空
    const trailing = index === matches.length - 1 && m.index + m[0].length === src.length;
    pattern += trailing ? '(.*)' : '(.*?)';
    last = m.index + m[0].length;
  });
  pattern += escapeRegExp(src.slice(last));
  if (!names.includes('sql')) throw new Error('必须包含 {sql} 占位符');
  return { regex: new RegExp(pattern), names };
}

/** 参数既可能是 "1(Integer), x(String)"，也可能是 "[admin01, 2]"，自动识别。 */
function parseParamsAuto(text) {
  const s = String(text == null ? '' : text).trim();
  if (!s) return { params: [], malformed: false };
  const typed = parseParams(s);
  if (!typed.malformed && typed.params.some((p) => p.type || p.isNull)) return typed;
  return { params: splitParamList(s).map(paramFromItem), malformed: false };
}

/**
 * 按自定义格式逐行解析日志。format 中的占位符：
 * {time} {mapper} {sql}（必填） {parameters}；其余文本按字面量匹配。
 * options.quoteAll 为 true 时所有参数按字符串加单引号（null 仍为 NULL）。
 */
export function parseLogWithFormat(text, format, options) {
  const quoteAll = Boolean(options && options.quoteAll);
  let compiled;
  try {
    compiled = buildFormatRegex(format);
  } catch (e) {
    return { statements: [], warnings: [`自定义日志格式无效：${e.message}`] };
  }

  const statements = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    if (!line.trim()) continue;
    const m = compiled.regex.exec(line);
    if (!m) continue;
    const fields = {};
    compiled.names.forEach((name, i) => {
      if (KNOWN_GROUPS.includes(name)) fields[name] = m[i + 1] == null ? '' : m[i + 1];
    });
    if (!fields.sql || !fields.sql.trim()) continue;
    statements.push({
      sql: fields.sql.trim(),
      paramsText: null,
      presetParams: parseParamsAuto(fields.parameters).params,
      mapper: fields.mapper || '',
      timestamp: fields.time || extractTimestamp(line),
      traceId: extractTraceId(line),
      total: null,
    });
  }

  const warnings = statements.length
    ? []
    : ['当前日志格式未匹配到任何 SQL 行，请检查格式配置。'];
  const result = finalizeStatements(statements);
  if (quoteAll) quoteAllParams(result);
  return { statements: result, warnings };
}

// ================= UI（仅浏览器环境执行） =================

if (typeof document !== 'undefined') {
  const SAMPLE = [
    "2026-10-13 13:41:30.232|-|yl-jmsvn-tms-report-api|-|http-nio-8080-exec-9|-|DEBUG|-|com.yl.tms.report.mapper.photo.PhotoTaskLogMapper.pageCount|-|TRACEID:[43ed9083cd0a47c38489534822ae294a]-|==>  Preparing: select count(1) from YL_TMS_PHOTO_TASK_LOG l INNER JOIN YL_TMS_PHOTO_TASK p ON l.TASK_ID = p.ID WHERE l.CREATE_TIME >= to_date(?, 'yyyy-MM-dd HH24:mi:ss') and l.CREATE_TIME <= to_date(?, 'yyyy-MM-dd HH24:mi:ss')",
    "2026-10-13 13:41:30.232|-|yl-jmsvn-tms-report-api|-|http-nio-8080-exec-9|-|DEBUG|-|com.yl.tms.report.mapper.photo.PhotoTaskLogMapper.pageCount|-|TRACEID:[43ed9083cd0a47c38489534822ae294a]-|==> Parameters: 2026-10-06 00:00:00(String), 2026-10-13 23:59:59(String)",
    "2026-10-13 13:41:30.239|-|yl-jmsvn-tms-report-api|-|http-nio-8080-exec-9|-|DEBUG|-|com.yl.tms.report.mapper.photo.PhotoTaskLogMapper.pageCount|-|TRACEID:[43ed9083cd0a47c38489534822ae294a]-|<==      Total: 1",
    "2026-10-13 13:41:30.241|-|yl-jmsvn-tms-report-api|-|http-nio-8080-exec-9|-|DEBUG|-|com.yl.tms.report.mapper.photo.PhotoTaskLogMapper.pageList|-|TRACEID:[43ed9083cd0a47c38489534822ae294a]-|==>  Preparing: select * from ( select r.*, rownum rn from ( select l.* from YL_TMS_PHOTO_TASK_LOG l INNER JOIN YL_TMS_PHOTO_TASK p ON l.TASK_ID = p.ID WHERE l.CREATE_TIME >= to_date(?, 'yyyy-MM-dd HH24:mi:ss') and l.CREATE_TIME <= to_date(?, 'yyyy-MM-dd HH24:mi:ss') order by l.CREATE_TIME desc ) r where rownum <= ? + ? ) where rn > ?",
    "2026-10-13 13:41:30.242|-|yl-jmsvn-tms-report-api|-|http-nio-8080-exec-9|-|DEBUG|-|com.yl.tms.report.mapper.photo.PhotoTaskLogMapper.pageList|-|TRACEID:[43ed9083cd0a47c38489534822ae294a]-|==> Parameters: 2026-10-06 00:00:00(String), 2026-10-13 23:59:59(String), 0(Long), 100(Long), 0(Long)",
    "2026-10-13 13:41:30.258|-|yl-jmsvn-tms-report-api|-|http-nio-8080-exec-9|-|DEBUG|-|com.yl.tms.report.mapper.photo.PhotoTaskLogMapper.pageList|-|TRACEID:[43ed9083cd0a47c38489534822ae294a]-|<==      Total: 21",
  ].join('\n');

  const SAMPLE_XML = `<mapper namespace="com.example.UserMapper">
  <sql id="cols">id, name, status</sql>
  <select id="search" resultType="map">
    select <include refid="cols"/> from t_user
    <where>
      <if test="name != null and name != ''">and name like #{name}</if>
      <if test="statuses != null and statuses.size() > 0">
        and status in
        <foreach collection="statuses" item="s" open="(" separator="," close=")">#{s}</foreach>
      </if>
    </where>
    order by id desc
  </select>
</mapper>`;
  const SAMPLE_PARAMS = `{"name": "张%", "statuses": [1, 2]}`;
  // 只写日志中稳定出现的片段即可，无需整行；{success} 只是跳过中间字段
  const SAMPLE_FORMAT = '"SqlId":"{mapper}","ExecuteSql":"{sql}","Success":"{success}","Parameters":"{parameters}"';

  const CONFIG_KEY = 'dbx-mybatis-tool.log-formats';

  function loadConfigState() {
    try {
      const raw = window.localStorage.getItem(CONFIG_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed && Array.isArray(parsed.configs)) {
          return {
            configs: parsed.configs
              .filter((c) => c && typeof c.id === 'string' && typeof c.format === 'string')
              .map((c) => ({
                id: c.id,
                name: typeof c.name === 'string' ? c.name : '',
                format: c.format,
                quoteAll: c.quoteAll === true,
              })),
            activeId: typeof parsed.activeId === 'string' ? parsed.activeId : '',
            defaultQuoteAll: parsed.defaultQuoteAll === true,
          };
        }
      }
    } catch (e) { /* localStorage 不可用时仅内存生效 */ }
    return { configs: [], activeId: '', defaultQuoteAll: false };
  }

  const configState = loadConfigState();

  function saveConfigState() {
    try {
      window.localStorage.setItem(CONFIG_KEY, JSON.stringify(configState));
    } catch (e) { /* ignore */ }
  }

  function activeConfig() {
    return configState.configs.find((c) => c.id === configState.activeId) || null;
  }

  const $ = (sel) => document.querySelector(sel);

  function esc(s) {
    return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  }

  async function copyText(text, btn) {
    const done = () => {
      const old = btn.textContent;
      btn.textContent = '已复制 ✓';
      btn.classList.add('ok');
      setTimeout(() => { btn.textContent = old; btn.classList.remove('ok'); }, 1200);
    };
    const fail = (b) => {
      const old = b.textContent;
      b.textContent = '复制失败，请手动选择';
      setTimeout(() => { b.textContent = old; }, 2000);
    };
    try {
      const dbx = window.dbxPlugin;
      if (dbx && dbx.clipboard && typeof dbx.clipboard.writeText === 'function') {
        await dbx.clipboard.writeText(text);
      } else if (dbx && typeof dbx.copy === 'function') {
        await dbx.copy(text);
      } else {
        throw new Error('no bridge');
      }
      done();
      return;
    } catch (e) {
      // 兜底：隐藏 textarea + execCommand
      try {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.cssText = 'position:fixed;left:-9999px;top:0';
        document.body.appendChild(ta);
        ta.select();
        const ok = document.execCommand('copy');
        document.body.removeChild(ta);
        if (ok) done();
        else fail(btn);
      } catch (e2) {
        fail(btn);
      }
    }
  }

  function cardHtml(st, idx) {
    const metaBits = [];
    if (st.timestamp) metaBits.push(esc(st.timestamp));
    if (st.traceId) metaBits.push('TRACE ' + esc(st.traceId.slice(0, 8)));
    metaBits.push(`参数 ${st.params.length}/${st.placeholders}`);
    if (st.total !== null && st.total !== undefined) metaBits.push(`Total ${st.total}`);
    const warns = st.warnings.map((w) => `<div class="warn">⚠ ${esc(w)}</div>`).join('');
    const paramRows = st.params
      .map((p, i) => `<tr><td>#${i + 1}</td><td>${esc(p.isNull ? 'null' : p.value)}</td><td>${esc(p.isNull ? '—' : shortType(p.type) || '未识别')}</td><td><code>${esc(renderParam(p))}</code></td></tr>`)
      .join('');
    return `<article class="card">
      <header class="card-head">
        <div class="card-title">
          <span class="mapper" title="${esc(st.mapper)}">${esc(st.mapperShort || 'SQL #' + (idx + 1))}</span>
          <span class="meta">${metaBits.join(' · ')}</span>
        </div>
        <button type="button" class="btn copy-sql" data-idx="${idx}">复制 SQL</button>
      </header>
      ${warns}
      <pre class="sql">${esc(st.filledSql)}</pre>
      ${st.params.length ? `<details class="params"><summary>参数明细（${st.params.length}）</summary><table><thead><tr><th>#</th><th>值</th><th>类型</th><th>回填为</th></tr></thead><tbody>${paramRows}</tbody></table></details>` : ''}
    </article>`;
  }

  function renderLog() {
    const text = $('#log-input').value;
    const list = $('#results');
    const summary = $('#summary');

    if (!text.trim()) {
      summary.hidden = true;
      list.innerHTML = `<div class="empty">粘贴包含 <code>Preparing:</code> 和 <code>Parameters:</code> 的 MyBatis 日志（<code>==&gt;</code> 箭头有无均可），或 <code>{"SqlId":…,"ExecuteSql":…,"Parameters":…}</code> 形式的 JSON 日志。格式不同可在「格式配置」里自定义。</div>`;
      return;
    }

    const cfg = activeConfig();
    const { statements, warnings } = cfg
      ? parseLogWithFormat(text, cfg.format, { quoteAll: cfg.quoteAll })
      : parseLog(text, { quoteAll: configState.defaultQuoteAll });
    const globalWarns = warnings.map((w) => `<div class="warn">⚠ ${esc(w)}</div>`).join('');
    summary.hidden = statements.length === 0;
    if (!statements.length) {
      list.innerHTML = globalWarns + `<div class="empty">未识别到 MyBatis 的 Preparing/Parameters 日志行，请检查日志格式${cfg ? '或当前格式配置' : ''}。</div>`;
      return;
    }
    $('#summary-text').textContent = `共解析出 ${statements.length} 条 SQL${cfg ? `（格式：${cfg.name || '未命名'}）` : ''}`;
    list.innerHTML = globalWarns + statements.map(cardHtml).join('');
    list.querySelectorAll('.copy-sql').forEach((btn) => {
      btn.addEventListener('click', () => copyText(statements[Number(btn.dataset.idx)].filledSql, btn));
    });
  }

  function xmlCardHtml(st, idx) {
    const metaBits = [st.tag];
    if (st.inlined) metaBits.push(`已内联参数 ${st.inlined} 个`);
    if (st.unresolved) metaBits.push(`未解析 ${st.unresolved} 个`);
    const warns = st.warnings.map((w) => `<div class="warn">⚠ ${esc(w)}</div>`).join('');
    return `<article class="card">
      <header class="card-head">
        <div class="card-title">
          <span class="mapper" title="${esc(st.id)}">${esc(st.id || '<' + st.tag + '>')}</span>
          <span class="meta">${metaBits.join(' · ')}</span>
        </div>
        <button type="button" class="btn copy-sql" data-idx="${idx}">复制 SQL</button>
      </header>
      ${warns}
      <pre class="sql">${esc(st.sql)}</pre>
    </article>`;
  }

  function renderXml() {
    const xml = $('#xml-input').value;
    const list = $('#results');
    const summary = $('#summary');

    if (!xml.trim()) {
      summary.hidden = true;
      list.innerHTML = `<div class="empty">粘贴 mapper XML（含 <code>&lt;select&gt;</code> 等语句），可另填参数 JSON，把 <code>#{}</code> 内联成可直接执行的 SQL。</div>`;
      return;
    }

    let params = {};
    let paramWarn = '';
    const raw = $('#param-input').value.trim();
    if (raw) {
      try {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) params = parsed;
        else paramWarn = `<div class="warn">⚠ 参数必须是 JSON 对象，当前按空参数处理。</div>`;
      } catch (e) {
        paramWarn = `<div class="warn">⚠ 参数 JSON 解析失败：${esc(e.message)}</div>`;
      }
    }

    const { statements, warnings } = parseMapperXml(xml, params);
    const globalWarns = warnings.map((w) => `<div class="warn">⚠ ${esc(w)}</div>`).join('');
    summary.hidden = statements.length === 0;
    if (!statements.length) {
      list.innerHTML = paramWarn + globalWarns + `<div class="empty">未识别到 <code>&lt;select&gt;</code>/<code>&lt;insert&gt;</code>/<code>&lt;update&gt;</code>/<code>&lt;delete&gt;</code> 语句。</div>`;
      return;
    }
    $('#summary-text').textContent = `共解析出 ${statements.length} 条 SQL`;
    list.innerHTML = paramWarn + globalWarns + statements.map(xmlCardHtml).join('');
    list.querySelectorAll('.copy-sql').forEach((btn) => {
      btn.addEventListener('click', () => copyText(statements[Number(btn.dataset.idx)].sql, btn));
    });
  }

  function syncQuoteAllCheckbox() {
    const cfg = activeConfig();
    $('#config-quote-all').checked = cfg ? Boolean(cfg.quoteAll) : Boolean(configState.defaultQuoteAll);
  }

  function renderConfigList() {
    const list = $('#config-list');
    const activeId = activeConfig() ? configState.activeId : '';
    const rows = [
      `<label class="config-row"><input type="radio" name="active-config" value=""${activeId ? '' : ' checked'} /> <span class="config-name">默认解析（不启用配置）</span>${configState.defaultQuoteAll ? '<span class="config-tag">全部加引号</span>' : ''}</label>`,
    ];
    for (const c of configState.configs) {
      rows.push(`<div class="config-row">
        <label><input type="radio" name="active-config" value="${esc(c.id)}"${activeId === c.id ? ' checked' : ''} /> <span class="config-name">${esc(c.name || '未命名')}</span></label>
        <code class="config-format" title="${esc(c.format)}">${esc(c.format)}</code>
        ${c.quoteAll ? '<span class="config-tag">全部加引号</span>' : ''}
        <button type="button" class="btn config-del" data-id="${esc(c.id)}">删除</button>
      </div>`);
    }
    if (!configState.configs.length) rows.push('<div class="config-empty">尚未配置，使用内置解析。</div>');
    list.innerHTML = rows.join('');
    list.querySelectorAll('input[name="active-config"]').forEach((radio) => {
      radio.addEventListener('change', () => {
        configState.activeId = radio.value;
        saveConfigState();
        syncQuoteAllCheckbox();
        render();
      });
    });
    list.querySelectorAll('.config-del').forEach((btn) => {
      btn.addEventListener('click', () => {
        configState.configs = configState.configs.filter((c) => c.id !== btn.dataset.id);
        if (configState.activeId === btn.dataset.id) configState.activeId = '';
        saveConfigState();
        renderConfigList();
        render();
      });
    });
    syncQuoteAllCheckbox();
  }

  function addConfig() {
    const err = $('#config-error');
    const name = $('#config-name').value.trim() || '未命名配置';
    const format = $('#config-format').value.trim();
    if (!format) {
      err.textContent = '请填写日志格式。';
      return;
    }
    try {
      buildFormatRegex(format);
    } catch (e) {
      err.textContent = e.message;
      return;
    }
    err.textContent = '';
    const id = 'cfg-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    configState.configs.push({ id, name, format, quoteAll: $('#config-quote-all').checked });
    configState.activeId = id;
    saveConfigState();
    $('#config-name').value = '';
    $('#config-format').value = '';
    renderConfigList();
    render();
  }

  let mode = 'log';

  function render() {
    if (mode === 'xml') renderXml();
    else renderLog();
  }

  function setMode(next) {
    mode = next;
    document.querySelectorAll('.mode-btn').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.mode === next);
    });
    $('#log-pane').hidden = next !== 'log';
    $('#xml-pane').hidden = next !== 'xml';
    render();
  }

  function init() {
    const input = $('#log-input');
    let timer = null;
    const scheduleRender = () => {
      clearTimeout(timer);
      timer = setTimeout(render, 250);
    };
    input.addEventListener('input', scheduleRender);
    $('#xml-input').addEventListener('input', scheduleRender);
    $('#param-input').addEventListener('input', scheduleRender);
    document.querySelectorAll('.mode-btn').forEach((btn) => {
      btn.addEventListener('click', () => setMode(btn.dataset.mode));
    });
    $('#clear-btn').addEventListener('click', () => {
      if (mode === 'xml') {
        $('#xml-input').value = '';
        $('#param-input').value = '';
      } else {
        input.value = '';
      }
      render();
    });
    $('#sample-btn').addEventListener('click', () => {
      if (mode === 'xml') {
        $('#xml-input').value = SAMPLE_XML;
        $('#param-input').value = SAMPLE_PARAMS;
      } else {
        input.value = SAMPLE;
      }
      render();
    });

    renderConfigList();
    $('#config-btn').addEventListener('click', () => {
      $('#config-modal').hidden = false;
      renderConfigList();
      $('#config-name').focus();
    });
    $('#config-close').addEventListener('click', () => { $('#config-modal').hidden = true; });
    $('#config-modal').addEventListener('click', (e) => {
      if (e.target.id === 'config-modal') $('#config-modal').hidden = true;
    });
    $('#config-example').addEventListener('click', () => {
      if (!$('#config-name').value.trim()) $('#config-name').value = 'JSON SQL 日志';
      $('#config-format').value = SAMPLE_FORMAT;
      $('#config-error').textContent = '';
    });
    $('#config-add').addEventListener('click', addConfig);
    // 勾选框直接改当前生效配置，立即重新生成
    $('#config-quote-all').addEventListener('change', () => {
      const checked = $('#config-quote-all').checked;
      const cfg = activeConfig();
      if (cfg) cfg.quoteAll = checked;
      else configState.defaultQuoteAll = checked;
      saveConfigState();
      renderConfigList();
      render();
    });

    render();
    input.focus();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
}
