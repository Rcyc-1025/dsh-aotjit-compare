/**
 * 逐字段比较（规格 §3.4 / §3.6）。
 *
 * - expected 永远是 AOT 侧，actual 永远是 JIT 侧；
 * - 每行只保留第一个不一致字段作为 firstMismatch，diffs 里仍按优先级收集多个字段的摘要；
 * - 超时和截断不是「插件坏了」，而是「不能证明一致」：match:false、ok 仍可为 true。
 */

import { firstTextDifference, normalizeText } from './normalize.js';

function textOf(value) {
  return typeof value === 'string' ? value : '';
}

/**
 * stdout 比较。
 * - 任一侧截断：不比较前缀，直接 truncated；
 * - 任一侧非 UTF-8：改为比较原始字节的 SHA-256；
 * - 否则归一化后逐字符比较，给第一处不同行。
 */
export function compareStdout(aot, jit, normalize) {
  if (aot.stdoutTruncated === true || jit.stdoutTruncated === true) {
    return {
      field: 'stdout',
      kind: 'truncated',
      firstMismatch: 'truncated',
      expected: `AOT stdout 截断（保留 ${aot.stdoutBytes ?? 0} 字节）`,
      actual: `JIT stdout 截断（保留 ${jit.stdoutBytes ?? 0} 字节）`,
      aotTruncated: aot.stdoutTruncated === true,
      jitTruncated: jit.stdoutTruncated === true,
    };
  }
  if (aot.stdoutEncoding === 'binary' || jit.stdoutEncoding === 'binary') {
    if (aot.stdoutSha256 !== null && aot.stdoutSha256 === jit.stdoutSha256) return null;
    return {
      field: 'stdout',
      kind: 'hash',
      expected: aot.stdoutSha256,
      actual: jit.stdoutSha256,
      aotEncoding: aot.stdoutEncoding,
      jitEncoding: jit.stdoutEncoding,
    };
  }
  const expected = normalizeText(textOf(aot.stdout), normalize);
  const actual = normalizeText(textOf(jit.stdout), normalize);
  const difference = firstTextDifference(expected, actual);
  if (difference === null) return null;
  return { field: 'stdout', ...difference };
}

/**
 * exit 比较：数值 + timedOut + signal。超时单独归到 timeout，优先级高于 exit。
 */
export function compareExit(aot, jit) {
  if (aot.timedOut === true || jit.timedOut === true) {
    return {
      field: 'timeout',
      kind: 'timeout',
      firstMismatch: 'timeout',
      expected: aot.timedOut === true ? `超时（>${aot.timeoutMs ?? '?'}ms）` : `exit ${aot.exitCode}`,
      actual: jit.timedOut === true ? `超时（>${jit.timeoutMs ?? '?'}ms）` : `exit ${jit.exitCode}`,
      aotTimedOut: aot.timedOut === true,
      jitTimedOut: jit.timedOut === true,
    };
  }
  if (aot.exitCode !== jit.exitCode || aot.signal !== jit.signal) {
    return {
      field: 'exit',
      kind: 'exit',
      expected: aot.exitCode,
      actual: jit.exitCode,
      expectedHex: aot.exitCodeHex,
      actualHex: jit.exitCodeHex,
      expectedSignal: aot.signal,
      actualSignal: jit.signal,
    };
  }
  return null;
}

/**
 * stderr 比较：off 不比；normalized 用与 stdout 相同的归一化（含 replacePaths）；
 * strict 只做 CRLF 归一化（规格 §3.4）。
 */
export function compareStderr(aot, jit, mode, normalize) {
  if (mode === 'off') return null;
  if (aot.stderrTruncated === true || jit.stderrTruncated === true) {
    return {
      field: 'stderr',
      kind: 'truncated',
      firstMismatch: 'truncated',
      expected: `AOT stderr 截断（保留 ${aot.stderrBytes ?? 0} 字节）`,
      actual: `JIT stderr 截断（保留 ${jit.stderrBytes ?? 0} 字节）`,
    };
  }
  if (aot.stderrEncoding === 'binary' || jit.stderrEncoding === 'binary') {
    if (aot.stderrSha256 !== null && aot.stderrSha256 === jit.stderrSha256) return null;
    return {
      field: 'stderr',
      kind: 'hash',
      expected: aot.stderrSha256,
      actual: jit.stderrSha256,
      aotEncoding: aot.stderrEncoding,
      jitEncoding: jit.stderrEncoding,
    };
  }
  const options =
    mode === 'strict'
      ? { ...normalize, ansi: false, trailingNewline: 'exact' }
      : normalize;
  const scope = mode === 'strict' ? { replacePaths: false } : {};
  const expected = normalizeText(textOf(aot.stderr), options, scope);
  const actual = normalizeText(textOf(jit.stderr), options, scope);
  const difference = firstTextDifference(expected, actual);
  if (difference === null) return null;
  return { field: 'stderr', ...difference };
}

/** 进程启动失败：两侧都记在 row.error 里，比较层面统一成 spawn。 */
export function compareSpawn(aot, jit) {
  if (aot.spawnError === null && jit.spawnError === null) return null;
  return {
    field: 'spawn',
    kind: 'spawn',
    firstMismatch: 'spawn',
    expected: aot.spawnError,
    actual: jit.spawnError,
  };
}

/**
 * 组装一行：按 spawn > timeout > exit > stdout > stderr > sideEffects 的优先级给出 firstMismatch。
 * @param {{aot: object, jit: object, compare: object, normalize: object, sideEffectDiffs: object[]}} input
 */
export function compareCase(input) {
  const { aot, jit, compare, normalize, sideEffectDiffs = [] } = input;
  const diffs = [];

  const spawnDiff = compareSpawn(aot, jit);
  if (spawnDiff !== null) diffs.push(spawnDiff);

  const exitDiff = compareExit(aot, jit);
  // 超时一律算差异（即使 compare.exit=false：超时本来就不能证明一致）。
  if (exitDiff !== null && (compare.exit !== false || exitDiff.kind === 'timeout')) diffs.push(exitDiff);

  if (compare.stdout !== false) {
    const stdoutDiff = compareStdout(aot, jit, normalize);
    if (stdoutDiff !== null) diffs.push(stdoutDiff);
  }

  const stderrDiff = compareStderr(aot, jit, compare.stderr ?? 'off', normalize);
  if (stderrDiff !== null) diffs.push(stderrDiff);

  for (const diff of sideEffectDiffs) diffs.push(diff);

  const match = diffs.length === 0;
  const first = diffs[0];
  return {
    match,
    firstMismatch: first === undefined ? null : (first.firstMismatch ?? first.field),
    diffs,
  };
}
