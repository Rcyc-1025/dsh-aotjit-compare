/**
 * 日志与产物落盘（规格 §3.7）。
 *
 * 日志只写「命令 + 结果 + 差异摘要」：不写 stdin 原文、不写完整环境变量。
 * 任何写盘失败都只返回 warning，不影响对拍结果。
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { toPosix } from './exec.js';

function two(value) {
  return String(value).padStart(2, '0');
}

/** 本地时间的 yyyyMMdd-HHmmss。 */
export function stampForFile(date) {
  const value = date instanceof Date && Number.isFinite(date.getTime()) ? date : new Date();
  return (
    String(value.getFullYear()) +
    two(value.getMonth() + 1) +
    two(value.getDate()) +
    '-' +
    two(value.getHours()) +
    two(value.getMinutes()) +
    two(value.getSeconds())
  );
}

function short(seed) {
  return String(seed).replace(/[^A-Za-z0-9_-]/g, '').slice(0, 24);
}

/** 一次运行的 runId：时间戳 + 随机后缀 + 可选 tag，日志与隔离目录共用。 */
export function createRunId(tag) {
  const random = Math.random().toString(16).slice(2, 6).padEnd(4, '0');
  const stamp = stampForFile(new Date()).replace(/-/g, '');
  const label = typeof tag === 'string' && tag.trim() !== '' ? `-${short(tag.trim())}` : '';
  return `${stamp}-${random}${label}`;
}

function sideLines(label, side) {
  const lines = [];
  lines.push(`  ${label}.argv: ${JSON.stringify(side.argv)}`);
  lines.push(`  ${label}.cwd: ${side.cwd}`);
  lines.push(`  ${label}.exit: ${side.exitCode === null ? 'null' : side.exitCode}${side.exitCodeHex !== null ? ` (${side.exitCodeHex})` : ''}`);
  lines.push(`  ${label}.signal: ${side.signal === null ? 'null' : side.signal}`);
  lines.push(`  ${label}.timedOut: ${side.timedOut === true}`);
  lines.push(`  ${label}.durationMs: ${side.durationMs}`);
  lines.push(
    `  ${label}.stdout: bytes=${side.stdoutBytes} truncated=${side.stdoutTruncated === true} encoding=${side.stdoutEncoding}`,
  );
  lines.push(
    `  ${label}.stderr: bytes=${side.stderrBytes} truncated=${side.stderrTruncated === true} encoding=${side.stderrEncoding}`,
  );
  if (side.spawnError !== null) lines.push(`  ${label}.spawnError: ${side.spawnError}`);
  return lines;
}

function diffLines(diffs) {
  const lines = [];
  for (const diff of diffs) {
    const parts = [`kind=${diff.kind}`];
    if (diff.path !== undefined) parts.push(`path=${diff.path}`);
    if (diff.aotLine !== undefined) parts.push(`aotLine=${diff.aotLine}`);
    if (diff.jitLine !== undefined) parts.push(`jitLine=${diff.jitLine}`);
    const expected = typeof diff.expected === 'string' && diff.expected.length > 200 ? `${diff.expected.slice(0, 200)}…` : diff.expected;
    const actual = typeof diff.actual === 'string' && diff.actual.length > 200 ? `${diff.actual.slice(0, 200)}…` : diff.actual;
    lines.push(`    - field=${diff.field} ${parts.join(' ')}`);
    if (expected !== undefined) lines.push(`      expected=${JSON.stringify(expected)}`);
    if (actual !== undefined) lines.push(`      actual=${JSON.stringify(actual)}`);
  }
  return lines;
}

/**
 * 日志正文：每行是否 match、两侧命令与结果、差异摘要。
 * @param {object} entry 一次运行的结构化结果（不含 stdin 原文）
 */
