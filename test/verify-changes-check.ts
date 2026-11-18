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
import path from "node:path";
import { fileURLToPath } from "node:url";

import { matchRules, planTasks } from "../tools/verify-changes.ts";

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
  "lib/router/handle.ts → check:routing + check:deliver",
  sameTasks(planTasks(["lib/router/handle.ts"]), ["check:routing", "check:deliver"])
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

console.log("");
if (fail === 0) {
  console.log("门禁选择器：" + pass + " 项全过。");
} else {
  console.log("门禁选择器：" + pass + " 项过，" + fail + " 项没过。");
  process.exitCode = 1;
}
