/**
 * 10 用例 parity 验收（规格 6.1 ②③）：本仓库自带 `test/fixtures/parity/case-01..10.mlir`，
 * 用真实 toyc 生成 AOT 可执行文件，再与 `--emit=run` 的 JIT 侧逐项对拍。
 *
 * ① 10 个用例必须 10/10 全一致；
 * ② 把 case-05 的常量改一下当作「注入错误」，必须只报这一条，且定位到 stdout + 行号。
 *
 * 运行（需要能真正 spawn 的环境；DSH 受限沙箱里 node 自己 spawn 会 EPERM，请用宿主侧 run_node）：
 *   node test/integration.parity.mjs [--json]
 *
 * 工具链位置可用环境变量覆盖：
 *   AOTJIT_TOYC     toyc.exe   默认读 mlir-lang 的 build/toyc.exe
 *   AOTJIT_CLANG    clang++.exe 默认读 LLVM 23.1.4 Windows 包里的 clang++
 * 缺工具时打印 SKIP 并以 0 退出（不让 CI 因缺工具变红）。
 */

import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { apply } from '../lib/index.js';

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, '..');
const FIXTURES = join(here, 'fixtures', 'parity');
const WORK = join(here, '.tmp', 'parity');
const BIN = join(WORK, 'bin');
const LOG_DIR = '.tmp/parity-logs';

const MLIR = 'D:\\Alice\\Documents\\deepseek-harness\\default-workspace\\mlir-lang';
const TOYC = process.env.AOTJIT_TOYC ?? join(MLIR, 'build', 'toyc.exe');
const CLANG =
  process.env.AOTJIT_CLANG ??
  'D:\\Code\\llvm\\clang+llvm-23.1.4-x86_64-pc-windows-msvc\\bin\\clang++.exe';

const CASES = [
  'case-01', 'case-02', 'case-03', 'case-04', 'case-05',
  'case-06', 'case-07', 'case-08', 'case-09', 'case-10',
];

// ---------- 沙箱里也要能跑：把 node:child_process 包成 handle 契约 ----------

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
      return { bytes: Buffer.concat(chunks), totalBytes: total };
    },
    finalize() {
      return { text: Buffer.concat(chunks).toString('utf8'), truncated: dropped };
    },
  };
}

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

// ---------- 工具链 ----------

if (!existsSync(TOYC)) {
  console.log(`SKIP parity: 找不到 toyc（${TOYC}），可用 AOTJIT_TOYC 指定。`);
  process.exit(0);
}
if (!existsSync(CLANG)) {
  console.log(`SKIP parity: 找不到 clang++（${CLANG}），可用 AOTJIT_CLANG 指定。`);
  process.exit(0);
}

for (const name of CASES) {
  if (!existsSync(join(FIXTURES, `${name}.mlir`))) {
    console.error(`FAIL parity: 缺少夹具 ${name}.mlir`);
    process.exit(1);
  }
}

rmSync(WORK, { recursive: true, force: true });
mkdirSync(BIN, { recursive: true });

// 夹具与产物都放进 workDir，让 argv 里的相对路径能解析到。
for (const name of CASES) copyFileSync(join(FIXTURES, `${name}.mlir`), join(WORK, `${name}.mlir`));

function buildAot(name) {
  const exe = join(BIN, `${name}.exe`);
  const built = spawnSync(TOYC, [join(WORK, `${name}.mlir`), '--emit=exe', '-o', exe, `--clang=${CLANG}`], {
    cwd: WORK,
    encoding: 'utf8',
    windowsHide: true,
  });
  if (built.status !== 0) {
    throw new Error(`toyc 编译 ${name} 失败（exit ${built.status}）：${(built.stderr ?? '').trim() || '无 stderr'}`);
  }
  return exe;
}

const exes = new Map();
for (const name of CASES) exes.set(name, buildAot(name));

// ---------- 跑插件 ----------

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
apply(ctx, { logDir: LOG_DIR, timeoutMs: 120_000 });
const tool = ctx.registered[0];
const exec = { agent: { session: { header: { cwd: ROOT } } } };

const results = [];
async function check(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`PASS ${name}`);
  } catch (error) {
    results.push({ name, ok: false, message: error.message });
    console.error(`FAIL ${name}: ${error.message}`);
  }
}

const parityCases = CASES.map((name) => ({
  name,
  aotExe: `bin/${name}.exe`,
  jitArgs: [`${name}.mlir`, '--emit=run'],
}));

const allMatch = await tool.execute(
  {
    jitSpec: { cmd: TOYC },
    cases: parityCases,
    workDir: WORK,
    tag: 'parity-10',
  },
  exec,
);

