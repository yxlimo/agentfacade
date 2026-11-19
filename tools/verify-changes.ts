// tools/verify-changes.ts — 按 diff 决定要跑哪些门禁。
//
//   node --experimental-strip-types tools/verify-changes.ts [--plan] [--base <rev>]
//   node --experimental-strip-types tools/verify-changes.ts --files a,b,c
//
// 为什么有这个东西：门禁分组写在 CONVENTIONS.md 的表里，靠人记。今天真的出过
// 事：改了面板文案，只跑了单测（check:web），面板 e2e 里断言旧文案的用例红着
// 没人知道 —— check:web 不启浏览器，e2e 三分钟又不该每次都跑。于是「改了什么
// 就跑什么」得由机器判，不能靠记性。
//
// 判据只有一条：路径落在哪张表里，就跑那一组；不认识就从严（跑全量）。
//
// 几件事是这个脚本的取舍：
//   - 基线：--base 显式给；否则 HEAD 不在 main 上就用 merge-base HEAD main
//     （worktree 与分支上的活都算）；在 main 上就用 origin/main；再没有就
//     HEAD~1。改动集合用 `git diff --name-only <base>`，它比的是基线与工作
//     区，所以未提交的改动也在里面 —— 子代理最常见的状态就是没提交。
//   - 注入：规则表是纯函数，测试直接 import 它算任务清单；CLI 另开 --files
//     给一组假路径，用来验「计划打印」这件事，不往生产路径里塞复位口。
//
// 边界：只用 node 内置模块，不装新依赖；不改任何业务代码；任务名一律用
// check:kinds 这种形式打印；不出现本机绝对路径。

import { spawnSync, execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** 仓库根目录：这个脚本在 tools/ 下面。 */
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** 一条规则：路径落在这些模式里，就贡献这些门禁。 */
interface Rule {
  /** 规则的名字（打印用）。 */
  id: string;
  /** 这条规则贡献的门禁。 */
  tasks: string[];
  /** 命中的路径模式。 */
  patterns: string[];
  /** 为什么它要跑这些门禁。 */
  why: string;
  /**
   * 这条规则比哪些规则更具体：它命中的文件不再计入那些规则。
   *
   * 只有当两边的门禁完全一样时才能这么写（否则会丢门禁）。
   */
  supersedes?: string[];
}

/**
 * 规则表。全量门禁 `check` 出现时其余都不用列 —— check 已经包含它们。
 *
 * 顺序即打印顺序（先命中先说），不是执行顺序；执行顺序另有 ORDER。
 */
const RULES: Rule[] = [
  {
    id: "admin",
    tasks: ["check:admin"],
    patterns: [
      "lib/admin/**",
      "lib/provider-kinds.ts",
      "lib/platforms*",
      "lib/platforms/**",
      "lib/model-catalog*",
      "lib/model-catalog/**",
    ],
    why: "面板后端、账号与模型目录变了 → 跑 check:admin",
  },
  {
    id: "routing",
    tasks: ["check:routing"],
    patterns: [
      "lib/router/**",
      "lib/cooldown*",
      "lib/cooldown/**",
      "lib/session*",
      "lib/session/**",
      "lib/periodic*",
      "lib/periodic/**",
    ],
    why: "选号、降级、冷却、用量、定时任务变了 → 跑 check:routing",
  },
  {
    id: "deliver",
    tasks: ["check:deliver"],
    patterns: ["lib/router/handle.ts", "lib/dialect*", "lib/dialect/**", "lib/log-scrub*", "lib/log-scrub/**"],
    why: "响应的投递、方言与脱敏变了 → 跑 check:deliver",
  },
  {
    id: "kinds",
    tasks: ["check:kinds"],
    patterns: [
      "lib/kinds/**",
      "lib/minimax/**",
      "lib/qoder/**",
      "lib/workbuddy/**",
      "lib/zcode/**",
      "lib/tokenrhythm/**",
      "lib/intern-ai/**",
      "lib/qiniu/**",
      "lib/xinghuo/**",
      "lib/sensenova/**",
    ],
    why: "上游 kind 与模拟端变了 → 跑 check:kinds",
  },
  {
    id: "web-src",
    tasks: ["check:web", "check:panel"],
    patterns: ["web/src/**"],
    // web/src/** 是 web/** 的子集，门禁一样：命中更具体的这条就够了，
    // 免得计划里同一个文件打两行一样的话。
    supersedes: ["web-other"],
    why: "`web/src/**` 变了 → 面板 e2e 断言的是用户可见文案",
  },
  {
    id: "web-other",
    tasks: ["check:web", "check:panel"],
    patterns: ["web/**"],
    why: "web/** 变了（构建、e2e、依赖）→ 面板单测与 e2e 都要跑",
  },
  {
    id: "panel-e2e",
    tasks: ["check:panel"],
    patterns: ["tests/**"],
    why: "仓库根的 tests/ 是面板 e2e 用例（不是 web/e2e/）→ 改它要跑浏览器那套",
  },
  {
    id: "proto",
    tasks: ["proto", "check:admin", "check:web"],
    patterns: ["proto/**"],
    why: "契约变了 → 先生成两份产物，再验面板后端与前端",
  },
  {
    id: "misc",
    tasks: ["check:misc"],
    patterns: [
      "mise.toml",
      "test/**",
      "tools/**",
      "check-privacy.ts",
      "tsconfig*.json",
      "tsconfig/**",
      ".github/**",
      ".gitignore",
      ".dockerignore",
      ".editorconfig",
      ".prettierrc",
      ".prettierrc.*",
      ".prettierignore",
    ],
    why: "门禁、测试与工具本身变了 → 跑 check:misc",
  },
  {
    id: "deps",
    tasks: ["check"],
    patterns: [
      "package.json",
      "pnpm-lock.yaml",
      "web/pnpm-lock.yaml",
      "web/pnpm-workspace.yaml",
      "pnpm-workspace.yaml",
    ],
    why: "依赖变了 → 谁也别猜，跑全量 check",
  },
  {
    id: "docs",
    tasks: ["privacy"],
    patterns: ["**/*.md", "docs/**", ".pi/**"],
    why: "只有文档与工作日志变了 → 只扫隐私",
  },
];

/** 命中不了的路径：从严，跑全量。 */
const UNKNOWN_RULE: Rule = {
  id: "unknown",
  tasks: ["check"],
  patterns: [],
  why: "有不认识的路径 → 从严，跑全量 check",
};

/** 执行顺序。proto 先生成，privacy 最后扫。 */
const ORDER = [
  "proto",
  "check:admin",
  "check:routing",
  "check:deliver",
  "check:kinds",
  "check:web",
  "check:panel",
  "check:misc",
  "privacy",
];

/** glob 变成正则。`**` 跨目录，`*` 不跨目录。 */
function globToRegExp(pattern: string): RegExp {
  let out = "";
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === "*") {
      if (pattern[i + 1] === "*") {
        if (pattern[i + 2] === "/") {
          out += "(?:.*/)?";
          i += 2;
        } else {
          out += ".*";
          i += 1;
        }
      } else {
        out += "[^/]*";
      }
    } else if ("\\^$.|+()[]{}".includes(ch)) {
      out += "\\" + ch;
    } else {
      out += ch;
    }
  }
  return new RegExp("^" + out + "$");
}

