// web/src/features/config/value-field.tsx — 配置项的值用什么控件、填得对不对。
//
// 契约说了三件事：kind（字符串/数字/布尔）、unit（数字的单位）、min/max（有没有界）。
// 面板照它们渲染，不按键名猜 —— 「_MS 结尾就当毫秒」这种推断在键名一改就悄悄失效。
//
// 值分两遍走：面板上显示与填写的是显示单位（毫秒项是秒），发出去的是传输单位
// （毫秒）。换算在 units.ts 里做，这里只调它。

import { useTranslation } from 'react-i18next'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { ConfigKind, ConfigUnit } from '@/gen/agentfacade/admin/v1/admin_pb'
import { displayMilliseconds, durationLanguage, isMilliseconds } from '@/features/config/units'

/** 正在改的这一项：面板要用的那几项契约字段。 */
export type EditingItem = {
  key: string
  title: string
  description: string
  secret: boolean
  kind: ConfigKind
  unit: ConfigUnit
  hasMin: boolean
  minValue: bigint
  hasMax: boolean
  maxValue: bigint
}

/** 输入控件的 id：Label 的 htmlFor 指到它，读屏器和自动化才找得到。 */
export const VALUE_FIELD_ID = 'config-value'

/** 填错了什么。面板层拦住，不发请求。 */
export type ValueProblem =
  | { kind: 'empty' }
  | { kind: 'notNumber' }
  | { kind: 'notBoolean' }
  | { kind: 'tooSmall'; limit: bigint }
  | { kind: 'tooLarge'; limit: bigint }

/**
 * 提交前拦一下：空值、不是数字、超界都不发请求。
 *
 * 服务端对数字项的脏值会静默落回默认值，用户看不到自己填错了 —— 面板自己拦。
 * 敏感项留空表示不改，那是另一条路（保存时干脆不发请求）。
 */
export function validateDraft(
  item: EditingItem,
  draft: string
): ValueProblem | null {
  const text = draft.trim()
  if (item.secret) return null
  if (text === '') return { kind: 'empty' }
  if (item.kind === ConfigKind.BOOLEAN) {
    return text === 'true' || text === 'false' ? null : { kind: 'notBoolean' }
  }
  if (item.kind !== ConfigKind.NUMBER) return null
  // 数字项只认整数：小数在这里是非法的，不在这里被四舍五入。
  if (!/^\d+$/.test(text)) return { kind: 'notNumber' }
  // 毫秒的单位：面板填秒，契约的界是毫秒，比的时候换过去。
  const value = isMilliseconds(item.unit) ? BigInt(text) * 1000n : BigInt(text)
  if (item.hasMin && value < item.minValue) {
    return { kind: 'tooSmall', limit: item.minValue }
  }
  if (item.hasMax && value > item.maxValue) {
    return { kind: 'tooLarge', limit: item.maxValue }
  }
  return null
}

/** 界值说给人听的形状：毫秒的界换算成秒，其余原样。 */
function limitText(
  limit: bigint,
  unit: ConfigUnit,
  language: ReturnType<typeof durationLanguage>
): string {
  if (!isMilliseconds(unit)) return limit.toString()
  return displayMilliseconds(limit.toString(), language)
}

/**
 * 配置项的值输入框。
 *
 * 三个分支：布尔是下拉框，数字是数字框（整数），其余是文本框。敏感项不管什么
 * kind 都是密码框 —— 它的值读不出来。
 */
export function ConfigValueField({
  item,
  value,
  onChange,
  problem,
}: {
  item: EditingItem
  value: string
  onChange: (next: string) => void
  problem: ValueProblem | null
}) {
  const { t, i18n } = useTranslation()
  const language = durationLanguage(i18n.language)
  const errorId = `${VALUE_FIELD_ID}-error`
  const invalid = problem !== null

  const error = (() => {
    if (!problem) return null
    switch (problem.kind) {
      case 'empty':
        return t('configPage.errorEmpty')
      case 'notNumber':
        return t('configPage.errorNotNumber')
      case 'notBoolean':
        return t('configPage.errorNotBoolean')
      case 'tooSmall':
        return t('configPage.errorTooSmall', {
          limit: limitText(problem.limit, item.unit, language),
        })
      case 'tooLarge':
        return t('configPage.errorTooLarge', {
          limit: limitText(problem.limit, item.unit, language),
        })
    }
  })()

  // 数字框上的 min/max：契约的界换算成显示单位（毫秒项是秒）。
  const minAttr = item.hasMin
    ? isMilliseconds(item.unit)
      ? String(Math.round(Number(item.minValue) / 1000))
      : item.minValue.toString()
    : undefined
  const maxAttr = item.hasMax
    ? isMilliseconds(item.unit)
      ? String(Math.round(Number(item.maxValue) / 1000))
      : item.maxValue.toString()
    : undefined

  const booleanText =
    value === 'true'
      ? t('configPage.booleanOn')
      : value === 'false'
        ? t('configPage.booleanOff')
        : value

  return (
    <div className='grid gap-2'>
      <Label htmlFor={VALUE_FIELD_ID}>{t('configPage.newValue')}</Label>
      {item.kind === ConfigKind.BOOLEAN && !item.secret ? (
        <Select value={value} onValueChange={onChange}>
          <SelectTrigger
            id={VALUE_FIELD_ID}
            aria-invalid={invalid}
            aria-describedby={error ? errorId : undefined}
          >
            {/* 当前值不在选项里时，Radix 自己找不到就退成占位符 —— 那是替服务端
                说话。触发器上的字由面板给。 */}
            <SelectValue placeholder={t('configPage.booleanUnset')}>
              {booleanText}
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value='true'>{t('configPage.booleanOn')}</SelectItem>
            <SelectItem value='false'>{t('configPage.booleanOff')}</SelectItem>
          </SelectContent>
        </Select>
      ) : item.kind === ConfigKind.NUMBER ? (
        <Input
          id={VALUE_FIELD_ID}
          type='number'
          step={1}
          min={minAttr}
          max={maxAttr}
          value={value}
          autoFocus
          aria-invalid={invalid}
          aria-describedby={error ? errorId : undefined}
          onChange={(event) => onChange(event.target.value)}
        />
      ) : (
        <Input
          id={VALUE_FIELD_ID}
          type={item.secret ? 'password' : 'text'}
          value={value}
          autoFocus
          aria-invalid={invalid}
          aria-describedby={error ? errorId : undefined}
          onChange={(event) => onChange(event.target.value)}
        />
      )}
      {error ? (
        <p id={errorId} role='alert' className='text-xs text-destructive'>
          {error}
        </p>
      ) : null}
      {isMilliseconds(item.unit) ? (
        <p className='text-xs text-muted-foreground'>
          {t('configPage.secondsHint')}
        </p>
      ) : null}
      {item.hasMin || item.hasMax ? (
        <p className='text-xs text-muted-foreground'>
          {item.hasMin && item.hasMax
            ? t('configPage.rangeHint', {
                min: limitText(item.minValue, item.unit, language),
                max: limitText(item.maxValue, item.unit, language),
              })
            : item.hasMin
              ? t('configPage.rangeMinHint', {
                  min: limitText(item.minValue, item.unit, language),
                })
              : t('configPage.rangeMaxHint', {
                  max: limitText(item.maxValue, item.unit, language),
                })}
        </p>
      ) : null}
    </div>
  )
}
