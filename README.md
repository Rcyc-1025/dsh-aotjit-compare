# dsh-aotjit-compare

把**同一个用例**分别交给「AOT 可执行文件」和「JIT 启动命令」跑一遍，逐字段比较 stdout / exit code（可选 stderr、可选文件副作用），给出「哪一行、哪一侧、期望什么、实际什么」。

插件 id：`aotjit-compare` · 工具名：`aotjit_compare` · 版本：0.1.0

## 它解决什么问题

MLIR/LLVM 的 AOT 后端（`toyc --emit=exe` 之类）与 JIT 路径（`toyc --emit=run`）本该给出同样的运行结果。一旦后端改动，差异往往只出现在某一类输入上，而且可能是 stdout 第 3 行、退出码、或者某个写入文件的内容。手工对拍慢且容易漏，这个工具把「跑两侧 + 比对 + 定位 + 留日志」做成一次调用。

```
aotjit_compare({
  aotExe: "build/s01/add.exe",
  jitSpec: { cmd: "build/toyc.exe", args: ["examples/add.mul.mlir", "--emit=run"] },
  cases: [{ name: "add.mul" }]
})
```

两侧输出都是 `7\n`、退出码都是 `9` → `allMatch: true`。

## 安装

插件目录需要被 desktop profile 引用。两种方式：

```powershell
# 1) 用 DSH CLI 把本地目录装进 profile
D:\exe\DSH\resources\runtime\cli\bin\dsh.cmd plugin --profile desktop add D:\workplace\aotjit-compare
```

```jsonc
// 2) 或手工在 <profile>/package.json 里登记（profile 目录通常为 %DSH_HOME%\data\profiles\desktop）
{
  "dependencies": { "dsh-aotjit-compare": "file:D:/workplace/aotjit-compare" },
  "dsh": { "profile": { "bundles": ["...", "dsh-aotjit-compare"] } }
}
```

`cordis.patch.yml` 会以 `insert` 方式注册本插件，`name: 'dsh-aotjit-compare'`。

## 配置（cordis.patch.yml / 宿主 config）

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `timeoutMs` | `120000` | 单个进程的超时；超时后先 SIGTERM，`graceMs` 后 SIGKILL |
| `maxOutputBytes` | `1048576` | 每个 stdout / stderr 流保留的字节上限，超出即视为截断 |
| `maxCases` | `100` | 单次调用允许的用例数上限 |
| `maxSideEffectBytes` | `16777216` | 副作用快照允许的总字节数 |
| `logDir` | `.aotjit-logs` | 日志目录（相对会话 cwd） |
| `compare` | `{stdout:true, exit:true, stderr:"off", sideEffects:false}` | 默认比较项 |
| `normalize` | `{crlf:true, ansi:false, trailingNewline:"exact", replacePaths:[]}` | 默认归一化 |
| `saveArtifacts` | `false` | 是否把每侧完整 stdout/stderr 另存到 `artifacts/` |

非法配置不会阻止加载：退回默认值并写进结果的 `warnings[]`。环境变量 `AOTJIT_TIMEOUT_MS` / `AOTJIT_MAX_OUTPUT_BYTES` 可做进程级覆盖（调用参数优先于配置）。

## 工具参数

`required` 只有 `jitSpec` 与 `cases`。

| 参数 | 类型 | 说明 |
| --- | --- | --- |
| `aotExe` | string | AOT 可执行文件；相对路径按 `workDir` 解析。顶层不写时每个 case 必须用 `cases[].aotExe` |
| `aotArgs` | string[] | 追加到每个 AOT 命令的 argv |
| `jitSpec` | object | `{cmd, args?, cwd?, env?}`；`cmd` 必填，可直接 spawn（`.cmd`/`.bat` 会被拒绝） |
| `cases` | array | 至少一个；每项 `{name, args?, stdin?, aotExe?, jitArgs?, env?, cwd?}` |
| `timeoutMs` | integer | 覆盖配置的逐进程超时 |
| `maxOutputBytes` | integer | 覆盖配置的每流上限 |
| `workDir` | string | 相对路径与默认 cwd 的基准，默认会话 cwd，必须存在 |
| `compare` | object | 覆盖配置的比较项（工具 schema 只收对象；插件配置里可写 `false` 一次关掉全部比较） |
| `normalize` | object | 覆盖配置的归一化 |
| `tag` | string | 日志文件名标签 |
| `saveArtifacts` | boolean | 本次是否另存完整输出 |

### argv 约定（重要）

```
AOT: [aotExe, ...aotArgs, ...case.args]
JIT: [cmd,    ...(case.jitArgs ?? jitSpec.args), ...case.args]
```

