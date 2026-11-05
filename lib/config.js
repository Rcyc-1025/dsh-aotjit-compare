/**
 * 配置默认值与归一化（规格 §2.2）。
 *
 * 两个原则：
 * 1) 配置永远不阻止插件加载：任何非法值都退回默认值并记一条 warning；
 * 2) 工具参数（aotjit_compare 的 timeoutMs / maxOutputBytes / compare / normalize）
 *    在调用时覆盖配置，但走同一套归一化，避免两套语义。
 */

/** 所有数值项的边界与默认值；工具参数也按这套边界收紧。 */
export const LIMITS = {
  timeoutMs: { min: 1, max: 3_600_000, default: 120_000 },
  maxOutputBytes: { min: 64, max: 64 * 1024 * 1024, default: 1_048_576 },
  maxCases: { min: 1, max: 1_000, default: 100 },
  maxSideEffectBytes: { min: 1_024, max: 1_073_741_824, default: 16_777_216 },
};

/** 终止进程的宽限期（毫秒）：SIGTERM 之后等这么久再 SIGKILL。 */
export const GRACE_MS = 2_000;

export const COMPARE_DEFAULTS = Object.freeze({
  stdout: true,
  exit: true,
  stderr: 'off',
  sideEffects: false,
});

export const NORMALIZE_DEFAULTS = Object.freeze({
  crlf: true,
  ansi: false,
  trailingNewline: 'exact',
  replacePaths: [],
});

export const STDERR_MODES = Object.freeze(['off', 'normalized', 'strict']);
export const TRAILING_NEWLINE_MODES = Object.freeze(['exact', 'ignore']);
export const SIDE_EFFECT_MODES = Object.freeze(['hash', 'content', 'tree']);

function plainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

function warn(warnings, message) {
  if (!warnings.includes(message)) warnings.push(message);
}

/**
 * 取正整数：越界/类型不对时退回 fallback，并记一条 warning。
 * @param {unknown} value 原始值
 * @param {{min:number,max:number,default:number}} range 边界
 */
function positiveInt(value, range, fallback, warnings, label) {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isInteger(value)) {
    warn(warnings, `${label} 必须是整数，已使用默认值 ${fallback}`);
    return fallback;
  }
  if (value < range.min || value > range.max) {
    warn(warnings, `${label} 必须在 ${range.min}..${range.max} 之间，已使用默认值 ${fallback}`);
    return fallback;
  }
  return value;
}

function enumValue(value, allowed, fallback, warnings, label) {
  if (value === undefined || value === null) return fallback;
  if (typeof value === 'string' && allowed.includes(value)) return value;
  warn(warnings, `${label} 只能是 ${allowed.join(' / ')}，已使用默认值 ${fallback}`);
  return fallback;
}

function boolValue(value, fallback, warnings, label) {
  if (value === undefined || value === null) return fallback;
  if (typeof value === 'boolean') return value;
  warn(warnings, `${label} 必须是布尔值，已使用默认值 ${fallback}`);
  return fallback;
}

function stringArray(value, warnings, label) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    warn(warnings, `${label} 必须是字符串数组，已忽略`);
    return [];
  }
  return value.filter((item) => item !== '');
}

/**
 * 合并 compare 配置：入参（可为 false / 对象）覆盖 base。
 * compare.sideEffects 的完整形状交给 sidefx.js 校验，这里只区分「关」和「开」。
 */
export function resolveCompare(raw, base, warnings = []) {
  const result = { ...base };
  if (raw === undefined || raw === null) return result;
  if (typeof raw === 'boolean') {
    // 允许 compare:false 一次性关掉全部比较（等价于只看进程能否跑完）。
    result.stdout = raw;
    result.exit = raw;
    result.stderr = raw ? base.stderr : 'off';
    if (raw === false) result.sideEffects = false;
    return result;
  }
  const object = plainObject(raw);
  if (object === null) {
    warn(warnings, 'compare 必须是对象或布尔值，已忽略');
    return result;
  }
  if ('stdout' in object) result.stdout = boolValue(object.stdout, base.stdout, warnings, 'compare.stdout');
  if ('exit' in object) result.exit = boolValue(object.exit, base.exit, warnings, 'compare.exit');
  if ('stderr' in object) result.stderr = enumValue(object.stderr, STDERR_MODES, base.stderr, warnings, 'compare.stderr');
  if ('sideEffects' in object) {
    const value = object.sideEffects;
    if (value === false || value === undefined || value === null) result.sideEffects = false;
    else if (value === true) result.sideEffects = true; // 缺 paths，由工具层报 INVALID_CASE
    else if (plainObject(value) !== null) result.sideEffects = value;
    else {
      warn(warnings, 'compare.sideEffects 必须是 false 或对象，已关闭');
      result.sideEffects = false;
    }
  }
  return result;
}

