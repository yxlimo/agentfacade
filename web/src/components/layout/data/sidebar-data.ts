import {
  Boxes,
  CalendarCheck,
  CircleDollarSign,
  LayoutDashboard,
  Layers,
  PlugZap,
  Settings2,
  Wallet,
} from 'lucide-react'
import { type SidebarData } from '../types'

export const sidebarData: SidebarData = {
  navGroups: [
    {
      title: 'shell.navOverview',
      items: [
        {
          title: 'shell.navOverview',
          url: '/',
          icon: LayoutDashboard,
        },
      ],
    },
    {
      title: 'shell.navGateway',
      items: [
        {
          title: 'shell.navPlatforms',
          url: '/upstreams',
          icon: Boxes,
        },
        {
          title: 'shell.navPlugins',
          url: '/quota-plugins',
          icon: PlugZap,
        },
        {
          title: 'shell.navQuotas',
          url: '/balance',
          icon: Wallet,
        },
        {
          title: 'shell.navCheckin',
          url: '/checkin',
          icon: CalendarCheck,
        },
        {
          title: 'shell.navUsage',
          url: '/usage',
          icon: CircleDollarSign,
        },
        {
          title: 'shell.navModels',
          url: '/models',
          icon: Layers,
        },
        {
          title: 'shell.navConfig',
          url: '/config',
          icon: Settings2,
        },
      ],
    },
  ],
}
