import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
// 语言实例：测试里单点渲染时也要有 i18n（app 入口在 main.tsx 里引）。
import '@/lib/i18n'
import { useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import {
  CheckCircle2,
  ExternalLink,
  KeyRound,
  Loader2,
  LogIn,
  RotateCcw,
  XCircle,
} from 'lucide-react'
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
import { Checkbox } from '@/components/ui/checkbox'
import {
  useCancelLogin,
  useExchangeLoginCode,
  useImportLoginToken,
  useLoginStatus,
  useLoginWithPassword,
} from '@/features/login/api'
import { useUpstreams } from '@/features/upstreams/api'
import { humanMessage } from '@/lib/errors'
import { invalidateServerData } from '@/lib/server-data'
import { formatCountdown } from '@/lib/format'

type LoginDialogProps = {
  open: boolean
  /** 这次登录的 id。空 = 还没开始。 */
  loginId: string
  /** 上次点的那个账号：会话没了也要能「重新发起」。 */
  upstreamId?: string
  accountId?: string
  accountLabel?: string
  onOpenChange: (open: boolean) => void
  /** 「重新发起」：重新发起一次登录。 */
  onRestart?: () => void
}

export function LoginDialog({
  open,
  loginId,
  upstreamId,
  accountId,
  accountLabel,
  onOpenChange,
  onRestart,
}: LoginDialogProps) {
  const { t } = useTranslation()
  const status = useLoginStatus(loginId)
  const cancel = useCancelLogin()
  const session = status.data?.session
  const queryClient = useQueryClient()
  // 这个上游是哪一类：登录方式看 kind，不看 id —— id 是用户起的。
  // 列表在别处已经拿过了，这里只读，不要再发一次请求。
  const upstreams = useUpstreams({ refetchOnMount: false })
  const upstreamKind =
    upstreams.data?.upstreams.find(
      (u) => u.id === (upstreamId ?? session?.upstreamId ?? '')
    )?.kind ?? ''
  // 登录成功只说一次。
  const announced = useRef('')

  // 成了：关掉对话框，说一声，把凭据那几摊重新取一遍。
  useEffect(() => {
    if (session?.status !== 'approved') return
    // 「说一声」只说一次；关对话框每次都要做（同一个会话可能被重新打开）。
    if (announced.current !== session.loginId) {
      announced.current = session.loginId
      toast.success(humanMessage(session.message) || t('login.loginDone'))
    }
    // 登录好了，账号那一行与平台的状态都变了（从「没登录」变成「就绪」）。
    invalidateServerData(queryClient, 'credentials')
    onOpenChange(false)
  }, [session?.status, session?.loginId, session?.message, onOpenChange, queryClient])

  const title = useMemo(() => {
    if (accountLabel) return t('login.loginAccount', { name: accountLabel })
    if (session?.upstreamId) return t('login.loginAccount', { name: session.upstreamId })
    return t('login.title')
  }, [accountLabel, session?.upstreamId, t])

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className='sm:max-w-lg'>
        <DialogHeader>
          <DialogTitle className='flex items-center gap-2'>
            <LogIn className='size-4' />
            {title}
          </DialogTitle>
          {/* 还在进行中时，这句话是「下一步该干什么」；结束了的话，结果块
              里已经有一句结果了，这里就不说。 */}
          {session && session.status === 'pending' ? (
            <DialogDescription>
              {humanMessage(session.message)}
            </DialogDescription>
          ) : null}
        </DialogHeader>

        {!session && status.isPending ? (
          <p className='flex items-center gap-2 py-6 text-sm text-muted-foreground'>
            <Loader2 className='size-4 animate-spin' />
            {t('login.fetchingStatus')}
          </p>
        ) : null}

        {!session && status.isError ? (
          <div className='grid gap-3 py-4'>
            <p className='text-sm text-destructive'>
              {t('login.cannotContinue', {
                reason:
                  humanMessage(
                    status.error instanceof Error ? status.error.message : ''
                  ) || t('login.sessionGone'),
              })}
            </p>
            {onRestart ? (
              <Button variant='outline' onClick={onRestart}>
                <RotateCcw />
                {t('login.restart')}
              </Button>
            ) : null}
          </div>
        ) : null}

        {session ? (
          <div className='grid gap-4'>
            {session.status === 'approved' ? (
              <LoginResult ok message={t('login.loginDone')} />
            ) : null}
            {session.status === 'failed' ? (
              <LoginResult
                ok={false}
                message={humanMessage(session.message) || t('login.loginFailed')}
                onRestart={onRestart}
              />
            ) : null}
            {session.status === 'expired' ? (
              <LoginResult
                ok={false}
                message={t('login.loginExpired')}
                onRestart={onRestart}
              />
            ) : null}
            {session.status === 'cancelled' ? (
              <LoginResult ok={false} message={t('login.loginCancelled')} />
            ) : null}

            {session.status === 'pending' ? (
              <LoginBody
                session={session}
                upstreamId={upstreamId ?? session.upstreamId}
                accountId={accountId ?? session.accountId}
                kind={upstreamKind}
                onCancel={() => cancel.mutate(loginId)}
                onDone={() => onOpenChange(false)}
                cancelling={cancel.isPending}
              />
            ) : null}
          </div>
        ) : null}

        <DialogFooter>
          <Button
            variant='outline'
            onClick={() => onOpenChange(false)}
            disabled={cancel.isPending}
          >
            {t('common.close')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/** 登录结果：成了或者败了。 */
function LoginResult({
  ok,
  message,
  onRestart,
}: {
  ok: boolean
  message: string
  onRestart?: () => void
}) {
  const { t } = useTranslation()
  return (
    <div className='grid gap-3 rounded-lg border p-3'>
      <p
        className={`flex items-center gap-2 text-sm ${
          ok ? 'text-emerald-600 dark:text-emerald-400' : 'text-destructive'
        }`}
      >
        {ok ? (
          <CheckCircle2 className='size-4' />
        ) : (
          <XCircle className='size-4' />
        )}
        {message}
      </p>
      {onRestart ? (
        <Button variant='outline' size='sm' className='w-fit' onClick={onRestart}>
          <RotateCcw />
          {t('login.restart')}
        </Button>
      ) : null}
    </div>
  )
}

type Session = {
  method: string
  authorizationUrl: string
  userCode: string
  expiresAt: bigint
  message: string
  username: string
}

/** 还没结束的时候，按登录方式画不同的东西。 */
function LoginBody({
  session,
  upstreamId,
  accountId,
  kind,
  onCancel,
  onDone,
  cancelling,
}: {
  session: Session
  upstreamId: string
  accountId: string
  /** 这个上游是哪一类（kind）。登录方式按它来。 */
  kind: string
  onCancel: () => void
  onDone: () => void
  cancelling: boolean
}) {
  switch (session.method) {
    case 'password':
      return (
        <PasswordForm
          session={session}
          upstreamId={upstreamId}
          accountId={accountId}
          kind={kind}
          onDone={onDone}
        />
      )
    case 'token':
      return (
        <TokenForm
          session={session}
          upstreamId={upstreamId}
          accountId={accountId}
          onDone={onDone}
        />
      )
    case 'code':
      return (
        <CodeForm
          session={session}
          upstreamId={upstreamId}
          accountId={accountId}
          onDone={onDone}
        />
      )
    default:
      return (
        <AuthorizationForm session={session} onCancel={onCancel} cancelling={cancelling} />
      )
  }
}

/**
 * 授权链接型（device / browser）。
 *
 * 用户在自己浏览器里点同意，后端在后台轮，面板只管问进度。
 */
function AuthorizationForm({
  session,
  onCancel,
  cancelling,
}: {
  session: Session
  onCancel: () => void
  cancelling: boolean
}) {
  const remaining = useCountdown(session.expiresAt)
  const { t } = useTranslation()

  return (
    <div className='grid gap-4'>
      {session.authorizationUrl ? (
        <div className='grid gap-1.5'>
          <Label>{t('login.authorizationUrl')}</Label>
          <a
            href={session.authorizationUrl}
            target='_blank'
            rel='noreferrer'
            className='flex items-center gap-2 rounded-md border px-3 py-2 font-mono text-xs underline underline-offset-4 break-all hover:bg-accent'
          >
            {session.authorizationUrl}
            <ExternalLink className='size-3 shrink-0' />
          </a>
          <p className='text-xs text-muted-foreground'>
            {t('login.openInBrowserHint')}
          </p>
        </div>
      ) : null}

      {session.userCode ? (
        <div className='grid gap-1.5'>
          <Label>{t('login.userCode')}</Label>
          <p className='rounded-md border bg-muted/40 px-3 py-3 text-center font-mono text-3xl tracking-[0.3em]'>
            {session.userCode}
          </p>
          <p className='text-xs text-muted-foreground'>
            {t('login.userCodeHint')}
          </p>
        </div>
      ) : null}

      <div className='grid gap-1'>
        <p className='flex items-center gap-2 text-sm'>
          <Loader2 className='size-4 animate-spin' />
          {t('login.waitingApproval')}
        </p>
        <p className='text-xs text-muted-foreground'>
          {remaining > 0
            ? t('login.remaining', { time: formatCountdown(remaining) })
            : t('login.expiringSoon')}
        </p>
      </div>

      <Button
        variant='outline'
        className='w-fit'
        onClick={onCancel}
        disabled={cancelling}
      >
        {cancelling ? <Loader2 className='animate-spin' /> : null}
        {t('login.cancelLogin')}
      </Button>
    </div>
  )
}

/** 账号密码型（tokenrhythm / sensenova）。 */
function PasswordForm({
  session,
  upstreamId,
  accountId,
  kind,
  onDone,
}: {
  session: Session
  upstreamId: string
  accountId: string
  /** 这个上游是哪一类（kind）。 */
  kind: string
  onDone: () => void
}) {
  const [username, setUsername] = useState(session.username ?? '')
  const [password, setPassword] = useState('')
  const [remember, setRemember] = useState(false)
  const login = useLoginWithPassword()
  const { t } = useTranslation()

  // SenseNova 的 cookie 就是会话本身：留不留密码都一样用得上，后端那边
  // 登录完总是把存的密码擦掉、只留 cookie。所以这个上游不给「记住密码」
  // 这个选项 —— 给了一个说了也不算的选项。
  // 按 kind 判，不按上游 id：id 是用户起的，会变。
  const canRemember = kind !== 'sensenova'

  return (
    <form
      className='grid gap-3'
      onSubmit={(event) => {
        event.preventDefault()
        login.mutate(
          { upstreamId, accountId, username, password, remember },
          { onSuccess: onDone }
        )
      }}
    >
      <div className='grid gap-1.5'>
        <Label htmlFor='login-username'>{t('login.username')}</Label>
        <Input
          id='login-username'
          value={username}
          autoComplete='username'
          onChange={(event) => setUsername(event.target.value)}
          placeholder={t('login.usernamePlaceholder')}
        />
      </div>
      <div className='grid gap-1.5'>
        <Label htmlFor='login-password'>{t('login.password')}</Label>
        <Input
          id='login-password'
          type='password'
          value={password}
          autoComplete='current-password'
          onChange={(event) => setPassword(event.target.value)}
        />
      </div>
      {canRemember ? (
        <label className='flex items-center gap-2 text-sm'>
          <Checkbox
            checked={remember}
            onCheckedChange={(checked) => setRemember(checked === true)}
          />
          {t('login.rememberPassword')}
        </label>
      ) : null}
      <Button type='submit' disabled={login.isPending} className='w-fit'>
        {login.isPending ? <Loader2 className='animate-spin' /> : <KeyRound />}
        {t('login.login')}
      </Button>
    </form>
  )
}

/**
 * 人机校验型（intern-ai）。
 *
 * 人机校验只能人自己在浏览器里过：面板给链接，用户登完把 token 贴回来。
 */
function TokenForm({
  session,
  upstreamId,
  accountId,
  onDone,
}: {
  session: Session
  upstreamId: string
  accountId: string
  onDone: () => void
}) {
  const [token, setToken] = useState('')
  const importToken = useImportLoginToken()
  const { t } = useTranslation()

  return (
    <form
      className='grid gap-3'
      onSubmit={(event) => {
        event.preventDefault()
        importToken.mutate({ upstreamId, accountId, token }, { onSuccess: onDone })
      }}
    >
      <div className='grid gap-1.5'>
        <Label>{t('login.ssoLink')}</Label>
        <a
          href={session.authorizationUrl}
          target='_blank'
          rel='noreferrer'
          className='flex items-center gap-2 rounded-md border px-3 py-2 font-mono text-xs underline underline-offset-4 break-all hover:bg-accent'
        >
          {session.authorizationUrl}
          <ExternalLink className='size-3 shrink-0' />
        </a>
      </div>

      <div className='rounded-md border border-amber-500/40 bg-amber-500/5 p-3'>
        <p className='text-sm'>{t('login.captchaNote')}</p>
        <ol className='mt-2 grid gap-1 text-xs text-muted-foreground'>
          <li>{t('login.captchaStep1')}</li>
          <li>{t('login.captchaStep2')}</li>
          <li>{t('login.captchaStep3')}</li>
        </ol>
      </div>

      <div className='grid gap-1.5'>
        <Label htmlFor='login-token'>{t('login.tokenLabel')}</Label>
        <Input
          id='login-token'
          value={token}
          onChange={(event) => setToken(event.target.value)}
          placeholder={t('login.tokenPlaceholder')}
        />
      </div>

      <Button type='submit' disabled={importToken.isPending} className='w-fit'>
        {importToken.isPending ? (
          <Loader2 className='animate-spin' />
        ) : (
          <KeyRound />
        )}
        {t('login.importToken')}
      </Button>
    </form>
  )
}

/** 授权码型（intern-ai 的另一条路）。 */
function CodeForm({
  session,
  upstreamId,
  accountId,
  onDone,
}: {
  session: Session
  upstreamId: string
  accountId: string
  onDone: () => void
}) {
  const [code, setCode] = useState('')
  const exchange = useExchangeLoginCode()
  const { t } = useTranslation()

  return (
    <form
      className='grid gap-3'
      onSubmit={(event) => {
        event.preventDefault()
        exchange.mutate({ upstreamId, accountId, code }, { onSuccess: onDone })
      }}
    >
      <div className='grid gap-1.5'>
        <Label>{t('login.codeLink')}</Label>
        <a
          href={session.authorizationUrl}
          target='_blank'
          rel='noreferrer'
          className='flex items-center gap-2 rounded-md border px-3 py-2 font-mono text-xs underline underline-offset-4 break-all hover:bg-accent'
        >
          {session.authorizationUrl}
          <ExternalLink className='size-3 shrink-0' />
        </a>
      </div>

      <div className='grid gap-1.5'>
        <Label htmlFor='login-code'>{t('login.authCode')}</Label>
        <Input
          id='login-code'
          value={code}
          onChange={(event) => setCode(event.target.value)}
          placeholder={t('login.codePlaceholder')}
        />
      </div>

      <Button type='submit' disabled={exchange.isPending} className='w-fit'>
        {exchange.isPending ? (
          <Loader2 className='animate-spin' />
        ) : (
          <KeyRound />
        )}
        {t('login.login')}
      </Button>
    </form>
  )
}

/** 剩下的秒数。每秒走一格。 */
function useCountdown(expiresAt: bigint | number): number {
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [])

  const ms = Number(expiresAt ?? 0)
  if (!ms) return 0
  return Math.max(0, Math.floor((ms - now) / 1000))
}
