import type { ThreadverseComment, ThreadverseFeed } from './shared'

type JsonObject = Record<string, unknown>

function asObject(value: unknown, label: string): JsonObject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be a JSON object.`)
  }
  return value as JsonObject
}

function stringFrom(object: JsonObject, keys: string[], label: string): string {
  for (const key of keys) {
    const value = object[key]
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  throw new Error(`${label} is missing.`)
}

function scoreFrom(object: JsonObject): number {
  const value = object.score ?? object.upvotes ?? object.votes
  return typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : 0
}

function positionalString(value: unknown, label: string): string {
  if (typeof value === 'string' && value.trim()) return value.trim()
  throw new Error(`${label} is missing.`)
}

function positionalScore(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : 0
}

function identifierFrom(value: unknown): string | null {
  if (typeof value === 'string' && value.trim()) return value.trim()
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  return null
}

interface NestingStats {
  total: number
  replies: number
  conversationsWithReplies: number
}

function nestingStats(comments: ThreadverseComment[]): NestingStats {
  let total = 0
  let replies = 0
  let conversationsWithReplies = 0

  const visit = (items: ThreadverseComment[], depth: number) => {
    for (const comment of items) {
      total += 1
      if (depth > 0) replies += 1
      visit(comment.replies, depth + 1)
    }
  }

  for (const comment of comments) {
    if (comment.replies.length > 0) conversationsWithReplies += 1
    visit([comment], 0)
  }
  return { total, replies, conversationsWithReplies }
}

function requireDiscussionNesting(comments: ThreadverseComment[]): void {
  const stats = nestingStats(comments)
  if (stats.total < 2) return

  const requiredReplies = Math.min(
    stats.total - 1,
    Math.max(1, Math.ceil(stats.total * 0.35)),
  )
  if (stats.replies < requiredReplies) {
    throw new Error(
      `The model returned a flat discussion: ${stats.replies} of ${stats.total} comments are replies, but at least ${requiredReplies} are required.`,
    )
  }

  const requiredConversations = Math.min(3, Math.floor(stats.total / 2))
  if (stats.conversationsWithReplies < requiredConversations) {
    throw new Error(
      `The model replied within only ${stats.conversationsWithReplies} top-level conversation${stats.conversationsWithReplies === 1 ? '' : 's'}; at least ${requiredConversations} are required.`,
    )
  }

  const requiredRoots = stats.total >= 6 ? 3 : 1
  if (comments.length < requiredRoots) {
    throw new Error(
      `The model returned only ${comments.length} top-level conversation${comments.length === 1 ? '' : 's'}; at least ${requiredRoots} are required.`,
    )
  }
}

function parseConversations(rawConversations: unknown[]): ThreadverseComment[] {
  if (rawConversations.length > 500) throw new Error('The generated comment tree is too large.')
  let totalComments = 0

  return rawConversations.map((value, conversationIndex) => {
    const conversation = asObject(value, `Conversation ${conversationIndex + 1}`)
    const rootObject = asObject(conversation.root, `Conversation ${conversationIndex + 1} root`)
    const rawReplies = conversation.replies ?? []
    if (!Array.isArray(rawReplies)) {
      throw new Error(`Conversation ${conversationIndex + 1} replies must be a JSON array.`)
    }
    totalComments += 1 + rawReplies.length
    if (totalComments > 500) throw new Error('The generated comment tree is too large.')

    const rootId = identifierFrom(rootObject.id) ?? `conversation-${conversationIndex + 1}`
    const root: ThreadverseComment = {
      username: stringFrom(rootObject, ['username', 'author', 'user'], `Conversation ${conversationIndex + 1} root username`),
      body: stringFrom(rootObject, ['body', 'content', 'text'], `Conversation ${conversationIndex + 1} root body`),
      score: scoreFrom(rootObject),
      replies: [],
    }

    const replyRows = rawReplies.map((replyValue, replyIndex) => {
      const reply = asObject(replyValue, `Conversation ${conversationIndex + 1} reply ${replyIndex + 1}`)
      const comment: ThreadverseComment = {
        username: stringFrom(reply, ['username', 'author', 'user'], `Conversation ${conversationIndex + 1} reply ${replyIndex + 1} username`),
        body: stringFrom(reply, ['body', 'content', 'text'], `Conversation ${conversationIndex + 1} reply ${replyIndex + 1} body`),
        score: scoreFrom(reply),
        replies: [],
      }
      return {
        id: identifierFrom(reply.id) ?? `conversation-${conversationIndex + 1}-reply-${replyIndex + 1}`,
        parentId: identifierFrom(reply.parent_id ?? reply.parentId ?? reply.reply_to),
        comment,
      }
    })

    const replyIndexes = new Map<string, number>()
    replyRows.forEach((reply, index) => {
      if (reply.id !== rootId && !replyIndexes.has(reply.id)) replyIndexes.set(reply.id, index)
    })
    replyRows.forEach((reply, index) => {
      const parentIndex = reply.parentId ? replyIndexes.get(reply.parentId) : undefined
      // The conversation itself already identifies the safe root. A missing,
      // cross-conversation, self, or forward parent can therefore be repaired
      // locally without guessing which top-level discussion it belongs to.
      if (
        !reply.parentId
        || reply.parentId === rootId
        || reply.parentId.toLowerCase() === 'root'
        || parentIndex === undefined
        || parentIndex >= index
      ) {
        root.replies.push(reply.comment)
      } else {
        replyRows[parentIndex].comment.replies.push(reply.comment)
      }
    })

    return root
  })
}

function parsePositionalComments(rawComments: unknown[]): ThreadverseComment[] {
  if (rawComments.length > 500) throw new Error('The generated comment tree is too large.')

  const rows = rawComments.map((value, index) => {
    if (!Array.isArray(value) || value.length !== 4) {
      throw new Error(`Comment row ${index + 1} must be [parent, username, body, score].`)
    }
    const [rawParent, username, body, score] = value
    const parent = typeof rawParent === 'string' && /^-?\d+$/.test(rawParent.trim())
      ? Number(rawParent)
      : rawParent
    if (typeof parent !== 'number' || !Number.isInteger(parent)) {
      throw new Error(`Comment row ${index + 1} has an invalid parent index.`)
    }
    return { parent, username, body, score }
  })

  const parents = rows.map((row) => row.parent)
  const zeroBasedMinusRootIsValid = parents.every((parent, index) => (
    parent === -1 || (parent >= 0 && parent < index)
  ))
  const oneBasedMinusRootIsValid = parents.every((parent, index) => (
    parent === -1 || (parent >= 1 && parent <= index)
  ))
  const parentMode = parents[0] === 0
    ? 'one-based-zero-root'
    : parents[0] === -1 && oneBasedMinusRootIsValid && !zeroBasedMinusRootIsValid
      ? 'one-based-minus-root'
      : 'zero-based-minus-root'

  const normalizedParents = rows.map(({ parent: encodedParent }, index) => {
    const parent = parentMode === 'one-based-zero-root'
      ? encodedParent === 0 ? -1 : encodedParent - 1
      : parentMode === 'one-based-minus-root'
        ? encodedParent === -1 ? -1 : encodedParent - 1
        : encodedParent

    // Some models use a row's own number as a top-level marker even after being
    // told to use zero. That reference cannot describe a reply, so treating it
    // as a root preserves the only unambiguous interpretation.
    if (parent === index) return -1
    if (parent !== -1 && (parent < 0 || parent >= rows.length)) {
      throw new Error(
        `Comment row ${index + 1} has an invalid parent index (${encodedParent}).`,
      )
    }
    return parent
  })

  const depths = new Array<number>(rows.length).fill(-1)
  const visiting = new Set<number>()
  const resolveDepth = (index: number): number => {
    if (depths[index] >= 0) return depths[index]
    if (visiting.has(index)) {
      throw new Error(`The generated comment tree contains a parent cycle at row ${index + 1}.`)
    }
    visiting.add(index)
    const parent = normalizedParents[index]
    const depth = parent === -1 ? 0 : resolveDepth(parent) + 1
    if (depth > 12) throw new Error('The generated comment tree is too large.')
    visiting.delete(index)
    depths[index] = depth
    return depth
  }
  rows.forEach((_, index) => resolveDepth(index))

  const comments: ThreadverseComment[] = rows.map(({ username, body, score }, index) => ({
    username: positionalString(username, `Comment row ${index + 1} username`),
    body: positionalString(body, `Comment row ${index + 1} body`),
    score: positionalScore(score),
    replies: [],
  }))
  const roots: ThreadverseComment[] = []
  comments.forEach((comment, index) => {
    const parent = normalizedParents[index]
    if (parent === -1) roots.push(comment)
    else comments[parent].replies.push(comment)
  })

  return roots
}

function extractJsonObject(text: string): string {
  const unfenced = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '')
  const start = unfenced.indexOf('{')
  if (start < 0) throw new Error('The model response did not contain a JSON object.')
  let depth = 0
  let quoted = false
  let escaped = false
  for (let index = start; index < unfenced.length; index += 1) {
    const character = unfenced[index]
    if (quoted) {
      if (escaped) escaped = false
      else if (character === '\\') escaped = true
      else if (character === '"') quoted = false
      continue
    }
    if (character === '"') quoted = true
    else if (character === '{') depth += 1
    else if (character === '}' && --depth === 0) return unfenced.slice(start, index + 1)
  }
  throw new Error('The model response contained incomplete JSON.')
}

export function parseThreadverseFeed(text: string): ThreadverseFeed {
  let parsed: unknown
  try {
    parsed = JSON.parse(extractJsonObject(text))
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('The model response')) throw error
    throw new Error('The model returned invalid JSON.')
  }
  const root = asObject(parsed, 'Feed')
  const post = asObject(root.post ?? root.openingPost ?? root.opening_post, 'Post')
  let totalComments = 0

  const parseComment = (value: unknown, depth: number): ThreadverseComment => {
    if (depth > 12 || totalComments >= 500) throw new Error('The generated comment tree is too large.')
    totalComments += 1
    const comment = asObject(value, 'Comment')
    const replies = comment.replies ?? comment.children ?? []
    if (!Array.isArray(replies)) throw new Error('Comment replies must be a JSON array.')
    return {
      username: stringFrom(comment, ['username', 'author', 'user'], 'Comment username'),
      body: stringFrom(comment, ['body', 'content', 'text'], 'Comment body'),
      score: scoreFrom(comment),
      replies: replies.map((reply) => parseComment(reply, depth + 1)),
    }
  }

  let comments: ThreadverseComment[]
  if (Array.isArray(root.conversations)) {
    comments = parseConversations(root.conversations)
  } else {
    const rawComments = root.comments
    if (!Array.isArray(rawComments)) {
      throw new Error('Feed conversations or comments must be a JSON array.')
    }
    comments = rawComments.some((comment) => Array.isArray(comment))
      ? parsePositionalComments(rawComments)
      : rawComments.map((comment) => parseComment(comment, 0))
  }

  return {
    title: stringFrom(root, ['title'], 'Thread title'),
    post: {
      username: stringFrom(post, ['username', 'author', 'user'], 'Post username'),
      body: stringFrom(post, ['body', 'content', 'text'], 'Post body'),
      score: scoreFrom(post),
    },
    comments,
  }
}

export function parseGeneratedThreadverseFeed(text: string): ThreadverseFeed {
  const feed = parseThreadverseFeed(text)
  requireDiscussionNesting(feed.comments)
  return feed
}

export function serializeFeedForContinuity(feed: ThreadverseFeed): string {
  const comments: string[] = []
  const appendComments = (items: ThreadverseComment[]): void => {
    for (const comment of items) {
      comments.push(`${comment.username} [${comment.score}]:\n${comment.body}`)
      appendComments(comment.replies)
    }
  }
  appendComments(feed.comments)

  return [
    feed.title,
    `${feed.post.username} [${feed.post.score}]:\n${feed.post.body}`,
    ...comments,
  ].join('\n\n')
}

export function serializeFeedAsPlainText(feed: ThreadverseFeed): string {
  const comments: string[] = []
  const appendComments = (items: ThreadverseComment[]): void => {
    for (const comment of items) {
      comments.push(`${comment.username}:\n${comment.body}`)
      appendComments(comment.replies)
    }
  }
  appendComments(feed.comments)

  return [
    feed.title,
    `${feed.post.username}:\n${feed.post.body}`,
    ...comments,
  ].join('\n\n')
}
