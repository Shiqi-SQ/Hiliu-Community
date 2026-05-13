<div align="center">

<img src="resources/icon.png" alt="Hiliu" width="128" height="128" />

# 你好，小刘（社区版）

住在 Windows 桌面右下角的 AI 宠物，形象使用知乎吉祥物「刘看山」。

[![License](https://img.shields.io/github/license/Shiqi-SQ/Hiliu-Community?color=0084FF)](LICENSE) [![Platform](https://img.shields.io/badge/platform-Windows%20x64-0078D6?logo=windows&logoColor=white)](#) [![Electron](https://img.shields.io/badge/Electron-33-47848F?logo=electron&logoColor=white)](https://www.electronjs.org/) [![React](https://img.shields.io/badge/React-18-61DAFB?logo=react&logoColor=white)](https://react.dev/) [![TypeScript](https://img.shields.io/badge/TypeScript-5-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/) [![TailwindCSS](https://img.shields.io/badge/Tailwind-3-06B6D4?logo=tailwindcss&logoColor=white)](https://tailwindcss.com/) [![Release](https://img.shields.io/github/v/release/Shiqi-SQ/Hiliu-Community?color=0084FF)](https://github.com/Shiqi-SQ/Hiliu-Community/releases) [![Stars](https://img.shields.io/github/stars/Shiqi-SQ/Hiliu-Community?style=social)](https://github.com/Shiqi-SQ/Hiliu-Community/stargazers) [![Hackathon](https://img.shields.io/badge/%E7%9F%A5%E4%B9%8E%20AI%20Hackathon-2026-0084FF)](https://hiliu.chat/)

**[官网 hiliu.chat](https://hiliu.chat/)** · **[项目文档《你好，小刘》PDF](https://static.hiliu.chat/%E3%80%8A%E4%BD%A0%E5%A5%BD%EF%BC%8C%E5%B0%8F%E5%88%98%E3%80%8B.pdf)** · **知乎 AI Hackathon 2026 参赛作品**

</div>

> **声明**：本项目并非知乎官方发布。形象与品牌归属见 `NOTICE` 文件。  
> 社区版不内置任何知乎私有 API，所有 LLM 能力依赖你自己配置的第三方供应商。

---

刘看山会安静地待在屏幕角落。他空闲时会伸懒腰、打盹；你叫他一声，气泡弹出来，他会认真回答。
鼠标点击由像素 alpha 命中决定，只会触发到他的实际身体，不影响桌面操作。

社区版把对话、动画、工具调用等通用能力开放出来，不含知乎热榜、直答接入、账号 OAuth 等主线版专属功能。新功能会在主线版稳定后择期同步，与主线版之间存在一定的功能滞后。可与主线版同时安装，互不冲突。

## 开始使用

从 [Releases](../../releases) 下载安装包，运行后进入「设置 → 智能 → 模型供应商」添加你的 API Key。

内置预设支持 Zhipu、Kimi、DeepSeek、豆包、MiniMax、小米 MiMo、LongCat、Anthropic 官方、OpenRouter，以及 OpenAI Responses 协议（本地翻译后发送）。填入对应 baseURL 和 Key 即可。

如果你在用各类 Claude Code 兼容网关，直接填 baseURL 通常就能用——社区版统一以 Anthropic Claude Code 同款协议发出请求，兼容市面大多数 CC 风格代理。

## 开发

需要 Node 20+、pnpm、Windows x64（底层大量用了 Windows 平台特有窗口能力）。

```bash
pnpm install
pnpm dev        # 开发模式，热更新
pnpm typecheck  # 类型检查
pnpm package    # 打包 NSIS 安装器
```

代码结构与设计约定见 `CLAUDE.md`。

## 形象与版权

「刘看山」是知乎（北京智者天下科技有限公司）的注册角色 IP。本项目以社区好意致敬，不主张对该形象的任何权利。请阅读 `NOTICE` 文件了解形象部分的使用边界。

如果你是知乎的法务/品牌方，有任何关切，欢迎通过 GitHub Issue 联系。

## 协议

源代码：**MIT**（见 `LICENSE`）  
桌宠立绘 / 角色形象：**知乎所有，不在 MIT 协议授权范围内**（见 `NOTICE`）

---

## Star History

<a href="https://www.star-history.com/?repos=Shiqi-SQ%2FHiliu-Community&type=date&legend=top-left">
 <picture>
   <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/chart?repos=Shiqi-SQ/Hiliu-Community&type=date&theme=dark&legend=top-left" />
   <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/chart?repos=Shiqi-SQ/Hiliu-Community&type=date&legend=top-left" />
   <img alt="Star History Chart" src="https://api.star-history.com/chart?repos=Shiqi-SQ/Hiliu-Community&type=date&legend=top-left" />
 </picture>
</a>
