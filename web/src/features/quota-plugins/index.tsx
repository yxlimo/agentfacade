import { useMemo, useState } from 'react'
import { useIsFetching } from '@tanstack/react-query'
import { toast } from 'sonner'
import { ChevronRight } from 'lucide-react'
import { PageShell } from '@/components/layout/page-shell'
import {
  EmptyState,
  ErrorState,
  LoadingState,
} from '@/components/async-state'
import { Card, CardContent } from '@/components/ui/card'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import {
  upstreamKeys,
  useDeleteAccount,
  useProviderKinds,
  useSetAccountEnabled,
  useUpdateProvider,
  useUpstreams,
} from '@/features/upstreams/api'
import { useQuotaPlugins } from '@/features/open-platforms/api'
import { ProviderAccounts } from '@/features/upstreams/provider-accounts'
import { ProviderKeysDialog } from '@/features/accounts/provider-keys-dialog'
import {
  providerKeyAccess,
  providerKindsFrom,
} from '@/features/accounts/provider-key-fields'
import { useSetProviderKeys } from '@/features/accounts/api'
import { useAccountLogin } from '@/features/login/use-account-login'
import { LoginDialog } from '@/features/login/login-dialog'
import type { Account, QuotaPluginPlatform, Upstream } from '@/gen/buddy/admin/v1/admin_pb'

/**
 * 插件列表页：服务端登记的额度插件，一行一个。
 *
 * 插件按平台地址自动匹配，匹配结果由服务端算好跟着答复走（QuotaPlugin.platforms
 * 与 Upstream.quota_plugin_*）：这一页把对应关系摆出来 —— 每个插件现在用到它的
 * 平台与账号。逐账号填凭据沿用平台页那套（ProviderAccounts + 凭据格子跟平台行
 * 走），不另造表单。
 */