/** 预编译好的规则，省得每个文件重编。 */
const COMPILED = RULES.map((rule) => ({
  rule,
  matchers: rule.patterns.map(globToRegExp),
}));

/** 一条规则命中了哪些文件。 */
export interface RuleHit {
  rule: Rule;
  files: string[];
}

/** 一条反向依赖：哪个源文件被哪个测试脚本直接 import。 */
export interface ImportHit {
  /** 命中的门禁。 */
  task: string;
  /** 改动的源文件（仓库相对路径）。 */
  source: string;
  /** 直接 import 它的测试脚本（仓库相对路径）。 */
  script: string;
}

/** 一个门禁组里的测试脚本，以及它直接 import 的源文件。 */
interface GateTest {
  task: string;
  script: string;
  imports: Set<string>;
}

/** mise.toml 里的任务块 `key = { depends = [...] }` / `run`。 */
interface TomlTask {
  name: string;
  depends: string[];
  run: string;
}

/**
 * 从 mise.toml 的文本里读出所有 `[tasks."..."]` 块。
 *
 * 只认这里用到的两种字段（depends 里的字符串数组、run 里的单行字符串）。
 * TOML 是外部输入，宁可解析不出来让调用方从严，也不猜一个半成品清单。
 */
export function parseTomlTasks(text: string): TomlTask[] {
  const tasks: TomlTask[] = [];
  let current: TomlTask | undefined;
  const flush = (): void => {
    if (current) tasks.push(current);
    current = undefined;
  };
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    const header = /^\[tasks\."([^"]+)"\]\s*$/.exec(line);
    if (header) {
      flush();
      current = { name: header[1], depends: [], run: "" };
      continue;
    }
    if (!current) continue;
    if (line === "" || line.startsWith("#")) continue;
    const depends = /^depends\s*=\s*\[([^\]]*)\]/.exec(line);
    if (depends) {
      current.depends = Array.from(depends[1].matchAll(/"([^"]+)"/g), (m) => m[1]);
      continue;
    }
    const run = /^run\s*=\s*"([^"\n]*)"\s*$/.exec(line);
    if (run) current.run = run[1];
  }
  flush();
  return tasks;
}

