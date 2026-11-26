import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Plus, Trash2 } from 'lucide-react'
import { create } from '@bufbuild/protobuf'
import {
  PublishedModelSchema,
  PublishedTargetSchema,
  type PublishedModel,
  type PublishedTarget,
} from '@/gen/agentfacade/admin/v1/admin_pb'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { DragSortList } from '@/components/drag-sort-list'
import { ModelPicker } from '@/features/models/model-picker'
import { GroupPicker } from '@/features/models/group-picker'
import { intFieldProblem, MAX_INT32 } from '@/lib/int-field'
import i18n from '@/lib/i18n'

/**
 * 整数格子的判据仍在 lib/int-field 那份；这里只把那半句话翻成面板语言。
 * 认不出的原文原样透出（那句话不是面板写的）。
 */
function translatedIntProblem(text: string): string | null {
  const problem = intFieldProblem(text)
  if (problem === null) return null
  if (problem === '要填整数') return i18n.t('models.intNeedInteger')
  if (problem === '不能是负数') return i18n.t('models.intNotNegative')
  if (problem === `不能超过 ${MAX_INT32}`) {
    return i18n.t('models.intExceedsMax', { max: MAX_INT32 })
  }
  return problem
}
import { newUid } from '@/lib/uid'
import { cn } from '@/lib/utils'

/**
 * 三个取值：继承上游的、自己指定开、自己指定关。
 *
 * 契约里上下文长度、输出上限、是否思考、是否工具都是 optional 的：
 * 不给就是继承目标的值，给了就是用这个值。以前面板把它们当普通值处理，
 * 编辑一次就把「继承」写死成了具体数字。
 */
type TriState = 'inherit' | 'yes' | 'no'

type ModelDraft = {
  id: string
  displayName: string
  enabled: boolean
  strategy: string
  contextWindow: string
  contextWindowInherit: boolean
  maxOutputTokens: string
  maxOutputTokensInherit: boolean
  /** 现算出来的值：继承时显示它，开关照旧是继承。 */
  effectiveContextWindow?: number
  effectiveMaxOutputTokens?: number
  reasoning: TriState
  toolCall: TriState
  effortOptions: string
  /**
   * 目标的先后与权重。
   *
   * single / fallback 下位次就是优先级：权重不存草稿，拖动一改位置，保存时按新的
   * 位次重算。balance 下权重是份额（越大分到的会话越多），由用户手填，与位次无关
   * ——顺序那套仍然保留，它决定的是「先问谁」，不是份额。
   *
   * 两种策略下同一个字段含义不同，所以草稿里存的是「可空的权重」：`null` 就是
   * 「按位次推导」，切回 single / fallback 时一律回到 null，balance 填的份额不跨
   * 策略留着。
   */
  targets: {
    /** 草稿内的行标识：排序的 FLIP 过渡靠它对号，不发给后端。 */
    uid: string
    groupName: string
    upstreamModel: string
    /** 手填的权重（balance 下是份额）；null = 按位次推导。 */
    weight: number | null
    /** 权重那格的原文：空、小数、负号都得能摆出来，才能提示是哪一种错。 */
    weightText: string
  }[]
}

function emptyTarget() {
  return {
    groupName: '',
    upstreamModel: '',
    uid: newUid(),
    // 新行还没有权重：balance 下等位次定了面板自己填（切策略或这一行填全时），
    // single / fallback 下压根没有这一格。
    weight: null,
    weightText: '',
  }
}

/**
 * 位次推导出来的权重：第 index 个目标（共 total 个）。
 *
 * single / fallback 下位次就是优先级，权重一律这么算 —— 后端按权重从大到小试目标
 * （读表 `ORDER BY ... weight DESC`，保存时也按权重从大到小排），proto 里写的是
 * 「权重：大的先试」。所以排在最上面的拿最大的权重，往下依次小一个。
 *
 * balance 下它只是个缺省：那里权重是份额，由用户手填，位次只决定「先问谁」。
 */
export function targetWeight(index: number, total: number): number {
  return total - index
}

