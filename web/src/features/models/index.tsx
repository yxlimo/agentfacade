import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import { create } from '@bufbuild/protobuf'
import { Pause, Pencil, Plus, Rocket, Trash2 } from 'lucide-react'
import {
  PublishedModelSchema,
  TargetBlocker,
  type PublishedModel,
  type PublishedTarget,
} from '@/gen/agentfacade/admin/v1/admin_pb'
import { PageShell } from '@/components/layout/page-shell'
import {
  EmptyState,
  ErrorState,
  LoadingState,
} from '@/components/async-state'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import {
  useDeletePublishedModel,
  usePublishedModels,
  useSavePublishedModel,
} from '@/features/models/api'
import { UNPUBLISHED_REASON_LABELS } from '@/features/upstreams/state'
import { UnpublishedReason } from '@/gen/agentfacade/admin/v1/admin_pb'
import { ModelDialog } from '@/features/models/model-dialog'
import { cooldownReasonLabel } from '@/features/upstreams/provider-accounts'
import { formatCount, formatDate, formatLocalMoment } from '@/lib/format'


/**
 * 列表上的策略徽章：后端给的是字符串，三选一查表，别把没见过的当成 single。
 */
const STRATEGY_LABEL_KEYS: Record<
  string,
  'models.strategySingle' | 'models.strategyFallback' | 'models.strategyBalance'
> = {
  single: 'models.strategySingle',
  fallback: 'models.strategyFallback',
  balance: 'models.strategyBalance',
};


/**
 * 模型目标上「为什么接不了」那一句。
 *
 * blocker 是枚举，句子在这里按语言渲染；只有冷却/额度这几种才有回复时刻和机器词，
 * 机器词跟平台行共用同一份映射。
 */
function targetBlockerReason(target: PublishedTarget, t: TFunction): string {
  switch (target.blocker) {
    case TargetBlocker.UPSTREAM_DISABLED:
      return t('models.blockerUpstreamDisabled')
    case TargetBlocker.NO_CREDENTIAL:
      return t('models.blockerNoCredential')
    case TargetBlocker.CREDENTIAL_EXPIRED:
      return t('models.blockerCredentialExpired')
    case TargetBlocker.CREDENTIAL_REJECTED:
      return t('models.blockerCredentialRejected')
    case TargetBlocker.OUT_OF_CREDITS:
    case TargetBlocker.COOLING: {
      let reason = t(
        target.blocker === TargetBlocker.COOLING
          ? 'models.blockerCooling'
          : 'models.blockerOutOfCredits'
      )
      if (target.recoversAtMs > 0n) {
        reason += t('models.blockerRecoversAt', {
          time: formatLocalMoment(target.recoversAtMs),
        })
      }
      if (target.blockerReason) {
        reason += t('upstreams.cooldownReason', {
          reason: cooldownReasonLabel(target.blockerReason, t),
        })
      }
      return reason
    }
    case TargetBlocker.QUEUED:
      return t('models.blockerQueued')
    case TargetBlocker.LOGGING_IN:
      return t('models.blockerLoggingIn')
    case TargetBlocker.UNKNOWN:
      return t('models.blockerUnknown')
    default:
      return ''
  }
}

/**
 *
 * 「当前指向」那行删了：颜色高亮已经说明路由落在哪个目标上，再写一遍名字
 * 是重复。目标都在但全被 ban 的情况，每个目标自己会写明为什么接不了，
 * 这里也不重复。
 */
function NoTargetLine({ model }: { model: PublishedModel }) {
  const { t } = useTranslation()
  if (model.targets.length > 0) return null
  return (
    <span className='text-xs text-muted-foreground'>
      {t('models.noTargets')}
    </span>
  )
}

