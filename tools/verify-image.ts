// tools/verify-image.ts — 证明「镜像里到底是哪份代码」。
//
//   node --experimental-strip-types tools/verify-image.ts [tag]
//
// 为什么有这个东西：以前「镜像里是不是有我刚改的那段代码」靠手敲几条 grep，
// 换一批字符串，检查强度就跟着心情漂。这个脚本把那件事固定下来：构建之后跑
// 一遍，答案只有两种 —— 这个镜像确实是这份提交构建出来的，或者不是。
//
// 它查什么：容器 CLI 在不在、工作区干净不干净、镜像在不在、镜像的提交号与版本
// 号跟仓库对不对得上、面板的产物完整不完整、容器起不起来、/health 与
// /admin/ 答不答。任何一条不过就非零退出，并说一句能直接看懂的中文原因。
//
// 它不查什么：镜像有没有推到 registry（那要网络与凭据，不是这里的事）。
//
// 边界：只用 node 内置模块与容器 CLI 命令行，不装新依赖；测试数据一律落在
// /tmp 下并收尾删掉，绝不碰 /data 与 /mnt/data，也不在主目录里留东西。

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** 默认的镜像 tag。 */
const DEFAULT_TAG = "localhost/buddy-proxy:latest";

/**
 * 容器 CLI 的可执行文件名。默认 podman（本机）；CI 里跑 docker，用
 * CONTAINER_CLI=docker 指定。docker 与 podman 的 image inspect / inspect
 * --format / run / rm -f 子命令形状一致，所以这里只换名字，不写两套逻辑。
 */
const CLI = (process.env.CONTAINER_CLI || "").trim() || "podman";

/** 仓库根目录：这个脚本在 tools/ 下面。 */
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** 镜像里的工作目录（Dockerfile 的 WORKDIR）。 */
const APP_DIR = "/app";

/** 面板产物在镜像里的位置。 */
const PANEL_DIR = APP_DIR + "/web/dist";

/** 容器里的数据目录：临时的，不碰 /data。 */
const CONTAINER_DATA_DIR = "/tmp/verify-data";

/** 起容器之后等 /health 的上限（毫秒）。 */
const HEALTH_TIMEOUT_MS = 30000;

/** 一条检查没过。带着这句退出。 */
class CheckFailure extends Error {}

interface RunResult {
  ok: boolean;
  out: string;
  err: string;
  /** 命令本身不存在（不是它跑失败了）。 */
  missing: boolean;
}

/** 跑一条命令，stdout 与 stderr 都拿回来，不抛。 */
function tryRun(cmd: string, args: string[], cwd?: string): RunResult {
  const result = spawnSync(cmd, args, { encoding: "utf8", cwd });
  if (result.error) {
    const code = (result.error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return { ok: false, out: "", err: "", missing: true };
    return { ok: false, out: "", err: result.error.message, missing: false };
  }
  return {
    ok: result.status === 0,
    out: result.stdout || "",
    err: (result.stderr || "").trim(),
    missing: false,
  };
}

/** 一次 GET：状态码与正文。不用 fetch：它把连接留在池里，进程退不出去。 */
function get(url: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const request = http.get(url, { agent: new http.Agent({ keepAlive: false }) }, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk: string) => {
        body += chunk;
      });
      response.on("end", () => resolve({ status: response.statusCode || 0, body }));
    });
    request.on("error", reject);
    request.setTimeout(5000, () => {
      request.destroy(new Error("请求超时"));
    });
  });
}

/** 1. 容器 CLI 在不在：这台机器没有它就什么都验不了。 */
function checkCli(): string {
  const result = tryRun(CLI, ["version", "--format", "{{.Client.Version}}"]);
  if (result.missing) {
    throw new CheckFailure("找不到容器 CLI：" + CLI + "，可以用 CONTAINER_CLI 指定");
  }
  if (!result.ok) {
    throw new CheckFailure(CLI + " 装了，但连不上它的服务：" + (result.err || "没有更多说明"));
  }
  return CLI + " 可用";
}

/** 2. 工作区干净不干净：镜像里不该有不属于任何提交的代码。 */
function checkWorktreeClean(): string {
  const result = tryRun("git", ["status", "--porcelain"], ROOT);
  if (!result.ok) throw new CheckFailure("读不到 git 状态：" + (result.err || "没有更多说明"));
  const dirty = result.out.trim();
  if (dirty !== "") {
    throw new CheckFailure(
      "工作区不干净，镜像里会是不存在于任何提交的代码。先提交（或 stash）再构建：\n" + dirty
    );
  }
  return "工作区干净";
}

