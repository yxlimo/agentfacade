// test/verify-changes-check.ts — 门禁选择器自己的语义。
//
//   node --experimental-strip-types test/verify-changes-check.ts
//
// Offline: 规则表是纯函数，这里不跑任何门禁，也不碰网络。CLI 的「计划打印」
// 用 --files 注入假路径来验，不去改生产路径。
//
// 最重要的一条是 web/src/** → check:web + check:panel：2026-11-xx 面板文案改动
// 只跑了单测，面板 e2e 里断言旧文案的用例红着没人知道。check:web 不启浏览器，
// 所以改前端必须带上 check:panel。

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  analyzePlan,
  matchRules,
  parseGateTests,
  parseTomlTasks,
  planTasks,
} from "../tools/verify-changes.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

let pass = 0;
let fail = 0;

function check(name: string, ok: boolean, detail = ""): void {
  if (ok) {
    pass++;
    console.log(`  ok   ${name}`);
  } else {
    fail++;
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

/** 任务清单相等（顺序也相等）。 */
function sameTasks(actual: string[], expected: string[]): boolean {
  return actual.length === expected.length && actual.every((task, i) => task === expected[i]);
}

/** 跑脚本的 --plan 模式，拿它的输出。 */
function planOutput(files: string[]): string {
  const script = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../tools/verify-changes.ts");
  return execFileSync(
    process.execPath,
    ["--experimental-strip-types", script, "--plan", "--files", files.join(",")],
    { encoding: "utf8" }
  );
}

console.log("门禁选择器：");

check(
  "lib/kinds/zcode.ts → 只有 check:kinds",
  sameTasks(planTasks(["lib/kinds/zcode.ts"]), ["check:kinds"])
);

check(
  "web/src/features/balance/quota.tsx → check:web + check:panel（今天事故的回归测试）",
  sameTasks(planTasks(["web/src/features/balance/quota.tsx"]), ["check:web", "check:panel"])
);

check(
  "proto/x.proto → proto、check:admin、check:web",
  sameTasks(planTasks(["proto/x.proto"]), ["proto", "check:admin", "check:web"])
);

check("pnpm-lock.yaml → 全量 check", sameTasks(planTasks(["pnpm-lock.yaml"]), ["check"]));

check("README.md → 只有 privacy", sameTasks(planTasks(["README.md"]), ["privacy"]));

check("mise.toml → check:misc", sameTasks(planTasks(["mise.toml"]), ["check:misc"]));

// ── smoke.sh 里跑的脚本必须有 mise 任务 ──
//
// 2026-11-xx 的事故：test/workbuddy-check.ts 只在 smoke.sh 里跑，mise 里没有
// 任务，反向依赖图建不到它。verify 因此选了 admin/routing/kinds/misc 全绿，
// 六分钟后的 check 才在 workbuddy-check 的断言上红。守门的判据故意只限于
// smoke.sh —— 别的脚本有各自的入口，不该被这条管到。

const smokeText = readFileSync(path.join(ROOT, "test/smoke.sh"), "utf8");
// 只抓「直接跑这个脚本」的行：test/serve.ts 是 smoke.sh 起的网关进程，
// 后面跟着 --mock 等参数，它不是测试任务，也进不了反向依赖图。
const smokeScripts = Array.from(
  smokeText.matchAll(/(?:^|[^\w./-])node\s+--experimental-strip-types\s+(test\/[\w./-]+\.ts)\s*$/gm),
  (m) => m[1]
);
const miseText = readFileSync(path.join(ROOT, "mise.toml"), "utf8");
const tasks = parseTomlTasks(miseText);
const scriptsWithTask = new Set(
  tasks.filter((task) => task.name.startsWith("test:")).map((task) => /(test\/[\w./-]+\.ts)/.exec(task.run)?.[1] ?? "")
);
check(
  "smoke.sh 里调的脚本非空（守门用例本身没瞎解析）",
  smokeScripts.length > 0,
  JSON.stringify(smokeScripts)
);
for (const script of smokeScripts) {
  check(
    `${script} 在 mise.toml 里有 test:* 任务`,
    scriptsWithTask.has(script),
    `smoke.sh 里跑了它，但反向依赖图看不到它`
  );
}

check(
  "不认识的路径 → 全量 check",
  sameTasks(planTasks(["weird/thing.bin"]), ["check"])
);

check(
  "混装 → 并集，且顺序稳定",
  sameTasks(planTasks(["lib/zcode/x.ts", "web/src/y.tsx"]), ["check:kinds", "check:web", "check:panel"]) &&
    sameTasks(planTasks(["lib/zcode/x.ts", "web/src/y.tsx"]), planTasks(["lib/zcode/x.ts", "web/src/y.tsx"]))
);

check(
  "命中全量后其余不列（依赖 + 业务代码 → 只有 check）",
  sameTasks(planTasks(["pnpm-lock.yaml", "lib/kinds/zcode.ts"]), ["check"])
);

check(
  "lib/router/handle.ts → check:routing + check:deliver + check:admin（admin 的测试也直接 import 它）",
  sameTasks(planTasks(["lib/router/handle.ts"]), [
    "check:admin",
    "check:routing",
    "check:deliver",
  ])
);

check(
  "web/e2e/tests/x.spec.ts → check:web + check:panel",
  sameTasks(planTasks(["web/e2e/tests/x.spec.ts"]), ["check:web", "check:panel"])
);

check(
  "lib/admin/api/x.ts → check:admin",
  sameTasks(planTasks(["lib/admin/api/x.ts"]), ["check:admin"])
);

check(
  "tools/verify-changes.ts → check:misc",
  sameTasks(planTasks(["tools/verify-changes.ts"]), ["check:misc"])
);

check(
  "lib/workbuddy/resources.ts → check:kinds + check:misc（workbuddy-check 反向依赖漏组的事故）",
  planTasks(["lib/workbuddy/resources.ts"]).includes("check:misc"),
  planTasks(["lib/workbuddy/resources.ts"]).join(", ")
);

const workbuddyOutput = planOutput(["lib/workbuddy/resources.ts"]);
check(
  "计划里说清是哪条 test:* 任务把 check:misc 拉进来的",
  workbuddyOutput.includes("test/workbuddy-check.ts") &&
    workbuddyOutput.includes("经 test:workbuddy]") &&
    workbuddyOutput.includes("check:misc"),
  workbuddyOutput.trim()
);

// ── 面板 e2e 用例在仓库根的 tests/，不在 web/e2e/ ──

check(
  "tests/panel-balance.e2e.ts → check:panel（不许落进 unknown）",
  sameTasks(planTasks(["tests/panel-balance.e2e.ts"]), ["check:panel"])
);

check(
  "tests/panel.ts → check:panel",
  sameTasks(planTasks(["tests/panel.ts"]), ["check:panel"])
);

check(
  "tests/** 不与 test/** 合并（两者都是目录，归属不同）",
  sameTasks(planTasks(["test/x.ts"]), ["check:misc"]) &&
    sameTasks(planTasks(["tests/x.ts"]), ["check:panel"])
);

// ── 仓库根的配置类文件 → misc，不要拉全量 ──

check(
  ".gitignore → check:misc（不许全量）",
  sameTasks(planTasks([".gitignore"]), ["check:misc"])
);

check(
  "根配置类文件都归 misc",
  sameTasks(planTasks([".dockerignore", ".editorconfig", ".prettierrc.json"]), ["check:misc"])
);

// ── 规则命中重叠时，计划里不要把同一批文件打两行 ──

const webSrcOutput = planOutput(["web/src/x.tsx"]);
// 只数「命中的规则」那些行：一条规则算一次，两条规则会打两行一样的话。
const panelRuleLines = webSrcOutput
  .split("\n")
  .filter((line) => line.includes("check:web + check:panel"));
check(
  "web/src/x.tsx → 计划里 web 规则只出现一次（不因两条规则重复）",
  panelRuleLines.length === 1 && !webSrcOutput.includes("web-other"),
  "重复行 " + panelRuleLines.length + " 行"
);

const panelE2eOutput = planOutput(["tests/panel-balance.e2e.ts"]);
check(
  "tests/panel-balance.e2e.ts 的计划里没有 unknown",
  !panelE2eOutput.includes("unknown") && panelE2eOutput.includes("check:panel"),
  panelE2eOutput.trim()
);

const gitignoreOutput = planOutput([".gitignore"]);
check(
  ".gitignore 的计划里没有落到全量 check",
  !gitignoreOutput.includes("unknown") && gitignoreOutput.includes("check:misc"),
  gitignoreOutput.trim()
);

// ── CLI 的计划打印 ──

const emptyOutput = planOutput([]);
check("空改动 → 打印「没有改动」", emptyOutput.includes("没有改动"), emptyOutput.trim());

const webOutput = planOutput(["web/src/features/balance/quota.tsx"]);
check(
  "计划里 web/src 的改动会说明为什么要跑 e2e",
  webOutput.includes("面板 e2e 断言的是用户可见文案"),
  webOutput.trim()
);
check(
  "计划里列出要跑的门禁，且 check:panel 在其中",
  webOutput.includes("check:panel"),
  webOutput.trim()
);

const first = planOutput(["lib/zcode/x.ts", "web/src/y.tsx"]);
const second = planOutput(["lib/zcode/x.ts", "web/src/y.tsx"]);
check("同一输入两次输出一致", first === second);

// ── 反向依赖：测试脚本直接 import 了改动文件，脚本所在的门禁也要跑 ──
//
// 事故复盘：2026-11-19 清 lib/router/catalog.ts 的死导出，当时
// test/sensenova-intern-ai-check.ts（check:kinds）直接 import 了它；路径规则
// 只选了 admin + routing，check:kinds 没选上，坏掉的 import 没被任何门禁看见。
// 现在那个测试已经改成 import lib/catalog-models.ts，所以用一份合成的
// mise.toml 复现事故当时的形状 —— 规则靠解析 mise.toml，不靠手抄清单。

const incidentToml = `
[tasks."check:kinds"]
depends = ["test:sensenova:intern"]

[tasks."test:sensenova:intern"]
run = "node --experimental-strip-types test/sensenova-intern-ai-check.ts"

[tasks."check:misc"]
depends = ["test:verify"]

[tasks."test:verify"]
run = "node --experimental-strip-types test/verify-changes-check.ts"
`;

const incidentScripts: Record<string, string> = {
  // 静态、动态、side-effect 三种 import 都在这条规则里。
  "test/sensenova-intern-ai-check.ts": [
    'import { x } from "../lib/sensenova/quota.ts";',
    'const { senseNovaCatalogModels } = await import("../lib/router/catalog.ts");',
  ].join("\n"),
  "test/verify-changes-check.ts": 'import { planTasks } from "../tools/verify-changes.ts";',
};

function incidentPlan(files: string[]) {
  return analyzePlan(files, incidentToml, (script) => incidentScripts[script] ?? "");
}

const incident = incidentPlan(["lib/router/catalog.ts"]);
check(
  "lib/router/catalog.ts → check:kinds（昨天漏掉的 case）",
  incident.tasks.includes("check:kinds"),
  incident.tasks.join(", ")
);
check(
  "来路说清是哪个脚本直接 import 了它",
  incident.imports.some(
    (hit) =>
      hit.task === "check:kinds" &&
      hit.source === "lib/router/catalog.ts" &&
      hit.script === "test/sensenova-intern-ai-check.ts"
  ),
  JSON.stringify(incident.imports)
);

const noImport = incidentPlan(["lib/router/never-imported-by-a-test.ts"]);
check(
  "没有任何测试直接 import 的文件只按路径规则选组，不被反向依赖污染",
  sameTasks(noImport.tasks, ["check:routing"]) && noImport.imports.length === 0,
  noImport.tasks.join(", ")
);

const broken = analyzePlan(["lib/router/catalog.ts"], "[tasks.\"check:kinds\"]\ndepends = [\"nope\"]", () => "");
check(
  "mise.toml 解析不出测试脚本 → 退回全量 check（不当成没有依赖）",
  sameTasks(broken.tasks, ["check"]) && broken.failClosed !== "",
  JSON.stringify(broken)
);
check(
  "一个门禁都没解析出来也算解析失败",
  sameTasks(
    analyzePlan(["lib/router/catalog.ts"], "[tasks.test]\nrun = \"x\"", () => "").tasks,
    ["check"]
  )
);
let parseThrew = false;
try {
  parseGateTests("not toml at all", () => "");
} catch {
  parseThrew = true;
}
check("解析函数本身对坏输入抛错，而不是返回空图", parseThrew);

const realCatalogOutput = planOutput(["lib/router/handle.ts"]);
check(
  "真实 mise.toml 的计划里有 import → 门禁的来路说明",
  /import → check:[a-z]+\s+\[[^\]]+ 被 test\/[^ ]+ 直接 import，经 test:[^ ]+\]/.test(realCatalogOutput),
  realCatalogOutput.trim()
);

console.log("");
if (fail === 0) {
  console.log("门禁选择器：" + pass + " 项全过。");
} else {
  console.log("门禁选择器：" + pass + " 项过，" + fail + " 项没过。");
  process.exitCode = 1;
}