export function PublishedModelsPage() {
  const { t } = useTranslation()
  const models = usePublishedModels()
  const save = useSavePublishedModel()
  const remove = useDeletePublishedModel()

  const [editing, setEditing] = useState<PublishedModel | undefined>(undefined)
  const [dialogOpen, setDialogOpen] = useState(false)
  const [deleting, setDeleting] = useState<PublishedModel | undefined>(undefined)
  const [disabling, setDisabling] = useState<PublishedModel | undefined>(undefined)
  const [busy, setBusy] = useState(false)

  const openCreate = () => {
    setEditing(undefined)
    setDialogOpen(true)
  }

  const openEdit = (model: PublishedModel) => {
    setEditing(model)
    setDialogOpen(true)
  }

  const submit = async (model: PublishedModel) => {
    setBusy(true)
    try {
      await save.mutateAsync(model)
      // 只有真的存成了才关弹窗。失败时 api 层已经报过错，弹窗留着，
      // 用户填的 id 和目标都还在。
      setDialogOpen(false)
    } catch {
      // 失败：不动弹窗。
    } finally {
      setBusy(false)
    }
  }

  const confirmDelete = async () => {
    if (!deleting) return
    setBusy(true)
    try {
      await remove.mutateAsync({ id: deleting.id })
      setDeleting(undefined)
    } catch {
      // 失败：对话框留着。
    } finally {
      setBusy(false)
    }
  }

  /**
   * 发布或者停用。
   *
   * 就是把这个模型原样再存一遍，只改 enabled —— 别的字段一个都不动。
   */
  const setEnabled = async (model: PublishedModel, enabled: boolean) => {
    setBusy(true)
    try {
      await save.mutateAsync(
        create(PublishedModelSchema, { ...model, enabled })
      )
    } catch {
      // 失败：api 层已经报过了。
    } finally {
      setBusy(false)
    }
  }

  if (models.isPending) {
    return <LoadingState />
  }
  if (models.isError) {
    return <ErrorState error={models.error} onRetry={() => models.refetch()} />
  }

  const list = models.data.models
  // 根路由现在真的公布了几个：模型在库里不等于公布了（上游全关着、
  // 目标模型上游没了，就没人能接）。
  const publishedCount = list.filter((model) => model.published).length

  return (
    <PageShell
      title={t('models.pageTitle')}
      description={t('models.pageDescription')}
      actions={
        <Button onClick={openCreate}>
          <Plus />
          {t('models.add')}
        </Button>
      }
    >
      <Card>
        <CardHeader>
          <CardTitle className='text-base'>{t('models.listTitle')}</CardTitle>
          <CardDescription>
            <span>
              {t('models.publishedCount', {
                published: publishedCount,
                total: list.length,
              })}
            </span>
          </CardDescription>
        </CardHeader>
        <CardContent className='px-0'>
          {list.length === 0 ? (
            <EmptyState
              title={t('models.emptyTitle')}
              action={
                <Button onClick={openCreate}>
                  <Plus />
                  {t('models.addOne')}
                </Button>
              }
            />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t('models.headPublicId')}</TableHead>
                  <TableHead>{t('models.headDisplayName')}</TableHead>
                  <TableHead>{t('models.headStrategy')}</TableHead>
                  <TableHead>{t('models.headContextOutput')}</TableHead>
                  <TableHead>{t('models.headTargets')}</TableHead>
                  <TableHead className='text-right'>
                    {t('models.headRequests')}
                  </TableHead>
                  <TableHead className='text-right'>
                    {t('models.headUpdated')}
                  </TableHead>
                  <TableHead className='text-right'>
                    {t('models.headActions')}
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {list.map((model) => (
                  <TableRow key={model.id}>
                    <TableCell>
                      <div className='grid gap-0.5'>
                        <span className='font-mono text-xs font-medium'>
                          {model.id}
                        </span>
                        <div className='flex flex-wrap gap-1'>
                          {!model.enabled ? (
                            <Badge variant='secondary'>
                              {t('models.disabledBadge')}
                            </Badge>
                          ) : null}
                          {/* 库里有不等于根路由公布了：上游关着、或者目标
                              模型的上游没了，都没人能接。published 说
                              有没有，unpublishedReason 说为什么。 */}
                          {model.published ? null : (
                            <Badge
                              variant='outline'
                              title={t('models.unpublishedHint')}
                            >
                              {t('models.unpublishedReason', {
                                reason:
                                  UNPUBLISHED_REASON_LABELS[
                                    model.unpublishedReason ??
                                      UnpublishedReason.UNSPECIFIED
                                  ] ?? t('models.reasonUnknown'),
                              })}
                            </Badge>
                          )}
                        </div>
                      </div>
                    </TableCell>
                    <TableCell>{model.displayName || '—'}</TableCell>
                    <TableCell>
                      <Badge variant='outline'>
                        {STRATEGY_LABEL_KEYS[model.strategy]
                          ? t(STRATEGY_LABEL_KEYS[model.strategy])
                          : model.strategy}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      {/* 继承之后的值：没填就是跟着目标走，目标之间不一致
                          时取最小的那个。库里存的是另一样东西（effective
                          那个字段是现算的）。 */}
                      <span className='font-mono text-xs'>
                        {model.effective?.contextWindow
                          ? formatCount(model.effective.contextWindow)
                          : t('models.inherit')}
                        {' / '}
                        {model.effective?.maxOutputTokens
                          ? formatCount(model.effective.maxOutputTokens)
                          : t('models.inherit')}
                      </span>
                    </TableCell>
                    <TableCell>
                      <div className='grid gap-1'>
                        <NoTargetLine model={model} />
                        {model.targets.length === 0 ? null : (
                          model.targets.map((target) => {
                            const blockerReason = targetBlockerReason(target, t)
                            return (
                            <div
                              key={`${target.groupName}-${target.upstreamModel}`}
                              className='grid gap-0.5'
                            >
                              <div className='flex items-center gap-1'>
                                <span
                                  className={[
                                    'max-w-[200px] font-mono text-xs break-all',
                                    // 当前目标只靠颜色认：文字标记一律不要。
                                    target.current
                                      ? 'text-emerald-600 dark:text-emerald-400'
                                      : target.blocked
                                        ? 'text-red-600 dark:text-red-400'
                                        : '',
                                  ].join(' ')}
                                >
                                  {target.groupName} → {target.upstreamModel}
                                </span>
                                {target.blocked && blockerReason ? (
                                  // 接不了的目标标红，写明为什么、什么时候能再接。
                                  <span
                                    className='rounded border border-red-500/40 px-1 text-[10px] font-medium text-red-600 dark:text-red-400'
                                    title={blockerReason}
                                  >
                                    {t('models.targetBlocked', {
                                      reason: blockerReason,
                                    })}
                                  </span>
                                ) : null}
                              </div>
                              <span className='text-xs text-muted-foreground'>
                                {t('models.requestCount', {
                                  count: formatCount(target.requests),
                                })}
                                {target.failed > 0n
                                  ? t('models.failedCount', {
                                      count: formatCount(target.failed),
                                    })
                                  : ''}
                                {!target.enabled ? t('models.targetDisabled') : ''}
                                {target.blocked &&
                                target.recoversAtMs > 0n &&
                                target.blocker !== TargetBlocker.OUT_OF_CREDITS &&
                                target.blocker !== TargetBlocker.COOLING
                                  ? t('models.recoversAt', {
                                      at: formatLocalMoment(target.recoversAtMs),
                                    })
                                  : ''}
                              </span>
                            </div>
                            )
                          })
                        )}
                      </div>
                    </TableCell>
                    <TableCell className='text-right font-mono'>
                      {formatCount(
                        model.targets.reduce(
                          (sum, target) => sum + target.requests,
                          0n
                        )
                      )}
                    </TableCell>
                    <TableCell className='text-right text-xs text-muted-foreground'>
                      {formatDate(model.updatedAt)}
                    </TableCell>
                    <TableCell className='text-right'>
                      <div className='flex justify-end gap-2'>
                        {model.enabled ? (
                          <Button
                            variant='outline'
                            size='sm'
                            disabled={busy}
                            onClick={() => setDisabling(model)}
                          >
                            <Pause />
                            {t('models.disable')}
                          </Button>
                        ) : (
                          <Button
                            variant='outline'
                            size='sm'
                            disabled={busy}
                            onClick={() => void setEnabled(model, true)}
                          >
                            <Rocket />
                            {t('models.publish')}
                          </Button>
                        )}
                        <Button
                          variant='outline'
                          size='icon'
                          title={t('models.edit')}
                          aria-label={t('models.edit')}
                          onClick={() => openEdit(model)}
                        >
                          <Pencil />
                        </Button>
                        <Button
                          variant='ghost'
                          size='icon'
                          title={t('models.delete')}
                          aria-label={t('models.delete')}
                          onClick={() => setDeleting(model)}
                        >
                          <Trash2 />
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <ModelDialog
        open={dialogOpen}
        model={editing}
        busy={busy}
        onOpenChange={setDialogOpen}
        onSubmit={(model) => void submit(model)}
      />

      <Dialog
        open={disabling !== undefined}
        onOpenChange={(open) => {
          if (!open) setDisabling(undefined)
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('models.disableTitle')}</DialogTitle>
            <DialogDescription>
              <span className='font-mono'>{disabling?.id}</span>{' '}
              {t('models.disableDescription')}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant='outline'
              onClick={() => setDisabling(undefined)}
              disabled={busy}
            >
              {t('models.cancel')}
            </Button>
            <Button
              onClick={() => {
                const model = disabling
                if (!model) return
                setDisabling(undefined)
                void setEnabled(model, false)
              }}
              disabled={busy}
            >
              {t('models.disable')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={deleting !== undefined}
        onOpenChange={(open) => {
          if (!open) setDeleting(undefined)
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('models.deleteTitle')}</DialogTitle>
            <DialogDescription>
              <span className='font-mono'>{deleting?.id}</span>{' '}
              {t('models.deleteDescription')}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant='outline'
              onClick={() => setDeleting(undefined)}
              disabled={busy}
            >
              {t('models.cancel')}
            </Button>
            <Button
              variant='destructive'
              disabled={busy}
              onClick={() => void confirmDelete()}
            >
              {t('models.delete')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </PageShell>
  )
}
