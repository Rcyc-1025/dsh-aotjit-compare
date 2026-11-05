import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

import {
  cleanupIsolation,
  compareSideEffects,
  isInside,
  prepareIsolation,
  takeSnapshot,
  validateSideEffects,
} from '../lib/sidefx.js';

const here = dirname(fileURLToPath(import.meta.url));
const TMP_ROOT = join(here, '.tmp');
mkdirSync(TMP_ROOT, { recursive: true });

function makeWorkDir() {
  return mkdtempSync(join(TMP_ROOT, 'sidefx-'));
}

test('isInside：目录内外的判断', () => {
  assert.equal(isInside('C:/w', 'C:/w/out/x.txt'), true);
  assert.equal(isInside('C:/w', 'C:/w'), true);
  assert.equal(isInside('C:/w', 'C:/other/x.txt'), false);
});

test('validateSideEffects：相对路径通过，默认 hash + isolate', () => {
  const result = validateSideEffects({ paths: ['out/result.txt'] }, 'C:/w');
  assert.equal(result.ok, true);
  assert.deepEqual(result.options, { paths: ['out/result.txt'], mode: 'hash', isolate: true, seed: [] });
});

test('validateSideEffects：绝对路径与 .. 逃逸被拒绝', () => {
  const absolute = validateSideEffects({ paths: ['C:/w/out.txt'] }, 'C:/w');
  assert.equal(absolute.ok, false);
  assert.equal(absolute.error.code, 'SIDE_EFFECT_ESCAPE');

  const escape = validateSideEffects({ paths: ['../etc/passwd'] }, 'C:/w');
  assert.equal(escape.ok, false);
  assert.equal(escape.error.code, 'SIDE_EFFECT_ESCAPE');
});

test('validateSideEffects：paths 缺失/为空 → INVALID_CASE', () => {
  assert.equal(validateSideEffects({}, 'C:/w').error.code, 'INVALID_CASE');
  assert.equal(validateSideEffects({ paths: [] }, 'C:/w').error.code, 'INVALID_CASE');
  assert.equal(validateSideEffects(null, 'C:/w').error.code, 'INVALID_CASE');
});

test('validateSideEffects：seed 逃逸被拒绝，mode 非法退回 hash', () => {
  const badSeed = validateSideEffects({ paths: ['out/'], seed: ['../x'] }, 'C:/w');
  assert.equal(badSeed.error.code, 'SIDE_EFFECT_ESCAPE');
  const mode = validateSideEffects({ paths: ['out/'], mode: 'nope' }, 'C:/w');
  assert.equal(mode.ok, true);
  assert.equal(mode.options.mode, 'hash');
});

