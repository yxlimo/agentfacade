import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import i18n from '@/lib/i18n'
import type { Upstream } from '@/gen/agentfacade/admin/v1/admin_pb'
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
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { describeErrorText } from '@/lib/errors'
import type { PlatformKind } from '@/gen/agentfacade/admin/v1/admin_pb'
import {
  isSimulatedKind,
  platformKindHint,
  platformKindPlaceholder,
  platformKindReadout,
  platformKindValue,
  simulatedPresetOf,
  type PlatformKindList,
} from './platform-kinds'
import {
  PLATFORM_TEMPLATES,
  type HeaderField,
  type PlatformTemplate,
} from './templates'
import { platformProblems, missingText, type PlatformField } from './platform-form'

export type PlatformSubmit = AddPlatformSubmit | UpdatePlatformSubmit

/**
 * 新增那一单。
 *
 * 类型是建平台时选的一格：建完就改不了，所以只有这一单带它。
 */
export type AddPlatformSubmit = {
  id: string
  label: string
  baseUrl: string
  /** 用哪一类适配器（清单里的一个 kind）。 */
  kind: string
  /** 转发时注入的头（有序）：开放平台每次带完整列表，模拟客户端不带这一格。 */
  headers?: HeaderField[]
}

/**
 * 修改那一单。
 *
 * 契约里 UpdatePlatform 没有 kind 这一格：类型建完就改不了，所以这里不带它 ——
 * 不是「带上但 hook 会挑掉」，是这一单本身就没有。
 *
 * 地址对模拟客户端是不适用的一格（归代码）：那一族提交时这一格
 * **不出现**，不是出现但为空串。
 */
export type UpdatePlatformSubmit = {
  id: string
  label: string
  /** 模拟客户端不带这一格（地址归代码）。 */
  baseUrl?: string
  /**
   * 用共性表补模型参数。
   *
   * 没动过这一格就不带：后端「没给 = 别动这一格」，带一个默认值是错的（那是
   * 明确写了一遍）。关掉这一格要带 `false`，它与「没给」不是一回事。
   */
  traitsFromCommon?: boolean
  /**
   * 转发时注入的头（有序）：开放平台每次保存都发完整列表（含空列表 = 清空）。
   * 模拟客户端不带这一格。
   */
  headers?: HeaderField[]
}

type Draft = {
  id: string
  label: string
  /**
   * 名字是不是用户自己敲的。
   *
   * 面板填的名字（预置的名字、模板的名字）不是用户的值：换一条类型时该跟着换。
   * 靠「现在这个名字是不是上一条的名字」猜是不行的 —— 两条类型同名的时
   * 候猜不出来，而且上一条名字本身也是面板填的。只有名字那一格的 onChange
   * 置这个标志。
   */
  labelEdited: boolean
  baseUrl: string
  /**
   * 用户自己敲过地址吗。
   *
   * 面板按类型预填的地址不算：换一条类型时那一格要跟着新类型走。敲过的才算
   * 用户的值：换类型时不覆盖它。
   */
  baseUrlEdited: boolean
  /**
   * 选中的那一条（见 `platformKindValue`：方言看 kind，模拟客户端看 presetId）。
   * 改平台时没有这一格 —— 类型建完就改不了。
   */
  choice: string
  /** 用共性表补模型参数这一格现在开着没有（这一格缺失时按关显示）。 */
  traitsFromCommon: boolean
  /**
   * 用户动过这一格吗。
   *
   * 没动过就不往请求里放（后端「没给 = 别动」）：面板不替用户把现在的值再写
   * 一遍。
   */
  traitsFromCommonEdited: boolean
  /** 注入头草稿：有序，删光就是空列表（保存 = 清空）。 */
  headers: HeaderField[]
}

/**
 * 下拉里的两组：模拟客户端在前（能建的多半是这一类，条目也多），方言在后。
 *
 * 分组的判据只有 `category`；看不出类别的（老服务端不带这一格）算方言 —— 那种
 * 时候它也只有方言可给。
 */