export function QuotaPluginsPage() {
  const pluginsQuery = useQuotaPlugins()
  const upstreams = useUpstreams()
  const providerKindsQuery = useProviderKinds()

  const setEnabled = useSetAccountEnabled()
  const updateProvider = useUpdateProvider()
  const deleteAccount = useDeleteAccount()
  const setKeys = useSetProviderKeys()
  const login = useAccountLogin()

  /** 展开着的那个插件：点一行看匹配到它的平台与账号。 */
  const [expanded, setExpanded] = useState<string | null>(null)
  /** 正在填 key 的账号 id。 */
  const [keysFor, setKeysFor] = useState<string | null>(null)
  /** 待注销的账号。 */
  const [deleteTarget, setDeleteTarget] = useState<Account | null>(null)

  // 列表在重取的时候开关别动：开关的值以服务端的答复为准。
  const refreshing = useIsFetching({ queryKey: upstreamKeys.all }) > 0

  const plugins = useMemo(
    () => pluginsQuery.data?.plugins ?? [],
    [pluginsQuery.data]
  )
  const platforms = useMemo(
    () => upstreams.data?.upstreams ?? [],
    [upstreams.data]
  )
  /** 平台 id → 平台行：插件自带的平台清单只有 id，账号与 kind 要回表里拿。 */
  const upstreamOf = useMemo(
    () => new Map(platforms.map((upstream) => [upstream.id, upstream])),
    [platforms]
  )

  if (pluginsQuery.isPending || upstreams.isPending) {
    return <LoadingState />
  }
  if (pluginsQuery.isError) {
    return (
      <ErrorState
        error={pluginsQuery.error}
        onRetry={() => pluginsQuery.refetch()}
      />
    )
  }
  if (upstreams.isError) {
    return (
      <ErrorState error={upstreams.error} onRetry={() => upstreams.refetch()} />
    )
  }

  // 两份登记表：凭据格子数由平台行带来的插件那几段说了算（服务端匹配好），
  // 判据都在 providerKeyAccess 那一层，这里只照结果渲染。
  const providerKinds = providerKindsFrom({
    isPending: providerKindsQuery.isPending,
    isError: providerKindsQuery.isError,
    error: providerKindsQuery.error,
    kinds: providerKindsQuery.data?.kinds,
  })
  const accessOf = (upstream: Upstream) =>
    providerKeyAccess({
      kind: upstream.kind,
      isOpenPlatform: upstream.isOpenPlatform,
      platformLabel: upstream.label || upstream.id,
      quotaPluginFields: upstream.quotaPluginFields,
      quotaPluginLabel: upstream.quotaPluginLabel,
      kinds: providerKinds,
    })

  // 每个插件现在用到它的平台：插件自带的清单原样拿来，回平台表里补齐
  // 账号与凭据格子。行不在表里（刚删掉的那种瞬间）就跳过。
  const matchedOf = (pluginId: string): Upstream[] =>
    (plugins.find((plugin) => plugin.id === pluginId)?.platforms ?? [])
      .map((entry: QuotaPluginPlatform) => upstreamOf.get(entry.platformId))
      .filter((row): row is Upstream => row !== undefined)

  const loginTarget = login.target
  const restartLogin = loginTarget
    ? () =>
        login.start({
          upstreamId: loginTarget.upstreamId,
          id: loginTarget.accountId,
          label: loginTarget.label,
        })
    : undefined

  const keysTarget = keysFor ? findAccount(platforms, keysFor) : undefined
  const keysAccess = keysTarget ? accessOf(keysTarget.upstream) : undefined
  // 弹窗只在格子数说得准的时候开：说不准就发上去一个短一截的 keys 数组，
  // 服务端按位置写，短掉的那几段就被清成空串了。
  const keysLayout =
    keysAccess?.status === 'ready' ? keysAccess.layout : null

  return (
    <PageShell
      title='插件列表'
      description='服务端登记的额度插件：插件按平台地址自动匹配，对不上任何插件的平台没有额度接口。'
    >
      <Card>
        <CardContent className='px-0'>
          {plugins.length === 0 ? (
            <EmptyState title='服务端没有登记任何额度插件' />
          ) : (
            <div
              role='list'
              aria-label='插件列表'
              className='grid gap-0'
            >
              {plugins.map((plugin) => {
                const isExpanded = expanded === plugin.id
                const matched = matchedOf(plugin.id)
                return (
                  <div
                    key={plugin.id}
                    role='listitem'
                    aria-label={`额度插件 ${plugin.label}`}
                    className='border-b last:border-b-0'
                  >
                    <button
                      type='button'
                      aria-expanded={isExpanded}
                      aria-label={`${
                        isExpanded ? '收起' : '展开'
                      } ${plugin.label} 的平台与账号`}
                      onClick={() =>
                        setExpanded(isExpanded ? null : plugin.id)
                      }
                      className='flex w-full items-center gap-2 px-4 py-3 text-left hover:bg-accent'
                    >
                      <ChevronRight
                        className={`size-4 shrink-0 transition-transform ${
                          isExpanded ? 'rotate-90' : ''
                        }`}
                      />
                      <span className='font-medium'>{plugin.label}</span>
                    </button>
                    <div className='grid gap-1 px-4 pb-3 ps-10'>
                      {plugin.baseUrls.length ? (
                        plugin.baseUrls.map((base) => (
                          <span
                            key={base}
                            className='font-mono text-xs break-all text-muted-foreground'
                          >
                            {base}
                          </span>
                        ))
                      ) : (
                        <span className='text-xs text-muted-foreground'>
                          没有声明地址
                        </span>
                      )}
                    </div>
                    {isExpanded ? (
                      <div className='grid gap-4 px-4 pb-4 ps-10'>
                        {matched.length === 0 ? (
                          <p className='text-sm text-muted-foreground'>
                            暂无平台使用这个插件
                          </p>
                        ) : (
                          matched.map((upstream) => (
                            <div
                              key={upstream.id}
                              className='grid gap-2 rounded-md border p-3'
                            >
                              <div className='grid gap-0.5'>
                                <span className='text-sm font-medium'>
                                  {upstream.label || upstream.id}
                                </span>
                                <span className='font-mono text-xs break-all text-muted-foreground'>
                                  {upstream.baseUrl}
                                </span>
                              </div>                              <ProviderAccounts
                                access={accessOf(upstream)}
                                accounts={upstream.accounts}
                                loggingIn={login.pending}
                                busyAccountId={
                                  setEnabled.isPending
                                    ? (setEnabled.variables?.accountId ??
                                      null)
                                    : null
                                }
                                refreshing={refreshing}
                                onLogin={(account) =>
                                  login.start({
                                    upstreamId: upstream.id,
                                    id: account.id,
                                    label: account.alias || account.id,
                                  })
                                }
                                onDelete={(account) => setDeleteTarget(account)}
                                onToggleEnabled={(account, enabled) =>
                                  setEnabled.mutate({
                                    accountId: account.id,
                                    enabled,
                                  })
                                }
                                onRename={(account, alias) =>
                                  updateProvider.mutate({
                                    id: account.id,
                                    alias,
                                  })
                                }
                                onWeightChange={(account, weight) =>
                                  updateProvider.mutate({
                                    id: account.id,
                                    // 契约里的别名没有 presence 位：不带它就是清掉。
                                    // 只改权重时把现在的别名一起带上。
                                    alias: account.alias ?? '',
                                    weight,
                                  })
                                }
                                onManageKeys={(account) => {
                                  // 账号不在列表里了：不要把 key 写到别处去。
                                  if (!findAccount(platforms, account.id)) {
                                    toast.error('找不到这个账号', {
                                      description: `${account.id} 不在平台列表里`,
                                    })
                                    return
                                  }
                                  setKeysFor(account.id)
                                }}
                              />
                            </div>
                          ))
                        )}
                      </div>
                    ) : null}
                  </div>
                )
              })}
            </div>
          )}
        </CardContent>
      </Card>

      <LoginDialog
        open={login.target !== null || login.loginId !== ''}
        loginId={login.loginId}
        upstreamId={login.target?.upstreamId}
        accountId={login.target?.accountId}
        accountLabel={login.target?.label}
        onOpenChange={(open) => {
          if (open) return
          login.close()
        }}
        onRestart={restartLogin}
      />

      {/* 凭据弹窗：这一类不用填 key（或者账号找不到了）时没有弹窗。 */}
      <ProviderKeysDialog
        open={keysTarget !== undefined && keysLayout !== null}
        layout={keysLayout}
        onOpenChange={(open) => {
          if (!open) setKeysFor(null)
        }}
        pending={setKeys.isPending}
        onSubmit={(keys) => {
          if (!keysTarget) return
          setKeys.mutate(
            { accountId: keysTarget.account.id, keys },
            {
              onSuccess: () => setKeysFor(null),
            }
          )
        }}
      />

      {/* 注销要确认：这一行删掉就没了，凭据也跟着删。 */}
      <AlertDialog
        open={deleteTarget !== null}
        onOpenChange={(open) => {
          if (!open) setDeleteTarget(null)
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              注销 {deleteTarget ? deleteTarget.alias || deleteTarget.id : ''}
            </AlertDialogTitle>
            <AlertDialogDescription>
              删除该账号会同时删除其名下的 {deleteTarget?.credentialCount ?? 0}{' '}
              条凭据，且不可恢复。平台本身保留，客户端的地址不变
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction
              variant='destructive'
              onClick={() => {
                const target = deleteTarget
                setDeleteTarget(null)
                if (!target) return
                deleteAccount.mutate({ id: target.id })
              }}
            >
              注销
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </PageShell>
  )
}

/**
 * 在所有平台的账号里找一个账号。
 *
 * 找到时把它所在的平台一起带出来：key 的种类与格子看平台，不看账号。
 */
function findAccount(
  list: Upstream[],
  accountId: string
): { account: Account; upstream: Upstream } | undefined {
  for (const upstream of list) {
    const account = upstream.accounts.find((row) => row.id === accountId)
    if (account) return { account, upstream }
  }
  return undefined
}
