/**
 * jsdom 没有布局：拖拽排序的悬停判定与 FLIP 都要读 getBoundingClientRect。
 * 这里把行的 rect 按「它在自己的列表里的 DOM 次序」钉住——重排后次序变了，
 * 读到的 top 跟着变，FLIP 才能量出非零位移。列表 top=0，每行高 rowHeight。
 */
import { fireEvent } from '@testing-library/react'

export function stubRowGeometry(rowHeight = 40) {
  const rect = (top: number, height: number) => ({
    top,
    bottom: top + height,
    height,
    left: 0,
    right: 0,
    width: 0,
    x: 0,
    y: top,
  })
  Object.defineProperty(HTMLLIElement.prototype, 'getBoundingClientRect', {
    value: function (this: HTMLElement) {
      const siblings = this.parentElement
        ? Array.from(this.parentElement.children)
        : []
      const index = Math.max(siblings.indexOf(this), 0)
      return rect(index * rowHeight, rowHeight)
    },
    configurable: true,
  })
  Object.defineProperty(HTMLUListElement.prototype, 'getBoundingClientRect', {
    value: () => rect(0, 0),
    configurable: true,
  })
}

/** 一套够用的指针事件序列：按住 → 移动 → 松开，坐标都能带上。 */
export function pointerDrag(
  from: HTMLElement,
  toClientY: number,
  moves: HTMLElement = from
) {
  fireEvent.pointerDown(from, {
    pointerId: 1,
    button: 0,
    isPrimary: true,
    clientY: 0,
  })
  fireEvent.pointerMove(moves, { pointerId: 1, clientY: toClientY })
  fireEvent.pointerUp(moves, { pointerId: 1 })
}