await check('10 用例 10/10 全一致', () => {
  assert.equal(allMatch.ok, true, allMatch.hint ?? '');
  assert.equal(allMatch.total, 10);
  assert.equal(allMatch.matched, 10);
  assert.equal(allMatch.mismatched, 0);
  assert.equal(allMatch.allMatch, true);
});

await check('每个用例 stdout 与 exit 都按夹具值', () => {
  const expected = [
    ['case-01', '7', 9],
    ['case-02', '30', 35],
    ['case-03', '123', 127],
    ['case-04', '3', 3],
    ['case-05', '100', 101],
    ['case-06', '18', 27],
    ['case-07', '0', 7],
    ['case-08', '168', 170],
    ['case-09', '84', 84],
    ['case-10', '5', 9],
  ];
  for (const [name, stdout, code] of expected) {
    const row = allMatch.rows.find((item) => item.case === name);
    assert.ok(row, `缺少 ${name} 的行`);
    assert.equal(row.match, true, `${name} 期望一致`);
    assert.equal(row.aot.stdout.replace(/\r\n/g, '\n'), `${stdout}\n`);
    assert.equal(row.jit.stdout.replace(/\r\n/g, '\n'), `${stdout}\n`);
    assert.equal(row.aot.exitCode, code);
    assert.equal(row.jit.exitCode, code);
  }
});

await check('日志落盘且列出 10 个用例', () => {
  assert.equal(existsSync(allMatch.logPath), true);
  const log = readFileSync(allMatch.logPath, 'utf8');
  for (const name of CASES) assert.match(log, new RegExp(name));
});

// ---------- 注入错误：只改 case-05 打印的值，不动它的退出码 ----------
// 规格 6.1③ 要求 firstMismatchField:"stdout"；但字段优先级是 exit 早于 stdout，
// 所以注入必须「只污染打印值、保持 return 不变」，否则会被正确地判成 exit 差异。

const buggySource = readFileSync(join(WORK, 'case-05.mlir'), 'utf8');
const printed = '    %sum = toy.add %lhs, %rhs : i32\n    toy.print %sum : i32\n';
const patchedPrint =
  '    %sum = toy.add %lhs, %rhs : i32\n' +
  '    %bug = toy.constant 1 : i32\n' +
  '    %bad = toy.add %sum, %bug : i32\n' +
  '    toy.print %bad : i32\n';
const patched = buggySource.replace(printed, patchedPrint);
if (patched === buggySource) throw new Error('注入失败：case-05.mlir 里没找到打印块');
writeFileSync(join(WORK, 'case-05-buggy.mlir'), patched, 'utf8');

const buggyCases = parityCases.map((item) =>
  item.name === 'case-05' ? { ...item, jitArgs: ['case-05-buggy.mlir', '--emit=run'] } : item,
);
const buggy = await tool.execute(
  {
    jitSpec: { cmd: TOYC },
    cases: buggyCases,
    workDir: WORK,
    tag: 'parity-buggy',
  },
  exec,
);

await check('注入错误只报 case-05，定位到 stdout', () => {
  assert.equal(buggy.ok, true, buggy.hint ?? '');
  assert.equal(buggy.allMatch, false);
  assert.equal(buggy.total, 10);
  assert.equal(buggy.matched, 9);
  assert.equal(buggy.mismatched, 1);
  assert.equal(buggy.firstMismatchCase, 'case-05');
  assert.equal(buggy.firstMismatchField, 'stdout');
  const row = buggy.rows.find((item) => item.case === 'case-05');
  assert.equal(row.match, false);
  // 注入只碰打印值，退出码必须两侧一致——这也是它能被判成 stdout 而不是 exit 的前提。
  assert.equal(row.aot.exitCode, row.jit.exitCode);
  const diff = row.diffs.find((item) => item.field === 'stdout');
  assert.equal(diff.expected, '100');
  assert.equal(diff.actual, '101');
});

await check('其余 9 行仍一致', () => {
  for (const row of buggy.rows) {
    if (row.case === 'case-05') continue;
    assert.equal(row.match, true, `${row.case} 不应受影响`);
  }
});

const failed = results.filter((item) => item.ok === false);
if (process.argv.includes('--json')) {
  console.log(JSON.stringify({ total: results.length, failed: failed.length, results }, null, 2));
}

for (const line of results) {
  if (!line.ok) console.error(`  ${line.name}: ${line.message}`);
}
rmSync(WORK, { recursive: true, force: true });

if (failed.length > 0) {
  console.error(`parity: ${failed.length}/${results.length} 失败`);
  process.exitCode = 1;
} else {
  console.log(`parity: ${results.length}/${results.length} 通过`);
}