- `case.jitArgs` 是**覆盖** `jitSpec.args`，不是追加——这样 10 个用例可以共用同一个 JIT 入口、只换输入文件。
- `case.args` 追加到**两侧**，用于同一份 IR 的运行时开关（如 `--seed=1`）。
- argv 直传，不经过 shell，所以不需要引号转义，也不能写管道/重定向。

## 输出

```jsonc
{
  "ok": true,               // 执行完成（不是「一致」）
  "allMatch": false,        // 全部用例一致
  "firstMismatchCase": "case-07",
  "firstMismatchField": "stdout",
  "total": 10, "matched": 9, "mismatched": 1,
  "rows": [
    {
      "index": 6, "case": "case-07", "match": false, "firstMismatch": "stdout",
      "diffs": [
        { "field": "stdout", "kind": "text", "aotLine": 1, "jitLine": 1,
          "expected": "7", "actual": "8", "expectedLength": 2, "actualLength": 2 }
      ],
      "aot": { "cmd": ["D:/p/build/parity/case-07.exe"], "cwd": "D:/p", "exitCode": 0,
               "exitCodeHex": "0x0", "signal": null, "timedOut": false, "durationMs": 12,
               "stdout": "7\n", "stderr": "", "stdoutTruncated": false, "stderrTruncated": false,
               "spawnError": null },
      "jit": { "...": "同上" }
    }
  ],
  "logPath": "D:/p/.aotjit-logs/20261106-103000-a1b2-case07.log",
  "durationMs": 183, "warnings": [], "hint": null
}
```

### `ok` 与 `allMatch` 是两件事

| 场景 | `ok` | `allMatch` | `firstMismatchField` |
| --- | --- | --- | --- |
| 全一致 | true | true | null |
| 对拍发现差异 | true | false | stdout / exit / stderr / sideEffects / timeout / truncated |
| 所有行都启动失败 | false | false | spawn（`error.code = SPAWN_FAILED`） |
| 参数 / 路径错误 | false | false | — |

「对拍发现差异」是**正常返回**：工具会把差异结构化给你，不会当成错误抛出。

### 字段优先级

`spawnError > timedOut > exit > stdout > stderr > sideEffects`。`diffs[].expected` 永远是 AOT 侧，`actual` 是 JIT 侧。

- 任一侧输出被截断 → 不比较截断前缀，直接 `firstMismatch: "truncated"`（避免拿残缺输出得出假结论）。
- 输出不是合法 UTF-8 → `stdoutEncoding: "binary"`，改比字节 SHA-256。
- Windows 负退出码保留原始数值，另给 `exitCodeHex`（如 `0xc0000005`）。

## 比较与归一化

`compare`：

- `stdout: true`（默认）——归一化后逐行比较，给首个不同行号。
- `exit: true`（默认）——比较退出码；`timedOut` 优先于退出码。
- `stderr: "off"`（默认）只采集不比；`"normalized"` 按 `normalize` 比较（含 `replacePaths`）；`"strict"` 只统一 CRLF，忽略 `ansi` / `trailingNewline` / `replacePaths`。
- `sideEffects`——见下节。

`normalize`：

- `crlf: true` 把 CRLF 与孤立 CR 统一成 LF；
- `ansi: false` 默认保留颜色序列，置 true 才剥掉；
- `trailingNewline: "exact"` 保留末尾换行，`"ignore"` 去掉末尾所有换行；
- `replacePaths: ["D:/build/debug"]` 把这些前缀替换成 `<path>`——stderr 里的构建目录差异靠它抹平。

## 文件副作用（sideEffects）

```jsonc
compare: {
  sideEffects: { paths: ["out/result.txt"], mode: "content", isolate: true, seed: ["input.bin"] }
}
```

- `paths` 必填，相对运行目录，**禁止绝对路径与 `..` 逃逸**（否则 `SIDE_EFFECT_ESCAPE`）。
- `mode`：`hash`（默认，比 SHA-256）、`content`（比内容并给首个不同行）、`tree`（递归目录树）。
- `isolate: true`（默认）：AOT 与 JIT 各跑在 `<workDir>/.aotjit/<runId>/<caseIndex>-aot|jit`，`seed` 里的文件/目录从 `workDir` 复制进两侧。这样 AOT 写的文件 JIT 看不到，副作用才算「各自产生的」。一次调用结束后（无论成功、失败还是中途 break）整棵 `<workDir>/.aotjit/<runId>/` 会被清掉；清理失败只进 `warnings[]`。
- `seed` 的字节数按**展开后**统计（目录会递归累加），AOT/JIT 两侧合计受 `maxSideEffectBytes` 约束。
- 超过 `maxSideEffectBytes` → `SIDE_EFFECT_TOO_LARGE`；复制 seed 失败 → `SIDE_EFFECT_COPY_FAILED`。

## 日志

