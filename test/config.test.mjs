import test from 'node:test';
import assert from 'node:assert/strict';

import {
  COMPARE_DEFAULTS,
  GRACE_MS,
  LIMITS,
  NORMALIZE_DEFAULTS,
  resolveCallOptions,
  resolveCompare,
  resolveConfig,
  resolveNormalize,
} from '../lib/config.js';

test('resolveConfig：无参时给出规格默认值', () => {
  const cfg = resolveConfig(undefined);
  assert.equal(cfg.timeoutMs, 120000);
  assert.equal(cfg.maxOutputBytes, 1048576);
  assert.equal(cfg.maxCases, 100);
  assert.equal(cfg.maxSideEffectBytes, 16777216);
  assert.equal(cfg.logDir, '.aotjit-logs');
  assert.equal(cfg.graceMs, 2000);
  assert.deepEqual(cfg.compare, { stdout: true, exit: true, stderr: 'off', sideEffects: false });
  assert.deepEqual(cfg.normalize, { crlf: true, ansi: false, trailingNewline: 'exact', replacePaths: [] });
  assert.deepEqual(cfg.warnings, []);
});

test('resolveConfig：非法数值退回默认并给中文 warning，不抛', () => {
  const cfg = resolveConfig({ timeoutMs: 'abc', maxCases: 0, maxOutputBytes: 1e12, logDir: '' });
  assert.equal(cfg.timeoutMs, 120000);
  assert.equal(cfg.maxCases, 100);
  assert.equal(cfg.maxOutputBytes, 1048576);
  assert.equal(cfg.logDir, '.aotjit-logs');
  assert.equal(cfg.warnings.length >= 3, true);
  assert.equal(cfg.warnings.every((item) => typeof item === 'string' && item.length > 0), true);
});

test('resolveConfig：边界值本身合法', () => {
  const cfg = resolveConfig({ timeoutMs: LIMITS.timeoutMs.min, maxCases: LIMITS.maxCases.max });
  assert.equal(cfg.timeoutMs, 1);
  assert.equal(cfg.maxCases, 1000);
  assert.deepEqual(cfg.warnings, []);
});

test('resolveConfig：compare:false 一次关掉全部比较', () => {
  const cfg = resolveConfig({ compare: false });
  assert.equal(cfg.compare.stdout, false);
  assert.equal(cfg.compare.exit, false);
  assert.equal(cfg.compare.stderr, 'off');
  assert.equal(cfg.compare.sideEffects, false);
});

test('resolveCompare：对象只覆盖给出的字段，stderr 非法退回 base', () => {
  const warnings = [];
  const merged = resolveCompare({ stderr: 'normalized', exit: false }, COMPARE_DEFAULTS, warnings);
  assert.equal(merged.stderr, 'normalized');
  assert.equal(merged.exit, false);
  assert.equal(merged.stdout, true);
  assert.deepEqual(warnings, []);

  const bad = resolveCompare({ stderr: 'verbose' }, COMPARE_DEFAULTS, []);
  assert.equal(bad.stderr, 'off');
});

test('resolveCompare：sideEffects 支持 false / true / 对象', () => {
  const on = resolveCompare({ sideEffects: { paths: ['out/x'] } }, COMPARE_DEFAULTS, []);
  assert.deepEqual(on.sideEffects, { paths: ['out/x'] });
  const legacy = resolveCompare({ sideEffects: true }, COMPARE_DEFAULTS, []);
  assert.equal(legacy.sideEffects, true);
  const off = resolveCompare({ sideEffects: false }, COMPARE_DEFAULTS, []);
  assert.equal(off.sideEffects, false);
});

test('resolveNormalize：默认值 + 覆盖 + 非法枚举退回', () => {
  assert.deepEqual(resolveNormalize(undefined, NORMALIZE_DEFAULTS, []), { ...NORMALIZE_DEFAULTS });
  const merged = resolveNormalize(
    { crlf: false, ansi: true, trailingNewline: 'ignore', replacePaths: ['C:/w', ''] },
    NORMALIZE_DEFAULTS,
    [],
  );
  assert.equal(merged.crlf, false);
  assert.equal(merged.ansi, true);
  assert.equal(merged.trailingNewline, 'ignore');
  assert.deepEqual(merged.replacePaths, ['C:/w']);

  const warnings = [];
  const bad = resolveNormalize({ trailingNewline: 'loose', replacePaths: 'oops' }, NORMALIZE_DEFAULTS, warnings);
  assert.equal(bad.trailingNewline, 'exact');
  assert.deepEqual(bad.replacePaths, []);
  assert.equal(warnings.length, 2);
});

test('resolveCallOptions：逐次覆盖配置，非法值退回配置值', () => {
  const cfg = resolveConfig({ timeoutMs: 5000 });
  const options = resolveCallOptions({ timeoutMs: 1000, compare: { stdout: false } }, cfg);
  assert.equal(options.timeoutMs, 1000);
  assert.equal(options.compare.stdout, false);
  assert.equal(options.compare.exit, true);
  assert.equal(options.maxOutputBytes, cfg.maxOutputBytes);

  const fallback = resolveCallOptions({ timeoutMs: -5 }, cfg);
  assert.equal(fallback.timeoutMs, 5000);
  assert.equal(fallback.warnings.length, 1);
});

test('GRACE_MS 是正有限数（subprocess 的硬要求）', () => {
  assert.equal(Number.isFinite(GRACE_MS), true);
  assert.equal(GRACE_MS > 0, true);
});
