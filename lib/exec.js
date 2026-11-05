/**
 * ctx.subprocess 封装：argv 直传、按 case 写 stdin、独立超时、每流截断、二进制识别。
 *
 * 关键事实（宿主 subprocess 0.2.x）：
 * - stdio.stdin 传 `{ data }` 时宿主会 write 完立即 end，所以不需要自己管流；
 * - 收集模式下 handle.collected.stdout / stderr 的 finalize() 才带 truncated（readFrom 只有 lossy）；
 * - abort 后宿主会 SIGTERM → graceMs 后 SIGKILL，done 仍会 settle（拿到的可能是被杀进程的退出码），
 *   所以「超时」必须由调用方自己记，不能靠 done 的 reject。
 */

import { createHash } from 'node:crypto';

/** 结果里的路径统一成正斜杠，避免 Windows 反斜杠在 JSON 里成串转义。 */
export function toPosix(value) {
  return typeof value === 'string' ? value.replaceAll('\\', '/') : value;
}

/** 32 位无符号十六进制：Windows 的负退出码（0xC0000005）也能原样展示。 */
export function exitCodeHex(exitCode) {
  if (typeof exitCode !== 'number' || !Number.isFinite(exitCode)) return null;
  return `0x${(exitCode >>> 0).toString(16)}`;
}

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

const EMPTY_STREAM = Object.freeze({
  text: '',
  bytes: null,
  truncated: false,
  totalBytes: 0,
});

/**
 * 读一个 OutputCollector：优先 finalize()（含 truncated），回退 readFrom(0)。
 * 同时取 snapshot().bytes 用于 SHA-256 与「是否合法 UTF-8」判断。
 */
function readStream(collector) {
  if (collector === null || typeof collector !== 'object') return { ...EMPTY_STREAM };

  let snapshot = null;
  if (typeof collector.snapshot === 'function') {
    try {
      snapshot = collector.snapshot();
    } catch {
      snapshot = null;
    }
  }
  const bytes = snapshot !== null && Buffer.isBuffer(snapshot.bytes) ? snapshot.bytes : null;
  const totalBytes = snapshot !== null && Number.isFinite(snapshot.totalBytes) ? snapshot.totalBytes : (bytes?.length ?? 0);

  let text = '';
  let dropped = 0;
  if (typeof collector.finalize === 'function') {
    try {
      const final = collector.finalize();
      text = typeof final.text === 'string' ? final.text : '';
      dropped = typeof final.truncated === 'number' ? final.truncated : 0;
    } catch {
      dropped = 0;
    }
  } else if (typeof collector.readFrom === 'function') {
    try {
      const read = collector.readFrom(0);
      text = typeof read.text === 'string' ? read.text : '';
      if (read.lossy === true) dropped = 1;
    } catch {
      dropped = 0;
    }
  }
  if (text === '' && bytes !== null) text = bytes.toString('utf8');

  return {
    text,
    bytes,
    truncated: dropped > 0 || totalBytes > (bytes?.length ?? 0),
    totalBytes,
  };
}

/** 文本按严格 UTF-8 解码；失败则视为二进制（比较时改用 SHA-256）。 */
function describeText(stream) {
  if (stream.bytes === null) {
    return { text: stream.text, encoding: 'utf8', sha256: null, bytes: null };
  }
  let encoding = 'utf8';
  let text = stream.text;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(stream.bytes);
  } catch {
    encoding = 'binary';
    text = stream.bytes.toString('utf8');
  }
  return { text, encoding, sha256: sha256(stream.bytes), bytes: stream.bytes };
}

/**
 * @param {(spec: object) => object} spawn 宿主 ctx.subprocess.spawn
 * @param {{graceMs?: number, timeoutMs?: number}} options 默认值
 */
