/**
 * 真机集成（需要能真正 spawn 进程的环境；DSH 受限沙箱里 Node 自己 spawn 会 EPERM）：
 * 用 node:child_process 模拟 ctx.subprocess 的 handle 契约，把插件跑在真实 exe 上。
 *
 * 运行：node test/integration.real.mjs [--json]
 * 只读 mlir-lang 的产物，所有写入都在本目录的 .tmp/ 下。
 */

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { apply } from '../lib/index.js';

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, '..');
const MLIR = 'D:\\Alice\\Documents\\deepseek-harness\\default-workspace\\mlir-lang';
const WORK = join(here, '.tmp', 'integration');
const LOG_DIR = '.tmp/integration-logs';

const TOYC = join(MLIR, 'build', 'toyc.exe');
const ADD_EXE = join(MLIR, 'build', 's01', 'add.exe');
const CMD = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'cmd.exe');

function makeCollector(maxBytes) {
  const chunks = [];
  let total = 0;
  let kept = 0;
  let dropped = 0;
  return {
    feed(buffer) {
      total += buffer.length;
      const room = Math.max(0, maxBytes - kept);
      if (room > 0) {
        const part = buffer.subarray(0, room);
        chunks.push(part);
        kept += part.length;
      }
      if (buffer.length > room) dropped += buffer.length - room;
    },
    snapshot() {
      const bytes = Buffer.concat(chunks);
      return { bytes, totalBytes: total };
    },
    finalize() {
      return { text: Buffer.concat(chunks).toString('utf8'), truncated: dropped };
    },
  };
}

/** 把 node:child_process 包成 ctx.subprocess.spawn 的 handle 形状。 */
function spawnHandle(spec) {
  const maxOut = spec?.stdio?.stdout?.maxBytes ?? 1_048_576;
  const maxErr = spec?.stdio?.stderr?.maxBytes ?? 1_048_576;
  const stdout = makeCollector(maxOut);
  const stderr = makeCollector(maxErr);
  const child = spawn(spec.argv[0], spec.argv.slice(1), {
    cwd: spec.cwd,
    env: { ...process.env, ...(spec.env ?? {}) },
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  child.stdout.on('data', (chunk) => stdout.feed(chunk));
  child.stderr.on('data', (chunk) => stderr.feed(chunk));

  const stdinMode = spec?.stdio?.stdin;
  if (stdinMode !== null && typeof stdinMode === 'object' && 'data' in stdinMode) {
    child.stdin.end(stdinMode.data);
  } else {
    child.stdin.end();
  }

  const done = new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', (code, signal) => resolve({ exitCode: code, signal: signal ?? null }));
  });

  if (spec.signal !== undefined && spec.signal !== null) {
    spec.signal.addEventListener('abort', () => {
      try {
        child.kill('SIGTERM');
      } catch {
        /* 进程可能已退出 */
      }
      const timer = setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch {
          /* 同上 */
        }
      }, spec.graceMs ?? 2_000);
      timer.unref?.();
    });
  }

  return {
    collected: { stdout, stderr },
    done,
    terminate() {
      try {
        child.kill();
      } catch {
        /* 忽略 */
      }
    },
    waitForExit: () => done,
  };
}

const results = [];
function record(name, fn) {
  try {
    fn();
    results.push({ name, ok: true });
    console.log(`PASS ${name}`);
  } catch (error) {
    results.push({ name, ok: false, message: error.message });
    console.error(`FAIL ${name}: ${error.message}`);
  }
}

const ctx = {
  registered: [],
  tools: {
    register(definition) {
      ctx.registered.push(definition);
      return () => {};
    },
  },
  subprocess: { spawn: spawnHandle },
  on() {},
};

mkdirSync(WORK, { recursive: true });
mkdirSync(join(WORK, 'out'), { recursive: true });
apply(ctx, { logDir: LOG_DIR, timeoutMs: 60_000 });
const tool = ctx.registered[0];
const exec = { agent: { session: { header: { cwd: ROOT } } } };

// 1) S-01 单用例：AOT 与 JIT 都输出 7、退出 9
const single = await tool.execute(
  {
    aotExe: ADD_EXE,
    jitSpec: { cmd: TOYC, args: [join(MLIR, 'examples', 'add.mul.mlir'), '--emit=run'] },
    cases: [{ name: 'add.mul' }],
    workDir: WORK,
  },
  exec,
);
record('S-01 单用例 allMatch', () => {
  assert.equal(single.ok, true);
  assert.equal(single.allMatch, true);
  assert.equal(single.rows[0].aot.exitCode, 9);
  assert.equal(single.rows[0].jit.exitCode, 9);
  assert.equal(single.rows[0].aot.stdout.replace(/\r\n/g, '\n'), '7\n');
  assert.equal(single.rows[0].jit.stdout.replace(/\r\n/g, '\n'), '7\n');
});
record('日志已落盘', () => {
  assert.equal(existsSync(single.logPath), true);
  assert.match(readFileSync(single.logPath, 'utf8'), /add\.mul/);
});

