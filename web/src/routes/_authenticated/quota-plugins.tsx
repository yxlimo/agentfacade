import { createFileRoute } from '@tanstack/react-router'
import { QuotaPluginsPage } from '@/features/quota-plugins'

export const Route = createFileRoute('/_authenticated/quota-plugins')({
  component: QuotaPluginsPage,
})
