import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { useState } from 'react'
import { DragSortList } from './drag-sort-list'

/**
 * hoverFromPointer 按各行的中点切行。jsdom 测不出布局，指针事件里要读
 * clientY 与各行几何，所以给 li / ul 的原型 stub 一份固定几何：列表 top=0，
 * 每行高 100px，行 i 的区间是 [i*100, (i+1)*100)，中点在 i*100+50。
 * rect 按 DOM 次序算——重排后次序变了，top 跟着变，FLIP 才能量出位移。
 */
const ROW_HEIGHT = 100

function stubGeometry() {
  Object.defineProperty(HTMLLIElement.prototype, 'getBoundingClientRect', {
    value: function (this: HTMLElement) {
      const siblings = this.parentElement
        ? Array.from(this.parentElement.children)
        : []
      const index = Math.max(siblings.indexOf(this), 0)
      return {
        top: index * ROW_HEIGHT,
        bottom: (index + 1) * ROW_HEIGHT,
        height: ROW_HEIGHT,
        left: 0,
        right: 0,
        width: 0,
        x: 0,
        y: index * ROW_HEIGHT,
      }
    },
    configurable: true,
  })
  Object.defineProperty(HTMLUListElement.prototype, 'getBoundingClientRect', {
    value: () => ({
      top: 0,
      bottom: 0,
      height: 0,
      left: 0,
      right: 0,
      width: 0,
      x: 0,
      y: 0,
    }),
    configurable: true,
  })
}

/** jsdom 的 PointerEvent 够真：能带 clientY / pointerId / isPrimary。 */
function firePointer(
  el: Element,
  type: 'pointerdown' | 'pointermove' | 'pointerup',
  clientY: number
) {
  fireEvent(
    el,
    new PointerEvent(type, {
      bubbles: true,
      cancelable: true,
      pointerId: 1,
      isPrimary: true,
      button: type === 'pointerdown' ? 0 : -1,
      clientY,
    })
  )
}

function setup(onMove?: (from: number, to: number) => void) {
  stubGeometry()
  render(
    <DragSortList
      items={['a', 'b', 'c']}
      getId={(item) => item}
      ariaLabel='排序列表'
      renderItem={(item) => <span>{item}</span>}
      onMove={onMove ?? (() => {})}
    />,
  )
  return screen.getAllByRole('listitem')
}

/**
 * FLIP 测试用的有状态外壳：onMove 真的换 items，次序变化才进得了
 * 布局副作用。onMove 什么都不做的话重排不会发生，FLIP 量不出位移。
 */
function StatefulList() {
  const [items, setItems] = useState(['a', 'b', 'c'])
  return (
    <DragSortList
      items={items}
      getId={(item) => item}
      ariaLabel='排序列表'
      renderItem={(item) => <span>{item}</span>}
      onMove={(from, to) => {
        setItems((prev) => {
          const next = [...prev]
          const [moved] = next.splice(from, 1)
          next.splice(to, 0, moved)
          return next
        })
      }}
    />
  )
}

/**
 * 把每行的 style 换成记账代理：FLIP 用普通赋值写 transform / transition，
 * jsdom 不走 setProperty，代理才能把这些中间写入记下来（效果同步跑完就
 * 清掉了，事后读 style 只能看到空）。
 */
function recordStyleWrites(li: HTMLElement[]) {
  const writes: string[] = []
  li.forEach((el, i) => {
    const real = el.style
    const proxy = new Proxy(real, {
      set(target, prop, value) {
        if (typeof prop === 'string') writes.push(`${i} ${prop}=${value}`)
        return Reflect.set(target, prop, value)
      },
    })
    Object.defineProperty(el, 'style', {
      get: () => proxy,
      configurable: true,
    })
  })
  return writes
}