export function formatRunLog(entry) {
  const sections = [];
  sections.push('# aotjit-compare 运行日志');
  sections.push('');
  sections.push(`runId: ${entry.runId}`);
  sections.push(`startedAt: ${entry.startedAt}`);
  sections.push(`finishedAt: ${entry.finishedAt}`);
  sections.push(`durationMs: ${entry.durationMs}`);
  sections.push(`workDir: ${toPosix(entry.workDir)}`);
  sections.push(`aotExe: ${entry.aotExe === null ? '(per-case)' : toPosix(entry.aotExe)}`);
  sections.push(`jitCmd: ${toPosix(entry.jitCmd)}`);
  sections.push(`timeoutMs: ${entry.timeoutMs}`);
  sections.push(`maxOutputBytes: ${entry.maxOutputBytes}`);
  sections.push(`compare: ${JSON.stringify(entry.compare)}`);
  sections.push(`normalize: ${JSON.stringify(entry.normalize)}`);
  sections.push(`counts: total=${entry.total} matched=${entry.matched} mismatched=${entry.mismatched}`);
  if (entry.firstMismatchCase !== null) sections.push(`firstMismatch: ${entry.firstMismatchCase} / ${entry.firstMismatchField}`);
  if (Array.isArray(entry.warnings) && entry.warnings.length > 0) {
    sections.push('');
    sections.push('## warnings');
    for (const warning of entry.warnings) sections.push(`- ${warning}`);
  }
  if (Array.isArray(entry.rows) && entry.rows.length > 0) {
    sections.push('');
    sections.push('## cases');
    for (const row of entry.rows) {
      sections.push('');
      sections.push(
        `### [${row.index}] ${row.case} match=${row.match === true} firstMismatch=${row.firstMismatch === null ? 'null' : row.firstMismatch}`,
      );
      sections.push(...sideLines('aot', row.aot));
      sections.push(...sideLines('jit', row.jit));
      if (row.isolation !== undefined && row.isolation !== null) {
        sections.push(`  isolation: aot=${row.isolation.aot} jit=${row.isolation.jit}`);
      }
      if (row.error !== undefined && row.error !== null) {
        sections.push(`  error: ${row.error.code} ${row.error.message}`);
      }
      if (Array.isArray(row.diffs) && row.diffs.length > 0) {
        sections.push('  diffs:');
        sections.push(...diffLines(row.diffs));
      }
    }
  }
  sections.push('');
  return sections.join('\n');
}

/** 写日志：失败只返回 warning（规格 §3.7）。 */
export function writeRunLog({ cwd, logDir, runId, content }) {
  const dir = resolve(cwd, typeof logDir === 'string' && logDir !== '' ? logDir : '.aotjit-logs');
  const target = join(dir, `aotjit-${runId}.log`);
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(target, content, 'utf8');
    return { path: toPosix(target), warning: null };
  } catch (error) {
    return {
      path: null,
      warning: `日志写入失败（${toPosix(target)}）：${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/**
 * saveArtifacts:true 时把每侧完整 stdout/stderr 写到 artifacts/<runId>/<idx>-<case>/。
 * 默认不写；失败只进 warnings。
 */
export function writeArtifacts({ cwd, logDir, runId, rows }) {
  const base = resolve(cwd, typeof logDir === 'string' && logDir !== '' ? logDir : '.aotjit-logs');
  const root = join(base, 'artifacts', runId);
  const warnings = [];
  for (const row of rows) {
    const caseDir = join(root, `${String(row.index).padStart(3, '0')}-${short(row.case)}`);
    try {
      mkdirSync(caseDir, { recursive: true });
      for (const side of ['aot', 'jit']) {
        const run = row[side];
        writeFileSync(join(caseDir, `${side}.stdout.txt`), run.stdout ?? '', 'utf8');
        writeFileSync(join(caseDir, `${side}.stderr.txt`), run.stderr ?? '', 'utf8');
      }
    } catch (error) {
      warnings.push(`artifacts 写入失败（${toPosix(caseDir)}）：${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return { dir: toPosix(root), warnings };
}
