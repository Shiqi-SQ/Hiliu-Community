// lookup_lore 实现——按 topic 字符串查知识库，返回最匹配条目的内容。
//
// 匹配优先级（从严到松）：
// 1) topic 精确等值
// 2) aliases 精确等值
// 3) topic 与 query 子串双向包含
// 4) aliases 与 query 子串双向包含
//
// 全部失败时返回兜底提示——让模型老实说「这个我没想过」，不胡编。

import { LORE_ENTRIES, LoreEntry } from './data'

const NOT_FOUND_HINT =
  '（这条我自己也没想过——别瞎编，老老实实告诉用户「这个我没想过」就好。）'

function normalize(s: string): string {
  return s.trim().toLowerCase()
}

function matches(entry: LoreEntry, query: string): boolean {
  const q = normalize(query)
  if (!q) return false
  if (normalize(entry.topic) === q) return true
  if (entry.aliases.some((a) => normalize(a) === q)) return true
  // 子串双向匹配——「我妈说的话」能命中「父母」别名「我妈」
  const topicNorm = normalize(entry.topic)
  if (topicNorm.includes(q) || q.includes(topicNorm)) return true
  return entry.aliases.some((a) => {
    const an = normalize(a)
    return an.includes(q) || q.includes(an)
  })
}

export function lookupLore(topic: string): string {
  if (!topic || typeof topic !== 'string') return NOT_FOUND_HINT
  // 先扫精确匹配，再子串匹配——行为更可预期
  const q = normalize(topic)
  const exactTopic = LORE_ENTRIES.find((e) => normalize(e.topic) === q)
  if (exactTopic) return exactTopic.content
  const exactAlias = LORE_ENTRIES.find((e) =>
    e.aliases.some((a) => normalize(a) === q)
  )
  if (exactAlias) return exactAlias.content
  const fuzzy = LORE_ENTRIES.find((e) => matches(e, topic))
  if (fuzzy) return fuzzy.content
  return NOT_FOUND_HINT
}

/**
 * 列出所有 topic——供将来在系统提示词里暴露目录时用。
 * 当前 prompt 设计不暴露目录，让模型自由想 topic 后模糊匹配。
 */
export function listLoreTopics(): string[] {
  return LORE_ENTRIES.map((e) => e.topic)
}
