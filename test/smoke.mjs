/**
 * 冒烟测试：不真起进程，用假的 ctx.subprocess 把「插件加载 → 工具注册 → 调用 →
 * 日志落盘 → 渲染」整条链路走一遍。
 *
 * 真机（真实 exe / 真实 JIT 命令）的验收见 README「验证」一节，需要宿主侧执行。
 * 运行：npm run smoke
 */

import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { apply, inject, name } from '../lib/index.js';

const here = dirname(fileURLToPath(import.meta.url));
const TMP_ROOT = join(here, '.tmp');
mkdirSync(TMP_ROOT, { recursive: true });

function collector(text, bytes = Buffer.from(text, 'utf8')) {
  return {
    snapshot: () => ({ bytes, totalBytes: bytes.length }),
    finalize: () => ({ text, truncated: 0 }),
  };
}

/** 假 subprocess：按 argv[0] 决定 AOT / JIT 的输出，模拟一次「对拍有差异」的场景。 */
function makeContext({ jitStdout = '7\n' } = {}) {
  const registered = [];
  const listeners = new Map();
  const spawns = [];
  return {
    registered,
    spawns,
    tools: {
      register(definition) {
        registered.push(definition);
        return () => {};
      },
    },
    subprocess: {
      spawn(spec) {
        spawns.push(spec);
        const isJit = /toyc\.exe$/i.test(spec.argv[0]);
        const stdout = isJit ? jitStdout : '7\n';
        return {
          collected: { stdout: collector(stdout), stderr: collector('') },
          done: Promise.resolve({ exitCode: isJit ? 9 : 9, signal: null }),
          waitForExit: () => Promise.resolve({ exitCode: 9, signal: null }),
          terminate() {},
        };
      },
    },
    on(event, handler) {
      listeners.set(event, handler);
    },
  };
}

function makeWorkspace() {
  const dir = mkdtempSync(join(TMP_ROOT, 'smoke-'));
  mkdirSync(join(dir, 'build'), { recursive: true });
  writeFileSync(join(dir, 'build', 'add.exe'), '');
  writeFileSync(join(dir, 'build', 'toyc.exe'), '');
  writeFileSync(join(dir, 'add.mul.mlir'), 'func.func @main() { %0 = arith.constant 7 : i32 ... }\n');
  return dir;
}

function check(label, fn) {
  try {
    fn();
    console.log(`PASS ${label}`);
  } catch (error) {
    console.error(`FAIL ${label}: ${error.message}`);
    throw error;
  }
}

const workspace = makeWorkspace();
try {
  const ctx = makeContext();
  apply(ctx, { logDir: '.aotjit-logs' });

  check('插件契约', () => {
    assert.equal(name, 'aotjit-compare');
    assert.deepEqual(inject, ['subprocess', 'tools']);
    assert.equal(ctx.registered.length, 1);
    assert.equal(ctx.registered[0].name, 'aotjit_compare');
  });

  const tool = ctx.registered[0];
  const exec = { agent: { session: { header: { cwd: workspace } } } };
  const args = {
    aotExe: 'build/add.exe',
    jitSpec: { cmd: 'build/toyc.exe', args: ['add.mul.mlir', '--emit=run'] },
    cases: [{ name: 'add.mul' }],
    workDir: workspace,
  };

  const ok = await tool.execute(args, exec);
  check('全一致 → ok:true / allMatch:true', () => {
    assert.equal(ok.ok, true);
    assert.equal(ok.allMatch, true);
    assert.equal(ok.total, 1);
    assert.equal(ok.rows[0].aot.exitCode, 9);
    assert.equal(ok.rows[0].aot.stdout, '7\n');
    assert.equal(ok.rows[0].jit.stdout, '7\n');
  });

  check('日志落盘且不含 stdin 原文', () => {
    assert.equal(typeof ok.logPath, 'string');
    assert.equal(existsSync(ok.logPath), true);
    const log = readFileSync(ok.logPath, 'utf8');
    assert.match(log, /add\.mul/);
    assert.match(log, /exit: 9/);
    assert.equal(log.includes('SENSITIVE-INPUT-TOKEN'), false);
  });

  check('渲染摘要', () => {
    const rendered = tool.output.render({}, ok);
    assert.equal(rendered[0].type, 'text');
    assert.match(rendered[0].text, /matched=1/);
  });

  const differ = makeContext({ jitStdout: '8\n' });
  apply(differ, { logDir: '.aotjit-logs' });
  const mismatch = await differ.registered[0].execute(
    { ...args, cases: [{ name: 'add.mul', stdin: 'SENSITIVE-INPUT-TOKEN' }] },
    exec,
  );
  check('JIT 输出不同 → allMatch:false 且定位到行', () => {
    assert.equal(mismatch.ok, true);
    assert.equal(mismatch.allMatch, false);
    assert.equal(mismatch.firstMismatchCase, 'add.mul');
    assert.equal(mismatch.firstMismatchField, 'stdout');
    assert.equal(mismatch.rows[0].diffs[0].expected, '7');
    assert.equal(mismatch.rows[0].diffs[0].actual, '8');
    assert.equal(mismatch.rows[0].diffs[0].aotLine, 1);
  });

  const invalid = await differ.registered[0].execute({ jitSpec: { cmd: 'build/toyc.exe' }, cases: [] }, exec);
  check('空 cases → NO_CASES', () => {
    assert.equal(invalid.ok, false);
    assert.equal(invalid.error.code, 'NO_CASES');
    assert.equal(typeof invalid.error.hint, 'string');
  });

  console.log('smoke: 全部通过');
} finally {
  rmSync(workspace, { recursive: true, force: true });
}
