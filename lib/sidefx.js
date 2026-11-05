/**
 * 声明式文件副作用：路径校验、快照（hash / content / tree）、隔离目录与 seed 复制。
 *
 * 安全边界（规格 §4.3）：只允许相对 `sideEffects.paths`，禁止绝对路径与 `..`；
 * 解析后必须仍在运行目录内；快照总量受 maxSideEffectBytes 限制。
 */

import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

import { SIDE_EFFECT_MODES } from './config.js';
import { toPosix } from './exec.js';

function plainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

/** target 是否在 base 之内（含 base 自身）。 */
export function isInside(base, target) {
  const rel = relative(resolve(base), resolve(target));
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

function escapeReason(path) {
  if (isAbsolute(path)) return '是不允许的绝对路径';
  const segments = path.split(/[\\/]+/);
  if (segments.includes('..')) return '包含 .. 逃逸段';
  return null;
}

function fsKind(path) {
  try {
    const info = statSync(path);
    if (info.isDirectory()) return 'dir';
    if (info.isFile()) return 'file';
    return 'other';
  } catch {
    return 'missing';
  }
}

/**
 * 校验 compare.sideEffects（对象形式）。
 * @returns {{ok:true, options:{paths:string[], mode:string, isolate:boolean, seed:string[]}} | {ok:false, error:{code:string,message:string}, hint:string}}
 */
export function validateSideEffects(raw, baseDir) {
  const object = plainObject(raw);
  if (object === null) {
    return {
      ok: false,
      error: { code: 'INVALID_CASE', message: 'compare.sideEffects 必须是对象（{paths, mode, isolate, seed}）' },
      hint: '启用副作用比较时请给出 paths，例如 {"paths":["out/result.txt"],"mode":"hash"}；不想比较就保持 false。',
    };
  }
  const rawPaths = object.paths;
  if (!Array.isArray(rawPaths) || rawPaths.length === 0 || rawPaths.some((item) => typeof item !== 'string' || item === '')) {
    return {
      ok: false,
      error: { code: 'INVALID_CASE', message: 'compare.sideEffects.paths 必须是非空字符串数组' },
      hint: 'paths 写相对运行目录的文件或目录，例如 ["out/result.txt", "out/"]。',
    };
  }
  for (const path of rawPaths) {
    const reason = escapeReason(path);
    if (reason !== null) {
      return {
        ok: false,
        error: { code: 'SIDE_EFFECT_ESCAPE', message: `sideEffects.paths 里的 ${path} ${reason}` },
        hint: '副作用路径必须是相对运行目录的路径，不能是绝对路径，也不能用 .. 跳到目录外。',
      };
    }
    if (!isInside(baseDir, resolve(baseDir, path))) {
      return {
        ok: false,
        error: { code: 'SIDE_EFFECT_ESCAPE', message: `sideEffects.paths 里的 ${path} 解析后跑到了运行目录之外` },
        hint: '请改用运行目录内的相对路径。',
      };
    }
  }

  const modeRaw = object.mode;
  const mode = typeof modeRaw === 'string' && SIDE_EFFECT_MODES.includes(modeRaw) ? modeRaw : 'hash';
  const isolate = typeof object.isolate === 'boolean' ? object.isolate : true;
  const rawSeed = object.seed;
  const seed = [];
  if (rawSeed !== undefined && rawSeed !== null) {
    if (!Array.isArray(rawSeed) || rawSeed.some((item) => typeof item !== 'string' || item === '')) {
      return {
        ok: false,
        error: { code: 'INVALID_CASE', message: 'compare.sideEffects.seed 必须是字符串数组' },
        hint: 'seed 写要从 workDir 复制进隔离目录的输入文件，例如 ["input.txt"]。',
      };
    }
    for (const path of rawSeed) {
      const reason = escapeReason(path);
      if (reason !== null) {
        return {
          ok: false,
          error: { code: 'SIDE_EFFECT_ESCAPE', message: `sideEffects.seed 里的 ${path} ${reason}` },
          hint: 'seed 必须是相对 workDir 的路径。',
        };
      }
      if (!isInside(baseDir, resolve(baseDir, path))) {
        return {
          ok: false,
          error: { code: 'SIDE_EFFECT_ESCAPE', message: `sideEffects.seed 里的 ${path} 跑到了 workDir 之外` },
          hint: 'seed 只能用 workDir 内的相对路径。',
        };
      }
      seed.push(path);
    }
  }
  return { ok: true, options: { paths: [...rawPaths], mode, isolate, seed } };
}

function sha256File(path, limitBytes) {
  const buffer = readFileSync(path);
  if (buffer.length > limitBytes) return { tooLarge: true, bytes: buffer.length };
  return { tooLarge: false, bytes: buffer.length, sha256: createHash('sha256').update(buffer).digest('hex') };
}

function walkDir(current, entries, budget, prefix) {
  const items = readdirSync(current, { withFileTypes: true });
  items.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
  for (const item of items) {
    const absolute = join(current, item.name);
    // 路径始终以声明时的 sideEffects.paths 为前缀，保证 diff 里的 path 能直接对回声明。
    const relPath = `${prefix}/${item.name}`;
    if (item.isDirectory()) {
      entries.push({ path: relPath, kind: 'dir' });
      walkDir(absolute, entries, budget, relPath);
    } else if (item.isFile()) {
      const info = statSync(absolute);
      budget.bytes += info.size;
      if (budget.bytes > budget.maxBytes) return false;
      entries.push({
        path: relPath,
        kind: 'file',
        size: info.size,
        sha256: createHash('sha256').update(readFileSync(absolute)).digest('hex'),
      });
    } else {
      entries.push({ path: relPath, kind: 'other' });
    }
  }
  return true;
}

/**
 * 对一个运行目录做副作用快照。
 * @returns {{ok:true, entries:Array<object>, bytes:number} | {ok:false, error:{code:string,message:string}, hint:string}}
 */
export function takeSnapshot(runDir, paths, options) {
  const mode = options?.mode ?? 'hash';
  const maxBytes = Math.max(1, options?.maxBytes ?? 16_777_216);
  const entries = [];
  const budget = { bytes: 0, maxBytes };

  for (const relPath of paths) {
    const absolute = resolve(runDir, relPath);
    const kind = fsKind(absolute);
    if (kind === 'missing') {
      entries.push({ path: toPosix(relPath), kind: 'missing' });
      continue;
    }
    if (kind === 'file') {
      const info = statSync(absolute);
      budget.bytes += info.size;
      if (budget.bytes > maxBytes) {
        return {
          ok: false,
          error: {
            code: 'SIDE_EFFECT_TOO_LARGE',
            message: `副作用快照 ${relPath} 超过 maxSideEffectBytes=${maxBytes}`,
          },
          hint: '缩小 sideEffects.paths 的范围，或提高配置 maxSideEffectBytes。',
        };
      }
      const hashed = sha256File(absolute, maxBytes);
      if (hashed.tooLarge) {
        return {
          ok: false,
          error: {
            code: 'SIDE_EFFECT_TOO_LARGE',
            message: `副作用文件 ${relPath} 大小 ${hashed.bytes} 字节，超过 maxSideEffectBytes=${maxBytes}`,
          },
          hint: '缩小 sideEffects.paths 的范围，或提高配置 maxSideEffectBytes。',
        };
      }
      const entry = { path: toPosix(relPath), kind: 'file', size: hashed.bytes, sha256: hashed.sha256 };
      if (mode === 'content') {
        entry.text = readFileSync(absolute).toString('utf8');
      }
      entries.push(entry);
      continue;
    }
    if (kind === 'dir') {
      if (mode === 'hash' || mode === 'content') {
        // hash 模式下目录只建索引，不递归：目录内容由 paths 显式列出。
        entries.push({ path: toPosix(relPath), kind: 'dir' });
        continue;
      }
      const tree = [{ path: toPosix(relPath), kind: 'dir' }];
      const ok = walkDir(absolute, tree, budget, toPosix(relPath));
      if (!ok) {
        return {
          ok: false,
          error: { code: 'SIDE_EFFECT_TOO_LARGE', message: `副作用目录 ${relPath} 超过 maxSideEffectBytes=${maxBytes}` },
          hint: '缩小 sideEffects.paths 的范围，或提高配置 maxSideEffectBytes。',
        };
      }
      entries.push(...tree);
      continue;
    }
    entries.push({ path: toPosix(relPath), kind: 'other' });
  }
  return { ok: true, entries, bytes: budget.bytes };
}

function firstContentDifference(aotText, jitText) {
  const expected = typeof aotText === 'string' ? aotText : '';
  const actual = typeof jitText === 'string' ? jitText : '';
  if (expected === actual) return null;
  const expectedLines = expected.split('\n');
  const actualLines = actual.split('\n');
  const limit = Math.max(expectedLines.length, actualLines.length);
  for (let index = 0; index < limit; index += 1) {
    if (expectedLines[index] !== actualLines[index]) {
      return { aotLine: index + 1, jitLine: index + 1, expected: expectedLines[index] ?? '', actual: actualLines[index] ?? '' };
    }
  }
  return { aotLine: 1, jitLine: 1, expected, actual };
}

/**
 * 比较两侧副作用快照。expected 是 AOT 侧，actual 是 JIT 侧（规格 §3.6）。
 * @returns {Array<object>} diffs，空数组表示一致
 */
export function compareSideEffects(aotSnapshot, jitSnapshot, mode = 'hash') {
  const diffs = [];
  const mapOf = (snapshot) => {
    const map = new Map();
    for (const entry of snapshot?.entries ?? []) map.set(entry.path, entry);
    return map;
  };
  const aotMap = mapOf(aotSnapshot);
  const jitMap = mapOf(jitSnapshot);
  const allPaths = [...new Set([...aotMap.keys(), ...jitMap.keys()])];

  for (const path of allPaths) {
    const expected = aotMap.get(path) ?? { path, kind: 'missing' };
    const actual = jitMap.get(path) ?? { path, kind: 'missing' };
    if (expected.kind === 'missing' && actual.kind === 'missing') continue;
    if (expected.kind !== actual.kind) {
      diffs.push({
        field: 'sideEffects',
        kind: 'missing',
        path,
        expected: expected.kind,
        actual: actual.kind,
      });
      continue;
    }
    if (expected.kind !== 'file') continue;
    if (expected.sha256 === actual.sha256) continue;
    const diff = {
      field: 'sideEffects',
      kind: mode === 'content' ? 'content' : 'hash',
      path,
      expected: mode === 'content' ? expected.text : expected.sha256,
      actual: mode === 'content' ? actual.text : actual.sha256,
      expectedSize: expected.size,
      actualSize: actual.size,
    };
    if (mode === 'content') {
      const lineDiff = firstContentDifference(expected.text, actual.text);
      if (lineDiff !== null) Object.assign(diff, lineDiff);
    }
    diffs.push(diff);
  }
  return diffs;
}

function copySeed(workDir, targetDir, seed) {
  let bytes = 0;
  for (const relPath of seed) {
    const source = resolve(workDir, relPath);
    const kind = fsKind(source);
    if (kind === 'missing') throw new Error(`seed 里的 ${relPath} 在 workDir 中不存在`);
    const destination = join(targetDir, relPath);
    mkdirSync(dirname(destination), { recursive: true });
    cpSync(source, destination, { recursive: true });
    if (kind === 'file') bytes += statSync(source).size;
  }
  return bytes;
}

/**
 * 为同一个 case 的 AOT / JIT 建两个隔离目录，并从 workDir 复制 seed。
 * 目录形状：<workDir>/.aotjit/<runId>/<caseIndex>-aot|jit（规格 §3.2 sideEffects）。
 */
export function prepareIsolation(options) {
  const { workDir, runId, caseIndex, seed, maxBytes } = options;
  const root = join(workDir, '.aotjit', runId);
  const aotDir = join(root, `${caseIndex}-aot`);
  const jitDir = join(root, `${caseIndex}-jit`);
  try {
    mkdirSync(aotDir, { recursive: true });
    mkdirSync(jitDir, { recursive: true });
    const copied = copySeed(workDir, aotDir, seed) + copySeed(workDir, jitDir, seed);
    if (copied > maxBytes) {
      rmSync(aotDir, { recursive: true, force: true });
      rmSync(jitDir, { recursive: true, force: true });
      return {
        ok: false,
        error: {
          code: 'SIDE_EFFECT_TOO_LARGE',
          message: `seed 复制 ${copied} 字节，超过 maxSideEffectBytes=${maxBytes}`,
        },
        hint: '减少 sideEffects.seed 的数量/体积，或提高配置 maxSideEffectBytes。',
      };
    }
  } catch (error) {
    return {
      ok: false,
      error: {
        code: 'SIDE_EFFECT_COPY_FAILED',
        message: `隔离目录/seed 复制失败：${error instanceof Error ? error.message : String(error)}`,
      },
      hint: '检查 sideEffects.seed 里的路径是否存在于 workDir，以及 .aotjit 目录是否可写。',
    };
  }
  return {
    ok: true,
    root: toPosix(root),
    aotDir,
    jitDir,
    relative: {
      aot: toPosix(relative(workDir, aotDir)),
      jit: toPosix(relative(workDir, jitDir)),
    },
  };
}

/** 日志里展示隔离目录相对 workDir 的位置，避免把用户目录明文铺满。 */
export function isolationLabel(result) {
  if (result?.ok !== true) return null;
  return { aot: result.relative.aot, jit: result.relative.jit };
}

/** 清理一次运行的隔离根目录（成功/失败都可用；失败只记 warning）。 */
export function cleanupIsolation(workDir, runId) {
  try {
    rmSync(join(workDir, '.aotjit', runId), { recursive: true, force: true });
    return null;
  } catch (error) {
    return `隔离目录清理失败（${join('.aotjit', runId)}）：${error instanceof Error ? error.message : String(error)}`;
  }
}

/** 隔离目录存在性（测试用；也便于排查残留）。 */
export function isolationExists(dir) {
  return existsSync(dir) && statSync(dir).isDirectory();
}

/** 路径分隔符常量导出，供测试断言跨平台。 */
export const SEP = sep;
