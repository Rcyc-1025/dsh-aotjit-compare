import test from 'node:test';
import assert from 'node:assert/strict';

import { compareCase, compareExit, compareStderr, compareStdout } from '../lib/compare.js';
import { NORMALIZE_DEFAULTS } from '../lib/config.js';

/** 造一个与 exec.js 输出同形的进程结果。 */
function run(overrides = {}) {
  return {
    argv: ['x'],
    cwd: 'C:/w',
    exitCode: 0,
    exitCodeHex: '0x0',
    signal: null,
    timedOut: false,
    durationMs: 1,
    stdout: '',
    stderr: '',
    stdoutBytes: 0,
    stderrBytes: 0,
    stdoutSha256: null,
    stderrSha256: null,
    stdoutEncoding: 'utf8',
    stderrEncoding: 'utf8',
    stdoutTruncated: false,
    stderrTruncated: false,
    spawnError: null,
    ...overrides,
  };
}

const NORMALIZE = { ...NORMALIZE_DEFAULTS };

test('compareStdout：完全一致返回 null', () => {
  assert.equal(compareStdout(run({ stdout: '7\n' }), run({ stdout: '7\n' }), NORMALIZE), null);
});

test('compareStdout：CRLF 归一化后一致', () => {
  assert.equal(compareStdout(run({ stdout: '7\r\n' }), run({ stdout: '7\n' }), NORMALIZE), null);
});

test('compareStdout：内容不同 → 第一处不同行 + 两侧文本', () => {
  const diff = compareStdout(
    run({ stdout: 'a\n7\nc\n' }),
    run({ stdout: 'a\n8\nc\n' }),
    NORMALIZE,
  );
  assert.equal(diff.field, 'stdout');
  assert.equal(diff.kind, 'text');
  assert.equal(diff.aotLine, 2);
  assert.equal(diff.jitLine, 2);
  assert.equal(diff.expected, '7');
  assert.equal(diff.actual, '8');
});

test('compareStdout：任一侧截断 → truncated，不比较前缀', () => {
  const diff = compareStdout(
    run({ stdout: '7\n', stdoutTruncated: true, stdoutBytes: 10 }),
    run({ stdout: '7\n' }),
    NORMALIZE,
  );
  assert.equal(diff.kind, 'truncated');
  assert.equal(diff.firstMismatch, 'truncated');
  assert.match(diff.expected, /截断/);
});

test('compareStdout：两侧都是二进制时比较 SHA-256', () => {
  const same = compareStdout(
    run({ stdout: '\uFFFD', stdoutEncoding: 'binary', stdoutSha256: 'aa' }),
    run({ stdout: 'other', stdoutEncoding: 'binary', stdoutSha256: 'aa' }),
    NORMALIZE,
  );
  assert.equal(same, null);
  const diff = compareStdout(
    run({ stdout: '\uFFFD', stdoutEncoding: 'binary', stdoutSha256: 'aa' }),
    run({ stdout: '\uFFFD', stdoutEncoding: 'binary', stdoutSha256: 'bb' }),
    NORMALIZE,
  );
  assert.equal(diff.kind, 'hash');
  assert.equal(diff.expected, 'aa');
  assert.equal(diff.actual, 'bb');
});

test('compareExit：相同返回 null；不同给数值与十六进制', () => {
  assert.equal(compareExit(run({ exitCode: 9, exitCodeHex: '0x9' }), run({ exitCode: 9, exitCodeHex: '0x9' })), null);
  const diff = compareExit(run({ exitCode: 9, exitCodeHex: '0x9' }), run({ exitCode: 8, exitCodeHex: '0x8' }));
  assert.equal(diff.kind, 'exit');
  assert.equal(diff.expected, 9);
  assert.equal(diff.actual, 8);
  assert.equal(diff.expectedHex, '0x9');
});

test('compareExit：Windows 负数退出码按原始数值比较', () => {
  const diff = compareExit(
    run({ exitCode: -1073741819, exitCodeHex: '0xc0000005' }),
    run({ exitCode: 0, exitCodeHex: '0x0' }),
  );
  assert.equal(diff.expected, -1073741819);
  assert.equal(diff.actualHex, '0x0');
});

test('compareExit：任一侧超时 → timeout（即使 exit code 相同）', () => {
  const diff = compareExit(run({ exitCode: 0, timedOut: true }), run({ exitCode: 0 }));
  assert.equal(diff.kind, 'timeout');
  assert.equal(diff.firstMismatch, 'timeout');
  assert.equal(diff.aotTimedOut, true);
});

