// A strict YAML subset: what pnpm-lock.yaml and a yarn Berry lockfile contain, and nothing more
// (spec 2026-11-15-pnpm-yarn-lockfiles §7.1). Anything outside the subset is a YamlError that
// names its line, so a reader refuses the lockfile instead of guessing at it. Every scalar is a
// string, a mapping is a Map (a key such as `__proto__` is an ordinary key), a sequence an array.
// One pass over the lines; the only recursion is flow nesting, which is bounded by FLOW_DEPTH.
// Block nesting is bounded too, by BLOCK_DEPTH, because a caller may recurse on what it is given.

export type YamlValue = string | readonly YamlValue[] | YamlMap;
export type YamlMap = ReadonlyMap<string, YamlValue>;

export class YamlError extends Error {
  readonly line: number;
  constructor(message: string, line: number) {
    super(`${message} (line ${line})`);
    this.name = 'YamlError';
    this.line = line;
  }
}

/** How deep flow collections may nest: `{a: {b: [x]}}` is three levels. */
export const FLOW_DEPTH = 8;

/** How deep block mappings may nest, the root being the first level. pnpm needs about 6. */
export const BLOCK_DEPTH = 64;

interface Row {
  no: number;
  indent: number;
  text: string;
}

interface Frame {
  indent: number;
  map: Map<string, YamlValue>;
}

// A plain scalar may not start with these: they are YAML syntax this subset refuses.
const PLAIN_REFUSED_START = '@`&*!|>%?,';

/** Every document of `text`, split at lines that are exactly `---`; each document is a mapping. */
export function parseYamlSubset(text: string): YamlMap[] {
  const body = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const lines = body.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.endsWith('\r')) {
      lines[i] = line.slice(0, -1);
    }
  }
  const bounds: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (lines[i] === '---') {
      bounds.push(i);
    }
  }
  const documents: YamlMap[] = [];
  let start = 0;
  for (let b = 0; b <= bounds.length; b++) {
    const end = b < bounds.length ? bounds[b]! : lines.length;
    const rows = readRows(lines, start, end);
    // An empty segment before the first marker is not a document.
    if (!(b === 0 && bounds.length > 0 && rows.length === 0)) {
      documents.push(parseBlock(rows));
    }
    start = end + 1;
  }
  return documents;
}

function readRows(lines: readonly string[], from: number, to: number): Row[] {
  const rows: Row[] = [];
  for (let i = from; i < to; i++) {
    const line = lines[i]!;
    const no = i + 1;
    let indent = 0;
    while (indent < line.length && (line[indent] === ' ' || line[indent] === '\t')) {
      indent++;
    }
    if (indent === line.length || line[indent] === '#') {
      continue; // blank, or a comment line
    }
    if (line.slice(0, indent).includes('\t')) {
      throw new YamlError('a tab in the indentation', no);
    }
    if (indent % 2 !== 0) {
      throw new YamlError(`indentation of ${indent} is not a multiple of two`, no);
    }
    rows.push({ no, indent, text: line.slice(indent) });
  }
  return rows;
}

function parseBlock(rows: readonly Row[]): Map<string, YamlValue> {
  const root = new Map<string, YamlValue>();
  if (rows.length === 0) {
    return root;
  }
  if (rows[0]!.indent !== 0) {
    throw new YamlError('the document does not start at column 0', rows[0]!.no);
  }
  const stack: Frame[] = [{ indent: 0, map: root }];
  let i = 0;
  while (i < rows.length) {
    const row = rows[i]!;
    while (stack.length > 1 && row.indent < stack[stack.length - 1]!.indent) {
      stack.pop();
    }
    const frame = stack[stack.length - 1]!;
    if (row.indent !== frame.indent) {
      throw new YamlError('unexpected indentation', row.no);
    }
    const { key, rest } = readKey(row.text, row.no);
    if (frame.map.has(key)) {
      throw new YamlError(`duplicate key ${JSON.stringify(key)}`, row.no);
    }
    i++;
    if (rest !== '' && !rest.startsWith('#')) {
      frame.map.set(key, parseInline(rest, row.no, true));
      continue;
    }
    // An empty value: a block sequence or a block mapping on the next rows, or an empty scalar.
    const next = rows[i];
    if (next?.indent !== row.indent + 2) {
      frame.map.set(key, '');
    } else if (isItem(next.text)) {
      const items: YamlValue[] = [];
      while (i < rows.length && rows[i]!.indent === next.indent) {
        const item = rows[i]!;
        if (!isItem(item.text)) {
          throw new YamlError('expected a sequence item', item.no);
        }
        const value = item.text.slice(1).trimStart();
        items.push(value === '' || value.startsWith('#') ? '' : parseInline(value, item.no, false));
        i++;
      }
      frame.map.set(key, items);
    } else {
      if (stack.length >= BLOCK_DEPTH) {
        throw new YamlError(`block mappings nested deeper than ${BLOCK_DEPTH}`, next.no);
      }
      const child = new Map<string, YamlValue>();
      frame.map.set(key, child);
      stack.push({ indent: next.indent, map: child });
    }
  }
  return root;
}