/**
 * 从一条 `run` 命令里取出脚本路径。
 *
 * 形如 `node --experimental-strip-types test/foo-check.ts`；只认以 test/ 开头
 * 的 .ts 脚本，别的任务（python、mise 子任务）不进 import 图。
 */
function scriptFromRun(run: string): string | undefined {
  const match = /(^|\s)((?:test\/)[^\s]+\.ts)(?=\s|$)/.exec(run);
  return match ? match[2] : undefined;
}

/** 从脚本正文里抽直接 import 的相对模块路径，解析成仓库相对路径。 */
function importedSources(script: string, body: string): string[] {
  const found = new Set<string>();
  const dir = path.posix.dirname(script);
  // 静态 import / export from、side-effect import、动态 import() 都算一跳。
  // 一跳是已知上限：传递依赖（脚本 import 的模块又 import 了改动文件）
  // 不做，否则这张图会滚雪球，误报的门禁比漏报的多。
  const patterns = [
    // [^;]*? 把匹配限制在一条语句里，免得跨语句捞到一个碰巧出现的路径字面量。
    /(?:^|[^\w$])(?:import|export)\s+[^;]*?\bfrom\s+["']([^"']+)["']/g,
    /(?:^|[^\w$])import\s+["']([^"']+)["']/g,
    /(?:^|[^\w$])import\s*\(\s*["']([^"']+)["']\s*\)/g,
  ];
  for (const pattern of patterns) {
    for (const match of body.matchAll(pattern)) {
      const spec = match[1];
      if (!spec.startsWith(".")) continue;
      const absolute = path.resolve(ROOT, dir, spec);
      const relative = path.relative(ROOT, absolute);
      if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) continue;
      found.add(relative.split(path.sep).join("/"));
    }
  }
  return [...found];
}

/** 由 mise.toml 的文本建「门禁 → 测试脚本 → 直接 import 的源文件」。 */
export function parseGateTests(text: string, readScript: (script: string) => string): GateTest[] {
  const tasks = parseTomlTasks(text);
  const byName = new Map(tasks.map((task) => [task.name, task]));
  const gates = tasks.filter((task) => task.name.startsWith("check:"));
  if (gates.length === 0) throw new Error("mise.toml 里没解析出任何 check:* 门禁");
  const gatesOut: GateTest[] = [];
  for (const gate of gates) {
    for (const testName of gate.depends) {
      // 有些 test:* 名字在表里没有 run（比如依赖另一个任务），跳过。
      const test = byName.get(testName);
      if (!test) continue;
      const script = scriptFromRun(test.run);
      if (!script) continue;
      // 仓库根的 tests/** 是面板 e2e：它们打 HTTP，不 import 服务端模块。
      if (script.startsWith("tests/")) continue;
      gatesOut.push({ task: gate.name, script, imports: new Set(importedSources(script, readScript(script))) });
    }
  }
  if (gatesOut.length === 0) throw new Error("mise.toml 里没解析出任何带脚本的测试任务");
  return gatesOut;
}

/** 改动的源文件被哪些测试脚本直接 import。 */
export function matchImports(files: string[], gates: GateTest[]): ImportHit[] {
  const changed = new Set(files);
  const hits: ImportHit[] = [];
  for (const gate of gates) {
    for (const source of gate.imports) {
      if (changed.has(source)) hits.push({ task: gate.task, source, script: gate.script });
    }
  }
  return hits;
}

/**
 * 路径 → 命中的规则。
 *
 * 一个文件可以命中多条规则（lib/router/handle.ts 既在 routing 里也在 deliver
 * 里），所以这里是「多条」，不是「一条」。
 */
