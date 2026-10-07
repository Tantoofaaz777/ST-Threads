export interface StoryRange {
  label: string
  content: string
}

export interface FandomThread {
  label: string
  content: string
}

export interface StoryMessageRange {
  label: string
  messages: string[]
}

export interface ThreadversePromptInput {
  previousRanges: StoryRange[]
  recentRange: StoryRange
  fandomContinuity: FandomThread[]
  fandomNotes?: string
  instructions: string
}

export function renderBlocks<T extends { label: string; content: string }>(items: T[]): string {
  if (items.length === 0) return ''

  return items
    .map((item) => `## ${item.label}\n${item.content.trim()}`)
    .join('\n\n')
}

function storyRangesFromSuffix(items: StoryMessageRange[], messageCount: number): StoryRange[] {
  let remainingToSkip = Math.max(0, items.reduce((total, item) => total + item.messages.length, 0) - messageCount)
  const selected: StoryRange[] = []
  for (const item of items) {
    const skippedHere = Math.min(remainingToSkip, item.messages.length)
    remainingToSkip -= skippedHere
    const messages = item.messages.slice(skippedHere)
    if (messages.length > 0) selected.push({ label: item.label, content: messages.join('\n\n') })
  }
  return groupConsecutiveStoryRanges(selected)
}

export async function selectPreviousContextByTokenBudget(
  items: StoryMessageRange[],
  tokenBudget: number,
  countTokens: (text: string) => Promise<number>,
): Promise<StoryRange[]> {
  const totalMessages = items.reduce((total, item) => total + item.messages.length, 0)
  if (tokenBudget <= 0 || totalMessages === 0) return []

  let minimum = 0
  let maximum = totalMessages
  while (minimum < maximum) {
    const candidateCount = Math.ceil((minimum + maximum) / 2)
    const candidate = storyRangesFromSuffix(items, candidateCount)
    const tokens = await countTokens(renderBlocks(candidate))
    if (tokens <= tokenBudget) minimum = candidateCount
    else maximum = candidateCount - 1
  }
  return storyRangesFromSuffix(items, minimum)
}

export async function selectNewestLabeledBlocksByTokenBudget<
  T extends { label: string; content: string },
>(
  items: T[],
  tokenBudget: number,
  countTokens: (text: string) => Promise<number>,
): Promise<T[]> {
  if (tokenBudget <= 0 || items.length === 0) return []

  let minimum = 0
  let maximum = items.length
  while (minimum < maximum) {
    const candidateCount = Math.ceil((minimum + maximum) / 2)
    const candidate = items.slice(-candidateCount)
    const tokens = await countTokens(renderBlocks(candidate))
    if (tokens <= tokenBudget) minimum = candidateCount
    else maximum = candidateCount - 1
  }
  return minimum === 0 ? [] : items.slice(-minimum)
}

export function groupConsecutiveStoryRanges(items: StoryRange[]): StoryRange[] {
  const grouped: StoryRange[] = []
  for (const item of items) {
    const previous = grouped.at(-1)
    if (previous?.label === item.label) {
      previous.content = `${previous.content.trim()}\n\n${item.content.trim()}`
    } else {
      grouped.push({ ...item })
    }
  }
  return grouped
}

export function installmentOrRoundLabel(installmentLabel: string, sequence: number): string {
  return installmentLabel || `ROUND ${sequence}`
}

export function buildThreadversePrompt(input: ThreadversePromptInput): string {
  const fandomNotes = input.fandomNotes?.trim() ?? ''
  return [
    ...(input.previousRanges.length > 0
      ? ['# PREVIOUS CONTEXT', renderBlocks(input.previousRanges)]
      : []),
    '# RECENT CONTEXT',
    renderBlocks([input.recentRange]),
    ...(input.fandomContinuity.length > 0
      ? ['# FANDOM CONTINUITY', renderBlocks(input.fandomContinuity)]
      : []),
    ...(fandomNotes ? ['# FANDOM NOTES', fandomNotes] : []),
    '# INSTRUCTIONS',
    input.instructions.trim(),
    '# OUTPUT FORMAT',
    `You must respond with ONLY valid JSON in this exact format:
{
  "title": "thread title",
  "post": { "username": "name", "body": "text", "score": 0 },
  "conversations": [
    {
      "root": { "id": "c1", "username": "root_a", "body": "independent top-level comment", "score": 120 },
      "replies": [
        { "id": "c1-r1", "parent_id": "c1", "username": "reply_a", "body": "direct reply to root_a", "score": 45 },
        { "id": "c1-r2", "parent_id": "c1-r1", "username": "root_a", "body": "nested reply to reply_a", "score": 31 }
      ]
    },
    {
      "root": { "id": "c2", "username": "root_b", "body": "another independent top-level comment", "score": 90 },
      "replies": [
        { "id": "c2-r1", "parent_id": "c2", "username": "reply_b", "body": "direct reply to root_b", "score": 28 }
      ]
    },
    {
      "root": { "id": "c3", "username": "root_c", "body": "another independent top-level comment", "score": 70 },
      "replies": [
        { "id": "c3-r1", "parent_id": "c3", "username": "reply_c", "body": "direct reply to root_c", "score": 19 }
      ]
    }
  ]
}
The example demonstrates structure only; scale the number of conversations and replies to the requested discussion size. Each item in conversations is one separate top-level Reddit conversation and contains exactly one root. Every reply must use parent_id equal to that conversation's root id or to the id of an earlier reply inside the SAME conversation. Never move a root into replies and never reference another conversation. At least 35% of all comments must be replies. With 6 or more comments, create at least 3 separate top-level conversations and give each of at least 3 conversations one or more replies. Do not put the entire discussion beneath one root.
Return ONLY the JSON—no explanations, no notes, no commentary.`,
  ].join('\n\n')
}