每次调用写一份 `<cwd>/<logDir>/<yyyyMMddHHmmss>-<4hex>[-tag].log`，含：

- 两侧 argv、cwd、退出码、耗时、截断与编码情况；
- 每处差异的字段、行号、期望/实际；
- 配置摘要与 warnings。

**不写** stdin 原文，也不写完整环境变量。写日志失败只进 `warnings[]`，不影响结论。`saveArtifacts: true` 时另存 `artifacts/<runId>/<idx>-<case>/aot.stdout.txt` 等文件。

## 错误码

| code | 含义 |
| --- | --- |
| `AOT_EXE_NOT_FOUND` | `aotExe` 缺失或指向的文件不存在 |
| `JIT_CMD_NOT_FOUND` | `jitSpec.cmd` 既不是存在的路径，也不在宿主 PATH 中 |
| `JIT_CMD_SHELL_WRAPPER` | `cmd` 是 `.cmd`/`.bat`；本插件不走 shell |
| `NO_CASES` / `TOO_MANY_CASES` | `cases` 为空 / 超过 `maxCases` |
| `INVALID_CASE` | 字段类型错误（name/args/stdin/jitArgs/env/cwd/aotExe） |
| `WORKDIR_NOT_FOUND` | `workDir` 或 `jitSpec.cwd` 不存在 |
| `SPAWN_FAILED` | 所有行都启动失败（如 `EPERM`） |
| `TIMEOUT` | 超时（同时 `timedOut: true`，`ok` 仍为 true） |
| `OUTPUT_TRUNCATED` | 输出被截断（对应 `firstMismatch: "truncated"`） |
| `SIDE_EFFECT_ESCAPE` / `SIDE_EFFECT_TOO_LARGE` / `SIDE_EFFECT_COPY_FAILED` | 副作用路径越界 / 超限 / seed 复制失败 |

每个错误都带中文 `hint`，说明下一步该改什么。

## 验证

```powershell
npm test                 # 85 个单测（node --test，无真实进程）
npm run smoke            # 假 subprocess 走通「加载 → 调用 → 日志 → 渲染」
npm run integration      # 8 条真机用例（真实 exe + cmd.exe，需要能 spawn 的宿主环境）
npm run integration:parity # 10 用例夹具 + 注入错误（需要 toyc 与 clang++）
```

`npm run integration` 用 `node:child_process` 冒充宿主 subprocess，在真实进程上验证：S-01 单用例全一致、stdout 差异定位、超时、截断、文件副作用与隔离、JIT 命令缺失、`.cmd` 包装器拒绝。DSH 的 workspace-write 沙箱里 Node 自己 spawn 会 `EPERM`，所以它要在宿主侧运行（插件本身在宿主里走 `ctx.subprocess`，不受影响）。

`npm run integration:parity` 覆盖规格 6.1 的 ②③：仓库自带 `test/fixtures/parity/case-01..10.mlir`，脚本用 `toyc --emit=exe` 现场生成 AOT 可执行文件、`--emit=run` 跑 JIT 侧，断言 10/10 全一致；随后只改 case-05 的打印值（退出码不变）当作注入错误，断言 `firstMismatchCase:"case-05"`、`firstMismatchField:"stdout"`、`100` vs `101`、其余 9 行仍 `match:true`。工具链默认读 mlir-lang 的 `build/toyc.exe` 与 LLVM 23.1.4 的 `clang++.exe`，可用 `AOTJIT_TOYC` / `AOTJIT_CLANG` 覆盖；缺工具时打印 `SKIP` 并以 0 退出。

> 注入必须只改 stdout：字段优先级是 `exit` 早于 `stdout`，若同时改掉退出码，正确的结果就是 `firstMismatchField:"exit"`。

S-01 单用例（规格 6.1①）的真机形态：`aotExe=build/s01/add.exe`、`jitSpec={cmd:build/toyc.exe,args:["examples/add.mul.mlir","--emit=run"]}`、`cases:[{name:"add.mul"}]` → `allMatch:true`，两侧 `stdout="7\n"`、`exitCode=9`。

## 实现拆分

规格建议的模块是 `lib/{index,config,exec,normalize,compare,tools}.js`；本实现额外拆出：

- `lib/sidefx.js`——副作用校验、快照、隔离目录；
- `lib/log.js`——日志与 artifacts。

这只是内部分层，不改变对外契约：插件 id、包名、工具名、入参、输出字段都按规格。

## 已知边界

- 只支持 Windows（路径、退出码语义、进程终止都以 Windows 为准）。
- 不做并行：每个 case 严格「先 AOT 后 JIT」，避免同一份输入文件被两侧同时写坏。
- 不做交互式 stdin：`stdin` 是一次性写入后立即关闭。
- 比较是逐行文本 / 字节级，不理解 IR 语义。

## License

MIT