function isItem(text: string): boolean {
  return text === '-' || text.startsWith('- ');
}

/** Reads `key:` off a block line; `rest` is what follows the colon, left-trimmed. */
function readKey(text: string, no: number): { key: string; rest: string } {
  const first = text[0]!;
  if (first === "'" || first === '"') {
    const [key, end] = first === "'" ? readSingle(text, 0, no) : readDouble(text, 0, no);
    let at = end;
    while (text[at] === ' ') {
      at++;
    }
    if (text[at] !== ':' || (at + 1 < text.length && text[at + 1] !== ' ')) {
      throw new YamlError("expected ':' after a quoted key", no);
    }
    return { key, rest: text.slice(at + 1).trimStart() };
  }
  refuseSyntax(text, no);
  if (first === '[' || first === '{') {
    throw new YamlError('a flow collection cannot be a key', no);
  }
  if (isItem(text)) {
    throw new YamlError('a sequence item where a key was expected', no);
  }
  for (let at = 0; at < text.length; at++) {
    const c = text[at]!;
    if (c === ':' && (at + 1 === text.length || text[at + 1] === ' ')) {
      const key = text.slice(0, at).trimEnd();
      if (key === '') {
        throw new YamlError('an empty key', no);
      }
      return { key, rest: text.slice(at + 1).trimStart() };
    }
    if (c === '#' && at > 0 && text[at - 1] === ' ') {
      break;
    }
  }
  throw new YamlError("expected 'key: value'", no);
}

function refuseSyntax(text: string, no: number): void {
  const first = text[0]!;
  if (PLAIN_REFUSED_START.includes(first)) {
    throw new YamlError(`a plain scalar cannot start with ${JSON.stringify(first)}`, no);
  }
}

/** A value after `key: ` or `- `, to the end of its line. */
function parseInline(s: string, no: number, allowFlow: boolean): YamlValue {
  const first = s[0]!;
  if (first === "'" || first === '"') {
    const [value, end] = first === "'" ? readSingle(s, 0, no) : readDouble(s, 0, no);
    checkTail(s, end, no);
    return value;
  }
  if (first === '[' || first === '{') {
    if (!allowFlow) {
      throw new YamlError('a flow collection in a block sequence', no);
    }
    const [value, end] = readFlow(s, 0, 1, no);
    checkTail(s, end, no);
    return value;
  }
  refuseSyntax(s, no);
  if (isItem(s)) {
    throw new YamlError('a block sequence on the same line as its key', no);
  }
  const comment = s.indexOf(' #');
  const value = (comment < 0 ? s : s.slice(0, comment)).trimEnd();
  if (value.includes(': ') || value.endsWith(':')) {
    throw new YamlError('a colon followed by a space inside a plain scalar', no);
  }
  return value;
}

function checkTail(s: string, end: number, no: number): void {
  const tail = s.slice(end);
  if (!/^ *$/.test(tail) && !/^ +#/.test(tail)) {
    throw new YamlError('unexpected text after a value', no);
  }
}

function readSingle(s: string, from: number, no: number): [string, number] {
  let out = '';
  let at = from + 1;
  for (;;) {
    const q = s.indexOf("'", at);
    if (q < 0) {
      throw new YamlError('unterminated single-quoted scalar', no);
    }
    out += s.slice(at, q);
    if (s[q + 1] === "'") {
      out += "'";
      at = q + 2;
    } else {
      return [out, q + 1];
    }
  }
}

const SIMPLE_ESCAPES: ReadonlyMap<string, string> = new Map([
  ['"', '"'],
  ['\\', '\\'],
  ['/', '/'],
  ['b', '\b'],
  ['f', '\f'],
  ['n', '\n'],
  ['r', '\r'],
  ['t', '\t'],
]);