export function createSubprocessRunner(spawn, options = {}) {
  const graceMs = Number.isFinite(options.graceMs) && options.graceMs > 0 ? options.graceMs : 2_000;
  const defaultTimeoutMs =
    Number.isFinite(options.timeoutMs) && options.timeoutMs > 0 ? options.timeoutMs : 120_000;

  /**
   * 跑一个进程。
   * @param {{argv: string[], cwd: string, env?: object, stdin?: string, timeoutMs?: number, maxBytes?: number}} spec
   * @returns 进程的可观察结果；永不抛异常（启动失败进 spawnError）。
   */
  return async function run(spec) {
    const startedAt = Date.now();
    const argv = Array.isArray(spec?.argv) ? spec.argv.map(String) : [];
    const cwd = typeof spec?.cwd === 'string' ? spec.cwd : process.cwd();
    const timeoutMs =
      Number.isFinite(spec?.timeoutMs) && spec.timeoutMs > 0 ? spec.timeoutMs : defaultTimeoutMs;
    const maxBytes = Number.isFinite(spec?.maxBytes) && spec.maxBytes > 0 ? spec.maxBytes : 1_048_576;
    const hasStdin = typeof spec?.stdin === 'string' && spec.stdin !== '';

    const result = {
      argv,
      cwd: toPosix(cwd),
      exitCode: null,
      exitCodeHex: null,
      signal: null,
      timedOut: false,
      durationMs: 0,
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
      stdinBytes: hasStdin ? Buffer.byteLength(spec.stdin, 'utf8') : 0,
    };

    const controller = new AbortController();
    let timedOut = false;
    let forceResolve = () => {};
    const forced = new Promise((resolve) => {
      forceResolve = resolve;
    });
    let forceTimer = null;

    // 超时到点：先 abort（宿主会走 SIGTERM → SIGKILL），再用兜底定时器防止 done 永不 settle。
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
      forceTimer = setTimeout(() => forceResolve({ kind: 'force' }), graceMs + 5_000);
    }, timeoutMs);

    let handle = null;
    try {
      handle = spawn({
        argv,
        cwd,
        stdio: {
          stdin: hasStdin ? { data: spec.stdin } : 'ignore',
          stdout: { maxBytes },
          stderr: { maxBytes },
        },
        graceMs,
        env: spec?.env,
        signal: controller.signal,
      });
    } catch (error) {
      clearTimeout(timer);
      result.timedOut = timedOut;
      result.durationMs = Date.now() - startedAt;
      result.spawnError = error instanceof Error ? error.message : String(error);
      return result;
    }

    let outcome;
    try {
      outcome = await Promise.race([
        Promise.resolve(handle?.done).then(
          (value) => ({ kind: 'exit', value }),
          (error) => ({ kind: 'error', error }),
        ),
        forced,
      ]);
    } finally {
      clearTimeout(timer);
      if (forceTimer !== null) clearTimeout(forceTimer);
    }

    if (outcome.kind === 'force') {
      timedOut = true;
    } else if (outcome.kind === 'error') {
      const message = outcome.error instanceof Error ? outcome.error.message : String(outcome.error);
      // 超时导致的终止在宿主里可能表现为 reject；此时按超时归因，不污染 spawnError。
      if (!timedOut) result.spawnError = message;
    } else if (outcome.value !== null && typeof outcome.value === 'object') {
      result.exitCode = Number.isFinite(outcome.value.exitCode) ? outcome.value.exitCode : null;
      result.signal = typeof outcome.value.signal === 'string' ? outcome.value.signal : null;
    }

    const collected = handle?.collected ?? {};
    const stdout = readStream(collected.stdout);
    const stderr = readStream(collected.stderr);
    const stdoutText = describeText(stdout);
    const stderrText = describeText(stderr);

    result.timedOut = timedOut;
    result.durationMs = Date.now() - startedAt;
    result.exitCodeHex = exitCodeHex(result.exitCode);
    result.stdout = stdoutText.text;
    result.stderr = stderrText.text;
    result.stdoutBytes = stdout.totalBytes;
    result.stderrBytes = stderr.totalBytes;
    result.stdoutSha256 = stdoutText.sha256;
    result.stderrSha256 = stderrText.sha256;
    result.stdoutEncoding = stdoutText.encoding;
    result.stderrEncoding = stderrText.encoding;
    result.stdoutTruncated = stdout.truncated;
    result.stderrTruncated = stderr.truncated;
    return result;
  };
}
