// 真 CC v2.1.112 在 cc-native 路径默认挂的 31 个内置工具 schema（dump 1:1 提取）。
// 不挂会被网关 400——这是合法 CC 客户端的隐性必填项；Hiliu 仍走 app-layer JSON，模型不会真调用。
// 只取 31 稳定子集——dump 中第 32-33 个是 MCP 浮动，硬编码反成新指纹。
// input_schema 用 unknown 宽类型——真 CC 用了 $schema/additionalProperties 等扩展字段，不要"修正"。

import builtinTools from './cc-builtin-tools.json'

export interface CCBuiltinTool {
  readonly name: string
  readonly description: string
  readonly input_schema: unknown
}

export const CC_BUILTIN_TOOLS: ReadonlyArray<CCBuiltinTool> =
  builtinTools as ReadonlyArray<CCBuiltinTool>