/** 3. 镜像在不在。 */
function inspectImage(tag: string): Record<string, unknown> {
  const result = tryRun(CLI, ["image", "inspect", tag]);
  if (!result.ok) throw new CheckFailure("镜像 " + tag + " 不在本机，先构建它");
  let parsed: unknown;
  try {
    parsed = JSON.parse(result.out);
  } catch {
    throw new CheckFailure(CLI + " image inspect 的输出不是 JSON，看不懂");
  }
  const image = Array.isArray(parsed) ? parsed[0] : parsed;
  if (!image || typeof image !== "object") {
    throw new CheckFailure(CLI + " image inspect 没有给出镜像信息");
  }
  return image as Record<string, unknown>;
}

/** 镜像上的一个 label。 */
function labelOf(image: Record<string, unknown>, key: string): string {
  const labels = image["Labels"];
  if (!labels || typeof labels !== "object") return "";
  const value = (labels as Record<string, unknown>)[key];
  return typeof value === "string" ? value : "";
}

/** 4. 身份：镜像的提交号必须就是仓库的 HEAD。 */
function checkRevision(image: Record<string, unknown>): string {
  const result = tryRun("git", ["rev-parse", "HEAD"], ROOT);
  if (!result.ok) throw new CheckFailure("读不到 HEAD：" + (result.err || "没有更多说明"));
  const head = result.out.trim();
  const label = labelOf(image, "org.opencontainers.image.revision");
  if (label !== head) {
    throw new CheckFailure(
      "镜像不是这份提交构建出来的：镜像的 revision 是 " + (label || "（没有这个 label）") +
        "，仓库的 HEAD 是 " + head
    );
  }
  return "提交号一致：" + head;
}

/** 5. 版本：label、镜像里的 package.json、仓库的 package.json 三处要一样。 */
function checkVersion(image: Record<string, unknown>, tag: string): string {
  let repoVersion = "";
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")) as Record<string, unknown>;
    repoVersion = String(pkg.version ?? "");
  } catch {
    throw new CheckFailure("读不到仓库的 package.json");
  }
  const label = labelOf(image, "org.opencontainers.image.version");
  let imageVersion = "";
  try {
    const pkg = JSON.parse(readImageFile(tag, APP_DIR + "/package.json")) as Record<string, unknown>;
    imageVersion = String(pkg.version ?? "");
  } catch (e) {
    if (e instanceof CheckFailure) throw e;
    imageVersion = "";
  }
  if (label !== repoVersion || imageVersion !== repoVersion) {
    throw new CheckFailure(
      "版本对不上：镜像的 version label 是 " + (label || "（没有这个 label）") +
        "，镜像里的 package.json 是 " + (imageVersion || "（读不到）") +
        "，仓库的 package.json 是 " + repoVersion
    );
  }
  return "版本一致：" + repoVersion;
}

/** 读镜像里的一个文件。 */
function readImageFile(tag: string, file: string): string {
  const result = tryRun(CLI, ["run", "--rm", "--pull=never", "--entrypoint", "cat", tag, file]);
  if (!result.ok) {
    throw new CheckFailure("镜像里没有 " + file + "：" + (result.err || "没有更多说明"));
  }
  return result.out;
}

/** 6. 面板产物：index.html 在，它引用的资源也得在（防半截面板）。 */
function checkPanel(tag: string): string {
  const html = readImageFile(tag, PANEL_DIR + "/index.html");
  const pattern = new RegExp("assets/[A-Za-z0-9._-]+", "g");
  const refs = new Set<string>();
  let match = pattern.exec(html);
  while (match !== null) {
    refs.add(match[0]);
    match = pattern.exec(html);
  }
  if (refs.size === 0) {
    throw new CheckFailure("镜像里的面板 index.html 没有引用任何 assets/ 资源，面板是空的");
  }
  const listed = tryRun(CLI, ["run", "--rm", "--pull=never", "--entrypoint", "ls", tag, PANEL_DIR + "/assets"]);
  const names = new Set(
    (listed.ok ? listed.out : "")
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line !== "")
  );
  const missing: string[] = [];
  for (const ref of refs) {
    const base = ref.slice(ref.lastIndexOf("/") + 1);
    if (!names.has(base)) missing.push(base);
  }
  if (missing.length > 0) {
    throw new CheckFailure(
      "镜像里的面板是半截的：index.html 引用了这些资源，但镜像里没有：" + missing.join(", ")
    );
  }
  return "面板产物完整：index.html 与 " + refs.size + " 个资源都在镜像里";
}