describe('DragSortList hoverFromPointer 中点判定', () => {
  it('指针落在行中心 → 判为这一行，而不是下一行', () => {
    const onMove = vi.fn()
    const li = setup(onMove)
    // 把 a（行 0）拖起，指针停在行 1 的正中心（y=150）。
    firePointer(li[0], 'pointerdown', 0)
    firePointer(li[0], 'pointermove', 1 * ROW_HEIGHT + ROW_HEIGHT / 2)
    firePointer(li[0], 'pointerup', 1 * ROW_HEIGHT + ROW_HEIGHT / 2)
    // 旧实现（严格小于）在这里判成行 2：拖到第一位实际落到第二位。
    expect(onMove).toHaveBeenCalledWith(0, 1)
  })

  it('指针越过中心到行的下半段 → 判为下一行', () => {
    const onMove = vi.fn()
    const li = setup(onMove)
    firePointer(li[0], 'pointerdown', 0)
    // 行 1 的下半段（y=180）归行 2。
    firePointer(li[0], 'pointermove', 1 * ROW_HEIGHT + 80)
    firePointer(li[0], 'pointerup', 1 * ROW_HEIGHT + 80)
    expect(onMove).toHaveBeenCalledWith(0, 2)
  })

  it('指针停在目标行中点偏上（未过中点）→ 判为目标行', () => {
    const onMove = vi.fn()
    const li = setup(onMove)
    // 把 c（行 2）拖起，指针停在行 0 中点偏上（y=40）。
    firePointer(li[2], 'pointerdown', 200)
    firePointer(li[2], 'pointermove', 40)
    firePointer(li[2], 'pointerup', 40)
    expect(onMove).toHaveBeenCalledWith(2, 0)
  })

  it('按在动作按钮上不起拖：onMove 不被调用', () => {
    const onMove = vi.fn()
    const li = setup(onMove)
    li[0].innerHTML = '<button>上移</button>'
    fireEvent.pointerDown(li[0].querySelector('button')!, {
      pointerId: 1,
      button: 0,
      isPrimary: true,
      clientY: 150,
    })
    firePointer(li[0], 'pointermove', 150)
    firePointer(li[0], 'pointerup', 150)
    expect(onMove).not.toHaveBeenCalled()
    // 行上也没有拖拽态留下的内联样式。
    expect(li[0].style.transform).toBe('')
  })
})

describe('DragSortList 的 FLIP 落位过渡', () => {
  it('键盘换位：换到的两行被写入非零位移，随后清干净', () => {
    stubGeometry()
    render(<StatefulList />)
    const li = screen.getAllByRole('listitem')
    const writes = recordStyleWrites(li)

    fireEvent.keyDown(li[0], { key: 'ArrowDown', altKey: true })

    // a 从旧位置 0 滑到新位置 100，b 从 100 滑到 0：位移差都不为零。
    expect(writes).toContain('0 transform=translateY(-100px)')
    expect(writes).toContain('1 transform=translateY(100px)')
    // 过渡写上去之后清掉，行回到常规文档流。
    expect(li[0].style.transform).toBe('')
    expect(li[1].style.transform).toBe('')
    expect(li[0].style.transition).toBe('')
  })

  it('指针拖放落位：让位的行也被写入非零位移', () => {
    stubGeometry()
    render(<StatefulList />)
    const li = screen.getAllByRole('listitem')
    const writes = recordStyleWrites(li)

    firePointer(li[0], 'pointerdown', 0)
    firePointer(li[0], 'pointermove', 250)
    firePointer(li[0], 'pointerup', 250)

    // [a,b,c] → [b,c,a]：a 下移两行，b、c 各上移一行。
    expect(writes).toContain('0 transform=translateY(-200px)')
    expect(writes).toContain('1 transform=translateY(100px)')
    expect(writes).toContain('2 transform=translateY(100px)')
    expect(li[0].style.transform).toBe('')
  })

  it('pointercancel 收尾：不留拖拽态，也不落位', () => {
    const onMove = vi.fn()
    const li = setup(onMove)
    const writes = recordStyleWrites(li)

    firePointer(li[0], 'pointerdown', 0)
    firePointer(li[0], 'pointermove', 150)
    fireEvent.pointerCancel(li[0])

    expect(onMove).not.toHaveBeenCalled()
    // 没有落位，就没有 FLIP：FLIP 必先写 transition='none' 再写位移。
    expect(writes.filter((w) => w.includes('transition'))).toEqual([])
    expect(li[0].style.transform).toBe('')
  })
})