function kindGroups(
  options: PlatformKind[]
): { title: string; items: PlatformKind[] }[] {
  const simulated = options.filter(isSimulatedKind)
  const dialect = options.filter((item) => !isSimulatedKind(item))
  const groups: { title: string; items: PlatformKind[] }[] = []
  if (simulated.length) {
    groups.push({ title: i18n.t('openPlatforms.kindGroupSimulated'), items: simulated })
  }
  if (dialect.length) {
    groups.push({ title: i18n.t('openPlatforms.kindGroupOpen'), items: dialect })
  }
  return groups
}

/**
 * 新增或修改一个开放平台。
 *
 * 新增只有三格（id、名字、地址）：服务端建的就是一个空平台，不接 key、不接
 * 模型清单。修改是整单提交 —— 名字、地址、模型目录一起发过去，
 * 空串表示清空。
 *
 * 选到模拟客户端时只有名字一格是能填的：id、地址、区域都是那个客户端的身份
 * （改了会话就接不上），面板不摆那几格，提交时按预置填。
 *
 * id 能不能用、地址是不是网址，面板先用自己手头的数据判（平台列表、账号
 * id）：判出来的问题摆在那一格下面，保存按钮灰着，请求不发。服务端那套校验
 * 照样在，它管的是别的客户端与并发 —— 那时它说不行就是不行，那句话原样显示。
 */