/**
 * 保存时这一行用哪个权重。
 *
 * balance 下权重是份额，用草稿里填的那个（7 就是 7，与位次无关）；草稿里是 null
 * （还没填）就退回位次 —— null 本来就是「按位次推导」的意思。single / fallback 下
 * 位次就是优先级，一律由位次推导，草稿里填过什么都不算数（那两个策略下没有这一格）。
 */
export function resolvedWeight(
  target: { weight: number | null },
  index: number,
  filledCount: number,
  strategy: string
): number {
  if (strategy === 'balance') {
    return target.weight ?? targetWeight(index, filledCount)
  }
  return targetWeight(index, filledCount)
}

/**
 * balance 下权重那格填的原文哪里不对；没问题返回 null。
 *
 * 空、小数、0、负数都拦下：后端拿 `weight > 0` 过滤，权重 0 等于把这一行丢掉，
 * 小数则根本存不进 int32。三句提示是同一件事（不是大于 0 的整数），所以这里只在
 * 「有没有毛病」上分。
 */
function weightProblem(text: string): string | null {
  const trimmed = text.trim()
  const value = Number(trimmed)
  if (trimmed === '' || !Number.isInteger(value) || value < 1) {
    return i18n.t('models.weightInvalid')
  }
  return null
}

/** 权重那格的原文 → 数字；不合法就是 null（草稿里 null 表示「按位次推导」）。 */
function parsedWeight(text: string): number | null {
  if (weightProblem(text) !== null) return null
  return Number(text.trim())
}

/** 一行的目标填全了没有。 */
function targetFilled(target: ModelDraft['targets'][number]): boolean {
  return target.groupName.trim() !== '' && target.upstreamModel.trim() !== ''
}

/**
 * 判重按组合（平台, 上游模型），不按单个字段：
 * 同一个平台上挂两个不同的模型、或者同一个模型挂在两个平台上，都是正常的。
 */
function targetKey(groupName: string, upstreamModel: string): string {
  return `${groupName.trim()}\u0000${upstreamModel.trim()}`
}

/**
 * 组合重复的行：行号 → 这个组合第一次出现在第几行（从 1 数，给用户看）。
 *
 * 只标后面那几行：用户看到的错是「这一行和上面某一行撞了」。
 * 后端建表时 (model_id, group_name, upstream_model) 是主键，撞了存不下，
 * 所以这种草稿根本没出门的必要。
 */
function duplicateTargets(targets: ModelDraft['targets']): Map<number, number> {
  const seen = new Map<string, number>()
  const duplicated = new Map<number, number>()
  targets.forEach((target, index) => {
    if (!targetFilled(target)) return
    const key = targetKey(target.groupName, target.upstreamModel)
    const first = seen.get(key)
    if (first === undefined) {
      seen.set(key, index)
      return
    }
    duplicated.set(index, first)
  })
  return duplicated
}

