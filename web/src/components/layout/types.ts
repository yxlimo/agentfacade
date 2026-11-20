import { type LinkProps } from '@tanstack/react-router'

/** 导航标题是词条键，渲染边界再翻译。 */
type NavTitleKey =
  | 'shell.navOverview'
  | 'shell.navGateway'
  | 'shell.navPlatforms'
  | 'shell.navPlugins'
  | 'shell.navQuotas'
  | 'shell.navCheckin'
  | 'shell.navUsage'
  | 'shell.navModels'
  | 'shell.navConfig'

type BaseNavItem = {
  title: NavTitleKey
  badge?: string
  icon?: React.ElementType
}

type NavLink = BaseNavItem & {
  url: LinkProps['to'] | (string & {})
  items?: never
}

type NavCollapsible = BaseNavItem & {
  items: (BaseNavItem & { url: LinkProps['to'] | (string & {}) })[]
  url?: never
}

type NavItem = NavCollapsible | NavLink

type NavGroup = {
  title: NavTitleKey
  items: NavItem[]
}

type SidebarData = {
  navGroups: NavGroup[]
}

export type { SidebarData, NavGroup, NavItem, NavCollapsible, NavLink }