test('takeSnapshot：hash 模式记录 size 与 sha256，缺失路径记为 missing', () => {
  const work = makeWorkDir();
  try {
    writeFileSync(join(work, 'result.txt'), '7\n', 'utf8');
    const snapshot = takeSnapshot(work, ['result.txt', 'gone.txt'], { mode: 'hash', maxBytes: 1024 });
    assert.equal(snapshot.ok, true);
    const file = snapshot.entries.find((entry) => entry.path === 'result.txt');
    assert.equal(file.kind, 'file');
    assert.equal(file.size, 2);
    assert.equal(typeof file.sha256, 'string');
    const missing = snapshot.entries.find((entry) => entry.path === 'gone.txt');
    assert.equal(missing.kind, 'missing');
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test('takeSnapshot：content 模式带文本；超上限 → SIDE_EFFECT_TOO_LARGE', () => {
  const work = makeWorkDir();
  try {
    writeFileSync(join(work, 'out.txt'), 'a\nb\n', 'utf8');
    const snapshot = takeSnapshot(work, ['out.txt'], { mode: 'content', maxBytes: 1024 });
    assert.equal(snapshot.entries[0].text, 'a\nb\n');

    const tooLarge = takeSnapshot(work, ['out.txt'], { mode: 'content', maxBytes: 1 });
    assert.equal(tooLarge.ok, false);
    assert.equal(tooLarge.error.code, 'SIDE_EFFECT_TOO_LARGE');
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test('takeSnapshot：tree 模式递归目录并给每个文件 hash', () => {
  const work = makeWorkDir();
  try {
    mkdirSync(join(work, 'out', 'nested'), { recursive: true });
    writeFileSync(join(work, 'out', 'a.txt'), 'a', 'utf8');
    writeFileSync(join(work, 'out', 'nested', 'b.txt'), 'b', 'utf8');
    const snapshot = takeSnapshot(work, ['out'], { mode: 'tree', maxBytes: 1024 });
    assert.equal(snapshot.ok, true);
    const paths = snapshot.entries.map((entry) => entry.path).sort();
    assert.deepEqual(paths, ['out', 'out/a.txt', 'out/nested', 'out/nested/b.txt']);
    assert.equal(snapshot.entries.filter((entry) => entry.kind === 'file').every((entry) => typeof entry.sha256 === 'string'), true);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test('compareSideEffects：一致返回空数组', () => {
  const a = { entries: [{ path: 'out.txt', kind: 'file', sha256: 'aa', size: 1 }] };
  const b = { entries: [{ path: 'out.txt', kind: 'file', sha256: 'aa', size: 1 }] };
  assert.deepEqual(compareSideEffects(a, b, 'hash'), []);
});

test('compareSideEffects：内容不同 → content 差异带首个不同行', () => {
  const a = { entries: [{ path: 'out.txt', kind: 'file', sha256: 'aa', size: 4, text: '7\n' }] };
  const b = { entries: [{ path: 'out.txt', kind: 'file', sha256: 'bb', size: 4, text: '8\n' }] };
  const diffs = compareSideEffects(a, b, 'content');
  assert.equal(diffs.length, 1);
  assert.equal(diffs[0].field, 'sideEffects');
  assert.equal(diffs[0].kind, 'content');
  assert.equal(diffs[0].path, 'out.txt');
  assert.equal(diffs[0].aotLine, 1);
  assert.equal(diffs[0].expected, '7');
  assert.equal(diffs[0].actual, '8');
});

test('compareSideEffects：一侧缺失 → kind missing，expected 是 AOT 侧', () => {
  const a = { entries: [{ path: 'out.txt', kind: 'file', sha256: 'aa', size: 1 }] };
  const b = { entries: [{ path: 'out.txt', kind: 'missing' }] };
  const diffs = compareSideEffects(a, b, 'hash');
  assert.equal(diffs[0].kind, 'missing');
  assert.equal(diffs[0].expected, 'file');
  assert.equal(diffs[0].actual, 'missing');
});

test('prepareIsolation：AOT/JIT 各一个目录，seed 复制两份，互不可见', () => {
  const work = makeWorkDir();
  try {
    writeFileSync(join(work, 'input.txt'), 'seed', 'utf8');
    const prepared = prepareIsolation({
      workDir: work,
      runId: 'run1',
      caseIndex: 1,
      seed: ['input.txt'],
      maxBytes: 1024,
    });
    assert.equal(prepared.ok, true);
    assert.equal(existsSync(join(prepared.aotDir, 'input.txt')), true);
    assert.equal(existsSync(join(prepared.jitDir, 'input.txt')), true);

    // AOT 侧写文件，JIT 侧不应看到。
    writeFileSync(join(prepared.aotDir, 'out.txt'), 'aot', 'utf8');
    assert.equal(existsSync(join(prepared.jitDir, 'out.txt')), false);

    const warning = cleanupIsolation(work, 'run1');
    assert.equal(warning, null);
    assert.equal(existsSync(prepared.aotDir), false);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test('prepareIsolation：seed 不存在 → SIDE_EFFECT_COPY_FAILED', () => {
  const work = makeWorkDir();
  try {
    const prepared = prepareIsolation({ workDir: work, runId: 'run2', caseIndex: 1, seed: ['nope.txt'], maxBytes: 1024 });
    assert.equal(prepared.ok, false);
    assert.equal(prepared.error.code, 'SIDE_EFFECT_COPY_FAILED');
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});