export function PlatformDialog({
  open,
  platform,
  existing,
  kinds,
  pending,
  error,
  onSubmit,
  onOpenChange,
}: {
  open: boolean
  /** 要改的平台。新增的时候不给。 */
  platform?: Upstream
  /** 表里现有的平台（含播种的模拟客户端）：id 重不重、是不是账号名，看它。 */
  existing: readonly Upstream[]
  /** 建平台时能选的类型清单：三档（加载中 / 取不到 / 到手）。 */
  kinds: PlatformKindList
  pending: boolean
  /** 上一次提交的错误：服务端的话，原样显示。 */
  error?: unknown
  /**
   * 交上去。新增那一单带 kind，改那一单不带（`PlatformSubmit` 是两个类型）。
   */
  onSubmit: (input: PlatformSubmit) => void
  onOpenChange: (open: boolean) => void
}) {
  const { t } = useTranslation()
  const [draft, setDraft] = useState<Draft>(() => toDraft(platform))
  /**
   * 用户碰过哪几格。
   *
   * 「没填」那句话只在碰过之后才摆：新开一个空表单，一行红字先骂起来没有意义。
   * 填错了（格式、被占用）都是敲进去才有的，不用等这个标志。
   */
  const [touched, setTouched] = useState<Partial<Record<PlatformField, true>>>(
    {}
  )
  /** 模板搜索框里的字：按名字或 id 过滤模板列表。 */
  const [templateQuery, setTemplateQuery] = useState('')
  /** 选中的那条模板：只是标一下，不参与提交。 */
  const [pickedTemplate, setPickedTemplate] = useState<string>('')

  useEffect(() => {
    // 打开的时候按这一单重铺草稿。
    //
    // 依赖里也盯平台 id：弹窗开着的时候父组件换了平台（列表刷新、或者从别处
    // 点进来），只盯 open 的话表单留着上一个平台的旧值、标题是新名字，提交
    // 就写错了行。服务端那边只是同一个平台的值变了，不重铺 —— 那会把用户已经
    // 填的东西抹掉。
    if (open) {
      setDraft(toDraft(platform))
      setTouched({})
      setTemplateQuery('')
      setPickedTemplate('')
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, platform?.id])

  /** 模板列表：按名字或 id 过滤（大小写不管）。 */
  const shownTemplates = useMemo(() => {
    const query = templateQuery.trim().toLowerCase()
    if (!query) return PLATFORM_TEMPLATES
    return PLATFORM_TEMPLATES.filter(
      (item) =>
        item.label.toLowerCase().includes(query) ||
        item.id.toLowerCase().includes(query)
    )
  }, [templateQuery])

  const patch = (part: Partial<Draft>) =>
    setDraft((prev) => ({ ...prev, ...part }))

  /** 碰过这一格（敲进来的字以后清空也算碰过）。 */
  const touch = (field: PlatformField) =>
    setTouched((prev) => (prev[field] ? prev : { ...prev, [field]: true }))

  /** 注入头：按序改一格。下标靠 React key 与顺序绑在一起，移动时整行跟着走。 */
  const changeHeader = (
    index: number,
    field: keyof HeaderField,
    value: string
  ) =>
    setDraft((prev) => ({
      ...prev,
      headers: prev.headers.map((item, i) =>
        i === index ? { ...item, [field]: value } : item
      ),
    }))

  /** 加一条空行：顺序就是发送顺序，新行追加在末尾。 */
  const addHeader = () =>
    setDraft((prev) => ({
      ...prev,
      headers: [...prev.headers, { name: '', value: '' }],
    }))

  /** 删一条：删光之后草稿是空列表，保存时按「清空」发出去。 */
  const removeHeader = (index: number) =>
    setDraft((prev) => ({
      ...prev,
      headers: prev.headers.filter((_, i) => i !== index),
    }))

  /** 上下移动：换两行的位置，顺序跟着变。 */
  const moveHeader = (index: number, delta: number) =>
    setDraft((prev) => {
      const target = index + delta
      if (target < 0 || target >= prev.headers.length) return prev
      const headers = [...prev.headers]
      const [row] = headers.splice(index, 1)
      headers.splice(target, 0, row)
      return { ...prev, headers }
    })

  const editing = platform !== undefined
  // 清单到手了才有可选项；没到手、取不到的时候一个也没有。
  const kindOptions = kinds.status === 'ready' ? kinds.kinds : []
  const chosenKind = kindOptions.find(
    (item) => platformKindValue(item) === draft.choice
  )
  // 选中的那一条是模拟客户端时的预置；是方言就是 undefined。
  const chosenPreset =
    chosenKind && isSimulatedKind(chosenKind) ? chosenKind : undefined
  // 改的是不是一个模拟客户端：按 id 与 kind 认出是哪一条预置（两个 Qoder 的
  // kind 相同，拿 kind 认不出来）。认不出来就照方言那套摆。
  const preset = platform ? simulatedPresetOf(kinds, platform) : chosenPreset
  // 改的时候清单可能还没到手（加载中 / 取不到），那时认不出是哪一条预置；但
  // 是不是模拟客户端平台那一条自己说得出来：服务端没把它明确算作开放平台的，
  // 就是那一族。地址归代码，不摆也不往上送。
  //
  // 判据只看族（服务端那一格说的是这个），不看「表里有没有这一行」：有没有行、
  // 能不能改删是另一件事，掺进来就会多出一条「模拟客户端被当成开放平台 → 发
  // 空串 → 抹掉库里那份地址」的路。
  //
  // 判据写成「不为 true」而不是「等于 false」：这一格缺失（老服务端 / 形状里
  // 没有它）时不能当成「不是模拟客户端」—— 那样会给模拟客户端露出地址格，
  // 用户一填就写进那一行。真开放平台这一格一定是 true。
  const simulated =
    preset !== undefined ||
    (platform !== undefined && platform.isOpenPlatform !== true)
  // 模拟客户端的 id 由预置定死：请求路径里那一段，也是调用方 base_url 的那一段。
  const fixedId = simulated ? (preset?.presetId || platform?.id || '') : ''
  // 清单现在怎么了：三档各一句（加载中 / 取不到 / 一条也没有）。有得选的时候
  // 这一行不摆；占位符与这行从同一处取，两处说法一致。
  const kindOptionHint = platformKindHint(kinds)
  // 「类型：xxx」那一行（改的时候）：判据在 platform-kinds.ts，卡片用的是同一个。
  const readonlyKind = platform ? platformKindReadout(kinds, platform) : null

  // id 重不重、是不是账号名：看表里现有的平台与它们名下的账号（两边共用一个
  // 命名空间）。改平台时把自己那一行排掉 —— 它当然跟自己的 id 重。
  const takenIds = useMemo(
    () =>
      existing.filter((item) => item.id !== platform?.id).map((item) => item.id),
    [existing, platform?.id]
  )
  const accountIds = useMemo(
    () =>
      existing.flatMap((item) =>
        item.accounts.map((account) => account.id)
      ),
    [existing]
  )
  // 提交前就能说清的那几件错：id 空/格式/自用/被占，名字空，地址空/不是网址。
  const problems = platformProblems({
    // 改平台时 id 改不了；模拟客户端的 id 由预置定，两处都不判这一格。
    id: editing || simulated ? undefined : draft.id,
    label: draft.label,
    // 模拟客户端的地址归代码，不摆也不判。
    baseUrl: simulated ? undefined : draft.baseUrl,
    takenIds,
    accountIds,
  })
  /**
   * 这一格下面摆不摆那句话。
   *
   * 「没填」只在碰过之后摆（新开的空表单不先骂人）；填错了（格式、被占用）
   * 都是敲进去才有的，一律摆。
   */
  const shown = (field: PlatformField): string | undefined => {
    const text = problems[field]
    if (!text) return undefined
    return draft[field].trim() === '' && !touched[field] ? undefined : text
  }
  // 有一格不对就不发请求：那些错在保存前就看得见。
  // 注入头只做最轻的同步检查：name / value 非空。其余判据（token、换行、长度、
  // 条数）交服务端，机器码由 describeErrorText 翻人话显示在弹窗里。模拟客户端
  // 不摆这一区，也不拿它的空值挡保存。
  const headersIncomplete =
    !simulated &&
    draft.headers.some(
      (item) => item.name.trim() === '' || item.value.trim() === ''
    )
  const blocked = Object.keys(problems).length > 0 || headersIncomplete
  /** 还差哪几格（页脚那一行用）：只说缺哪几格，不把三句「没填」在页脚再摆一遍。 */
  const missing = (['id', 'label', 'baseUrl'] as PlatformField[]).filter(
    (field) => problems[field] === missingText(field)
  )
  const MISSING_LABEL: Record<PlatformField, string> = {
    id: t('openPlatforms.missingFieldId'),
    label: t('openPlatforms.missingFieldLabel'),
    baseUrl: t('openPlatforms.missingFieldBaseUrl'),
  }

  useEffect(() => {
    // 新增：清单到手后默认选第一条（顺序照服务端给的）。改的时候没有这一格。
    //
    // 依赖里带上 open：弹窗每开一次都把草稿重置成空的，重置完得重新选一次。
    // 只看 kinds 的话，清单早就到手了，打开弹窗时这条 effect 不会再跑，类型
    // 就会一直空着（保存一直禁用）。
    if (!open || editing || kinds.status !== 'ready') return
    const first = kinds.kinds[0]
    if (!first) return
    setDraft((prev) =>
      kinds.kinds.some((item) => platformKindValue(item) === prev.choice)
        ? prev
        : {
            ...prev,
            choice: platformKindValue(first),
            // 地址是空的才用这一类的默认地址占位；填过的不动。
            baseUrl: isSimulatedKind(first)
              ? ''
              : prev.baseUrlEdited
                ? prev.baseUrl
                : first.defaultBaseUrl,
            // 名字空着、选中的又是预置：填它的名字（能改）。
            label:
              isSimulatedKind(first) && !prev.labelEdited && !prev.label.trim()
                ? first.label
                : prev.label,
          }
    )
  }, [open, editing, kinds])

  /**
   * 换一条类型。
   *
   * 地址是空的时候用这一类的默认地址占位（模拟客户端的地址由模拟端定，留空）。
   * 名字没被用户改过时跟着换成这一条的名字：换一条预置却留着上一条的名字，
   * 建出来就是一个名字对不上的平台。
   *
   * 离开预置那一族（模拟客户端 → 方言）时 id 清掉：那格在预置那边是不摆的，
   * 草稿里留着的东西跟现在选中的类型没关系 —— 提交上去就成了一个用户没填过
   * 的 id。
   */
  const chooseKind = (value: string) => {
    const option = kindOptions.find((item) => platformKindValue(item) === value)
    setDraft((prev) => {
      const previous = kindOptions.find(
        (item) => platformKindValue(item) === prev.choice
      )
      const simulated = option ? isSimulatedKind(option) : false
      const leavingPreset =
        !simulated && (previous ? isSimulatedKind(previous) : false)
      return {
        ...prev,
        choice: value,
        id: leavingPreset ? '' : prev.id,
        baseUrl: simulated
          ? ''
          : prev.baseUrlEdited
            ? prev.baseUrl
            : (option?.defaultBaseUrl ?? ''),
        label: prev.labelEdited
          ? prev.label
          : simulated
            ? (option?.label ?? '')
            : '',
      }
    })
  }
  /**
   * 选一条模板：把 id、名字、地址三格填上。
   *
   * 填完这三格还是能改的 —— 模板是起点，不是定好的答案。模板表里不做「只能用
   * 一次」那类判断：id 撞了就是那个平台已经存在，服务端会说明。
   */
  const pickTemplate = (template: PlatformTemplate) => {
    setPickedTemplate(template.id)
    patch({
      id: template.id,
      label: template.label,
      // 模板给的名字是面板填的，不是用户敲的：换一条类型时该跟着换。
      labelEdited: false,
      baseUrl: template.baseUrl,
      // 模板里的注入头一起预填（没有这一格的模板就是空）。模板只是起点，
      // 用户照旧能改能删 —— 删光保存会把这一格清空。
      headers: (template.headers ?? []).map((item) => ({
        name: item.name,
        value: item.value,
      })),
    })
  }

  const submit = () => {
    if (editing) {
      const shared = {
        id: draft.id.trim(),
        label: draft.label.trim(),
      }
      // 模拟客户端的地址归代码：这一格整格不出现。发空串是「清空
      // 那一格」的意思，会把库里原来那份抹掉。
      if (simulated) {
        onSubmit(shared)
        return
      }
      const update: UpdatePlatformSubmit = {
        ...shared,
        baseUrl: draft.baseUrl.trim(),
        // 每次保存都发完整列表：用户删光所有行 = 空列表 = 清空服务端那一份。
        headers: draft.headers.map((item) => ({
          name: item.name.trim(),
          value: item.value.trim(),
        })),
      }
      // 只有用户动过这一格才带：契约里它是 optional bool，没给就是「别动这一格」。
      // 带一个默认值等于替用户写一遍，把它自己改过的值盖回去。
      if (draft.traitsFromCommonEdited) {
        update.traitsFromCommon = draft.traitsFromCommon
      }
      onSubmit(update)
      return
    }
    // 新增只建空平台：额度插件按地址匹配，不是建平台时能填的一格。
    const add: AddPlatformSubmit = {
      // 模拟客户端：id 是预置定的那一个，不是下拉里那个值本身（方言的
      // 下拉值是 kind，不是 id）。
      id: simulated ? fixedId : draft.id.trim(),
      label: draft.label.trim(),
      baseUrl: simulated ? '' : draft.baseUrl.trim(),
      kind: chosenKind?.kind ?? '',
      // 开放平台每次都发完整列表（空 = 没配）；模拟客户端这一格整格不出现。
      ...(simulated
        ? {}
        : {
            headers: draft.headers.map((item) => ({
              name: item.name.trim(),
              value: item.value.trim(),
            })),
          }),
    }
    onSubmit(add)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className='sm:max-w-lg'>
        <DialogHeader>
          <DialogTitle>
            {editing
              ? t('openPlatforms.editTitle', {
                  name: platform.label || platform.id,
                })
              : t('openPlatforms.addTitle')}
          </DialogTitle>
          <DialogDescription>
            {simulated
              ? t('openPlatforms.editHintSimulated')
              : editing
                ? t('openPlatforms.editHintAddress')
                : t('openPlatforms.addHint')}
          </DialogDescription>
        </DialogHeader>

        <div className='grid gap-4'>
          {editing ? (
            // 类型改不了（契约里 UpdatePlatform 没有这一格），只摆一行只读的。
            // kind 空着、清单没到手都说不准名字：那些时候整行不摆。
            readonlyKind ? (
              <p className='text-sm'>
                {t('openPlatforms.kindReadout', { kind: readonlyKind })}
              </p>
            ) : null
          ) : (
            <div className='grid gap-2'>
              <Label htmlFor='platform-kind'>{t('openPlatforms.kindLabel')}</Label>
              <Select
                value={chosenKind ? platformKindValue(chosenKind) : ''}
                disabled={kindOptions.length === 0}
                onValueChange={chooseKind}
              >
                <SelectTrigger
                  id='platform-kind'
                  aria-label={t('openPlatforms.kindLabel')}
                >
                  <SelectValue placeholder={platformKindPlaceholder(kinds)} />
                </SelectTrigger>
                <SelectContent>
                  {kindGroups(kindOptions).map((group) => (
                    <SelectGroup key={group.title}>
                      <SelectLabel>{group.title}</SelectLabel>
                      {group.items.map((item) => (
                        <SelectItem
                          key={platformKindValue(item)}
                          value={platformKindValue(item)}
                        >
                          {item.label}
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  ))}
                </SelectContent>
              </Select>
              {/* 清单取不到的时候补上原因。其余两档（还在加载 / 一条也没有）
                  上面那一行占位已经把话说完了，不重复一遍。 */}
              {kindOptionHint ? (
                <p className='text-xs text-muted-foreground'>
                  {kindOptionHint}
                </p>
              ) : null}
            </div>
          )}

          {/* 模板表里是第三方厂商的地址与名字：先填三格再改。模拟客户端的
              id 与地址由预置定，用不上这一块。 */}
          {editing || simulated ? null : (
            <div className='grid gap-2'>
              <Label htmlFor='platform-template-search'>
                {t('openPlatforms.templateSearchLabel')}
              </Label>
              <Input
                id='platform-template-search'
                value={templateQuery}
                placeholder={t('openPlatforms.templateSearchPlaceholder')}
                onChange={(event) => setTemplateQuery(event.target.value)}
              />
              <div
                role='group'
                aria-label={t('openPlatforms.templateListLabel')}
                className='max-h-56 overflow-y-auto rounded-md border'
              >
                {shownTemplates.length ? (
                  shownTemplates.map((template) => (
                    <button
                      key={template.id}
                      type='button'
                      aria-current={
                        pickedTemplate === template.id ? 'true' : undefined
                      }
                      onClick={() => pickTemplate(template)}
                      className='flex w-full flex-col items-start gap-0.5 border-b px-3 py-2 text-left last:border-b-0 hover:bg-accent aria-[current=true]:bg-accent'
                    >
                      <span className='text-sm font-medium'>
                        {template.label}
                      </span>
                      <span className='text-xs text-muted-foreground'>
                        {template.baseUrl}
                      </span>
                    </button>
                  ))
                ) : (
                  <p className='px-3 py-2 text-sm text-muted-foreground'>
                    {t('openPlatforms.templateNone')}
                  </p>
                )}
              </div>
            </div>
          )}

          {simulated ? (
            // 模拟客户端的 id 是它自己的身份（客户端路径里那一段）：只摆出来，
            // 不给改 —— 改了就认不出是哪一个客户端了。
            <div className='grid gap-2'>
              <p className='text-sm font-medium'>
                {t('openPlatforms.platformIdLabel')}
              </p>
              <p className='font-mono text-sm'>{fixedId}</p>
              <p className='text-xs text-muted-foreground'>
                {t('openPlatforms.clientPath', { id: fixedId })}
              </p>
            </div>
          ) : (
            <div className='grid gap-2'>
              <Label htmlFor='platform-id'>
                {t('openPlatforms.platformIdLabel')}
              </Label>
              <Input
                id='platform-id'
                value={draft.id}
                disabled={editing}
                placeholder={t('openPlatforms.platformIdPlaceholder')}
                aria-invalid={shown('id') ? true : undefined}
                aria-describedby={shown('id') ? 'platform-id-problem' : undefined}
                onChange={(event) => {
                  touch('id')
                  patch({ id: event.target.value })
                }}
              />
              {shown('id') ? (
                <p
                  id='platform-id-problem'
                  className='text-xs text-destructive'
                >
                  {shown('id')}
                </p>
              ) : null}
              <p className='text-xs text-muted-foreground'>
                {editing
                  ? t('openPlatforms.platformIdEditHint')
                  : t('openPlatforms.platformIdAddHint')}
              </p>
            </div>
          )}

          <div className='grid gap-2'>
            <Label htmlFor='platform-label'>{t('openPlatforms.nameLabel')}</Label>
            <Input
              id='platform-label'
              value={draft.label}
              placeholder={t('openPlatforms.namePlaceholder')}
              aria-invalid={shown('label') ? true : undefined}
              aria-describedby={
                shown('label') ? 'platform-label-problem' : undefined
              }
              onChange={(event) => {
                // 用户敲过的名字不再跟着类型走。
                touch('label')
                patch({ label: event.target.value, labelEdited: true })
              }}
            />
            {shown('label') ? (
              <p
                id='platform-label-problem'
                className='text-xs text-destructive'
              >
                {shown('label')}
              </p>
            ) : null}
          </div>

          {/* 地址：模拟客户端的发到哪由模拟端定（库里那个是空串），不摆这一格。 */}
          {simulated ? null : (
            <div className='grid gap-2'>
              <Label htmlFor='platform-base-url'>
                {t('openPlatforms.addressLabel')}
              </Label>
              <Input
                id='platform-base-url'
                value={draft.baseUrl}
                placeholder='https://api.example.com/v1'
                aria-invalid={shown('baseUrl') ? true : undefined}
                aria-describedby={
                  shown('baseUrl') ? 'platform-base-url-problem' : undefined
                }
                onChange={(event) => {
                  touch('baseUrl')
                  // 敲过的地址是用户的值：换类型时不再拿默认值盖它。
                  patch({ baseUrl: event.target.value, baseUrlEdited: true })
                }}
              />
              {shown('baseUrl') ? (
                <p
                  id='platform-base-url-problem'
                  className='text-xs text-destructive'
                >
                  {shown('baseUrl')}
                </p>
              ) : null}
            </div>
          )}

          {/* 注入头：只有开放平台有这一区（模拟客户端的请求指纹归代码）。
              顺序就是发送顺序，上行按钮改顺序，末尾追加新行，删光保存 = 清空。
              只查 name/value 非空，其余交给服务端拒并把机器码翻人话。 */}
          {simulated ? null : (
            <div className='grid gap-2'>
              <Label>{t('openPlatforms.headersLabel')}</Label>
              <p className='text-xs text-muted-foreground'>
                {t('openPlatforms.headersHint')}
              </p>
              <div className='grid gap-2'>
                {draft.headers.map((header, index) => (
                  <div
                    key={index}
                    className='grid grid-cols-[1fr_1fr_auto_auto_auto] items-start gap-1'
                  >
                    <Input
                      aria-label={t('openPlatforms.headerName', { n: index + 1 })}
                      value={header.name}
                      placeholder='x-opencode-session'
                      onChange={(event) =>
                        changeHeader(index, 'name', event.target.value)
                      }
                    />
                    <Input
                      aria-label={t('openPlatforms.headerValue', { n: index + 1 })}
                      value={header.value}
                      placeholder='{session-id}'
                      onChange={(event) =>
                        changeHeader(index, 'value', event.target.value)
                      }
                    />
                    <button
                      type='button'
                      aria-label={t('openPlatforms.headerMoveUp', { n: index + 1 })}
                      disabled={index === 0}
                      onClick={() => moveHeader(index, -1)}
                      className='h-9 w-8 rounded-md border text-sm disabled:opacity-40'
                    >
                      ↑
                    </button>
                    <button
                      type='button'
                      aria-label={t('openPlatforms.headerMoveDown', {
                        n: index + 1,
                      })}
                      disabled={index === draft.headers.length - 1}
                      onClick={() => moveHeader(index, 1)}
                      className='h-9 w-8 rounded-md border text-sm disabled:opacity-40'
                    >
                      ↓
                    </button>
                    <button
                      type='button'
                      aria-label={t('openPlatforms.headerRemove', { n: index + 1 })}
                      onClick={() => removeHeader(index)}
                      className='h-9 w-8 rounded-md border text-sm'
                    >
                      ×
                    </button>
                  </div>
                ))}
              </div>
              {headersIncomplete ? (
                <p className='text-xs text-destructive'>
                  {t('openPlatforms.headersIncomplete')}
                </p>
              ) : null}
              <div>
                <Button variant='outline' size='sm' onClick={addHeader}>
                  {t('openPlatforms.headerAdd')}
                </Button>
              </div>
            </div>
          )}

          {/* 额度插件按平台地址自动匹配，不是能填的一格：没有控件也没有提示。
              匹配不到插件就是没有额度接口，账号的凭据里只有推理那一格。 */}

          {editing ? (
            <>
              {/* 模型目录不由用户管：开放平台的目录一律从上游拉，模拟客户端的
                  目录归代码。两族都只留一句说清，没有开关也没有文本域。 */}
              {simulated ? (
                <p className='text-sm text-muted-foreground'>
                  {t('openPlatforms.catalogCodeOnly')}
                </p>
              ) : (
                <p className='text-sm text-muted-foreground'>
                  {t('openPlatforms.catalogPlatform')}
                </p>
              )}

              {/* 共性表：只有目录归上游的开放平台才有「平台没报的参数」这回事。
                  模拟客户端的参数归代码，不摆这一格。 */}
              {simulated ? null : (
                <div className='grid gap-2'>
                  <div className='flex items-center gap-2'>
                    <Switch
                      id='platform-traits-from-common'
                      checked={draft.traitsFromCommon}
                      onCheckedChange={(checked) =>
                        patch({
                          traitsFromCommon: checked,
                          // 动过一次就算动过：再拨回来也是「明确关掉」，带 false。
                          traitsFromCommonEdited: true,
                        })
                      }
                    />
                    <Label htmlFor='platform-traits-from-common'>
                      {t('openPlatforms.traitsSwitch')}
                    </Label>
                  </div>
                  <p className='text-xs text-muted-foreground'>
                    {t('openPlatforms.traitsHint')}
                  </p>
                </div>
              )}
            </>
          ) : null}

          {error ? (
            <p role='alert' className='text-sm text-destructive'>
              {describeErrorText(error, i18n.t)}
            </p>
          ) : null}
        </div>

        <DialogFooter>
          {/* 按钮灰着的时候旁边说清差什么：新开的空表单一行红字都没敲就先骂起来
              没有意义，这两句合到这一行里说。 */}
          {missing.length ? (
            <p className='me-auto text-xs text-muted-foreground'>
              {t('openPlatforms.missingFields', {
                fields: missing.map((field) => MISSING_LABEL[field]).join('、'),
              })}
            </p>
          ) : null}
          <Button variant='outline' onClick={() => onOpenChange(false)}>
            {t('openPlatforms.cancel')}
          </Button>
          <Button
            disabled={pending || (!editing && !chosenKind) || blocked}
            onClick={submit}
          >
            {editing ? t('openPlatforms.save') : t('openPlatforms.add')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/**
 * 弹窗里现在这几格。
 *
 * 改的时候从平台上取现在的值（整单提交要的就是它们）。
 */
function toDraft(platform?: Upstream): Draft {
  if (!platform) {
    return {
      id: '',
      label: '',
      labelEdited: false,
      baseUrl: '',
      // 新增：地址是面板按类型预填的，用户没敲过。
      baseUrlEdited: false,
      // 空串：清单到手后由上面那个 effect 选第一条。
      choice: '',
      // 新增没有平台行，这一格没有意义（界面上也不摆）。
      traitsFromCommon: false,
      traitsFromCommonEdited: false,
      // 新增：还没配注入头，模板可以在选模板那一步预填。
      headers: [],
    }
  }
  return {
    id: platform.id,
    label: platform.label,
    // 平台上的名字是用户的值（改平台没有类型这一格，也没人换它）。
    labelEdited: true,
    baseUrl: platform.baseUrl,
    // 改平台时这一格是行上的值（用户自己存的那份）：当成敲过的。
    baseUrlEdited: true,
    // 改平台没有类型这一格（契约里 UpdatePlatform 没有它）。
    choice: '',
    // 还没动过：提交时不带这一格。
    traitsFromCommon: traitsFromCommonOf(platform),
    traitsFromCommonEdited: false,
    // 改平台：从服务端返回的模板回填（用户删光保存后这里就是空）。
    headers: platform.headers.map((item) => ({
      name: item.name,
      value: item.value,
    })),
  }
}

/**
 * 平台上这一格现在开着没有。
 *
 * 老服务端（或老库）的平台上没有这一格：那时按关显示 —— 这一格说是 true 才是
 * 开着，其余（false、缺失）都算关。
 */
function traitsFromCommonOf(platform: Upstream): boolean {
  return platform.traitsFromCommon === true
}
