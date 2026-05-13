// 气泡内的手绘风格确认对话框——用来在不离开桌宠语境的前提下做"危险动作二次确认"。
//
// 形态：
// - 一层 absolute inset-0 的遮罩覆盖在气泡内容上，背景是半透明白 + 轻量虚化，
//   不"变暗"——只是让下层内容退后一步、突出前景的卡片
// - 中间一张固定尺寸的小卡片，描边走 Bubble 同款双笔触（铅笔阴影 + 钢笔主线），
//   保证和气泡本体的手绘味一致
// - 主按钮（确认）暖色描边，副按钮（取消）灰色描边，无填充——避免抢走气泡的视觉权重
import { useMemo } from 'react'
import rough from 'roughjs'
import { extractRoughPaths, roundedRectPath } from '../utils/roughSvg'

const generator = rough.generator()

interface Props {
  message: string
  confirmText?: string
  cancelText?: string
  onConfirm: () => void
  onCancel: () => void
}

const CARD_W = 220
const CARD_H = 110
const PAD = 8 // 给笔触溢出留余量

/** 按钮的手绘描边——根据传入的尺寸 + 颜色现算 path */
function useRoughStroke(
  w: number,
  h: number,
  color: string,
  seed: number
): string {
  return useMemo(() => {
    if (w <= 0 || h <= 0) return ''
    const path = roundedRectPath(w, h, 6)
    const drawable = generator.path(path, {
      roughness: 1.4,
      bowing: 1.0,
      seed,
      stroke: color,
      strokeWidth: 1.2,
      fill: 'none',
      disableMultiStroke: false
    })
    return extractRoughPaths(drawable.sets).stroke
  }, [w, h, color, seed])
}

export function RoughConfirm(props: Props): JSX.Element {
  const { message, onConfirm, onCancel } = props
  const confirmText = props.confirmText ?? '确认'
  const cancelText = props.cancelText ?? '取消'

  // 卡片描边——双笔触：铅笔阴影 + 钢笔主线（同 Bubble.tsx 的层次配方，但收敛参数）
  const { shadowStroke, mainStroke, fillPath } = useMemo(() => {
    const path = roundedRectPath(CARD_W, CARD_H, 12)
    const shadow = generator.path(path, {
      roughness: 1.8,
      bowing: 1.4,
      seed: 17,
      stroke: 'rgba(140, 140, 145, 0.4)',
      strokeWidth: 2.2,
      fill: 'none',
      disableMultiStroke: false
    })
    const main = generator.path(path, {
      roughness: 1.1,
      bowing: 1.0,
      seed: 9,
      stroke: '#1A1A1A',
      strokeWidth: 1.4,
      fill: '#ffffff',
      fillStyle: 'solid',
      disableMultiStroke: false
    })
    const mainPaths = extractRoughPaths(main.sets)
    return {
      shadowStroke: extractRoughPaths(shadow.sets).stroke,
      mainStroke: mainPaths.stroke,
      fillPath: mainPaths.fill
    }
  }, [])

  // 按钮尺寸——取消 56×26、确认 56×26（统一节奏）
  const BTN_W = 56
  const BTN_H = 26
  const cancelStroke = useRoughStroke(BTN_W, BTN_H, '#85909a', 21)
  const confirmStroke = useRoughStroke(BTN_W, BTN_H, '#b45309', 23) // amber-700

  return (
    <div
      data-clickable="true"
      className="absolute inset-0 z-20 flex items-center justify-center"
      // 半透明白 + 轻量虚化——「不变暗」但能虚化下层文字，让前景卡片清晰
      style={{
        background: 'rgba(255, 255, 255, 0.55)',
        backdropFilter: 'blur(2px)'
      }}
      // 拦截点击穿透到下层 ChatThread——空白处点击当作取消
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onCancel()
      }}
    >
      <div
        className="relative"
        style={{ width: CARD_W, height: CARD_H }}
        onMouseDown={(e) => e.stopPropagation()}
      >
        {/* 卡片描边层——绝对定位、不挡点击 */}
        <svg
          width={CARD_W + PAD * 2}
          height={CARD_H + PAD * 2}
          viewBox={`${-PAD} ${-PAD} ${CARD_W + PAD * 2} ${CARD_H + PAD * 2}`}
          style={{
            position: 'absolute',
            left: -PAD,
            top: -PAD,
            pointerEvents: 'none',
            overflow: 'visible'
          }}
        >
          {fillPath && (
            <path d={fillPath} fill="#ffffff" stroke="none" />
          )}
          {shadowStroke && (
            <path
              d={shadowStroke}
              fill="none"
              stroke="rgba(140, 140, 145, 0.4)"
              strokeWidth={2.2}
              strokeLinejoin="round"
              strokeLinecap="round"
            />
          )}
          {mainStroke && (
            <path
              d={mainStroke}
              fill="none"
              stroke="#1A1A1A"
              strokeWidth={1.4}
              strokeLinejoin="round"
              strokeLinecap="round"
              transform="translate(0.5 -0.3)"
            />
          )}
        </svg>

        {/* 卡片内容 */}
        <div className="font-kangkang relative flex h-full flex-col justify-between px-4 py-3">
          <p className="text-[13px] leading-snug text-zhihu-ink">{message}</p>
          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={onCancel}
              className="relative font-kangkang text-[12px] text-zhihu-gray transition-colors hover:text-zhihu-ink"
              style={{ width: BTN_W, height: BTN_H }}
            >
              <svg
                width={BTN_W + PAD * 2}
                height={BTN_H + PAD * 2}
                viewBox={`${-PAD} ${-PAD} ${BTN_W + PAD * 2} ${BTN_H + PAD * 2}`}
                style={{
                  position: 'absolute',
                  left: -PAD,
                  top: -PAD,
                  pointerEvents: 'none',
                  overflow: 'visible'
                }}
              >
                <path
                  d={cancelStroke}
                  fill="none"
                  stroke="#85909a"
                  strokeWidth={1.2}
                  strokeLinejoin="round"
                  strokeLinecap="round"
                />
              </svg>
              <span className="relative">{cancelText}</span>
            </button>
            <button
              type="button"
              onClick={onConfirm}
              className="relative font-kangkang text-[12px] font-medium text-amber-700 transition-colors hover:text-amber-800"
              style={{ width: BTN_W, height: BTN_H }}
            >
              <svg
                width={BTN_W + PAD * 2}
                height={BTN_H + PAD * 2}
                viewBox={`${-PAD} ${-PAD} ${BTN_W + PAD * 2} ${BTN_H + PAD * 2}`}
                style={{
                  position: 'absolute',
                  left: -PAD,
                  top: -PAD,
                  pointerEvents: 'none',
                  overflow: 'visible'
                }}
              >
                <path
                  d={confirmStroke}
                  fill="none"
                  stroke="#b45309"
                  strokeWidth={1.2}
                  strokeLinejoin="round"
                  strokeLinecap="round"
                />
              </svg>
              <span className="relative">{confirmText}</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