test('compareStderr：off 只采集不比', () => {
  assert.equal(compareStderr(run({ stderr: 'a' }), run({ stderr: 'b' }), 'off', NORMALIZE), null);
});

test('compareStderr：normalized + replacePaths 后一致，strict 下不一致', () => {
  const normalize = { ...NORMALIZE, replacePaths: ['D:/build/x.mlir', 'D:/other/x.mlir'] };
  const aot = run({ stderr: 'D:/build/x.mlir:1: warning: hi\n' });
  const jit = run({ stderr: 'D:/other/x.mlir:1: warning: hi\n' });
  assert.equal(compareStderr(aot, jit, 'normalized', normalize), null);
  const strict = compareStderr(aot, jit, 'strict', normalize);
  assert.equal(strict.kind, 'text');
  assert.match(strict.expected, /D:\/build/);
});

test('compareStderr：strict 忽略 ansi 与 trailingNewline 选项，只做 CRLF', () => {
  const strict = compareStderr(
    run({ stderr: 'warn\n' }),
    run({ stderr: 'warn\n\n' }),
    'strict',
    { ...NORMALIZE, trailingNewline: 'ignore' },
  );
  assert.equal(strict.kind, 'text');
});

test('compareCase：字段优先级 spawn > timeout > exit > stdout > stderr > sideEffects', () => {
  const spawnDiff = compareCase({
    aot: run({ spawnError: 'EPERM' }),
    jit: run({ timedOut: true }),
    compare: { stdout: true, exit: true, stderr: 'strict', sideEffects: false },
    normalize: NORMALIZE,
    sideEffectDiffs: [{ field: 'sideEffects', kind: 'hash', path: 'out/x' }],
  });
  assert.equal(spawnDiff.match, false);
  assert.equal(spawnDiff.firstMismatch, 'spawn');

  const timeoutDiff = compareCase({
    aot: run({ timedOut: true }),
    jit: run({ exitCode: 3 }),
    compare: { stdout: true, exit: false, stderr: 'off', sideEffects: false },
    normalize: NORMALIZE,
  });
  assert.equal(timeoutDiff.firstMismatch, 'timeout');

  const exitDiff = compareCase({
    aot: run({ exitCode: 9, exitCodeHex: '0x9', stdout: '7\n' }),
    jit: run({ exitCode: 8, exitCodeHex: '0x8', stdout: '8\n' }),
    compare: { stdout: true, exit: true, stderr: 'off', sideEffects: false },
    normalize: NORMALIZE,
  });
  assert.equal(exitDiff.firstMismatch, 'exit');
  assert.deepEqual(exitDiff.diffs.map((diff) => diff.field), ['exit', 'stdout']);
});

test('compareCase：全部一致 → match true，firstMismatch null', () => {
  const result = compareCase({
    aot: run({ exitCode: 9, exitCodeHex: '0x9', stdout: '7\n' }),
    jit: run({ exitCode: 9, exitCodeHex: '0x9', stdout: '7\n' }),
    compare: { stdout: true, exit: true, stderr: 'off', sideEffects: false },
    normalize: NORMALIZE,
  });
  assert.equal(result.match, true);
  assert.equal(result.firstMismatch, null);
  assert.deepEqual(result.diffs, []);
});

test('compareCase：只有 sideEffects 不同时 firstMismatch 为 sideEffects', () => {
  const result = compareCase({
    aot: run({ stdout: '7\n' }),
    jit: run({ stdout: '7\n' }),
    compare: { stdout: true, exit: true, stderr: 'off', sideEffects: true },
    normalize: NORMALIZE,
    sideEffectDiffs: [{ field: 'sideEffects', kind: 'content', path: 'out/result.txt' }],
  });
  assert.equal(result.match, false);
  assert.equal(result.firstMismatch, 'sideEffects');
});

test('compareCase：compare.stdout:false 时不比较 stdout，但 exit 仍然比较', () => {
  const result = compareCase({
    aot: run({ stdout: 'a', exitCode: 1, exitCodeHex: '0x1' }),
    jit: run({ stdout: 'b', exitCode: 1, exitCodeHex: '0x1' }),
    compare: { stdout: false, exit: true, stderr: 'off', sideEffects: false },
    normalize: NORMALIZE,
  });
  assert.equal(result.match, true);
});
