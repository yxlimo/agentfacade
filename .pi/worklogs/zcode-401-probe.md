# ZCode 401 静默缺陷

任务：ZCode 的令牌被上游拒了（401），面板却显示「凭据可用 + 额度区空白」。

根因（四步各自都没错，合起来把「凭据被拒」变成「不知道」）：

1. `lib/zcode/credits.ts` 的 `if (!r.ok) return null` —— 401 与「没问」「问不到」一起折成 null
2. `lib/kinds/zcode.ts` 的 `quota === null` → `quotas()` 返回 []，面板连卡片都不出现
3. `lib/zcode/auth.ts` 的 JWT 没有 exp → 只凭会话在不在，一律答 authenticated
4. `lib/provider-kinds.ts` 的凭据状态映射 → AUTHENTICATED

做法：

- 定义共用的探测结论形状 `VendorProbe<T>`（lib/provider-kinds.ts，kinds/shared.ts 再导出）
- `fetchZcodeQuota` / `zcodeQuota` 返回结论而不是 `ZcodeQuota | null`
- 快照里写整个结论（含 at 与会话的 loginAtMs）
- 凭据：unauthorized 且结论时刻晚于会话的 loginAtMs → EXPIRED（重登自动清红）
- 额度卡：unauthorized / failed / missing 各给一张说明卡，不再整片留白
- outOfCredits / recoverAt：三种非 ok 结论都不算用完、不给恢复时刻

## 步骤

- 读代码，定型 `VendorProbe`（放在 lib/provider-kinds.ts：它是注册表的词汇表，
  厂商模块（lib/zcode/credits.ts）也要说同一套话，从 kinds/shared.ts 反向依赖
  是朝上依赖）
- 改 `lib/zcode/credits.ts`：401/403 → unauthorized，其余失败 → failed，没会话 →
  missing，200 + code 0 → ok（空桶仍是 ok = 用完）
- 改 `lib/admin/upstreams.ts`：快照里存整个结论 + 会话的 loginAtMs
- 改 `lib/kinds/zcode.ts`：卡片、用尽、恢复时刻、凭据状态
- 改 `lib/kinds/shared.ts`：`sessionSlot` 多一个 `refused` 钩子（厂商 kind 自己
  判断「上游拒了现在这一把」），`sessionOnlyPlan` 把它传下去
- 补 `test/zcode-quota-check.ts`：假上游（401/403/500/断连/超时/业务码/空桶/有桶）
  + 读快照的规则 + 凭据那一头 + 凭据行
- 反证：把 `fetchZcodeQuota` 临时改回 `return null` 的旧行为 → 12 项红；
  改回来 → 49 项全过

## 交付记录

### 改了哪些文件

- `lib/provider-kinds.ts`：`VendorProbe<T>` 与它的四个造法、两个读法；快照里
  zcode 那一桶多一个 `loginAtMs`
- `lib/kinds/shared.ts`：再导出 `VendorProbe` 那一套；`sessionSlot` 多一个
  `refused` 钩子，`sessionOnlyPlan` 把它传下去
- `lib/zcode/credits.ts`：`fetchZcodeQuota` / `zcodeQuota` 返回结论；超时可配
  （`ZCODE_QUOTA_TIMEOUT_MS`，默认 20 秒 —— 为了能在测试里等一次超时）
- `lib/zcode/auth.ts`：新增 `zcodeLoginAtMs`
- `lib/admin/upstreams.ts`：zcode 那一支把结论整体写进快照（含 loginAtMs）
- `lib/kinds/zcode.ts`：卡片 / 用尽 / 恢复时刻 / 凭据状态都按结论走
- `test/zcode-quota-check.ts`：重写成四种结论的规则 + 假上游 + 凭据那一头
- `test/quota-readout-check.ts`：跟着新的返回形状改

### 验证

- `mise run test:zcode:quota` → 全部通过（49 项）
- `mise run check:kinds` → exit 0
- `mise run check:admin` → exit 0
- `mise run check` → exit 0（各段 pass 合计 2431、fail=0）
- 反证：旧行为下 `test:zcode:quota` 12 项红（输出见交付报告）
- `mise run privacy --all` → 744 个文件、0 条命中

### 未决

- minimax / qoder / workbuddy 还没用 `VendorProbe`：那是另一张单。这张单只把
  形状与用法立好（`VendorProbe` + `vendorOk/vendorUnauthorized/vendorFailed/
  vendorMissing` + `vendorProbeOf`），照着套即可。
- 平台的可用性（`lib/admin/platform-state.ts`）走的是账号的凭据行：被拒 →
  EXPIRED → 平台状态 `credential_expired`（不是绿）。`failed`（5xx、超时）不动
  凭据 —— 上游挂掉不是凭据的毛病。
