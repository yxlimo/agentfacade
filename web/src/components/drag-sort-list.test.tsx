import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { DragSortList } from './drag-sort-list'

/**
 * hoverFromPointer 按各行的中点切行。jsdom 测不出布局，也没有 DragEvent
 * （fireEvent.dragStart/dragOver 造出的 Event 读不到 clientY），所以给
 * HTMLLIElement 原型 stub 一份固定几何，dragover 用带 clientY 的
 * MouseEvent 派发：列表 top=0，每行高 100px，行 i 的区间是
 * [i*100, (i+1)*100)，中点在 i*100+50。落位以 drop 后 onMove 的目标行断言。
 */
const ROW_HEIGHT = 100

/** jsdom 没有 DragEvent：dragover 用 MouseEvent 派发才能带上 clientY。 */
function fireDragOver(el: Element, clientY: number) {
  fireEvent(el, new MouseEvent('dragover', {
    bubbles: true, cancelable: true, clientY,
  }))
}

/** dragstart 同理，startYRef 才能读到起拖位置。 */
function fireDragStart(el: Element) {
  fireEvent(el, new MouseEvent('dragstart', {
    bubbles: true, cancelable: true, clientY: 0,
  }))
}

function setup(onMove: (from: number, to: number) => void) {
  const liProto = HTMLLIElement.prototype
  Object.defineProperty(liProto, 'getBoundingClientRect', {
    value: function () {
      const index = Number(
        (this as HTMLElement).getAttribute('data-index') ?? 0,
      )
      return {
        top: index * ROW_HEIGHT,
        bottom: (index + 1) * ROW_HEIGHT,
        height: ROW_HEIGHT,
        left: 0,
        right: 0,
      }
    },
    configurable: true,
  })
  render(
    <DragSortList
      items={['a', 'b', 'c']}
      getId={(item) => item}
      ariaLabel='排序列表'
      renderItem={(item, index) => (
        <span data-index={index}>{item}</span>
      )}
      onMove={onMove}
    />,
  )
  // li 上补 data-index，stub 的 rect 靠它算行高区间。
  const li = screen.getAllByRole('listitem')
  li.forEach((el, index) => el.setAttribute('data-index', String(index)))
  return li
}

describe('DragSortList hoverFromPointer 中点判定', () => {
  it('指针落在行中心 → 判为这一行，而不是下一行', () => {
    const onMove = vi.fn()
    const li = setup(onMove)
    // 把 a（行 0）拖起，指针停在行 1 的正中心（y=150）。
    fireDragStart(li[0])
    fireDragOver(li[1], 1 * ROW_HEIGHT + ROW_HEIGHT / 2)
    fireEvent.drop(li[1])
    // 旧实现（严格小于）在这里判成行 2：拖到第一位实际落到第二位。
    expect(onMove).toHaveBeenCalledWith(0, 1)
  })

  it('指针越过中心到行的下半段 → 判为下一行', () => {
    const onMove = vi.fn()
    const li = setup(onMove)
    fireDragStart(li[0])
    // 行 1 的下半段（y=180）归行 2。
    fireDragOver(li[1], 1 * ROW_HEIGHT + 80)
    fireEvent.drop(li[1])
    expect(onMove).toHaveBeenCalledWith(0, 2)
  })

  it('指针停在目标行中点偏上（未过中点）→ 判为目标行', () => {
    const onMove = vi.fn()
    const li = setup(onMove)
    // 把 c（行 2）拖起，指针停在行 0 中点偏上（y=40）：Playwright dragTo
    // 落中心的场景里，旧实现会把 c 判到行 1。
    fireDragStart(li[2])
    fireDragOver(li[0], 40)
    fireEvent.drop(li[0])
    expect(onMove).toHaveBeenCalledWith(2, 0)
  })
})
