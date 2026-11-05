import test from 'node:test';
import assert from 'node:assert/strict';

import {
  applyTrailingNewline,
  countLines,
  firstTextDifference,
  normalizeNewlines,
  normalizeText,
  replacePathsInText,
  stripAnsi,
} from '../lib/normalize.js';
import { NORMALIZE_DEFAULTS } from '../lib/config.js';

test('stripAnsi：去掉 CSI 颜色序列，保留正文', () => {
  assert.equal(stripAnsi('\u001b[31merror\u001b[0m: boom'), 'error: boom');
  assert.equal(stripAnsi('plain'), 'plain');
  assert.equal(stripAnsi(undefined), '');
});

test('normalizeNewlines：CRLF 与孤立 CR 都统一成 LF', () => {
  assert.equal(normalizeNewlines('a\r\nb\rc\n'), 'a\nb\nc\n');
});

test('applyTrailingNewline：exact 保留，ignore 去掉末尾所有换行', () => {
  assert.equal(applyTrailingNewline('7\n', 'exact'), '7\n');
  assert.equal(applyTrailingNewline('7\n\n', 'ignore'), '7');
  assert.equal(applyTrailingNewline('7', 'ignore'), '7');
});

test('replacePathsInText：绝对路径（含反斜杠与大小写差异）替换成 <path>', () => {
  assert.equal(
    replacePathsInText('located at D:/build/foo.mlir:3: error', ['D:/build/foo.mlir']),
    'located at <path>:3: error',
  );
  assert.equal(replacePathsInText('at D:\\build\\x', ['D:/build/x']), 'at <path>');
  assert.equal(replacePathsInText('at d:/BUILD/x', ['D:/build/x']), 'at <path>');
  assert.equal(replacePathsInText('unchanged', []), 'unchanged');
});

test('normalizeText：默认配置做 CRLF 且保留末尾换行', () => {
  assert.equal(normalizeText('7\r\n', NORMALIZE_DEFAULTS), '7\n');
});

test('normalizeText：crlf:false 时不动换行', () => {
  assert.equal(normalizeText('7\r\n', { ...NORMALIZE_DEFAULTS, crlf: false }), '7\r\n');
});

test('normalizeText：ansi:true 去色，trailingNewline:ignore 去尾换行', () => {
  const options = { ...NORMALIZE_DEFAULTS, ansi: true, trailingNewline: 'ignore' };
  assert.equal(normalizeText('\u001b[32m7\u001b[0m\n', options), '7');
});

test('normalizeText：replacePaths 只在对该 scope 允许时生效', () => {
  const options = { ...NORMALIZE_DEFAULTS, replacePaths: ['D:/build/x'] };
  assert.equal(normalizeText('D:/build/x:1: err', options), '<path>:1: err');
  assert.equal(normalizeText('D:/build/x:1: err', options, { replacePaths: false }), 'D:/build/x:1: err');
});

test('firstTextDifference：返回第一个不同行与两侧文本', () => {
  const diff = firstTextDifference('line1\n7\nline3\n', 'line1\n8\nline3\n');
  assert.equal(diff.kind, 'text');
  assert.equal(diff.aotLine, 2);
  assert.equal(diff.jitLine, 2);
  assert.equal(diff.expected, '7');
  assert.equal(diff.actual, '8');
});

test('firstTextDifference：一侧多一行时行号仍指向分歧处', () => {
  const diff = firstTextDifference('a\nb\n', 'a\nb\nc\n');
  assert.equal(diff.aotLine, 3);
  assert.equal(diff.jitLine, 3);
  assert.equal(diff.expected, '');
  assert.equal(diff.actual, 'c');
});

test('firstTextDifference：相同返回 null', () => {
  assert.equal(firstTextDifference('7\n', '7\n'), null);
  assert.equal(firstTextDifference('', ''), null);
});

test('firstTextDifference：超长行会被裁剪并标注字符数', () => {
  const long = 'x'.repeat(1200);
  const diff = firstTextDifference(long, 'y'.repeat(1200));
  assert.equal(diff.expected.length < 1200, true);
  assert.match(diff.expected, /共 1200 字符/);
});

test('countLines：按实际内容行统计', () => {
  assert.equal(countLines(''), 0);
  assert.equal(countLines('7\n'), 1);
  assert.equal(countLines('a\nb'), 2);
  assert.equal(countLines('a\nb\n'), 2);
});