export function matchRules(files: string[]): RuleHit[] {
  // 先各算各的，再让更具体的规则把笼统规则里的同一批文件拿掉。
  const matched = new Map<string, string[]>();
  for (const { rule, matchers } of COMPILED) {
    const hit = files.filter((file) => matchers.some((m) => m.test(file)));
    if (hit.length > 0) matched.set(rule.id, hit);
  }
  for (const { rule, matchers } of COMPILED) {
    if (!rule.supersedes) continue;
    for (const id of rule.supersedes) {
      const other = matched.get(id);
      if (!other) continue;
      const remaining = other.filter((file) => !matchers.some((m) => m.test(file)));
      if (remaining.length === 0) matched.delete(id);
      else matched.set(id, remaining);
    }
  }
  const hits: RuleHit[] = [];
  for (const { rule } of COMPILED) {
    const hit = matched.get(rule.id);
    if (hit) hits.push({ rule, files: hit });
  }
  // 有文件一条规则都没命中，就是有不认识的路径 → 从严。
  const known = new Set(hits.flatMap((hit) => hit.files));
  const unknown = files.filter((file) => !known.has(file));
  if (unknown.length > 0) {
    hits.push({ rule: UNKNOWN_RULE, files: unknown });
  }
  return hits;
}

/** 一次分析的完整结果：任务、反向依赖来路、解析失败的原因。 */
export interface PlanResult {
  tasks: string[];
  imports: ImportHit[];
  failClosed: string;
}

/**
 * 改动文件 → 要跑的门禁（有序）。
 *
 * 路径规则之外还要看反向依赖：测试脚本直接 import 了改动文件，那个脚本所属
 * 的门禁组也必须跑（tsconfig 不查 test/**，路径规则又按目录写，两头都想不到）。
 * 图解析不出来就退回全量 check —— 宁可慢，不可漏。
 *
 * 命中「全量 check」时只留它：check 已经包含其余各组。
 */
export function analyzePlan(
  files: string[],
  toml: string,
  readScript: (script: string) => string
): PlanResult {
  const hits = matchRules(files);
  const tasks = new Set<string>();
  for (const hit of hits) for (const task of hit.rule.tasks) tasks.add(task);
  if (tasks.has("check")) return { tasks: ["check"], imports: [], failClosed: "" };
  let gates: GateTest[];
  try {
    gates = parseGateTests(toml, readScript);
  } catch (e) {
    return { tasks: ["check"], imports: [], failClosed: (e as Error).message || String(e) };
  }
  const imports = matchImports(files, gates);
  for (const hit of imports) tasks.add(hit.task);
  return { tasks: ORDER.filter((task) => tasks.has(task)), imports, failClosed: "" };
}

/** 生产入口：从工作树读 mise.toml，解析不出来自从严。 */
export function planTasks(files: string[]): string[] {
  const toml = readFileSync(path.join(ROOT, "mise.toml"), "utf8");
  return analyzePlan(files, toml, (script) => readFileSync(path.join(ROOT, script), "utf8")).tasks;
}

/** 跑一条 git 命令，拿 stdout。失败就抛。 */
function git(args: string[]): string {
  return execFileSync("git", args, { cwd: ROOT, encoding: "utf8" });
}

/** 这个 ref 存不存在。 */
function hasRef(ref: string): boolean {
  try {
    git(["rev-parse", "--verify", "--quiet", ref]);
    return true;
  } catch {
    return false;
  }
}

/**
 * 取基线。
 *
 * --base 优先；否则 HEAD 不在 main 上就用 merge-base HEAD main（worktree 与
 * 分支上的活都算）；在 main 上就用 origin/main；再没有就 HEAD~1。
 */
export function resolveBase(explicit?: string): string {
  if (explicit && explicit.trim() !== "") {
    const rev = explicit.trim();
    if (!hasRef(rev)) throw new Error("基线 " + rev + " 不存在");
    return rev;
  }
  let branch = "";
  try {
    branch = git(["rev-parse", "--abbrev-ref", "HEAD"]).trim();
  } catch {
    branch = "";
  }
  if (branch !== "main") {
    try {
      const base = git(["merge-base", "HEAD", "main"]).trim();
      if (base !== "") return base;
    } catch {
      // 没有 main 分支：往下走。
    }
  }
  if (hasRef("origin/main")) return "origin/main";
  return "HEAD~1";
}

/** 改动集合：基线到工作区的差异，加上还没进版本库的新文件。 */
export function changedFiles(base: string): string[] {
  const tracked = git(["diff", "--name-only", base])
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");
  let untracked: string[] = [];
  try {
    untracked = git(["ls-files", "--others", "--exclude-standard"])
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line !== "");
  } catch {
    untracked = [];
  }
  return Array.from(new Set([...tracked, ...untracked])).sort();
}

