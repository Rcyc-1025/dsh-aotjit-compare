import { resolveConfig } from './config.js';
import { createSubprocessRunner } from './exec.js';
import { buildAotjitTools } from './tools.js';

export const name = 'aotjit-compare';
export const inject = ['subprocess', 'tools'];

/**
 * 注册唯一工具 aotjit_compare：同一组用例分别跑 AOT 可执行文件与 JIT 命令，
 * 逐字段比较 stdout / exit（可选 stderr、文件副作用）。
 *
 * apply 里不探测、不 spawn、不读工作目录：aotExe / jitSpec.cmd 的解析推迟到每次调用，
 * 缺文件只会让那一次调用返回 ok:false + hint，插件加载本身永远成功。
 */
export function apply(ctx, config) {
  const cfg = resolveConfig(config);
  const runner = createSubprocessRunner((spec) => ctx.subprocess.spawn(spec), {
    graceMs: cfg.graceMs,
    timeoutMs: cfg.timeoutMs,
  });
  // PATH 解析只在调用时发生（jitSpec.cmd 没有路径分隔符时才用得上）。
  const deps = {
    resolveExecutable: (command) =>
      typeof ctx.subprocess?.resolveExecutable === 'function' ? ctx.subprocess.resolveExecutable(command) : null,
  };
  const disposers = buildAotjitTools(cfg, runner, deps).map((definition) => ctx.tools.register(definition));
  if (typeof ctx.on === 'function') {
    ctx.on('dispose', () => {
      for (const dispose of disposers) {
        if (typeof dispose === 'function') dispose();
      }
    });
  }
}
