/**
 * aotjit_compare 工具面：参数校验、逐用例执行、比较、日志。
 *
 * 约定：
 * - 永远不抛异常：输入/路径/启动层失败 → {ok:false, error:{code,message,hint}, hint}；
 * - 对拍发现差异 → {ok:true, allMatch:false, rows[].diffs}，这是正常返回；
 * - 每个进程独立超时；超时/截断不中断后续用例；
 * - 每个 case 先 AOT 后 JIT，严格串行（规格 §3.3）。
 */

import { statSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';

import { LIMITS, resolveCallOptions } from './config.js';
import { compareCase } from './compare.js';
import { toPosix } from './exec.js';
import { createRunId, formatRunLog, writeArtifacts, writeRunLog } from './log.js';
import {
  cleanupIsolation,
  compareSideEffects,
  isolationLabel,
  prepareIsolation,
  takeSnapshot,
  validateSideEffects,
} from './sidefx.js';

const SHELL_WRAPPER = /\.(cmd|bat)$/i;

function plainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

/** 会话 cwd 优先；测试/宿主调用没有 session 时回退进程 cwd。 */
export function sessionCwd(exec) {
  const header =
    exec !== null && typeof exec === 'object' && exec.agent !== undefined ? exec.agent?.session?.header : undefined;
  const cwd = header !== null && typeof header === 'object' ? header.cwd : undefined;
  return typeof cwd === 'string' && cwd !== '' ? cwd : process.cwd();
}

function isStringArray(value) {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function isStringMap(value) {
  const object = plainObject(value);
  return object !== null && Object.values(object).every((item) => typeof item === 'string');
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

function setupFailure(code, message, hint, extra = {}) {
  return {
    ok: false,
    error: { code, message, hint },
    hint,
    allMatch: false,
    firstMismatchCase: null,
    firstMismatchField: null,
    total: 0,
    matched: 0,
    mismatched: 0,
    rows: [],
    logPath: null,
    durationMs: 0,
    warnings: [],
    ...extra,
  };
}

function invalidCase(index, name, message) {
  const label = typeof name === 'string' && name !== '' ? name : `#${index + 1}`;
  return {
    ok: false,
    error: { code: 'INVALID_CASE', message: `用例 ${label} 的 ${message}` },
    hint: '检查 cases[] 里每个元素的 name/args/stdin/aotExe/jitArgs/env/cwd 字段类型。',
  };
}

function resolveOnPath(resolveExecutable, command) {
  if (typeof resolveExecutable !== 'function') return null;
  try {
    const found = resolveExecutable(command);
    return typeof found === 'string' && found !== '' ? found : null;
  } catch {
    return null;
  }
}

/**
 * 解析 JIT 入口：绝对路径 / 相对 workDir 的路径 / PATH 中的命令名。
 */
function resolveJitCommand(cmd, workDir, resolveExecutable) {
  if (SHELL_WRAPPER.test(cmd)) {
    return {
      ok: false,
      code: 'JIT_CMD_SHELL_WRAPPER',
      message: `jitSpec.cmd=${cmd} 是 .cmd/.bat 包装器，插件不走 shell`,
      hint: '把 JIT 换成可直接 spawn 的 exe，或显式用 cmd.exe 作为 cmd 并把 /c 和原命令放进 jitSpec.args。',
    };
  }
  const pathLike = isAbsolute(cmd) || cmd.includes('/') || cmd.includes('\\');
  if (pathLike) {
    const absolute = isAbsolute(cmd) ? resolve(cmd) : resolve(workDir, cmd);
    if (fsKind(absolute) === 'file') return { ok: true, path: absolute, argv0: absolute };
    return {
      ok: false,
      code: 'JIT_CMD_NOT_FOUND',
      message: `jitSpec.cmd 指向的 ${cmd} 不存在：${toPosix(absolute)}`,
      hint: '确认 JIT 入口路径（相对路径按 workDir 解析），或改用 PATH 里的命令名。',
    };
  }
  const found = resolveOnPath(resolveExecutable, cmd);
  if (found === null) {
    return {
      ok: false,
      code: 'JIT_CMD_NOT_FOUND',
      message: `jitSpec.cmd=${cmd} 不在宿主 PATH 中`,
      hint: '改用绝对路径，或把 JIT 入口所在目录加入宿主 PATH 后重试。',
    };
  }
  return { ok: true, path: found, argv0: found };
}

function resolveAotExe(raw, workDir) {
  const absolute = isAbsolute(raw) ? resolve(raw) : resolve(workDir, raw);
  if (fsKind(absolute) === 'file') return { ok: true, path: absolute };
  return {
    ok: false,
    message: `AOT 可执行文件不存在：${toPosix(absolute)}`,
    hint: 'aotExe 的相对路径按 workDir 解析；先用 P-02 构建或 toyc --emit=exe 产出 exe。',
  };
}

/**
 * 校验并展开成可执行的计划；任何输入错误都在这里返回 ok:false。
 * @param {object} args 工具入参
 * @param {string} cwd 会话 cwd
 * @param {object} config 归一化后的插件配置
 * @param {{resolveExecutable?: Function}} deps 宿主能力
 */
export function preparePlan(args, cwd, config, deps = {}) {
  const object = plainObject(args);
  if (object === null) {
    return {
      ok: false,
      error: { code: 'INVALID_CASE', message: '入参必须是对象' },
      hint: '按 aotjit_compare 的 parameters 传 {jitSpec, cases, ...}。',
    };
  }

  // workDir：显式给出时必须是存在的目录；否则用会话 cwd。
  let workDir = cwd;
  if (object.workDir !== undefined && object.workDir !== null) {
    if (typeof object.workDir !== 'string' || object.workDir === '') {
      return {
        ok: false,
        error: { code: 'WORKDIR_NOT_FOUND', message: 'workDir 必须是非空字符串' },
        hint: '省略 workDir 表示使用会话 cwd；显式给出时要写存在的目录。',
      };
    }
    workDir = isAbsolute(object.workDir) ? resolve(object.workDir) : resolve(cwd, object.workDir);
  }
  if (fsKind(workDir) !== 'dir') {
    return {
      ok: false,
      error: { code: 'WORKDIR_NOT_FOUND', message: `workDir 不存在或不是目录：${toPosix(workDir)}` },
      hint: '检查 workDir；Windows 路径里的反斜杠在 JSON 中要转义。',
    };
  }

  const callOptions = resolveCallOptions(object, config);
  const warnings = [...(config.warnings ?? []), ...callOptions.warnings];

  // cases 基本形状
  if (!Array.isArray(object.cases) || object.cases.length === 0) {
    return {
      ok: false,
      error: { code: 'NO_CASES', message: 'cases 必须是非空数组' },
      hint: '至少给一个用例，例如 cases:[{name:"add.mul"}]。',
    };
  }
  if (object.cases.length > config.maxCases) {
    return {
      ok: false,
      error: {
        code: 'TOO_MANY_CASES',
        message: `cases 有 ${object.cases.length} 个，超过 maxCases=${config.maxCases}`,
      },
      hint: `拆成多次调用（每次 <= ${config.maxCases} 个），或提高配置 maxCases。`,
    };
  }

  // jitSpec
  const jitSpec = plainObject(object.jitSpec);
  if (jitSpec === null) {
    return {
      ok: false,
      error: { code: 'INVALID_CASE', message: 'jitSpec 必须是对象且包含 cmd' },
      hint: '例如 jitSpec:{cmd:"build/toyc.exe",args:["examples/add.mul.mlir","--emit=run"]}。',
    };
  }
  if (typeof jitSpec.cmd !== 'string' || jitSpec.cmd.trim() === '') {
    return {
      ok: false,
      error: { code: 'INVALID_CASE', message: 'jitSpec.cmd 必须是非空字符串' },
      hint: 'jitSpec.cmd 写可直接 spawn 的 exe 路径或命令名，不要写 shell 片段。',
    };
  }
  if (jitSpec.args !== undefined && jitSpec.args !== null && !isStringArray(jitSpec.args)) {
    return {
      ok: false,
      error: { code: 'INVALID_CASE', message: 'jitSpec.args 必须是字符串数组' },
      hint: 'args 是 argv 数组，不要拼成一个字符串。',
    };
  }
  if (jitSpec.cwd !== undefined && jitSpec.cwd !== null && typeof jitSpec.cwd !== 'string') {
    return {
      ok: false,
      error: { code: 'INVALID_CASE', message: 'jitSpec.cwd 必须是字符串' },
      hint: 'jitSpec.cwd 是 JIT 侧工作目录，相对 workDir 解析。',
    };
  }
  if (jitSpec.env !== undefined && jitSpec.env !== null && !isStringMap(jitSpec.env)) {
    return {
      ok: false,
      error: { code: 'INVALID_CASE', message: 'jitSpec.env 必须是字符串到字符串的对象' },
      hint: 'env 只写需要追加的键值，值必须是字符串。',
    };
  }

  const jit = resolveJitCommand(jitSpec.cmd, workDir, deps.resolveExecutable);
  if (!jit.ok) return { ok: false, error: { code: jit.code, message: jit.message }, hint: jit.hint };

  const jitSpecArgs = isStringArray(jitSpec.args) ? jitSpec.args : [];
  const jitSpecEnv = isStringMap(jitSpec.env) ? jitSpec.env : {};
  const jitSpecCwd =
    typeof jitSpec.cwd === 'string' && jitSpec.cwd !== '' ? resolve(workDir, jitSpec.cwd) : null;
  if (jitSpecCwd !== null && fsKind(jitSpecCwd) !== 'dir') {
    return {
      ok: false,
      error: { code: 'WORKDIR_NOT_FOUND', message: `jitSpec.cwd 不存在或不是目录：${toPosix(jitSpecCwd)}` },
      hint: 'jitSpec.cwd 相对 workDir 解析；确认目录存在。',
    };
  }

  // 顶层 aotExe
  let topAotExe = null;
  if (object.aotExe !== undefined && object.aotExe !== null && object.aotExe !== '') {
    if (typeof object.aotExe !== 'string') {
      return {
        ok: false,
        error: { code: 'INVALID_CASE', message: 'aotExe 必须是字符串' },
        hint: 'aotExe 写 AOT 可执行文件路径，或用 cases[].aotExe 逐个覆盖。',
      };
    }
    const resolved = resolveAotExe(object.aotExe, workDir);
    if (!resolved.ok) {
      return { ok: false, error: { code: 'AOT_EXE_NOT_FOUND', message: resolved.message }, hint: resolved.hint };
    }
    topAotExe = resolved.path;
  }
  if (object.aotArgs !== undefined && object.aotArgs !== null && !isStringArray(object.aotArgs)) {
    return {
      ok: false,
      error: { code: 'INVALID_CASE', message: 'aotArgs 必须是字符串数组' },
      hint: 'aotArgs 是追加到 AOT 命令的 argv 数组。',
    };
  }
  const aotArgs = isStringArray(object.aotArgs) ? object.aotArgs : [];

  // 逐个 case 展开
  const plan = [];
  for (let index = 0; index < object.cases.length; index += 1) {
    const raw = object.cases[index];
    const item = plainObject(raw);
    if (item === null) return invalidCase(index, null, '元素必须是对象');
    const name = item.name;
    if (typeof name !== 'string' || name.trim() === '') return invalidCase(index, null, 'name 不能为空');
    if (item.args !== undefined && item.args !== null && !isStringArray(item.args)) {
      return invalidCase(index, name, 'args 必须是字符串数组');
    }
    if (item.stdin !== undefined && item.stdin !== null && typeof item.stdin !== 'string') {
      return invalidCase(index, name, 'stdin 必须是字符串');
    }
    if (item.jitArgs !== undefined && item.jitArgs !== null && !isStringArray(item.jitArgs)) {
      return invalidCase(index, name, 'jitArgs 必须是字符串数组');
    }
    if (item.aotExe !== undefined && item.aotExe !== null && typeof item.aotExe !== 'string') {
      return invalidCase(index, name, 'aotExe 必须是字符串');
    }
    if (item.cwd !== undefined && item.cwd !== null && typeof item.cwd !== 'string') {
      return invalidCase(index, name, 'cwd 必须是字符串');
    }
    if (item.env !== undefined && item.env !== null && !isStringMap(item.env)) {
      return invalidCase(index, name, 'env 必须是字符串到字符串的对象');
    }

    let aotExe = topAotExe;
    if (typeof item.aotExe === 'string' && item.aotExe !== '') {
      const resolved = resolveAotExe(item.aotExe, workDir);
      if (!resolved.ok) {
        return {
          ok: false,
          error: { code: 'AOT_EXE_NOT_FOUND', message: `用例 ${name} 的 ${resolved.message}` },
          hint: resolved.hint,
        };
      }
      aotExe = resolved.path;
    }
    if (aotExe === null) {
      return {
        ok: false,
        error: { code: 'AOT_EXE_NOT_FOUND', message: `用例 ${name} 没有 aotExe（顶层与 cases[] 都没有）` },
        hint: '在顶层给 aotExe，或在每个 case 里用 cases[].aotExe 指定；AOT 产物要先构建好。',
      };
    }

    const caseCwd = typeof item.cwd === 'string' && item.cwd !== '' ? resolve(workDir, item.cwd) : null;
    if (caseCwd !== null && fsKind(caseCwd) !== 'dir') {
      return {
        ok: false,
        error: { code: 'WORKDIR_NOT_FOUND', message: `用例 ${name} 的 cwd 不存在或不是目录：${toPosix(caseCwd)}` },
        hint: 'cases[].cwd 相对 workDir 解析；确认目录存在。',
      };
    }

    plan.push({
      index: index + 1,
      name,
      aotExe,
      aotArgvExtra: aotArgs,
      jitArgv0: jit.argv0,
      jitArgs: isStringArray(item.jitArgs) ? item.jitArgs : jitSpecArgs,
      args: isStringArray(item.args) ? item.args : [],
      stdin: typeof item.stdin === 'string' ? item.stdin : '',
      aotEnv: { ...(isStringMap(item.env) ? item.env : {}) },
      jitEnv: { ...jitSpecEnv, ...(isStringMap(item.env) ? item.env : {}) },
      caseCwd,
      jitSpecCwd,
    });
  }

  // 副作用配置
  let sideEffects = null;
  if (callOptions.compare.sideEffects !== false && callOptions.compare.sideEffects !== undefined) {
    if (callOptions.compare.sideEffects === true) {
      return {
        ok: false,
        error: { code: 'INVALID_CASE', message: 'compare.sideEffects:true 缺少 paths' },
        hint: '写成 {paths:["out/result.txt"],mode:"hash"}，或保持 false 关闭副作用比较。',
      };
    }
    const validated = validateSideEffects(callOptions.compare.sideEffects, workDir);
    if (!validated.ok) return validated;
    sideEffects = validated.options;
    if (sideEffects.isolate === false) {
      warnings.push(
        'sideEffects.isolate:false：AOT 与 JIT 共用同一个运行目录，可能互相污染；仅在确认程序只读时使用。',
      );
    }
  }

  return {
    ok: true,
    plan: {
      workDir,
      runId: createRunId(object.tag),
      cases: plan,
      jitCmd: jit.path,
      topAotExe,
      timeoutMs: callOptions.timeoutMs,
      maxOutputBytes: callOptions.maxOutputBytes,
      compare: callOptions.compare,
      normalize: callOptions.normalize,
      sideEffects,
      saveArtifacts:
        object.saveArtifacts === true || (object.saveArtifacts === undefined && config.saveArtifacts === true),
      warnings,
    },
  };
}

function sideSummary(run, timeoutMs) {
  return {
    cmd: run.argv.map((part) => toPosix(part)),
    cwd: run.cwd,
    exitCode: run.exitCode,
    exitCodeHex: run.exitCodeHex,
    signal: run.signal,
    timedOut: run.timedOut === true,
    timeoutMs,
    durationMs: run.durationMs,
    stdout: run.stdout,
    stderr: run.stderr,
    stdoutBytes: run.stdoutBytes,
    stderrBytes: run.stderrBytes,
    stdoutSha256: run.stdoutSha256,
    stderrSha256: run.stderrSha256,
    stdoutEncoding: run.stdoutEncoding,
    stderrEncoding: run.stderrEncoding,
    stdoutTruncated: run.stdoutTruncated === true,
    stderrTruncated: run.stderrTruncated === true,
    spawnError: run.spawnError,
  };
}

/**
 * 跑完整个计划。runner 由 index.js 注入，便于无进程单测。
 * @param {object} plan preparePlan 的 plan
 * @param {Function} runner exec.js 的 run()
 * @param {{maxSideEffectBytes?: number}} context 配置里的上限
 */
export async function executePlan(plan, runner, context = {}) {
  const maxSideEffectBytes = context.maxSideEffectBytes ?? 16_777_216;
  const startedAt = new Date();
  const rows = [];
  const warnings = [...plan.warnings];
  let fatal = null;

  try {
    for (const item of plan.cases) {
      let aotCwd = item.caseCwd ?? plan.workDir;
      let jitCwd = item.caseCwd ?? item.jitSpecCwd ?? plan.workDir;
      let isolation = null;

      if (plan.sideEffects !== null && plan.sideEffects.isolate !== false) {
        const prepared = prepareIsolation({
          workDir: plan.workDir,
          runId: plan.runId,
          caseIndex: item.index,
          seed: plan.sideEffects.seed,
          maxBytes: maxSideEffectBytes,
        });
        if (!prepared.ok) {
          fatal = prepared;
          break;
        }
        isolation = isolationLabel(prepared);
        aotCwd = prepared.aotDir;
        jitCwd = prepared.jitDir;
      }

      const aotRun = await runner({
        argv: [item.aotExe, ...item.aotArgvExtra, ...item.args],
        cwd: aotCwd,
        env: item.aotEnv,
        stdin: item.stdin,
        timeoutMs: plan.timeoutMs,
        maxBytes: plan.maxOutputBytes,
      });
      const jitRun = await runner({
        argv: [item.jitArgv0, ...item.jitArgs, ...item.args],
        cwd: jitCwd,
        env: item.jitEnv,
        stdin: item.stdin,
        timeoutMs: plan.timeoutMs,
        maxBytes: plan.maxOutputBytes,
      });

      let sideEffectDiffs = [];
      if (plan.sideEffects !== null) {
        const aotSnapshot = takeSnapshot(aotCwd, plan.sideEffects.paths, {
          mode: plan.sideEffects.mode,
          maxBytes: maxSideEffectBytes,
        });
        if (!aotSnapshot.ok) {
          fatal = aotSnapshot;
          break;
        }
        const jitSnapshot = takeSnapshot(jitCwd, plan.sideEffects.paths, {
          mode: plan.sideEffects.mode,
          maxBytes: maxSideEffectBytes,
        });
        if (!jitSnapshot.ok) {
          fatal = jitSnapshot;
          break;
        }
        sideEffectDiffs = compareSideEffects(aotSnapshot, jitSnapshot, plan.sideEffects.mode);
      }

      const compared = compareCase({
        aot: aotRun,
        jit: jitRun,
        compare: plan.compare,
        normalize: plan.normalize,
        sideEffectDiffs,
      });

      const spawnFailed = aotRun.spawnError !== null || jitRun.spawnError !== null;
      rows.push({
        index: item.index,
        case: item.name,
        match: compared.match,
        firstMismatch: compared.firstMismatch,
        diffs: compared.diffs,
        aot: sideSummary(aotRun, plan.timeoutMs),
        jit: sideSummary(jitRun, plan.timeoutMs),
        isolation,
        error: spawnFailed
          ? {
              code: 'SPAWN_FAILED',
              message: [aotRun.spawnError, jitRun.spawnError].filter((value) => value !== null).join(' / '),
            }
          : null,
      });
      if (aotRun.stdoutTruncated || jitRun.stdoutTruncated) {
        warnings.push(`用例 ${item.name} 的 stdout 被 maxOutputBytes=${plan.maxOutputBytes} 截断，不能证明一致。`);
      }
      if (aotRun.timedOut || jitRun.timedOut) {
        warnings.push(`用例 ${item.name} 有进程超时（timeoutMs=${plan.timeoutMs}）。`);
      }
    }

  } finally {
    if (plan.sideEffects !== null && plan.sideEffects.isolate !== false) {
      const cleanupWarning = cleanupIsolation(plan.workDir, plan.runId);
      if (cleanupWarning !== null) warnings.push(cleanupWarning);
    }
  }

  const finishedAt = new Date();
  const durationMs = finishedAt.getTime() - startedAt.getTime();
  const matched = rows.filter((row) => row.match === true).length;
  const firstMismatchRow = rows.find((row) => row.match !== true) ?? null;
  const executed = rows.filter((row) => row.error === null).length;

  const result = {
    ok: fatal === null && executed > 0,
    allMatch: fatal === null && executed > 0 && matched === rows.length && rows.length > 0,
    firstMismatchCase: firstMismatchRow === null ? null : firstMismatchRow.case,
    firstMismatchField: firstMismatchRow === null ? null : firstMismatchRow.firstMismatch,
    total: rows.length,
    matched,
    mismatched: rows.length - matched,
    rows,
    logPath: null,
    durationMs,
    warnings: [...new Set(warnings)],
    hint: null,
  };

  if (fatal !== null) {
    result.error = fatal.error;
    result.hint = fatal.hint;
    return { result, plan, startedAt, finishedAt };
  }
  if (executed === 0) {
    result.error = { code: 'SPAWN_FAILED', message: '所有用例的进程都没能启动' };
    result.hint =
      'AOT/JIT 进程启动失败（EPERM/ENOENT）：确认路径可执行、不在受限沙箱里直接 spawn，并检查宿主 subprocess 是否可用。';
  }
  return { result, plan, startedAt, finishedAt };
}

function clipForDisplay(text) {
  const source = typeof text === 'string' ? text : '';
  if (source.length <= 120) return source;
  return `${source.slice(0, 120)}…(${source.length} 字符)`;
}

function renderDiff(diff) {
  if (diff.kind === 'text') {
    return `  ${diff.field}: AOT 行 ${diff.aotLine} ${JSON.stringify(clipForDisplay(diff.expected))} ≠ JIT 行 ${diff.jitLine} ${JSON.stringify(clipForDisplay(diff.actual))}`;
  }
  if (diff.kind === 'exit') return `  exit: AOT ${diff.expected} ≠ JIT ${diff.actual}`;
  if (diff.kind === 'timeout') return `  timeout: AOT ${diff.expected} / JIT ${diff.actual}`;
  if (diff.kind === 'truncated') return `  truncated: AOT ${diff.expected} / JIT ${diff.actual}`;
  if (diff.kind === 'spawn') return `  spawn: AOT ${diff.expected ?? 'ok'} / JIT ${diff.actual ?? 'ok'}`;
  if (diff.field === 'sideEffects') return `  sideEffects(${diff.path}): ${diff.kind}`;
  return `  ${diff.field}: ${diff.kind}`;
}

function renderRow(row) {
  const mark = row.match === true ? '✓' : '✗';
  const head = `[${row.index}] ${row.case} ${mark} aot exit=${row.aot.exitCode === null ? 'null' : row.aot.exitCode} out=${JSON.stringify(clipForDisplay(row.aot.stdout))} | jit exit=${row.jit.exitCode === null ? 'null' : row.jit.exitCode} out=${JSON.stringify(clipForDisplay(row.jit.stdout))}`;
  if (row.match === true) return head;
  const detail = row.diffs.slice(0, 3).map(renderDiff).join('\n');
  return detail === '' ? head : `${head}\n${detail}`;
}

export function renderAotjitResult(value) {
  const lines = [];
  if (value.ok !== true && value.error !== undefined && value.error !== null) {
    lines.push(`aotjit_compare 失败：${value.error.code} ${value.error.message}`);
    if (value.hint) lines.push(`建议：${value.hint}`);
    if (Array.isArray(value.rows) && value.rows.length > 0) {
      lines.push('');
      for (const row of value.rows) lines.push(renderRow(row));
    }
    return lines.join('\n');
  }
  lines.push(
    `AOT/JIT 对拍：${value.total} 用例，matched=${value.matched} mismatched=${value.mismatched}，allMatch=${value.allMatch}`,
  );
  for (const row of value.rows ?? []) lines.push(renderRow(row));
  if (value.firstMismatchCase !== null) {
    lines.push(`首个不一致：${value.firstMismatchCase} / ${value.firstMismatchField}`);
  }
  if (Array.isArray(value.warnings) && value.warnings.length > 0) {
    lines.push('warnings:');
    for (const warning of value.warnings) lines.push(`  - ${warning}`);
  }
  if (value.logPath !== null) lines.push(`日志：${value.logPath}`);
  return lines.join('\n');
}

/** 工具定义（规格 §3.1 / §3.2）。 */
export function buildAotjitCompareTool(config, runner, deps = {}) {
  return {
    name: 'aotjit_compare',
    description:
      'AOT/JIT 对拍：同一组用例分别启动 AOT 可执行文件与 JIT 命令，逐字段比较 stdout、exit code（可选 stderr、声明式文件副作用），返回每行是否 match 以及第一处不一致的用例与字段（含行号、两侧 argv/cwd/exit、日志路径）。ok 只表示「执行完成」，allMatch 才表示「全一致」：ok:true + allMatch:false 是对拍发现差异的正常返回，不是插件故障。进程超时/输出截断记为「不能证明一致」而不是异常；缺 aotExe/JIT 命令/工作目录等输入层问题返回 ok:false + 中文 hint。插件不构建 AOT、不实现 JIT，只执行与比较。',
    parameters: {
      type: 'object',
      properties: {
        aotExe: {
          type: 'string',
          description: 'AOT 可执行文件路径；相对路径按 workDir 解析。顶层与 cases[].aotExe 至少有一个。',
        },
        aotArgs: { type: 'array', items: { type: 'string' }, description: '追加到 AOT 命令的固定参数。' },
        jitSpec: {
          type: 'object',
          properties: {
            cmd: {
              type: 'string',
              description: 'JIT 入口：绝对路径、相对 workDir 的路径，或宿主 PATH 里的命令名；不能是 .cmd/.bat。',
            },
            args: {
              type: 'array',
              items: { type: 'string' },
              description: '固定的 JIT 参数；cases[].jitArgs 会覆盖它而不是追加。',
            },
            cwd: { type: 'string', description: 'JIT 侧工作目录；默认 workDir。' },
            env: {
              type: 'object',
              additionalProperties: { type: 'string' },
              description: '只对 JIT 追加的环境变量（与基础环境合并）。',
            },
          },
          required: ['cmd'],
          additionalProperties: false,
        },
        cases: {
          type: 'array',
          minItems: 1,
          items: {
            type: 'object',
            properties: {
              name: { type: 'string', description: '用例名，出现在 rows[].case 与日志里。' },
              args: {
                type: 'array',
                items: { type: 'string' },
                description: '追加到两侧的运行时参数（AOT 与 JIT 都收到）。',
              },
              stdin: { type: 'string', description: '写入两侧 stdin 的文本；默认空。日志不记录原文。' },
              aotExe: { type: 'string', description: '覆盖顶层 aotExe，用于每个用例不同的 AOT 产物。' },
              jitArgs: { type: 'array', items: { type: 'string' }, description: '覆盖 jitSpec.args（不是追加）。' },
              env: {
                type: 'object',
                additionalProperties: { type: 'string' },
                description: '该用例追加到两侧的环境变量。',
              },
              cwd: {
                type: 'string',
                description: '该用例的工作目录；默认 workDir。启用 sideEffects.isolate 时以隔离目录为准。',
              },
            },
            required: ['name'],
            additionalProperties: false,
          },
        },
        timeoutMs: {
          type: 'integer',
          minimum: LIMITS.timeoutMs.min,
          maximum: LIMITS.timeoutMs.max,
          description: '每个进程的超时（毫秒），默认取插件配置 120000；超时后终止进程并记 timedOut。',
        },
        workDir: { type: 'string', description: '解析相对路径与默认 cwd 的基准目录；默认会话 cwd，必须存在。' },
        compare: {
          type: 'object',
          properties: {
            stdout: { type: 'boolean', description: '是否比较 stdout，默认 true。' },
            exit: { type: 'boolean', description: '是否比较 exit code/signal/timedOut，默认 true。' },
            stderr: {
              type: 'string',
              enum: ['off', 'normalized', 'strict'],
              description: 'stderr 比较模式：off 只采集不比（默认），normalized 归一化后比较，strict 只做 CRLF。',
            },
            sideEffects: {
              description: '文件副作用比较：false 关闭（默认）；对象形式 {paths,mode,isolate,seed}。',
              anyOf: [
                { type: 'boolean' },
                {
                  type: 'object',
                  properties: {
                    paths: {
                      type: 'array',
                      items: { type: 'string' },
                      description: '相对运行目录的文件或目录；禁止绝对路径与 ..。',
                    },
                    mode: {
                      type: 'string',
                      enum: ['hash', 'content', 'tree'],
                      description: 'hash（默认）/content（首个不同行）/tree（目录树）。',
                    },
                    isolate: { type: 'boolean', description: 'AOT/JIT 各用独立目录，默认 true。' },
                    seed: {
                      type: 'array',
                      items: { type: 'string' },
                      description: '从 workDir 复制进隔离目录的输入文件或目录（目录按展开后总字节计）。',
                    },
                  },
                  required: ['paths'],
                  additionalProperties: false,
                },
              ],
            },
          },
          additionalProperties: false,
        },
        normalize: {
          type: 'object',
          properties: {
            crlf: { type: 'boolean', description: '把 CRLF/孤立 CR 统一成 LF，默认 true。' },
            ansi: { type: 'boolean', description: '去掉 ANSI 颜色序列，默认 false。' },
            trailingNewline: {
              type: 'string',
              enum: ['exact', 'ignore'],
              description: 'exact 保留末尾换行（默认）；ignore 去掉末尾所有换行。',
            },
            replacePaths: {
              type: 'array',
              items: { type: 'string' },
              description: '把这些绝对路径替换成 <path>，用于 stderr 里的构建目录差异。',
            },
          },
          additionalProperties: false,
        },
        maxOutputBytes: {
          type: 'integer',
          minimum: LIMITS.maxOutputBytes.min,
          maximum: LIMITS.maxOutputBytes.max,
          description: '每个 stdout/stderr 流保留的字节上限，默认取插件配置 1048576；超过即视为截断。',
        },
        tag: { type: 'string', description: '日志文件名标签，便于定位本次对拍。' },
        saveArtifacts: {
          type: 'boolean',
          description: '把每侧完整 stdout/stderr 另存到日志目录的 artifacts/<runId>/ 下，默认 false。',
        },
      },
      required: ['jitSpec', 'cases'],
      additionalProperties: false,
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [{ type: 'text', text: renderAotjitResult(value) }],
    },
    async execute(rawArgs, exec) {
      try {
        const cwd = sessionCwd(exec);
        const prepared = preparePlan(rawArgs, cwd, config, deps);
        if (!prepared.ok) {
          return setupFailure(prepared.error.code, prepared.error.message, prepared.hint, {
            warnings: [...(config.warnings ?? [])],
          });
        }
        const plan = prepared.plan;
        const executed = await executePlan(plan, runner, { maxSideEffectBytes: config.maxSideEffectBytes });
        const { result, startedAt, finishedAt } = executed;

        const log = formatRunLog({
          runId: plan.runId,
          startedAt: startedAt.toISOString(),
          finishedAt: finishedAt.toISOString(),
          durationMs: result.durationMs,
          workDir: plan.workDir,
          aotExe: plan.topAotExe,
          jitCmd: plan.jitCmd,
          timeoutMs: plan.timeoutMs,
          maxOutputBytes: plan.maxOutputBytes,
          compare: plan.compare,
          normalize: plan.normalize,
          total: result.total,
          matched: result.matched,
          mismatched: result.mismatched,
          firstMismatchCase: result.firstMismatchCase,
          firstMismatchField: result.firstMismatchField,
          warnings: result.warnings,
          rows: result.rows,
        });
        const written = writeRunLog({ cwd, logDir: config.logDir, runId: plan.runId, content: log });
        if (written.path !== null) result.logPath = written.path;
        if (written.warning !== null) result.warnings = [...result.warnings, written.warning];

        if (plan.saveArtifacts && result.rows.length > 0) {
          const artifacts = writeArtifacts({ cwd, logDir: config.logDir, runId: plan.runId, rows: result.rows });
          if (artifacts.warnings.length > 0) result.warnings = [...result.warnings, ...artifacts.warnings];
        }

        if (result.error !== undefined && result.error !== null) {
          return { ...result, error: { ...result.error, hint: result.hint } };
        }
        return result;
      } catch (error) {
        // 兜底：任何未预期异常都归一成 ok:false，工具本身绝不抛。
        const message = error instanceof Error ? error.message : String(error);
        return setupFailure(
          'INVALID_CASE',
          `aotjit_compare 内部错误：${message}`,
          '请把这条错误和入参一起报告给插件作者。',
        );
      }
    },
  };
}

/** apply 里用的入口：工具数组（便于将来加入兄弟工具）。 */
export function buildAotjitTools(config, runner, deps = {}) {
  return [buildAotjitCompareTool(config, runner, deps)];
}
