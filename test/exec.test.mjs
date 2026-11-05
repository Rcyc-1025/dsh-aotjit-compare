import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import { createSubprocessRunner, exitCodeHex, toPosix } from '../lib/exec.js';

function collector(text, dropped = 0, totalBytes) {
  const bytes = Buffer.from(text, 'utf8');
  return {
    snapshot: () => ({ bytes, totalBytes: totalBytes ?? bytes.length }),
    finalize: () => ({ text, truncated: dropped }),
    readFrom: () => ({ text, nextOffset: text.length, lossy: dropped > 0 }),
  };
}

function handle({ stdout = '', stderr = '', exitCode = 0, signal = null, dropped = 0, totalBytes } = {}) {
  return {
    collected: { stdout: collector(stdout, dropped, totalBytes), stderr: collector(stderr) },
    done: Promise.resolve({ exitCode, signal }),
    terminate() {},
  };
}

test('toPosix / exitCodeHex', () => {
  assert.equal(toPosix('C:\\a\\b.exe'), 'C:/a/b.exe');
  assert.equal(exitCodeHex(9), '0x9');
  assert.equal(exitCodeHex(-1073741819), '0xc0000005');
  assert.equal(exitCodeHex(null), null);
});

test('runner：正常退出，收集 stdout/stderr 与 SHA-256', async () => {
  const runner = createSubprocessRunner(() => handle({ stdout: '7\n', stderr: 'warn\n', exitCode: 9 }));
  const result = await runner({ argv: ['x.exe'], cwd: 'C:/w', timeoutMs: 5000, maxBytes: 1024 });
  assert.equal(result.exitCode, 9);
  assert.equal(result.exitCodeHex, '0x9');
  assert.equal(result.signal, null);
  assert.equal(result.timedOut, false);
  assert.equal(result.spawnError, null);
  assert.equal(result.stdout, '7\n');
  assert.equal(result.stderr, 'warn\n');
  assert.equal(result.stdoutBytes, 2);
  assert.equal(result.stdoutEncoding, 'utf8');
  assert.equal(result.stdoutSha256, createHash('sha256').update('7\n').digest('hex'));
});

test('runner：argv 直传、cwd 与 stdin 以 {data} 形式交给宿主', async () => {
  let captured = null;
  const runner = createSubprocessRunner((spec) => {
    captured = spec;
    return handle({ stdout: 'ok' });
  });
  await runner({ argv: ['C:/toyc.exe', 'examples/add.mul.mlir', '--emit=run'], cwd: 'C:/w', stdin: 'hello', timeoutMs: 1000, maxBytes: 64 });
  assert.deepEqual(captured.argv, ['C:/toyc.exe', 'examples/add.mul.mlir', '--emit=run']);
  assert.equal(captured.cwd, 'C:/w');
  assert.deepEqual(captured.stdio.stdin, { data: 'hello' });
  assert.deepEqual(captured.stdio.stdout, { maxBytes: 64 });
  assert.equal(captured.graceMs, 2000);
});

test('runner：没有 stdin 时用 ignore', async () => {
  let captured = null;
  const runner = createSubprocessRunner((spec) => {
    captured = spec;
    return handle({});
  });
  await runner({ argv: ['x'], cwd: 'C:/w', timeoutMs: 1000 });
  assert.equal(captured.stdio.stdin, 'ignore');
});

test('runner：finalize().truncated 才是截断信号（readFrom 的 lossy 只是回退）', async () => {
  const runner = createSubprocessRunner(() => handle({ stdout: 'head', dropped: 4096, totalBytes: 8192 }));
  const result = await runner({ argv: ['x'], cwd: 'C:/w', timeoutMs: 1000 });
  assert.equal(result.stdoutTruncated, true);
  assert.equal(result.stdoutBytes, 8192);
});

test('runner：非 UTF-8 输出标记 binary 并提供 SHA-256', async () => {
  const bytes = Buffer.from([0xff, 0xfe, 0x00, 0x41]);
  const raw = {
    snapshot: () => ({ bytes, totalBytes: bytes.length }),
    finalize: () => ({ text: bytes.toString('utf8'), truncated: 0 }),
    readFrom: () => ({ text: bytes.toString('utf8'), nextOffset: 4, lossy: false }),
  };
  const runner = createSubprocessRunner(() => ({
    collected: { stdout: raw, stderr: collector('') },
    done: Promise.resolve({ exitCode: 0, signal: null }),
  }));
  const result = await runner({ argv: ['x'], cwd: 'C:/w', timeoutMs: 1000 });
  assert.equal(result.stdoutEncoding, 'binary');
  assert.equal(result.stdoutSha256, createHash('sha256').update(bytes).digest('hex'));
});

test('runner：spawn 抛错 → spawnError，不抛异常', async () => {
  const runner = createSubprocessRunner(() => {
    throw new Error('EPERM: spawn not allowed');
  });
  const result = await runner({ argv: ['x'], cwd: 'C:/w', timeoutMs: 1000 });
  assert.equal(result.spawnError, 'EPERM: spawn not allowed');
  assert.equal(result.exitCode, null);
  assert.equal(result.stdout, '');
});

test('runner：超时 → timedOut:true，且不把 abort 的 reject 记成 spawnError', async () => {
  const runner = createSubprocessRunner(
    (spec) => ({
      collected: { stdout: collector('partial'), stderr: collector('') },
      done: new Promise((_resolve, reject) => {
        spec.signal.addEventListener('abort', () => reject(new Error('aborted')));
      }),
    }),
    { graceMs: 50, timeoutMs: 1000 },
  );
  const result = await runner({ argv: ['slow.exe'], cwd: 'C:/w', timeoutMs: 20 });
  assert.equal(result.timedOut, true);
  assert.equal(result.spawnError, null);
  assert.equal(result.stdout, 'partial');
});

test('runner：done 永不 settle 时由兜底定时器收尾（不挂死）', async () => {
  const runner = createSubprocessRunner(
    () => ({
      collected: { stdout: collector('x'), stderr: collector('') },
      done: new Promise(() => {}),
    }),
    { graceMs: 10, timeoutMs: 1000 },
  );
  const result = await runner({ argv: ['hang.exe'], cwd: 'C:/w', timeoutMs: 30 });
  assert.equal(result.timedOut, true);
  assert.equal(result.spawnError, null);
});

test('runner：Windows 负退出码保留原始数值并给十六进制', async () => {
  const runner = createSubprocessRunner(() => handle({ exitCode: -1073741819 }));
  const result = await runner({ argv: ['crash.exe'], cwd: 'C:/w', timeoutMs: 1000 });
  assert.equal(result.exitCode, -1073741819);
  assert.equal(result.exitCodeHex, '0xc0000005');
});