export function toDraft(model: PublishedModel | undefined): ModelDraft {
  if (!model) {
    return {
      id: '',
      displayName: '',
      enabled: true,
      strategy: 'single',
      contextWindow: '',
      contextWindowInherit: true,
      maxOutputTokens: '',
      maxOutputTokensInherit: true,
      reasoning: 'inherit',
      toolCall: 'inherit',
      effortOptions: '',
      targets: [emptyTarget()],
    }
  }
  return {
    id: model.id,
    displayName: model.displayName,
    enabled: model.enabled,
    strategy: model.strategy || 'single',
    // 服务端回的是库里存的那个：空就是继承。
    // effective 里是现算的值 —— 继承时界面上要显示它，但开关不能因为它
    // 变成「不继承」：那会把继承写死成具体数字。
    contextWindow:
      model.contextWindow === undefined ? '' : String(model.contextWindow),
    contextWindowInherit: model.contextWindow === undefined,
    maxOutputTokens:
      model.maxOutputTokens === undefined
        ? ''
        : String(model.maxOutputTokens),
    maxOutputTokensInherit: model.maxOutputTokens === undefined,
    effectiveContextWindow: model.effective?.contextWindow,
    effectiveMaxOutputTokens: model.effective?.maxOutputTokens,
    reasoning: toTriState(model.reasoning),
    toolCall: toTriState(model.toolCall),
    effortOptions: model.effortOptions.join(', '),
    // 服务端回的目标已经按权重从大到小排好，读进来就是界面上要显示的先后。
    // 目标上的 enabled 不读了：面板没有这个开关，保存时一律写开。
    //
    // balance 下权重是份额，原样读进草稿（库里是 7 就还是 7）：用户填过的份额不能
    // 一开一关就丢掉。single / fallback 下权重由位次推导，草稿里留 null —— 那时候
    // 服务端那串是优先级，摆进 balance 的输入框会被当成份额，是另一回事。
    targets: model.targets.map((target) => {
      const filledWeight = model.strategy === 'balance' ? target.weight : null
      return {
        groupName: target.groupName,
        upstreamModel: target.upstreamModel,
        uid: newUid(),
        weight: filledWeight,
        weightText: filledWeight === null ? '' : String(filledWeight),
      }
    }),
  }
}

/** 继承时把现在实际的值显示出来。 */
function inheritedHint(value: number | undefined): string {
  if (value === undefined) return i18n.t('models.inheritToggle')
  return i18n.t('models.inheritHint', { value: value.toLocaleString() })
}

function toTriState(value: boolean | undefined): TriState {
  if (value === undefined) return 'inherit'
  return value ? 'yes' : 'no'
}

export function fromDraft(draft: ModelDraft): PublishedModel {
  return {
    ...create(PublishedModelSchema),
    id: draft.id.trim(),
    displayName: draft.displayName.trim() || draft.id.trim(),
    enabled: draft.enabled,
    strategy: draft.strategy,
    // 继承的字段不给值：不给就是继承，给了就是用这个值。
    contextWindow: draft.contextWindowInherit
      ? undefined
      : Number(draft.contextWindow) || 0,
    maxOutputTokens: draft.maxOutputTokensInherit
      ? undefined
      : Number(draft.maxOutputTokens) || 0,
    reasoning: fromTriState(draft.reasoning),
    toolCall: fromTriState(draft.toolCall),
    // 空 = 继承目标支持的档位。
    effortOptions: draft.effortOptions
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean),
    // single / fallback 下位次即权重：按草稿里的先后填，第一个最大（只有一个目标时
    // 顺序没有意义，权重仍然是它自己那一个）。balance 下用草稿里填的份额。
    targets: draft.targets
      .filter(targetFilled)
      .map((target, index, all): PublishedTarget => ({
        ...create(PublishedTargetSchema),
        groupName: target.groupName.trim(),
        upstreamModel: target.upstreamModel.trim(),
        weight: resolvedWeight(target, index, all.length, draft.strategy),
        // 目标上没有开关了：想不去这个目标就把它删掉。后端还按这一列判
        // 「这个目标参不参与选路」，所以一律写开。
        enabled: true,
        // requests / failed 是网关的计数，只读：保存时会被覆盖。
        requests: 0n,
        failed: 0n,
      })),
    updatedAt: 0n,
  }
}

function fromTriState(state: TriState): boolean | undefined {
  if (state === 'inherit') return undefined
  return state === 'yes'
}

type ModelDialogProps = {
  open: boolean
  model?: PublishedModel
  onOpenChange: (open: boolean) => void
  onSubmit: (model: PublishedModel) => void
  busy?: boolean
}