// 2) 真实 stdout 差异：JIT 侧换成 cmd.exe 输出 8
const diff = await tool.execute(
  {
    aotExe: ADD_EXE,
    jitSpec: { cmd: CMD, args: ['/c', 'echo 8 & exit 9'] },
    cases: [{ name: 'echo-8' }],
    workDir: WORK,
  },
  exec,
);
record('stdout 差异定位到行', () => {
  assert.equal(diff.ok, true);
  assert.equal(diff.allMatch, false);
  assert.equal(diff.firstMismatchCase, 'echo-8');
  assert.equal(diff.firstMismatchField, 'stdout');
  assert.equal(diff.rows[0].diffs[0].expected, '7');
  assert.equal(diff.rows[0].diffs[0].actual.trim(), '8');
});

// 3) 真实超时：JIT 侧 sleep，timeoutMs=600
const timeout = await tool.execute(
  {
    aotExe: ADD_EXE,
    jitSpec: { cmd: CMD, args: ['/c', 'ping -n 6 127.0.0.1 >nul'] },
    cases: [{ name: 'slow' }],
    timeoutMs: 600,
    workDir: WORK,
  },
  exec,
);
record('超时 → timedOut 且 ok:true', () => {
  assert.equal(timeout.ok, true);
  assert.equal(timeout.allMatch, false);
  assert.equal(timeout.firstMismatchField, 'timeout');
  assert.equal(timeout.rows[0].jit.timedOut, true);
});

// 4) 真实截断：JIT 侧输出 400 行，maxOutputBytes=256
const truncated = await tool.execute(
  {
    aotExe: ADD_EXE,
    jitSpec: { cmd: CMD, args: ['/c', '(for /l %i in (1,1,400) do @echo xxxxxxxxxxxxxxxxxxxx) & exit 9'] },
    cases: [{ name: 'noisy' }],
    maxOutputBytes: 256,
    workDir: WORK,
  },
  exec,
);
record('输出截断 → firstMismatch truncated', () => {
  assert.equal(truncated.ok, true);
  assert.equal(truncated.rows[0].jit.stdoutTruncated, true);
  assert.equal(truncated.firstMismatchField, 'truncated');
});

// 5) 真实文件副作用：AOT 写 7、JIT 写 8，内容不同
// 注意 cmd 里 `echo 7>result.txt` 会被解析成「句柄 7 重定向」，必须写成 `>result.txt echo 7`。
const side = await tool.execute(
  {
    aotExe: CMD,
    aotArgs: ['/c', '>result.txt echo 7'],
    jitSpec: { cmd: CMD, args: ['/c', '>result.txt echo 8'] },
    cases: [{ name: 'write-file' }],
    compare: { stdout: false, exit: false, sideEffects: { paths: ['result.txt'], mode: 'content' } },
    workDir: WORK,
  },
  exec,
);
record('副作用差异 + 隔离目录', () => {
  assert.equal(side.ok, true);
  assert.equal(side.rows[0].isolation.aot !== side.rows[0].isolation.jit, true);
  assert.equal(side.firstMismatchField, 'sideEffects');
  const diff = side.rows[0].diffs.find((item) => item.field === 'sideEffects');
  assert.equal(diff.expected.trim(), '7');
  assert.equal(diff.actual.trim(), '8');
});

// 6) JIT 命令不存在 → ok:false + hint；.cmd 包装器被拒
const missing = await tool.execute(
  { aotExe: ADD_EXE, jitSpec: { cmd: 'definitely-not-here.exe' }, cases: [{ name: 'x' }], workDir: WORK },
  exec,
);
record('JIT 命令缺失 → ok:false + hint', () => {
  assert.equal(missing.ok, false);
  assert.equal(missing.error.code, 'JIT_CMD_NOT_FOUND');
  assert.equal(typeof missing.hint, 'string');
});

const wrapper = await tool.execute(
  { aotExe: ADD_EXE, jitSpec: { cmd: 'build\\toyc.cmd' }, cases: [{ name: 'x' }], workDir: WORK },
  exec,
);
record('.cmd 包装器被拒', () => {
  assert.equal(wrapper.ok, false);
  assert.equal(wrapper.error.code, 'JIT_CMD_SHELL_WRAPPER');
});

const failed = results.filter((item) => item.ok === false);
if (process.argv.includes('--json')) {
  console.log(JSON.stringify({ total: results.length, failed: failed.length, results }, null, 2));
}
rmSync(WORK, { recursive: true, force: true });

if (failed.length > 0) {
  console.error(`integration: ${failed.length}/${results.length} 失败`);
  process.exitCode = 1;
} else {
  console.log(`integration: ${results.length}/${results.length} 通过`);
}