function readDouble(s: string, from: number, no: number): [string, number] {
  let out = '';
  let at = from + 1;
  while (at < s.length) {
    const c = s[at]!;
    if (c === '"') {
      return [out, at + 1];
    }
    if (c.charCodeAt(0) < 0x20) {
      throw new YamlError('a control character in a double-quoted scalar', no);
    }
    if (c !== '\\') {
      out += c;
      at++;
      continue;
    }
    const e = s[at + 1];
    if (e === 'u') {
      const hex = s.slice(at + 2, at + 6);
      if (!/^[0-9a-fA-F]{4}$/.test(hex)) {
        throw new YamlError('a malformed \\u escape', no);
      }
      out += String.fromCharCode(parseInt(hex, 16));
      at += 6;
      continue;
    }
    const plain = e === undefined ? undefined : SIMPLE_ESCAPES.get(e);
    if (plain === undefined) {
      throw new YamlError(`an escape JSON lacks: \\${e ?? ''}`, no);
    }
    out += plain;
    at += 2;
  }
  throw new YamlError('unterminated double-quoted scalar', no);
}

function skipSpaces(s: string, at: number): number {
  while (s[at] === ' ') {
    at++;
  }
  return at;
}

function flowEnd(no: number): YamlError {
  return new YamlError('a flow collection that does not end on its line', no);
}

/** Reads a flow collection at `from`; returns it and the index just past its closing bracket. */
function readFlow(s: string, from: number, depth: number, no: number): [YamlValue, number] {
  if (depth > FLOW_DEPTH) {
    throw new YamlError(`flow collections nested deeper than ${FLOW_DEPTH}`, no);
  }
  const isMap = s[from] === '{';
  const close = isMap ? '}' : ']';
  const items: YamlValue[] = [];
  const map = new Map<string, YamlValue>();
  let at = skipSpaces(s, from + 1);
  if (s[at] === close) {
    return [isMap ? map : items, at + 1];
  }
  for (;;) {
    at = skipSpaces(s, at);
    if (at >= s.length) {
      throw flowEnd(no);
    }
    if (isMap) {
      const c = s[at]!;
      if (c === '[' || c === '{') {
        throw new YamlError('a flow collection cannot be a key', no);
      }
      let key: string;
      [key, at] = readFlowScalar(s, at, no, true);
      at = skipSpaces(s, at);
      if (s[at] !== ':') {
        throw new YamlError("expected ':' after a key in a flow mapping", no);
      }
      at = skipSpaces(s, at + 1);
      if (at >= s.length) {
        throw flowEnd(no);
      }
      if (map.has(key)) {
        throw new YamlError(`duplicate key ${JSON.stringify(key)}`, no);
      }
      let value: YamlValue;
      [value, at] = readFlowNode(s, at, depth, no);
      map.set(key, value);
    } else {
      let value: YamlValue;
      [value, at] = readFlowNode(s, at, depth, no);
      items.push(value);
    }
    at = skipSpaces(s, at);
    if (s[at] === ',') {
      at++;
    } else if (s[at] === close) {
      return [isMap ? map : items, at + 1];
    } else if (at >= s.length) {
      throw flowEnd(no);
    } else {
      throw new YamlError(`expected ',' or '${close}' in a flow collection`, no);
    }
  }
}

function readFlowNode(s: string, at: number, depth: number, no: number): [YamlValue, number] {
  const c = s[at];
  if (c === '[' || c === '{') {
    return readFlow(s, at, depth + 1, no);
  }
  return readFlowScalar(s, at, no, false);
}

function readFlowScalar(s: string, at: number, no: number, isKey: boolean): [string, number] {
  const c = s[at]!;
  if (c === "'") {
    return readSingle(s, at, no);
  }
  if (c === '"') {
    return readDouble(s, at, no);
  }
  if (c === ']' || c === '}') {
    throw new YamlError('an empty entry in a flow collection', no);
  }
  refuseSyntax(s.slice(at), no);
  let end = at;
  while (end < s.length) {
    const d = s[end]!;
    if (d === ',' || d === ']' || d === '}' || d === '[' || d === '{') {
      break;
    }
    if (d === ':') {
      const after = s[end + 1];
      if (after === undefined || after === ' ' || after === ',' || after === ']' || after === '}') {
        break;
      }
    }
    if (d === '#' && end > at && s[end - 1] === ' ') {
      break;
    }
    end++;
  }
  const text = s.slice(at, end).trimEnd();
  if (text === '') {
    throw new YamlError(isKey ? 'an empty key' : 'an empty entry in a flow collection', no);
  }
  return [text, end];
}