/** 合并 normalize 配置（crlf / ansi / trailingNewline / replacePaths）。 */
export function resolveNormalize(raw, base, warnings = []) {
  const result = { ...base };
  const object = plainObject(raw);
  if (raw !== undefined && raw !== null && object === null) {
    warn(warnings, 'normalize 必须是对象，已忽略');
    return result;
  }
  if (object === null) return result;
  if ('crlf' in object) result.crlf = boolValue(object.crlf, base.crlf, warnings, 'normalize.crlf');
  if ('ansi' in object) result.ansi = boolValue(object.ansi, base.ansi, warnings, 'normalize.ansi');
  if ('trailingNewline' in object) {
    result.trailingNewline = enumValue(
      object.trailingNewline,
      TRAILING_NEWLINE_MODES,
      base.trailingNewline,
      warnings,
      'normalize.trailingNewline',
    );
  }
  if ('replacePaths' in object) result.replacePaths = stringArray(object.replacePaths, warnings, 'normalize.replacePaths');
  return result;
}

/** 环境变量覆盖（v1 可选，规格 §2.2 末尾）。 */
function envInt(name) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return undefined;
  const value = Number(raw);
  return Number.isInteger(value) && value > 0 ? value : undefined;
}

/**
 * 归一化插件配置；永远返回可用的对象。
 * @param {unknown} raw cordis.patch.yml 里的 config
 */
export function resolveConfig(raw) {
  const warnings = [];
  const object = plainObject(raw) ?? {};

  const envTimeout = envInt('AOTJIT_TIMEOUT_MS');
  const envMaxOutput = envInt('AOTJIT_MAX_OUTPUT_BYTES');

  const timeoutMs = positiveInt(
    object.timeoutMs ?? envTimeout,
    LIMITS.timeoutMs,
    LIMITS.timeoutMs.default,
    warnings,
    'timeoutMs',
  );
  const maxOutputBytes = positiveInt(
    object.maxOutputBytes ?? envMaxOutput,
    LIMITS.maxOutputBytes,
    LIMITS.maxOutputBytes.default,
    warnings,
    'maxOutputBytes',
  );
  const maxCases = positiveInt(object.maxCases, LIMITS.maxCases, LIMITS.maxCases.default, warnings, 'maxCases');
  const maxSideEffectBytes = positiveInt(
    object.maxSideEffectBytes,
    LIMITS.maxSideEffectBytes,
    LIMITS.maxSideEffectBytes.default,
    warnings,
    'maxSideEffectBytes',
  );
  const logDirRaw = object.logDir;
  const logDir =
    typeof logDirRaw === 'string' && logDirRaw.trim() !== '' ? logDirRaw : '.aotjit-logs';
  if (logDirRaw !== undefined && logDir !== logDirRaw) warnings.push('logDir 必须是非空字符串，已使用默认值 .aotjit-logs');

  const compare = resolveCompare(object.compare, COMPARE_DEFAULTS, warnings);
  const normalize = resolveNormalize(object.normalize, NORMALIZE_DEFAULTS, warnings);
  const saveArtifacts = boolValue(object.saveArtifacts, false, warnings, 'saveArtifacts');

  return {
    timeoutMs,
    maxOutputBytes,
    maxCases,
    maxSideEffectBytes,
    logDir,
    compare,
    normalize,
    saveArtifacts,
    graceMs: GRACE_MS,
    warnings,
  };
}

/**
 * 工具调用的逐次覆盖：只处理 timeoutMs / maxOutputBytes / compare / normalize。
 * 与配置共用同一套边界，非法值退回配置值并进 warnings。
 */
export function resolveCallOptions(args, config) {
  const warnings = [];
  const object = plainObject(args) ?? {};
  const timeoutMs = positiveInt(object.timeoutMs, LIMITS.timeoutMs, config.timeoutMs, warnings, 'timeoutMs');
  const maxOutputBytes = positiveInt(
    object.maxOutputBytes,
    LIMITS.maxOutputBytes,
    config.maxOutputBytes,
    warnings,
    'maxOutputBytes',
  );
  const compare = resolveCompare(object.compare, config.compare, warnings);
  const normalize = resolveNormalize(object.normalize, config.normalize, warnings);
  return { timeoutMs, maxOutputBytes, compare, normalize, warnings };
}
