/** @type {import('tailwindcss').Config} */
export default {
  content: ['./src/renderer/index.html', './src/renderer/src/**/*.{ts,tsx}'],
  // 由 ThemeApplier 根据 appearance.theme 在 <html> 上加/去 .dark
  darkMode: 'class',
  theme: {
    extend: {
      // 颜色统一走 CSS 变量（RGB triple），由 index.css 的 :root / html.dark 切换具体值。
      // 用 rgb(var(--x) / <alpha-value>) 写法保留 Tailwind 的 /20 /95 等 alpha 修饰符能力。
      colors: {
        zhihu: {
          blue: 'rgb(var(--zhihu-blue) / <alpha-value>)',
          'blue-hover': 'rgb(var(--zhihu-blue-hover) / <alpha-value>)',
          'blue-active': 'rgb(var(--zhihu-blue-active) / <alpha-value>)',
          'blue-light': 'rgb(var(--zhihu-blue-light) / <alpha-value>)',
          'blue-soft': 'rgb(var(--zhihu-blue-soft) / <alpha-value>)',
          ink: 'rgb(var(--zhihu-ink) / <alpha-value>)',
          gray: 'rgb(var(--zhihu-gray) / <alpha-value>)',
          'gray-2': 'rgb(var(--zhihu-gray-2) / <alpha-value>)',
          'gray-3': 'rgb(var(--zhihu-gray-3) / <alpha-value>)',
          border: 'rgb(var(--zhihu-border) / <alpha-value>)',
          'border-light': 'rgb(var(--zhihu-border-light) / <alpha-value>)',
          bg: 'rgb(var(--zhihu-bg) / <alpha-value>)',
          'bg-soft': 'rgb(var(--zhihu-bg-soft) / <alpha-value>)',
          // 卡片/弹窗背景（替代硬写的 bg-white/95），暗色下变成深卡
          card: 'rgb(var(--zhihu-card) / <alpha-value>)',
          // 页面级别底色
          page: 'rgb(var(--zhihu-page) / <alpha-value>)'
        },
        provider: {
          openai: '#10A37F',
          claude: '#D97706',
          kimi: '#1677FF',
          deepseek: '#4F46E5',
          doubao: '#F59E0B'
        }
      },
      fontFamily: {
        sans: [
          '"PingFang SC"',
          '"Microsoft YaHei"',
          '"Segoe UI"',
          'system-ui',
          'sans-serif'
        ],
        // 气泡专用：手写「康康体」，找不到时回退到 sans 链不至于乱码
        kangkang: [
          '"KangKang"',
          '"PingFang SC"',
          '"Microsoft YaHei"',
          'sans-serif'
        ]
      },
      boxShadow: {
        'zhihu-card': '0 1px 3px rgba(26, 26, 26, 0.04), 0 1px 2px rgba(26, 26, 26, 0.06)',
        'zhihu-pop': '0 8px 24px rgba(0, 132, 255, 0.12), 0 2px 8px rgba(26, 26, 26, 0.08)'
      },
      keyframes: {
        'summon-in': {
          '0%': { opacity: '0', transform: 'translateY(8px) scale(0.96)' },
          '100%': { opacity: '1', transform: 'translateY(0) scale(1)' }
        },
        'bubble-in': {
          '0%': { opacity: '0', transform: 'translateY(4px) scale(0.96)' },
          '100%': { opacity: '1', transform: 'translateY(0) scale(1)' }
        }
      },
      animation: {
        'summon-in': 'summon-in 200ms cubic-bezier(0.2, 0.8, 0.2, 1)',
        'bubble-in': 'bubble-in 180ms cubic-bezier(0.2, 0.8, 0.2, 1)'
      }
    }
  },
  plugins: []
}
