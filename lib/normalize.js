/**
 * 文本归一化与「第一个不同行」定位（规格 §3.4）。
 *
 * 归一化只在比较前做一次，不改变返回给调用方的原文：row 里的 stdout/stderr 永远是进程真实输出，
 * diffs 里的 expected/actual 才是归一化后的比较值。这样「看到的」和「比的」不会混在一起。
 */

/** ANSI CSI / OSC 序列；只用于 ansi:true。 */
const ANSI_PATTERN = new RegExp(
  [
    '[\\u001B\\u009B][[\\]()#;?]*(?:',
    '(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]', // CSI
    '|\\][^\\u0007\\u001B]*(?:\\u0007|\\u001B\\\\)', // OSC
    ')',
  ].join(''),
  'g',
);

const MAX_LINE_CHARS = 800;

/** 去掉 ANSI 颜色/控制序列（JIT 诊断常带颜色）。 */
export function stripAnsi(text) {
  return typeof text === 'string' ? text.replace(ANSI_PATTERN, '') : '';
}

/** `\r\n` 与孤立 `\r` 统一成 `\n`。 */
export function normalizeNewlines(text) {
  return typeof text === 'string' ? text.replace(/\r\n/g, '\n').replace(/\r/g, '\n') : '';
}

/** 末尾换行策略：exact 保留；ignore 去掉末尾所有换行（只用于明确不关心末尾空行的程序）。 */
export function applyTrailingNewline(text, mode) {
  if (mode !== 'ignore') return text;
  return text.replace(/\n+$/, '');
}

/** 路径替换：把每个绝对路径替换成 `<path>`，同时容忍正反斜杠与大小写差异（Windows）。 */
export function replacePathsInText(text, paths) {
  let result = text;
  for (const path of Array.isArray(paths) ? paths : []) {
    if (typeof path !== 'string' || path === '') continue;
    const variants = new Set([path, path.replaceAll('\\', '/'), path.replaceAll('/', '\\')]);
    for (const variant of variants) {
      if (variant === '') continue;
      result = result.split(variant).join('<path>');
      // Windows 路径大小写不敏感：剩下的按不区分大小写处理。
      if (/[A-Za-z]/.test(variant)) {
        const escaped = variant.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        result = result.replace(new RegExp(escaped, 'gi'), '<path>');
      }
    }
  }
  return result;
}

/**
 * 比较用的文本归一化。
 * @param {string} text 原始文本
 * @param {{crlf:boolean, ansi:boolean, trailingNewline:string, replacePaths:string[]}} options 归一化配置
 * @param {{replacePaths?:boolean}} [scope] scope.replacePaths=false 时不做路径替换（stderr strict 用）
 */
export function normalizeText(text, options, scope = {}) {
  const opts = options ?? {};
  let result = typeof text === 'string' ? text : '';
  if (opts.ansi === true) result = stripAnsi(result);
  // crlf:false 时连 CRLF 都不动；stderr strict 的「只做 CRLF」也是走这个开关（规格 §3.4）。
  if (opts.crlf !== false) result = normalizeNewlines(result);
  if (scope.replacePaths !== false && Array.isArray(opts.replacePaths) && opts.replacePaths.length > 0) {
    result = replacePathsInText(result, opts.replacePaths);
  }
  result = applyTrailingNewline(result, opts.trailingNewline);
  return result;
}

/** 1-based 行号：下标之前的换行数 + 1。 */
function lineNumberAt(text, index) {
  let line = 1;
  const limit = Math.min(index, text.length);
  for (let i = 0; i < limit; i += 1) {
    if (text.charCodeAt(i) === 10) line += 1;
  }
  return line;
}

/** 取第 1-based 行（不含换行符）；越界返回空串。 */
function lineAt(text, line) {
  const lines = text.split('\n');
  return lines[line - 1] ?? '';
}

function clipLine(text) {
  if (text.length <= MAX_LINE_CHARS) return text;
  return `${text.slice(0, MAX_LINE_CHARS)}…(共 ${text.length} 字符)`;
}

/**
 * 找出两个文本的第一处不同：返回行号与该行两侧文本。
 * 完全一致返回 null。
 */
export function firstTextDifference(expectedText, actualText) {
  const expected = typeof expectedText === 'string' ? expectedText : '';
  const actual = typeof actualText === 'string' ? actualText : '';
  if (expected === actual) return null;

  const limit = Math.min(expected.length, actual.length);
  let index = 0;
  while (index < limit && expected.charCodeAt(index) === actual.charCodeAt(index)) index += 1;

  const aotLine = lineNumberAt(expected, index);
  const jitLine = lineNumberAt(actual, index);
  const aotText = clipLine(lineAt(expected, aotLine));
  const jitText = clipLine(lineAt(actual, jitLine));

  // 典型情况是「同一行内容不同」；如果只是行数不同（一侧多了一行），行号仍然指向第一处分歧。
  return {
    kind: 'text',
    aotLine,
    jitLine,
    expected: aotText,
    actual: jitText,
    // 两边长度不同时给出字符数量，方便判断是「少一行」还是「整段不同」。
    expectedLength: expected.length,
    actualLength: actual.length,
  };
}

/** 统计行数（以 `\n` 结尾的文本按实际内容行算，不额外补空行）。 */
export function countLines(text) {
  if (typeof text !== 'string' || text === '') return 0;
  const trimmed = text.endsWith('\n') ? text.slice(0, -1) : text;
  if (trimmed === '') return 1;
  let count = 1;
  for (let i = 0; i < trimmed.length; i += 1) if (trimmed.charCodeAt(i) === 10) count += 1;
  return count;
}

/** 展示用截断：保留头尾，中间标注省略的字节数。 */
export function clipHeadTail(text, maxBytes) {
  const source = typeof text === 'string' ? text : '';
  const bytes = Buffer.byteLength(source, 'utf8');
  if (!Number.isInteger(maxBytes) || maxBytes <= 0 || bytes <= maxBytes) {
    return { text: source, truncated: false, bytes };
  }
  const headBytes = Math.max(0, Math.floor(maxBytes * 0.6));
  const tailBytes = Math.max(0, maxBytes - headBytes);
  const totalBuffer = Buffer.from(source, 'utf8');
  // 先按字节切再解码，避免切在多字节字符中间。
  const head = totalBuffer.subarray(0, headBytes).toString('utf8');
  const tail = totalBuffer.subarray(Math.max(0, totalBuffer.length - tailBytes)).toString('utf8');
  return {
    text: `${head}\n... [已省略 ${bytes - maxBytes} 字节] ...\n${tail}`,
    truncated: true,
    bytes,
  };
}