/** 打印计划。返回打印出来的文本（测试要读它）。 */
function printPlan(
  files: string[],
  tasks: string[],
  hits: RuleHit[],
  imports: ImportHit[],
  failClosed: string
): string {
  const lines: string[] = [];
  lines.push("改动 " + files.length + " 个文件：");
  for (const file of files.slice(0, 20)) lines.push("  " + file);
  if (files.length > 20) lines.push("  …（还有 " + (files.length - 20) + " 个）");
  lines.push("");
  lines.push("命中的规则：");
  for (const hit of hits) {
    const shown = hit.files.slice(0, 3).join(", ");
    const more = hit.files.length > 3 ? " …（共 " + hit.files.length + " 个）" : "";
    lines.push("  " + hit.rule.id + " → " + hit.rule.tasks.join(" + ") + "  [" + shown + more + "]");
    lines.push("      为什么：" + hit.rule.why);
  }
  if (failClosed !== "") {
    lines.push("  import → 全量 check  [import 图解析失败：" + failClosed + "]");
  } else if (imports.length > 0) {
    lines.push("命中的反向依赖：");
    for (const hit of imports) {
      lines.push(
        "  import → " + hit.task + "  [" + hit.source + " 被 " + hit.script + " 直接 import]"
      );
    }
  }
  lines.push("");
  if (tasks.length === 0) {
    lines.push("没有要跑的门禁。");
  } else {
    lines.push("按顺序跑这 " + tasks.length + " 组门禁：");
    tasks.forEach((task, index) => lines.push("  " + (index + 1) + ". " + task));
  }
  const text = lines.join("\n");
  console.log(text);
  return text;
}

/** 跑一组门禁。第一个失败就停。 */
function runTasks(tasks: string[]): number {
  const done: { task: string; seconds: number }[] = [];
  const startedAll = Date.now();
  for (const task of tasks) {
    console.log("");
    console.log("── 跑 " + task + " ──");
    const started = Date.now();
    const result = spawnSync("mise", ["run", task], { cwd: ROOT, stdio: "inherit" });
    const seconds = (Date.now() - started) / 1000;
    done.push({ task, seconds });
    if (result.status !== 0) {
      console.log("");
      console.log("✗ " + task + " 没过（" + seconds.toFixed(1) + " 秒）。后面的组不跑了。");
      printSummary(done, (Date.now() - startedAll) / 1000);
      // status 为 null 表示被信号杀死，也算失败（原来落进这个分支只是类型不对）
      return result.status ?? 1;
    }
  }
  printSummary(done, (Date.now() - startedAll) / 1000);
  return 0;
}

/** 末尾的汇总：跑了哪几组、各多少秒、总耗时。 */
function printSummary(done: { task: string; seconds: number }[], total: number): void {
  console.log("");
  console.log("汇总：");
  for (const item of done) {
    console.log("  " + item.task + "  " + item.seconds.toFixed(1) + " 秒");
  }
  console.log("  共 " + done.length + " 组，总耗时 " + total.toFixed(1) + " 秒");
}

async function main(argv: string[]): Promise<number> {
  let plan = false;
  let baseArg: string | undefined;
  let filesArg: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--plan") plan = true;
    else if (arg === "--base") baseArg = argv[++i];
    else if (arg.startsWith("--base=")) baseArg = arg.slice("--base=".length);
    else if (arg === "--files") filesArg = argv[++i];
    else if (arg.startsWith("--files=")) filesArg = arg.slice("--files=".length);
    else {
      console.error("不认识的参数：" + arg);
      return 2;
    }
  }

  let files: string[];
  let base = "";
  if (filesArg !== undefined) {
    // 测试与实验用的注入点：假路径，不问 git。
    files = filesArg.split(",").map((line) => line.trim()).filter((line) => line !== "");
    base = baseArg !== undefined ? baseArg : "(注入的文件列表)";
  } else {
    try {
      base = resolveBase(baseArg);
    } catch (e) {
      console.error("取基线失败：" + ((e as Error).message || String(e)));
      return 2;
    }
    files = changedFiles(base);
  }

  if (files.length === 0) {
    console.log("没有改动（基线 " + base + "）。");
    return 0;
  }

  const hits = matchRules(files);
  let result: PlanResult;
  try {
    const toml = readFileSync(path.join(ROOT, "mise.toml"), "utf8");
    result = analyzePlan(files, toml, (script) => readFileSync(path.join(ROOT, script), "utf8"));
  } catch (e) {
    result = { tasks: ["check"], imports: [], failClosed: (e as Error).message || String(e) };
  }
  printPlan(files, result.tasks, hits, result.imports, result.failClosed);

  if (plan) return 0;
  if (result.tasks.length === 0) {
    console.log("");
    console.log("没有要跑的门禁。");
    return 0;
  }
  return runTasks(result.tasks);
}

const invokedDirectly =
  process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  process.exitCode = await main(process.argv.slice(2));
}