/** 7. 起容器：/health 与 /admin/ 都要答。 */
async function checkRuns(tag: string): Promise<string> {
  const port = await freePort();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "buddy-verify-"));
  // 容器里的运行用户要能写这个目录：它挂进去当数据目录用。
  fs.chmodSync(dataDir, 0o777);
  const name = "buddy-proxy-verify-" + process.pid + "-" + Date.now();
  try {
    const started = tryRun(CLI, [
      "run", "-d", "--name", name, "--pull=never",
      "-p", "127.0.0.1:" + port + ":6450",
      "-e", "ROUTER_PORT=6450",
      "-e", "BUDDY_DATA_DIR=" + CONTAINER_DATA_DIR,
      "-v", dataDir + ":" + CONTAINER_DATA_DIR,
      tag,
    ]);
    if (!started.ok) {
      throw new CheckFailure("镜像起不来：" + (started.err || "没有更多说明"));
    }
    const health = await waitForHealth(port, name);
    if (health["status"] !== "ok") {
      throw new CheckFailure("/health 的 status 不是 ok，是 " + JSON.stringify(health["status"]));
    }
    const dialects = health["dialects"];
    if (!Array.isArray(dialects) || dialects.length === 0) {
      throw new CheckFailure("/health 没有报出 dialects");
    }
    const providers = health["providers"];
    if (!Array.isArray(providers) || providers.length === 0) {
      throw new CheckFailure("/health 没有报出 providers");
    }
    const panel = await get("http://127.0.0.1:" + port + "/admin/");
    if (panel.status !== 200) {
      throw new CheckFailure("镜像里的面板没有被服务起来：GET /admin/ 返回 " + panel.status);
    }
    return "容器起来了：/health 正常，/admin/ 返回 200";
  } finally {
    // 收尾不留东西：容器与临时目录都删掉。
    tryRun(CLI, ["rm", "-f", name]);
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
}

/** 轮询 /health，直到它答 200、容器死了，或者超时。 */
async function waitForHealth(port: number, name: string): Promise<Record<string, unknown>> {
  const deadline = Date.now() + HEALTH_TIMEOUT_MS;
  const url = "http://127.0.0.1:" + port + "/health";
  let last = "还没有试过";
  while (Date.now() < deadline) {
    const running = tryRun(CLI, ["inspect", "-f", "{{.State.Running}}", name]);
    if (running.ok && running.out.trim() !== "true") {
      const logs = tryRun(CLI, ["logs", "--tail", "20", name]);
      throw new CheckFailure("容器起来就退了。它的日志：\n" + (logs.out || logs.err || "（没有日志）"));
    }
    let response: { status: number; body: string } | null = null;
    try {
      response = await get(url);
    } catch (e) {
      last = "连不上 /health：" + ((e as Error).message || "不知道");
    }
    if (response !== null) {
      if (response.status === 200) {
        try {
          return JSON.parse(response.body) as Record<string, unknown>;
        } catch {
          throw new CheckFailure("/health 的正文不是 JSON");
        }
      }
      last = "/health 返回 " + response.status;
    }
    await sleep(500);
  }
  throw new CheckFailure(
    "等了 " + Math.round(HEALTH_TIMEOUT_MS / 1000) + " 秒，/health 还没正常：" + last
  );
}

/** 一个当前没人占的端口。写死端口会撞上别的服务。 */
function freePort(): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const server = net.createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = address && typeof address === "object" ? address.port : 0;
      server.close(() => {
        if (port === 0) reject(new Error("拿不到空闲端口"));
        else resolve(port);
      });
    });
  });
}

/** 等一会儿。 */
function sleep(ms: number): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

async function main(argv: string[]): Promise<number> {
  const tag = argv[0] && argv[0].trim() !== "" ? argv[0].trim() : DEFAULT_TAG;
  const notes: string[] = [];
  try {
    notes.push(checkCli());
    notes.push(checkWorktreeClean());
    const image = inspectImage(tag);
    notes.push(checkRevision(image));
    notes.push(checkVersion(image, tag));
    notes.push(checkPanel(tag));
    notes.push(await checkRuns(tag));
  } catch (e) {
    console.error("✗ 验证失败：" + ((e as Error).message || String(e)));
    for (const note of notes) console.error("  ✓ " + note);
    return 1;
  }
  for (const note of notes) console.log("✓ " + note);
  console.log("镜像 " + tag + " 验证通过。");
  return 0;
}

process.exitCode = await main(process.argv.slice(2));
