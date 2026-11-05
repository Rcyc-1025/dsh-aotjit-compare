import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { resolveConfig } from '../lib/config.js';
import { buildAotjitCompareTool, executePlan, preparePlan, sessionCwd } from '../lib/tools.js';

const here = dirname(fileURLToPath(import.meta.url));
const TMP_ROOT = join(here, '.tmp');
mkdirSync(TMP_ROOT, { recursive: true });

function makeWorkDir() {
  const dir = mkdtempSync(join(TMP_ROOT, 'tools-'));
  writeFileSync(join(dir, 'add.exe'), '');
  writeFileSync(join(dir, 'toyc.exe'), '');
  mkdirSync(join(dir, 'build'), { recursive: true });
  writeFileSync(join(dir, 'build', 'toyc.exe'), '');
  writeFileSync(join(dir, 'build', 'add.exe'), '');
  return dir;
}

function fakeRun(overrides = {}) {
  return {
    argv: ['x'],
    cwd: 'C:/w',
    exitCode: 9,
    exitCodeHex: '0x9',
    signal: null,
    timedOut: false,
    durationMs: 3,
    stdout: '7\n',
    stderr: '',
    stdoutBytes: 2,
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

const config = resolveConfig(undefined);

test('preparePlan：cases 为空 → NO_CASES', () => {
  const work = makeWorkDir();
  try {
    const result = preparePlan({ aotExe: 'add.exe', jitSpec: { cmd: 'build/toyc.exe' }, cases: [] }, work, config);
    assert.equal(result.ok, false);
    assert.equal(result.error.code, 'NO_CASES');
    assert.match(result.hint, /cases/);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test('preparePlan：超过 maxCases → TOO_MANY_CASES', () => {
  const work = makeWorkDir();
  try {
    const limited = resolveConfig({ maxCases: 2 });
    const cases = [{ name: 'a' }, { name: 'b' }, { name: 'c' }];
    const result = preparePlan({ aotExe: 'add.exe', jitSpec: { cmd: 'build/toyc.exe' }, cases }, work, limited);
    assert.equal(result.error.code, 'TOO_MANY_CASES');
    assert.match(result.hint, /maxCases/);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test('preparePlan：name 为空 / args 非数组 → INVALID_CASE', () => {
  const work = makeWorkDir();
  try {
    const noName = preparePlan({ aotExe: 'add.exe', jitSpec: { cmd: 'build/toyc.exe' }, cases: [{ name: ' ' }] }, work, config);
    assert.equal(noName.error.code, 'INVALID_CASE');
    assert.match(noName.error.message, /name/);

    const badArgs = preparePlan(
      { aotExe: 'add.exe', jitSpec: { cmd: 'build/toyc.exe' }, cases: [{ name: 'a', args: 'oops' }] },
      work,
      config,
    );
    assert.equal(badArgs.error.code, 'INVALID_CASE');
    assert.match(badArgs.error.message, /args/);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test('preparePlan：没有 aotExe → AOT_EXE_NOT_FOUND 且指明 case', () => {
  const work = makeWorkDir();
  try {
    const result = preparePlan({ jitSpec: { cmd: 'build/toyc.exe' }, cases: [{ name: 'case-07' }] }, work, config);
    assert.equal(result.error.code, 'AOT_EXE_NOT_FOUND');
    assert.match(result.error.message, /case-07/);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test('preparePlan：aotExe 不存在 → AOT_EXE_NOT_FOUND', () => {
  const work = makeWorkDir();
  try {
    const result = preparePlan(
      { aotExe: 'missing.exe', jitSpec: { cmd: 'build/toyc.exe' }, cases: [{ name: 'a' }] },
      work,
      config,
    );
    assert.equal(result.error.code, 'AOT_EXE_NOT_FOUND');
    assert.match(result.error.message, /missing\.exe/);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test('preparePlan：.cmd 包装器 → JIT_CMD_SHELL_WRAPPER；不存在 → JIT_CMD_NOT_FOUND', () => {
  const work = makeWorkDir();
  try {
    const wrapper = preparePlan(
      { aotExe: 'add.exe', jitSpec: { cmd: 'build/toyc.cmd' }, cases: [{ name: 'a' }] },
      work,
      config,
    );
    assert.equal(wrapper.error.code, 'JIT_CMD_SHELL_WRAPPER');
    assert.match(wrapper.hint, /cmd\.exe/);

    const missing = preparePlan(
      { aotExe: 'add.exe', jitSpec: { cmd: 'build/nope.exe' }, cases: [{ name: 'a' }] },
      work,
      config,
    );
    assert.equal(missing.error.code, 'JIT_CMD_NOT_FOUND');
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test('preparePlan：workDir 不存在 → WORKDIR_NOT_FOUND', () => {
  const work = makeWorkDir();
  try {
    const result = preparePlan(
      { aotExe: 'add.exe', jitSpec: { cmd: 'build/toyc.exe' }, cases: [{ name: 'a' }], workDir: 'nope' },
      work,
      config,
    );
    assert.equal(result.error.code, 'WORKDIR_NOT_FOUND');
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test('preparePlan：argv 约定 —— jitArgs 覆盖 jitSpec.args，case.args 追加到两侧', () => {
  const work = makeWorkDir();
  try {
    const prepared = preparePlan(
      {
        aotExe: 'add.exe',
        aotArgs: ['--aot-flag'],
        jitSpec: { cmd: 'build/toyc.exe', args: ['default.mlir', '--emit=run'] },
        cases: [
          { name: 'override', jitArgs: ['case-02.mlir', '--emit=run'], args: ['--runtime'] },
          { name: 'inherit' },
        ],
      },
      work,
      config,
    );
    assert.equal(prepared.ok, true);
    const [override, inherit] = prepared.plan.cases;
    assert.deepEqual(override.jitArgs, ['case-02.mlir', '--emit=run']);
    assert.deepEqual(override.args, ['--runtime']);
    assert.deepEqual(inherit.jitArgs, ['default.mlir', '--emit=run']);
    assert.deepEqual(inherit.args, []);
    assert.equal(prepared.plan.jitCmd, join(work, 'build', 'toyc.exe'));
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test('executePlan：两侧一致 → allMatch:true，row 带 argv/cwd/exit', async () => {
  const work = makeWorkDir();
  try {
    const prepared = preparePlan(
      { aotExe: 'add.exe', jitSpec: { cmd: 'build/toyc.exe', args: ['x.mlir', '--emit=run'] }, cases: [{ name: 'add.mul' }] },
      work,
      config,
    );
    const runner = async (spec) => ({ ...fakeRun({ argv: spec.argv, cwd: spec.cwd }) });
    const { result } = await executePlan(prepared.plan, runner);
    assert.equal(result.ok, true);
    assert.equal(result.allMatch, true);
    assert.equal(result.total, 1);
    assert.equal(result.matched, 1);
    assert.equal(result.rows[0].aot.exitCode, 9);
    assert.equal(result.rows[0].aot.stdout, '7\n');
    assert.deepEqual(result.rows[0].jit.cmd, [join(work, 'build', 'toyc.exe').replaceAll('\\', '/'), 'x.mlir', '--emit=run']);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test('executePlan：JIT 侧输出不同 → 首个 mismatch 可定位，其余行仍 match', async () => {
  const work = makeWorkDir();
  try {
    const prepared = preparePlan(
      {
        aotExe: 'add.exe',
        jitSpec: { cmd: 'build/toyc.exe' },
        cases: [
          { name: 'case-01', jitArgs: ['case-01.mlir'] },
          { name: 'case-07', jitArgs: ['case-07.mlir'] },
          { name: 'case-08', jitArgs: ['case-08.mlir'] },
        ],
      },
      work,
      config,
    );
    const runner = async (spec) => {
      const isJit = spec.argv[0].endsWith('toyc.exe');
      // 只有 case-07 的 JIT 侧注入错误：AOT 侧 argv 里没有 jitArgs。
      const isBuggy = spec.argv.includes('case-07.mlir');
      const stdout = isJit && isBuggy ? '8\n' : '7\n';
      return fakeRun({ argv: spec.argv, cwd: spec.cwd, stdout, stdoutBytes: 2 });
    };
    const { result } = await executePlan(prepared.plan, runner);
    assert.equal(result.allMatch, false);
    assert.equal(result.mismatched, 1);
    assert.equal(result.firstMismatchCase, 'case-07');
    assert.equal(result.firstMismatchField, 'stdout');
    assert.equal(result.rows[0].match, true);
    assert.equal(result.rows[2].match, true);
    assert.equal(result.rows[1].diffs[0].expected, '7');
    assert.equal(result.rows[1].diffs[0].actual, '8');
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test('executePlan：全部启动失败 → ok:false + 中文 hint', async () => {
  const work = makeWorkDir();
  try {
    const prepared = preparePlan(
      { aotExe: 'add.exe', jitSpec: { cmd: 'build/toyc.exe' }, cases: [{ name: 'a' }, { name: 'b' }] },
      work,
      config,
    );
    const runner = async (spec) => fakeRun({ argv: spec.argv, spawnError: 'EPERM' });
    const { result } = await executePlan(prepared.plan, runner);
    assert.equal(result.ok, false);
    assert.equal(result.error.code, 'SPAWN_FAILED');
    assert.match(result.hint, /EPERM|启动失败/);
    assert.equal(result.rows[0].error.code, 'SPAWN_FAILED');
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test('executePlan：sideEffects 内容不同 → firstMismatch sideEffects，且两侧隔离目录独立', async () => {
  const work = makeWorkDir();
  try {
    const prepared = preparePlan(
      {
        aotExe: 'add.exe',
        jitSpec: { cmd: 'build/toyc.exe' },
        cases: [{ name: 'case-07' }],
        compare: { sideEffects: { paths: ['out/result.txt'], mode: 'content' } },
      },
      work,
      config,
    );
    const runner = async (spec) => {
      const isJit = spec.argv[0].endsWith('toyc.exe');
      mkdirSync(join(spec.cwd, 'out'), { recursive: true });
      writeFileSync(join(spec.cwd, 'out', 'result.txt'), isJit ? '8\n' : '7\n', 'utf8');
      // AOT 侧另外写一个未声明的文件，JIT 侧不应看到（隔离）。
      if (!isJit) writeFileSync(join(spec.cwd, 'scratch.txt'), 'aot-only', 'utf8');
      return fakeRun({ argv: spec.argv, cwd: spec.cwd });
    };
    const { result } = await executePlan(prepared.plan, runner, { maxSideEffectBytes: config.maxSideEffectBytes });
    assert.equal(result.rows[0].match, false);
    assert.equal(result.rows[0].firstMismatch, 'sideEffects');
    const diff = result.rows[0].diffs.find((item) => item.field === 'sideEffects');
    assert.equal(diff.kind, 'content');
    assert.equal(diff.path, 'out/result.txt');
    assert.equal(diff.expected, '7');
    assert.equal(diff.actual, '8');
    assert.notEqual(result.rows[0].isolation.aot, result.rows[0].isolation.jit);
    // 一次调用结束后隔离根目录必须被清掉（否则 workDir/.aotjit 会随运行次数累积）。
    assert.equal(existsSync(join(work, '.aotjit', prepared.plan.runId)), false);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test('tool.execute：完整链路写日志，且日志不含 stdin 原文', async () => {
  const work = makeWorkDir();
  try {
    const runner = async (spec) => fakeRun({ argv: spec.argv, cwd: spec.cwd });
    const tool = buildAotjitCompareTool(config, runner);
    const value = await tool.execute(
      {
        aotExe: 'add.exe',
        jitSpec: { cmd: 'build/toyc.exe', args: ['examples/add.mul.mlir', '--emit=run'] },
        cases: [{ name: 'add.mul', stdin: 'SENSITIVE-INPUT-TOKEN' }],
        workDir: work,
      },
      { agent: { session: { header: { cwd: work } } } },
    );
    assert.equal(value.ok, true);
    assert.equal(value.allMatch, true);
    assert.equal(value.total, 1);
    assert.equal(typeof value.logPath, 'string');
    assert.equal(existsSync(value.logPath), true);
    const log = readFileSync(value.logPath, 'utf8');
    assert.match(log, /add\.mul/);
    assert.match(log, /exit: 9/);
    assert.equal(log.includes('SENSITIVE-INPUT-TOKEN'), false);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test('tool.execute：输入错误返回 ok:false 且不抛异常', async () => {
  const work = makeWorkDir();
  try {
    const tool = buildAotjitCompareTool(config, async () => fakeRun());
    const value = await tool.execute({ jitSpec: { cmd: 'build/toyc.exe' }, cases: [] }, { agent: { session: { header: { cwd: work } } } });
    assert.equal(value.ok, false);
    assert.equal(value.error.code, 'NO_CASES');
    assert.equal(typeof value.error.hint, 'string');
    assert.equal(value.logPath, null);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test('tool.render：摘要包含 matched/mismatch 与首处不一致', async () => {
  const work = makeWorkDir();
  try {
    const runner = async (spec) => {
      const isJit = spec.argv[0].endsWith('toyc.exe');
      return fakeRun({ argv: spec.argv, cwd: spec.cwd, stdout: isJit ? '8\n' : '7\n' });
    };
    const tool = buildAotjitCompareTool(config, runner);
    const value = await tool.execute(
      { aotExe: 'add.exe', jitSpec: { cmd: 'build/toyc.exe' }, cases: [{ name: 'case-07' }], workDir: work },
      { agent: { session: { header: { cwd: work } } } },
    );
    const rendered = tool.output.render({}, value);
    assert.equal(rendered[0].type, 'text');
    assert.match(rendered[0].text, /matched=0 mismatched=1/);
    assert.match(rendered[0].text, /case-07/);
    assert.match(rendered[0].text, /stdout/);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test('sessionCwd：从 exec.agent.session.header.cwd 取，缺失时回退 process.cwd()', () => {
  assert.equal(sessionCwd({ agent: { session: { header: { cwd: 'C:/x' } } } }), 'C:/x');
  assert.equal(sessionCwd(undefined), process.cwd());
  assert.equal(sessionCwd({ agent: {} }), process.cwd());
});
