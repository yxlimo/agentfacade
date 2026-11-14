import {
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import { GripVertical } from 'lucide-react'
import { cn } from '@/lib/utils'

/**
 * 拖拽排序列表：平台页的排序模式与主路由弹窗的排序模式共用这一套。
 *
 * 拖动走 Pointer Events（不用 HTML5 DnD）：触屏上 draggable 根本不触发，
 * 指针事件鼠标与触屏一套代码。pointerdown 起拖并 setPointerCapture，
 * 指针移出行外也收得到 move / up；行上 touch-action: none，否则移动端
 * 把按住拖动当成页面滚动，事件收不到。拖动时被拖的行跟着指针走
 * （inline transform，无过渡），它经过的行用 transition 平滑让位；
 * 松手落位，inline 样式清干净，行回到常规文档流。pointercancel（比如
 * 浏览器中途接管手势）直接收尾，不留拖拽态与内联样式。
 * 次序变化（拖放落位、Alt+↑/↓）用 FLIP 补一段过渡，键盘换位也有动画。
 *
 * 放在 components/ 而不是 lib/：它是带渲染的共用交互组件，与 ui/ 里的
 * Button、Dialog 同一层，两个 feature 各自传内容进来，不让位逻辑写两遍。
 */
export type DragSortListProps<T> = {
  items: T[]
  /** 行的稳定标识：拖放与 FLIP 都按它对号。 */
  getId: (item: T, index: number) => string
  /** 列表的可访问名（ul 的 aria-label）。 */
  ariaLabel: string
  /** 行的正文：把手与行尾按钮之外的那一块。 */
  renderItem: (item: T, index: number) => ReactNode
  /** 行尾的动作按钮（平台页的上移/下移）。主路由的排序模式不传。 */
  rowActions?: (item: T, index: number, total: number) => ReactNode
  /** 额外钉在 li 上的属性（data-platform-id、行可访问名这类）。 */
  rowProps?: (
    item: T,
    index: number
  ) => React.HTMLAttributes<HTMLLIElement> & {
    [key: `data-${string}`]: string
  }
  onMove: (from: number, to: number) => void
  hint?: string
}

/** 一次拖动的过程状态：起点行、当前悬停位、各行该让出的位移。 */
type DragState = {
  from: number
  hover: number
  dy: number
  offsets: number[]
}

/** 各行让位的位移：被拖行跟指针，中间的行让出一个行高。 */
function computeOffsets(
  from: number,
  hover: number,
  dy: number,
  heights: number[]
): number[] {
  const offsets = heights.map(() => 0)
  for (let i = 0; i < heights.length; i++) {
    if (i === from) continue
    if (from < hover && i > from && i <= hover) offsets[i] = -heights[from]
    if (hover < from && i >= hover && i < from) offsets[i] = heights[from]
  }
  let dragged = dy
  if (hover > from) {
    for (let i = from; i < hover; i++) dragged += heights[i]
  }
  if (hover < from) {
    for (let i = hover; i < from; i++) dragged -= heights[i]
  }
  offsets[from] = dragged
  return offsets
}

export function DragSortList<T>({
  items,
  getId,
  ariaLabel,
  renderItem,
  rowActions,
  rowProps,
  onMove,
  hint,
}: DragSortListProps<T>) {
  const [drag, setDrag] = useState<DragState | null>(null)
  const listRef = useRef<HTMLUListElement>(null)
  const rowRefs = useRef<(HTMLLIElement | null)[]>([])
  const startYRef = useRef(0)
  /** drop / 键盘处理里要读最新一份 drag，镜像一份。 */
  const dragRef = useRef<DragState | null>(null)
  dragRef.current = drag
  /** FLIP 用：次序变化前各行的位置（按行 id 记）。 */
  const beforeRectsRef = useRef<Map<string, number> | null>(null)
  /** drop 会先落在行上再冒泡到 ul：一次拖动只提交一次。 */
  const committedRef = useRef(false)

  const rowHeights = () =>
    rowRefs.current.map((el) => el?.getBoundingClientRect().height ?? 0)

  /** 指针落在原始布局的哪一行（按各行的中点切，中点归本行）。 */
  const hoverFromPointer = (clientY: number, heights: number[]): number => {
    const listTop = listRef.current?.getBoundingClientRect().top ?? 0
    let acc = 0
    for (let i = 0; i < heights.length; i++) {
      if (clientY - listTop <= acc + heights[i] / 2) return i
      acc += heights[i]
    }
    return heights.length - 1
  }

  const trackHover = (clientY: number) => {
    setDrag((prev) => {
      if (!prev) return prev
      const heights = rowHeights()
      // 测不出行高（jsdom、列表刚挂载）时悬停位不动：没几何可切行。
      // 指针路径的悬停位一律按中点切行（中点归本行）。
      const measurable = heights.some((h) => h > 0)
      const hover = measurable ? hoverFromPointer(clientY, heights) : prev.hover
      const dy = measurable ? clientY - startYRef.current : prev.dy
      if (hover === prev.hover && dy === prev.dy) return prev
      return {
        ...prev,
        hover,
        dy,
        offsets: computeOffsets(prev.from, hover, dy, heights),
      }
    })
  }

  /** 包一层 onMove：先记下各行位置，落位后 FLIP 补过渡。 */
  const move = (from: number, to: number) => {
    const rects = new Map<string, number>()
    rowRefs.current.forEach((el, i) => {
      if (el) rects.set(getId(items[i], i), el.getBoundingClientRect().top)
    })
    beforeRectsRef.current = rects
    onMove(from, to)
  }

  // 次序变了：从旧位置滑到新位置，滑完把 inline 样式清掉。
  useLayoutEffect(() => {
    const before = beforeRectsRef.current
    beforeRectsRef.current = null
    if (!before) return
    rowRefs.current.forEach((el, i) => {
      if (!el) return
      const oldTop = before.get(getId(items[i], i))
      if (oldTop === undefined) return
      const delta = oldTop - el.getBoundingClientRect().top
      if (delta === 0) return
      el.style.transition = 'none'
      el.style.transform = `translateY(${delta}px)`
      void el.offsetHeight
      el.style.transition = ''
      el.style.transform = ''
    })
  })

  const finish = (commit: boolean) => {
    const current = dragRef.current
    setDrag(null)
    if (committedRef.current) return
    if (commit && current && current.hover !== current.from) {
      committedRef.current = true
      move(current.from, current.hover)
    }
  }

  return (
    <div>
      {hint ? (
        <p className='text-xs text-muted-foreground'>{hint}</p>
      ) : null}
      <ul ref={listRef} aria-label={ariaLabel} className='grid gap-1'>
        {items.map((item, index) => {
          const offset = drag?.offsets[index] ?? 0
          const dragging = drag?.from === index
          return (
            <li
              key={getId(item, index)}
              {...rowProps?.(item, index)}
              ref={(el) => {
                rowRefs.current[index] = el
              }}
              data-sort-id={getId(item, index)}
              tabIndex={0}
              onPointerDown={(event) => {
                // 只认主键的按下：右键、多点触控的第二根手指不起拖。
                if (event.button !== 0 || !event.isPrimary) return
                // 行尾的动作按钮照常点：从按钮上按下去不是拖这一行。
                if (
                  (event.target as HTMLElement).closest(
                    'button, a, input, select, textarea'
                  )
                ) {
                  return
                }
                committedRef.current = false
                startYRef.current = event.clientY
                // 抓住指针：移出行（甚至移出窗口）也照样收 move / up。
                // jsdom 没有 setPointerCapture，可选调用。
                event.currentTarget.setPointerCapture?.(event.pointerId)
                setDrag({
                  from: index,
                  hover: index,
                  dy: 0,
                  offsets: computeOffsets(index, index, 0, rowHeights()),
                })
              }}
              onPointerMove={(event) => {
                if (!drag || drag.from !== index) return
                // 压掉拖动引发的文本选择。
                event.preventDefault()
                trackHover(event.clientY)
              }}
              onPointerUp={() => finish(true)}
              onPointerCancel={() => finish(false)}
              onKeyDown={(event) => {
                if (!event.altKey) return
                if (event.key === 'ArrowUp' && index > 0) {
                  event.preventDefault()
                  move(index, index - 1)
                }
                if (
                  event.key === 'ArrowDown' &&
                  index < items.length - 1
                ) {
                  event.preventDefault()
                  move(index, index + 1)
                }
              }}
              style={
                offset !== 0
                  ? { transform: `translateY(${offset}px)` }
                  : undefined
              }
              className={cn(
                // touch-action: none：触屏上按住行拖动不能被浏览器当成滚动。
                'flex touch-none items-center gap-2 rounded-md border px-3 py-2',
                dragging
                  ? 'relative z-10 cursor-grabbing opacity-50 shadow-md transition-none'
                  : 'cursor-grab transition-transform duration-150'
              )}
            >
              <GripVertical
                aria-hidden
                className='size-4 shrink-0 text-muted-foreground'
              />
              <div className='grid min-w-0 flex-1 gap-0.5'>
                {renderItem(item, index)}
              </div>
              {rowActions?.(item, index, items.length)}
            </li>
          )
        })}
      </ul>
    </div>
  )
}