export function ModelDialog({
  open,
  model,
  onOpenChange,
  onSubmit,
  busy,
}: ModelDialogProps) {
  const { t } = useTranslation()
  const [draft, setDraft] = useState<ModelDraft>(() => toDraft(model))
  const [tab, setTab] = useState('basic')
  /** 排序模式：目标压成一行只看「平台组 / 上游模型」，拖着排完再回卡片。 */
  const [sorting, setSorting] = useState(false)

  useEffect(() => {
    if (open) setDraft(toDraft(model))
  }, [open, model])

  const patch = (part: Partial<ModelDraft>) =>
    setDraft((prev) => ({ ...prev, ...part }))

  const patchTarget = (
    index: number,
    part: Partial<ModelDraft['targets'][number]>
  ) =>
    setDraft((prev) => {
      const targets = prev.targets.map((target, i) =>
        i === index ? { ...target, ...part } : target
      )
      // balance 下这一行刚填全、还没有权重：当场按位次填上（与切到 balance 时同一
      // 条规则），免得用户填完平台组与模型 id 之后还被一个空的权重格挡着保存。
      if (prev.strategy !== 'balance') return { ...prev, targets }
      const row = targets[index]
      if (row.weight !== null || !targetFilled(row)) return { ...prev, targets }
      const filled = targets.filter(targetFilled)
      const derived = targetWeight(filled.indexOf(row), filled.length)
      return {
        ...prev,
        targets: targets.map((target, i) =>
          i === index
            ? { ...target, weight: derived, weightText: String(derived) }
            : target
        ),
      }
    })


  /**
   * 换策略：同一个「权重」字段在两个策略下是两回事，草稿跟着换。
   *
   * 切到 balance 的那一刻把当前位次推导出来的值填进草稿（两行 → 2、1），不要一上来
   * 全是空或 0：那里权重是份额，用户要能直接改，而「按位次」是个合理的起点。
   *
   * 切回 single / fallback 时权重一律回到 null（按位次推导）：把 balance 填的份额留着
   * 会莫名其妙 —— 那边是份额，这边是优先级。
   */
  const changeStrategy = (value: string) =>
    setDraft((prev) => {
      const filled = prev.targets.filter(targetFilled)
      return {
        ...prev,
        strategy: value,
        targets: prev.targets.map((target) => {
          if (value !== 'balance') {
            return { ...target, weight: null, weightText: '' }
          }
          if (target.weight !== null) return target
          const position = filled.indexOf(target)
          if (position < 0) return target
          const derived = targetWeight(position, filled.length)
          return { ...target, weight: derived, weightText: String(derived) }
        }),
      }
    })

  /** 改某一行的权重：原文进草稿，能解析成大于 0 的整数就记下数字。 */
  const patchWeight = (index: number, text: string) =>
    setDraft((prev) => ({
      ...prev,
      targets: prev.targets.map((target, i) =>
        i === index
          ? { ...target, weightText: text, weight: parsedWeight(text) }
          : target
      ),
    }))
  /** 把第 from 行挪到第 to 位。越界或原地不动时不动。 */
  const moveTarget = (from: number, to: number) =>
    setDraft((prev) => {
      if (from === to) return prev
      if (from < 0 || to < 0 || from >= prev.targets.length) return prev
      if (to >= prev.targets.length) return prev
      const targets = [...prev.targets]
      const [moved] = targets.splice(from, 1)
      targets.splice(to, 0, moved)
      return { ...prev, targets }
    })

  // 按填全了的目标数算，不是按行数：没填全的行会被过滤掉，拿行数算会
  // 放行一个「发出去是空 targets」的请求。
  const filledTargets = draft.targets.filter(targetFilled)

  // 每一行将要发的权重：只给填全了的行算，没填全的行本来也发不出去。
  const weights = new Map<number, number>()
  draft.targets.forEach((target, index) => {
    if (!targetFilled(target)) return
    weights.set(
      index,
      targetWeight(filledTargets.indexOf(target), filledTargets.length)
    )
  })

  // 组合撞了的行：后端存不下这种草稿（主键 (model_id, group_name,
  // upstream_model)），所以在这里就拦住，不发请求。
  const duplicated = duplicateTargets(draft.targets)

  // balance 下每一行填全了的目标都得有份量：空、小数、0、负数都在这里拦住。
  // 只判填全了的行 —— 没填全的行本来就发不出去，不该先为权重红起来。
  const weightProblems = new Map<number, string>()
  if (draft.strategy === 'balance') {
    draft.targets.forEach((target, index) => {
      if (!targetFilled(target)) return
      const problem = weightProblem(target.weightText)
      if (problem !== null) weightProblems.set(index, problem)
    })
  }

  /**
   * 这一行能选的上游模型里，哪些已经被别的行占着了。
   * 只有同一个平台才有意义：判重是组合，不是单个模型 id。
   */
  const takenModelIds = (index: number): string[] => {
    const group = draft.targets[index]?.groupName.trim() ?? ''
    if (group === '') return []
    return draft.targets
      .filter((target, i) => {
        if (i === index) return false
        return (
          target.groupName.trim() === group &&
          target.upstreamModel.trim() !== ''
        )
      })
      .map((target) => target.upstreamModel.trim())
  }

  // 哪个分组里有没填的必填项：分组标题上标红，切过去给行内提示。
  const basicMissing = draft.id.trim().length === 0
  const targetsMissing = filledTargets.length === 0
  // 组合撞了、或者 balance 下的权重填不对，都是「平台目标」那一页的问题：保存灰着的
  // 时候，用户得知道去哪看。
  const targetsProblem =
    targetsMissing || duplicated.size > 0 || weightProblems.size > 0
  // 两个整数格：继承时不判（那两格灰着，值不属于这一单），填了才判。
  const contextProblem = draft.contextWindowInherit
    ? null
    : translatedIntProblem(draft.contextWindow)
  const outputProblem = draft.maxOutputTokensInherit
    ? null
    : translatedIntProblem(draft.maxOutputTokens)

  const valid =
    !basicMissing &&
    !targetsMissing &&
    contextProblem === null &&
    outputProblem === null &&
    duplicated.size === 0 &&
    weightProblems.size === 0

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className='max-h-[90vh] overflow-y-auto sm:max-w-2xl'>
        <DialogHeader>
          <DialogTitle>
            {model ? t('models.dialogEditTitle') : t('models.dialogAddTitle')}
          </DialogTitle>
          <DialogDescription>
            {t('models.dialogDescription')}
          </DialogDescription>
        </DialogHeader>

        <Tabs value={tab} onValueChange={setTab}>
          <TabsList>
            <TabsTrigger value='basic'>
              {t('models.tabBasic')}
              {basicMissing ? <RequiredDot /> : null}
            </TabsTrigger>
            <TabsTrigger value='targets'>
              {t('models.tabTargets')}
              {targetsProblem ? <RequiredDot /> : null}
            </TabsTrigger>
          </TabsList>

          <TabsContent value='basic' className='grid gap-4'>
            <div className='grid gap-2'>
              <Label htmlFor='model-id'>{t('models.headPublicId')}</Label>
              <Input
                id='model-id'
                value={draft.id}
                disabled={Boolean(model)}
                aria-invalid={basicMissing || undefined}
                onChange={(event) => patch({ id: event.target.value })}
                placeholder={t('models.idPlaceholder')}
              />
              {basicMissing ? (
                <p className='text-xs text-destructive'>
                  {t('models.idRequired')}
                </p>
              ) : null}
            </div>
            <div className='grid gap-2'>
              <Label htmlFor='model-name'>
                {t('models.headDisplayName')}
              </Label>
              <Input
                id='model-name'
                value={draft.displayName}
                onChange={(event) =>
                  patch({ displayName: event.target.value })
                }
                placeholder={t('models.namePlaceholder')}
              />
            </div>
            <div className='grid gap-2'>
              <Label htmlFor='model-strategy'>
                {t('models.headStrategy')}
              </Label>
              <Select
                value={draft.strategy}
                onValueChange={changeStrategy}
              >
                <SelectTrigger id='model-strategy'>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value='single'>
                    {t('models.strategySingle')}
                  </SelectItem>
                  <SelectItem value='fallback'>
                    {t('models.strategyFallback')}
                  </SelectItem>
                  <SelectItem value='balance'>
                    {t('models.strategyBalance')}
                  </SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className='grid gap-4 sm:grid-cols-2'>
              <div className='grid gap-2'>
                <Label htmlFor='model-ctx'>
                  {t('models.contextLabel')}
                </Label>
                <Input
                  id='model-ctx'
                  inputMode='numeric'
                  disabled={draft.contextWindowInherit}
                  aria-invalid={contextProblem ? true : undefined}
                  aria-describedby={
                    contextProblem ? 'model-ctx-problem' : undefined
                  }
                  placeholder={
                    draft.contextWindowInherit
                      ? inheritedHint(draft.effectiveContextWindow)
                      : t('models.leaveEmptyInherit')
                  }
                  value={draft.contextWindow}
                  onChange={(event) =>
                    patch({ contextWindow: event.target.value })
                  }
                />
                {contextProblem ? (
                  <p
                    id='model-ctx-problem'
                    className='text-xs text-destructive'
                  >
                    {contextProblem}
                  </p>
                ) : null}
                <InheritToggle
                  id='model-ctx-inherit'
                  label={t('models.inheritToggle')}
                  checked={draft.contextWindowInherit}
                  onChange={(checked) =>
                    patch({
                      contextWindowInherit: checked,
                      contextWindow: checked ? '' : draft.contextWindow,
                    })
                  }
                />
              </div>
              <div className='grid gap-2'>
                <Label htmlFor='model-out'>
                  {t('models.outputLabel')}
                </Label>
                <Input
                  id='model-out'
                  inputMode='numeric'
                  disabled={draft.maxOutputTokensInherit}
                  aria-invalid={outputProblem ? true : undefined}
                  aria-describedby={
                    outputProblem ? 'model-out-problem' : undefined
                  }
                  placeholder={
                    draft.maxOutputTokensInherit
                      ? inheritedHint(draft.effectiveMaxOutputTokens)
                      : t('models.leaveEmptyInherit')
                  }
                  value={draft.maxOutputTokens}
                  onChange={(event) =>
                    patch({ maxOutputTokens: event.target.value })
                  }
                />
                {outputProblem ? (
                  <p
                    id='model-out-problem'
                    className='text-xs text-destructive'
                  >
                    {outputProblem}
                  </p>
                ) : null}
                <InheritToggle
                  id='model-out-inherit'
                  label={t('models.inheritToggle')}
                  checked={draft.maxOutputTokensInherit}
                  onChange={(checked) =>
                    patch({
                      maxOutputTokensInherit: checked,
                      maxOutputTokens: checked ? '' : draft.maxOutputTokens,
                    })
                  }
                />
              </div>
            </div>

            <div className='grid gap-4 sm:grid-cols-2'>
              <div className='grid gap-2'>
                <Label htmlFor='model-reasoning'>
                  {t('models.reasoningLabel')}
                </Label>
                <Select
                  value={draft.reasoning}
                  onValueChange={(value) =>
                    patch({ reasoning: value as TriState })
                  }
                >
                  <SelectTrigger id='model-reasoning'>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value='inherit'>
                      {t('models.inheritToggle')}
                    </SelectItem>
                    <SelectItem value='yes'>{t('models.supported')}</SelectItem>
                    <SelectItem value='no'>
                      {t('models.notSupported')}
                    </SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className='grid gap-2'>
                <Label htmlFor='model-tool-call'>
                  {t('models.toolCallLabel')}
                </Label>
                <Select
                  value={draft.toolCall}
                  onValueChange={(value) =>
                    patch({ toolCall: value as TriState })
                  }
                >
                  <SelectTrigger id='model-tool-call'>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value='inherit'>
                      {t('models.inheritToggle')}
                    </SelectItem>
                    <SelectItem value='yes'>{t('models.supported')}</SelectItem>
                    <SelectItem value='no'>
                      {t('models.notSupported')}
                    </SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div className='grid gap-2'>
              <Label htmlFor='model-effort'>
                {t('models.effortLabel')}
              </Label>
              <Input
                id='model-effort'
                value={draft.effortOptions}
                onChange={(event) => patch({ effortOptions: event.target.value })}
                placeholder='low, medium, high'
              />
              <p className='text-xs text-muted-foreground'>
                {t('models.effortHint')}
              </p>
            </div>

            <label className='flex items-center gap-2 text-sm'>
              <Switch
                checked={draft.enabled}
                onCheckedChange={(checked) => patch({ enabled: checked })}
              />
              {t('models.enabledLabel')}
            </label>
          </TabsContent>

          <TabsContent value='targets' className='grid gap-3'>
            {targetsMissing && !sorting ? (
              <p className='text-xs text-destructive'>
                {t('models.targetsRequired')}
              </p>
            ) : null}
            {draft.strategy === 'balance' ? (
              <>
                <p className='text-xs text-muted-foreground'>
                  {t('models.weightHint')}
                </p>
                <p className='text-xs text-muted-foreground'>
                  {t('models.balanceWeightHint')}
                </p>
              </>
            ) : null}
            {sorting ? (
              <>
                <p className='text-xs text-muted-foreground'>
                  {t('models.sortHint')}
                </p>
                {/* 排序模式下每行只留「平台组 / 上游模型」，拖拽、让位动画与
                    Alt + 上/下箭头都走共用那套（DragSortList）。草稿不动：
                    退出后各字段的输入原样回来。 */}
                <DragSortList
                  items={draft.targets}
                  // 草稿里的稳定 id：排序的落位过渡按它在前后两帧对上同一行。
                  // 用下标当 id 的话重排后每个位置拿到的 id 不变，位移差恒为零。
                  getId={(target) => target.uid}
                  ariaLabel={t('models.targetOrderLabel')}
                  rowProps={(_, index) => ({
                    'data-target-row': String(index),
                    'aria-label': t('models.targetHeading', {
                      index: index + 1,
                    }),
                  })}
                  renderItem={(target) => (
                    <>
                      <span className='font-mono text-sm font-medium'>
                        {target.groupName.trim() || t('models.groupUnfilled')}
                      </span>
                      <span className='font-mono text-xs break-all text-muted-foreground'>
                        {' / '}
                        {target.upstreamModel.trim() ||
                          t('models.modelUnfilled')}
                      </span>
                    </>
                  )}
                  onMove={moveTarget}
                />
                <Button
                  variant='outline'
                  size='sm'
                  className='w-fit'
                  onClick={() => setSorting(false)}
                >
                  {t('models.sortDone')}
                </Button>
              </>
            ) : (
              <>
                <p className='text-xs text-muted-foreground'>
                  {t('models.orderHint')}
                </p>
                <Button
                  variant='outline'
                  size='sm'
                  className='w-fit'
                  onClick={() => setSorting(true)}
                >
                  {t('models.sortStart')}
                </Button>
                <ul
                  aria-label={t('models.targetOrderLabel')}
                  className='grid gap-2'
                >
                  {draft.targets.map((target, index) => {
                    const weight = weights.get(index)
                    return (
                      <li
                        key={index}
                        data-target-row={index}
                        aria-label={t('models.targetHeading', {
                          index: index + 1,
                        })}
                        className='grid gap-2 rounded-lg border p-3'
                      >
                        <div className='flex flex-wrap items-center gap-2'>
                          <span className='text-sm font-medium'>
                            {t('models.targetHeading', { index: index + 1 })}
                          </span>
                          {/* balance 下权重由下面的输入框取代这行只读文字：那里是
                              份额，得手填；single / fallback 下位次就是权重。 */}
                          {weight === undefined ||
                          draft.strategy === 'balance' ? null : (
                            <span className='text-xs text-muted-foreground'>
                              {t('models.targetWeight', { weight })}
                            </span>
                          )}
                          <span className='ms-auto flex items-center gap-1'>
                            <Button
                              variant='ghost'
                              size='sm'
                              aria-label={t('models.removeTarget', {
                                index: index + 1,
                              })}
                              disabled={draft.targets.length === 1}
                              onClick={() =>
                                setDraft((prev) => ({
                                  ...prev,
                                  targets: prev.targets.filter(
                                    (_, i) => i !== index
                                  ),
                                }))
                              }
                            >
                              <Trash2 />
                              {t('models.delete')}
                            </Button>
                          </span>
                        </div>
                        <div className='grid gap-2 sm:grid-cols-2'>
                          <div className='grid gap-2'>
                            <Label htmlFor={`target-group-${index}`}>
                              {t('models.groupColumn')}
                            </Label>
                            <GroupPicker
                              id={`target-group-${index}`}
                              value={target.groupName}
                              onChange={(value) =>
                                patchTarget(index, {
                                  groupName: value,
                                  // 换了组，上一个组的模型 id 就不再作数。
                                  upstreamModel: '',
                                })
                              }
                            />
                          </div>
                          <div className='grid gap-2'>
                            <Label htmlFor={`target-model-${index}`}>
                              {t('models.modelIdColumn')}
                            </Label>
                            <ModelPicker
                              id={`target-model-${index}`}
                              groupName={target.groupName}
                              value={target.upstreamModel}
                              takenModelIds={takenModelIds(index)}
                              onChange={(value) =>
                                patchTarget(index, { upstreamModel: value })
                              }
                            />
                          </div>
                        </div>
                        {draft.strategy === 'balance' ? (
                          <div className='grid gap-2'>
                            <Label htmlFor={`target-weight-${index}`}>
                              {t('models.weightLabel')}
                            </Label>
                            <Input
                              id={`target-weight-${index}`}
                              type='number'
                              step={1}
                              min={1}
                              inputMode='numeric'
                              value={target.weightText}
                              aria-invalid={
                                weightProblems.has(index) || undefined
                              }
                              aria-describedby={
                                weightProblems.has(index)
                                  ? `target-weight-problem-${index}`
                                  : undefined
                              }
                              onChange={(event) =>
                                patchWeight(index, event.target.value)
                              }
                            />
                            {weightProblems.has(index) ? (
                              <p
                                id={`target-weight-problem-${index}`}
                                className='text-xs text-destructive'
                              >
                                {weightProblems.get(index)}
                              </p>
                            ) : null}
                          </div>
                        ) : null}
                        {duplicated.has(index) ? (
                          <p className='text-xs text-destructive'>
                            {t('models.duplicateTarget', {
                              group: target.groupName.trim(),
                              model: target.upstreamModel.trim(),
                              index: (duplicated.get(index) ?? 0) + 1,
                            })}
                          </p>
                        ) : null}
                        {!targetFilled(target) ? (
                          <p className='text-xs text-destructive'>
                            {t('models.targetIncomplete')}
                          </p>
                        ) : null}
                      </li>
                    )
                  })}
                </ul>
              </>
            )}
            <Button
              variant='outline'
              size='sm'
              className='w-fit'
              onClick={() =>
                setDraft((prev) => ({
                  ...prev,
                  targets: [...prev.targets, emptyTarget()],
                }))
              }
            >
              <Plus />
              {t('models.addTarget')}
            </Button>
          </TabsContent>
        </Tabs>

        <DialogFooter>
          <Button variant='outline' onClick={() => onOpenChange(false)}>
            {t('models.cancel')}
          </Button>
          <Button
            disabled={!valid || busy}
            onClick={() => onSubmit(fromDraft(draft))}
          >
            {t('models.save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/**
 * 分组标题上的小红点：那个分组里有必填项没填。
 */
function RequiredDot() {
  return (
    <span
      aria-hidden='true'
      className={cn(
        'ms-1.5 inline-block size-1.5 rounded-full bg-destructive align-middle'
      )}
    />
  )
}

function InheritToggle({
  id,
  label,
  checked,
  onChange,
}: {
  id: string
  label: string
  checked: boolean
  onChange: (checked: boolean) => void
}) {
  return (
    <label htmlFor={id} className='flex items-center gap-2 text-xs'>
      <Switch id={id} checked={checked} onCheckedChange={onChange} />
      {label}
    </label>
  )
}
