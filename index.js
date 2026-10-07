// src/host.ts
var NAMESPACE = "st_threads";
function liveKey(context) {
  if (!context.chatId)
    return null;
  if (context.groupId)
    return JSON.stringify(["group", context.groupId, context.chatId]);
  const character = context.characters?.[context.characterId ?? -1];
  if (!character?.avatar)
    return null;
  return JSON.stringify(["character", character.avatar, context.chatMetadata?.integrity || context.chatId]);
}
function createHost(getContext, tt) {
  const storage = tt?.api?.extension?.store;
  return {
    async readChat() {
      const context = getContext();
      const identity = liveKey(context);
      if (!identity)
        return null;
      const group = context.groups?.find((item) => item.id === context.groupId);
      const character = context.characters?.[context.characterId ?? -1];
      const messages = context.chat.flatMap((item, index) => {
        if (!item || item.is_system || typeof item.mes !== "string" || !item.mes.trim())
          return [];
        return [{
          index,
          name: item.name || (item.is_user ? "You" : "Character"),
          role: item.is_user ? "user" : "assistant",
          content: item.mes
        }];
      });
      const stable = tt?.api?.chat ? await tt.api.chat.current.handle().stableId() : identity;
      if (liveKey(getContext()) !== identity)
        throw new Error("The chat changed while loading. Refresh the list.");
      return {
        key: `${tt ? "tt" : "st"}:${context.groupId ? "group" : "character"}:${stable}`,
        name: `${group?.name || character?.name || "Chat"} · ${context.chatId}`,
        messages
      };
    },
    listProfiles() {
      const context = getContext();
      const service = context.ConnectionManagerRequestService;
      if (!service || context.extensionSettings.disabledExtensions?.includes("connection-manager")) {
        throw new Error("Enable Connection Manager to choose a generation profile.");
      }
      return service.getSupportedProfiles().filter((item) => item.api && context.CONNECT_API_MAP?.[item.api]?.selected === "openai").map((item) => ({ id: item.id, name: item.name || item.id, model: item.model || "" }));
    },
    async readStore() {
      if (storage) {
        const result = await storage.tryGetJson({ namespace: NAMESPACE, key: "state" });
        return result.found ? result.value : undefined;
      }
      return structuredClone(getContext().extensionSettings[NAMESPACE]);
    },
    async writeStore(store) {
      if (storage) {
        await storage.setJson({ namespace: NAMESPACE, key: "state", value: store });
      } else {
        const context = getContext();
        context.extensionSettings[NAMESPACE] = structuredClone(store);
        context.saveSettingsDebounced();
      }
    },
    async generate(profileId, prompt, maxTokens, signal, progress) {
      const context = getContext();
      if (!this.listProfiles().some((item) => item.id === profileId)) {
        throw new Error("Select an available Chat Completion profile in Connection Manager.");
      }
      const service = context.ConnectionManagerRequestService;
      const output = await service.sendRequest(profileId, [{ role: "user", content: prompt }], maxTokens, { stream: true, signal, extractData: true, includePreset: true });
      let text = "";
      if (typeof output === "function") {
        for await (const chunk of output()) {
          signal.throwIfAborted();
          if (typeof chunk.text === "string") {
            text = chunk.text;
            progress(text);
          }
        }
      } else if (typeof output?.content === "string") {
        text = output.content;
        progress(text);
      }
      signal.throwIfAborted();
      if (!text.trim())
        throw new Error("The model returned an empty response.");
      return text;
    },
    subscribe(handler) {
      const context = getContext();
      const names = [
        "CHAT_CHANGED",
        "CHAT_RENAMED",
        "CHAT_DELETED",
        "GROUP_CHAT_DELETED",
        "MESSAGE_SENT",
        "MESSAGE_RECEIVED",
        "MESSAGE_EDITED",
        "MESSAGE_DELETED",
        "MESSAGE_SWIPED"
      ];
      const events = [...new Set(names.map((name) => context.eventTypes[name]).filter(Boolean))];
      for (const event of events)
        context.eventSource.on(event, handler);
      return () => {
        for (const event of events)
          context.eventSource.removeListener(event, handler);
      };
    }
  };
}

// src/core/feed.ts
function asObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be a JSON object.`);
  }
  return value;
}
function stringFrom(object, keys, label) {
  for (const key of keys) {
    const value = object[key];
    if (typeof value === "string" && value.trim())
      return value.trim();
  }
  throw new Error(`${label} is missing.`);
}
function scoreFrom(object) {
  const value = object.score ?? object.upvotes ?? object.votes;
  return typeof value === "number" && Number.isFinite(value) ? Math.round(value) : 0;
}
function positionalString(value, label) {
  if (typeof value === "string" && value.trim())
    return value.trim();
  throw new Error(`${label} is missing.`);
}
function positionalScore(value) {
  return typeof value === "number" && Number.isFinite(value) ? Math.round(value) : 0;
}
function identifierFrom(value) {
  if (typeof value === "string" && value.trim())
    return value.trim();
  if (typeof value === "number" && Number.isFinite(value))
    return String(value);
  return null;
}
function nestingStats(comments) {
  let total = 0;
  let replies = 0;
  let conversationsWithReplies = 0;
  const visit = (items, depth) => {
    for (const comment of items) {
      total += 1;
      if (depth > 0)
        replies += 1;
      visit(comment.replies, depth + 1);
    }
  };
  for (const comment of comments) {
    if (comment.replies.length > 0)
      conversationsWithReplies += 1;
    visit([comment], 0);
  }
  return { total, replies, conversationsWithReplies };
}
function requireDiscussionNesting(comments) {
  const stats = nestingStats(comments);
  if (stats.total < 2)
    return;
  const requiredReplies = Math.min(stats.total - 1, Math.max(1, Math.ceil(stats.total * 0.35)));
  if (stats.replies < requiredReplies) {
    throw new Error(`The model returned a flat discussion: ${stats.replies} of ${stats.total} comments are replies, but at least ${requiredReplies} are required.`);
  }
  const requiredConversations = Math.min(3, Math.floor(stats.total / 2));
  if (stats.conversationsWithReplies < requiredConversations) {
    throw new Error(`The model replied within only ${stats.conversationsWithReplies} top-level conversation${stats.conversationsWithReplies === 1 ? "" : "s"}; at least ${requiredConversations} are required.`);
  }
  const requiredRoots = stats.total >= 6 ? 3 : 1;
  if (comments.length < requiredRoots) {
    throw new Error(`The model returned only ${comments.length} top-level conversation${comments.length === 1 ? "" : "s"}; at least ${requiredRoots} are required.`);
  }
}
function parseConversations(rawConversations) {
  if (rawConversations.length > 500)
    throw new Error("The generated comment tree is too large.");
  let totalComments = 0;
  return rawConversations.map((value, conversationIndex) => {
    const conversation = asObject(value, `Conversation ${conversationIndex + 1}`);
    const rootObject = asObject(conversation.root, `Conversation ${conversationIndex + 1} root`);
    const rawReplies = conversation.replies ?? [];
    if (!Array.isArray(rawReplies)) {
      throw new Error(`Conversation ${conversationIndex + 1} replies must be a JSON array.`);
    }
    totalComments += 1 + rawReplies.length;
    if (totalComments > 500)
      throw new Error("The generated comment tree is too large.");
    const rootId = identifierFrom(rootObject.id) ?? `conversation-${conversationIndex + 1}`;
    const root = {
      username: stringFrom(rootObject, ["username", "author", "user"], `Conversation ${conversationIndex + 1} root username`),
      body: stringFrom(rootObject, ["body", "content", "text"], `Conversation ${conversationIndex + 1} root body`),
      score: scoreFrom(rootObject),
      replies: []
    };
    const replyRows = rawReplies.map((replyValue, replyIndex) => {
      const reply = asObject(replyValue, `Conversation ${conversationIndex + 1} reply ${replyIndex + 1}`);
      const comment = {
        username: stringFrom(reply, ["username", "author", "user"], `Conversation ${conversationIndex + 1} reply ${replyIndex + 1} username`),
        body: stringFrom(reply, ["body", "content", "text"], `Conversation ${conversationIndex + 1} reply ${replyIndex + 1} body`),
        score: scoreFrom(reply),
        replies: []
      };
      return {
        id: identifierFrom(reply.id) ?? `conversation-${conversationIndex + 1}-reply-${replyIndex + 1}`,
        parentId: identifierFrom(reply.parent_id ?? reply.parentId ?? reply.reply_to),
        comment
      };
    });
    const replyIndexes = new Map;
    replyRows.forEach((reply, index) => {
      if (reply.id !== rootId && !replyIndexes.has(reply.id))
        replyIndexes.set(reply.id, index);
    });
    replyRows.forEach((reply, index) => {
      const parentIndex = reply.parentId ? replyIndexes.get(reply.parentId) : undefined;
      if (!reply.parentId || reply.parentId === rootId || reply.parentId.toLowerCase() === "root" || parentIndex === undefined || parentIndex >= index) {
        root.replies.push(reply.comment);
      } else {
        replyRows[parentIndex].comment.replies.push(reply.comment);
      }
    });
    return root;
  });
}
function parsePositionalComments(rawComments) {
  if (rawComments.length > 500)
    throw new Error("The generated comment tree is too large.");
  const rows = rawComments.map((value, index) => {
    if (!Array.isArray(value) || value.length !== 4) {
      throw new Error(`Comment row ${index + 1} must be [parent, username, body, score].`);
    }
    const [rawParent, username, body, score] = value;
    const parent = typeof rawParent === "string" && /^-?\d+$/.test(rawParent.trim()) ? Number(rawParent) : rawParent;
    if (typeof parent !== "number" || !Number.isInteger(parent)) {
      throw new Error(`Comment row ${index + 1} has an invalid parent index.`);
    }
    return { parent, username, body, score };
  });
  const parents = rows.map((row) => row.parent);
  const zeroBasedMinusRootIsValid = parents.every((parent, index) => parent === -1 || parent >= 0 && parent < index);
  const oneBasedMinusRootIsValid = parents.every((parent, index) => parent === -1 || parent >= 1 && parent <= index);
  const parentMode = parents[0] === 0 ? "one-based-zero-root" : parents[0] === -1 && oneBasedMinusRootIsValid && !zeroBasedMinusRootIsValid ? "one-based-minus-root" : "zero-based-minus-root";
  const normalizedParents = rows.map(({ parent: encodedParent }, index) => {
    const parent = parentMode === "one-based-zero-root" ? encodedParent === 0 ? -1 : encodedParent - 1 : parentMode === "one-based-minus-root" ? encodedParent === -1 ? -1 : encodedParent - 1 : encodedParent;
    if (parent === index)
      return -1;
    if (parent !== -1 && (parent < 0 || parent >= rows.length)) {
      throw new Error(`Comment row ${index + 1} has an invalid parent index (${encodedParent}).`);
    }
    return parent;
  });
  const depths = new Array(rows.length).fill(-1);
  const visiting = new Set;
  const resolveDepth = (index) => {
    if (depths[index] >= 0)
      return depths[index];
    if (visiting.has(index)) {
      throw new Error(`The generated comment tree contains a parent cycle at row ${index + 1}.`);
    }
    visiting.add(index);
    const parent = normalizedParents[index];
    const depth = parent === -1 ? 0 : resolveDepth(parent) + 1;
    if (depth > 12)
      throw new Error("The generated comment tree is too large.");
    visiting.delete(index);
    depths[index] = depth;
    return depth;
  };
  rows.forEach((_, index) => resolveDepth(index));
  const comments = rows.map(({ username, body, score }, index) => ({
    username: positionalString(username, `Comment row ${index + 1} username`),
    body: positionalString(body, `Comment row ${index + 1} body`),
    score: positionalScore(score),
    replies: []
  }));
  const roots = [];
  comments.forEach((comment, index) => {
    const parent = normalizedParents[index];
    if (parent === -1)
      roots.push(comment);
    else
      comments[parent].replies.push(comment);
  });
  return roots;
}
function extractJsonObject(text) {
  const unfenced = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "");
  const start = unfenced.indexOf("{");
  if (start < 0)
    throw new Error("The model response did not contain a JSON object.");
  let depth = 0;
  let quoted = false;
  let escaped = false;
  for (let index = start;index < unfenced.length; index += 1) {
    const character = unfenced[index];
    if (quoted) {
      if (escaped)
        escaped = false;
      else if (character === "\\")
        escaped = true;
      else if (character === '"')
        quoted = false;
      continue;
    }
    if (character === '"')
      quoted = true;
    else if (character === "{")
      depth += 1;
    else if (character === "}" && --depth === 0)
      return unfenced.slice(start, index + 1);
  }
  throw new Error("The model response contained incomplete JSON.");
}
function parseThreadverseFeed(text) {
  let parsed;
  try {
    parsed = JSON.parse(extractJsonObject(text));
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("The model response"))
      throw error;
    throw new Error("The model returned invalid JSON.");
  }
  const root = asObject(parsed, "Feed");
  const post = asObject(root.post ?? root.openingPost ?? root.opening_post, "Post");
  let totalComments = 0;
  const parseComment = (value, depth) => {
    if (depth > 12 || totalComments >= 500)
      throw new Error("The generated comment tree is too large.");
    totalComments += 1;
    const comment = asObject(value, "Comment");
    const replies = comment.replies ?? comment.children ?? [];
    if (!Array.isArray(replies))
      throw new Error("Comment replies must be a JSON array.");
    return {
      username: stringFrom(comment, ["username", "author", "user"], "Comment username"),
      body: stringFrom(comment, ["body", "content", "text"], "Comment body"),
      score: scoreFrom(comment),
      replies: replies.map((reply) => parseComment(reply, depth + 1))
    };
  };
  let comments;
  if (Array.isArray(root.conversations)) {
    comments = parseConversations(root.conversations);
  } else {
    const rawComments = root.comments;
    if (!Array.isArray(rawComments)) {
      throw new Error("Feed conversations or comments must be a JSON array.");
    }
    comments = rawComments.some((comment) => Array.isArray(comment)) ? parsePositionalComments(rawComments) : rawComments.map((comment) => parseComment(comment, 0));
  }
  return {
    title: stringFrom(root, ["title"], "Thread title"),
    post: {
      username: stringFrom(post, ["username", "author", "user"], "Post username"),
      body: stringFrom(post, ["body", "content", "text"], "Post body"),
      score: scoreFrom(post)
    },
    comments
  };
}
function parseGeneratedThreadverseFeed(text) {
  const feed = parseThreadverseFeed(text);
  requireDiscussionNesting(feed.comments);
  return feed;
}
function serializeFeedAsPlainText(feed) {
  const comments = [];
  const appendComments = (items) => {
    for (const comment of items) {
      comments.push(`${comment.username}:
${comment.body}`);
      appendComments(comment.replies);
    }
  };
  appendComments(feed.comments);
  return [
    feed.title,
    `${feed.post.username}:
${feed.post.body}`,
    ...comments
  ].join(`

`);
}

// src/core/prompt.ts
function renderBlocks(items) {
  if (items.length === 0)
    return "";
  return items.map((item) => `## ${item.label}
${item.content.trim()}`).join(`

`);
}
function buildThreadversePrompt(input) {
  const fandomNotes = input.fandomNotes?.trim() ?? "";
  return [
    ...input.previousRanges.length > 0 ? ["# PREVIOUS CONTEXT", renderBlocks(input.previousRanges)] : [],
    "# RECENT CONTEXT",
    renderBlocks([input.recentRange]),
    ...input.fandomContinuity.length > 0 ? ["# FANDOM CONTINUITY", renderBlocks(input.fandomContinuity)] : [],
    ...fandomNotes ? ["# FANDOM NOTES", fandomNotes] : [],
    "# INSTRUCTIONS",
    input.instructions.trim(),
    "# OUTPUT FORMAT",
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
Return ONLY the JSON—no explanations, no notes, no commentary.`
  ].join(`

`);
}

// src/store.ts
var DEFAULT_INSTRUCTIONS = `You are simulating an online fandom discussing a fictional story as an ongoing television series or serialized fanfiction.
Discuss the selected scene as an audience. Do not continue or rewrite the story.
Create a Reddit-style discussion with an opening post, varied usernames, nested replies, votes, theories, jokes, shipping, criticism and disagreement.
Write the discussion in English. Create 3 to 5 separate conversations, each with replies.`;
var LEGACY_DEFAULT_INSTRUCTIONS = DEFAULT_INSTRUCTIONS.replace("in English.", "in Brazilian Portuguese.");
var MAX_FEEDS_PER_CHAT = 10;
function normalizeSettings(value) {
  const item = value && typeof value === "object" ? value : {};
  return {
    profileId: typeof item.profileId === "string" ? item.profileId : "",
    maxTokens: typeof item.maxTokens === "number" && Number.isInteger(item.maxTokens) && item.maxTokens >= 256 && item.maxTokens <= 32768 ? item.maxTokens : 4096,
    instructions: typeof item.instructions === "string" && item.instructions.trim() && item.instructions.replace(/\r\n/g, `
`) !== LEGACY_DEFAULT_INSTRUCTIONS ? item.instructions : DEFAULT_INSTRUCTIONS
  };
}
function normalizeStore(value) {
  const input = value && typeof value === "object" ? value : {};
  if (input.version !== undefined && input.version !== 1) {
    throw new Error("The saved data belongs to another version. Back it up before continuing.");
  }
  const result = { version: 1, settings: normalizeSettings(input.settings), chats: Object.create(null) };
  if (input.chats && typeof input.chats === "object") {
    for (const [key, raw] of Object.entries(input.chats)) {
      if (!raw || typeof raw !== "object" || typeof raw.name !== "string" || !Array.isArray(raw.feeds))
        continue;
      const feeds = [];
      for (const item of raw.feeds.slice(-MAX_FEEDS_PER_CHAT)) {
        if (!item || typeof item.id !== "string" || typeof item.label !== "string" || typeof item.createdAt !== "string" || !Array.isArray(item.scene))
          continue;
        try {
          feeds.push({
            id: item.id,
            label: item.label,
            createdAt: item.createdAt,
            scene: item.scene.filter((message) => message && Number.isInteger(message.index) && typeof message.content === "string" && typeof message.name === "string" && (message.role === "user" || message.role === "assistant")),
            feed: parseThreadverseFeed(JSON.stringify(item.feed))
          });
        } catch {}
      }
      result.chats[key] = { name: raw.name, feeds };
    }
  }
  return result;
}

class Repository {
  host;
  queue = Promise.resolve();
  constructor(host) {
    this.host = host;
  }
  async read() {
    await this.queue.catch(() => {
      return;
    });
    return normalizeStore(await this.host.readStore());
  }
  update(change) {
    const operation = this.queue.catch(() => {
      return;
    }).then(async () => {
      const store = normalizeStore(await this.host.readStore());
      change(store);
      await this.host.writeStore(store);
      return store;
    });
    this.queue = operation;
    return operation;
  }
}

// src/generation.ts
function appendFeed(store, origin, saved) {
  const previous = store.chats[origin.key]?.feeds || [];
  store.chats[origin.key] = {
    name: origin.name,
    feeds: [...previous.filter((item) => item.id !== saved.id), saved].slice(-MAX_FEEDS_PER_CHAT)
  };
}

class SaveFeedError extends Error {
  saved;
  constructor(saved, cause) {
    super("The feed was generated but could not be saved.", { cause });
    this.saved = saved;
  }
}
function sameMessage(left, right) {
  return left.index === right.index && left.role === right.role && left.content === right.content;
}
function scenePrompt(scene, label, instructions) {
  return buildThreadversePrompt({
    previousRanges: [],
    fandomContinuity: [],
    recentRange: {
      label: label.trim() || "Selected scene",
      content: scene.map((item) => `[${item.name} / ${item.role}]
${item.content}`).join(`

`)
    },
    instructions
  });
}

class Generation {
  host;
  repository;
  active = null;
  saving = false;
  get running() {
    return this.active !== null;
  }
  get committing() {
    return this.saving;
  }
  constructor(host, repository) {
    this.host = host;
    this.repository = repository;
  }
  cancel() {
    if (!this.saving)
      this.active?.abort(new DOMException("Generation canceled.", "AbortError"));
  }
  async run(expected, indices, label, settings, progress, onCommit = () => {}) {
    if (this.active)
      throw new Error("A generation is already in progress.");
    const selected = expected.messages.filter((item) => indices.has(item.index));
    if (!selected.length)
      throw new Error("Select at least one message.");
    if (!settings.profileId)
      throw new Error("Choose a generation profile.");
    const controller = new AbortController;
    this.active = controller;
    try {
      const snapshot = await this.host.readChat();
      controller.signal.throwIfAborted();
      if (!snapshot || snapshot.key !== expected.key || selected.some((item) => {
        const current = snapshot.messages.find((message) => message.index === item.index);
        return !current || !sameMessage(item, current);
      }))
        throw new Error("The scene changed. Refresh the list and check your selection before generating.");
      const scene = structuredClone(selected);
      const prompt = scenePrompt(scene, label, settings.instructions);
      const output = await this.host.generate(settings.profileId, prompt, settings.maxTokens, controller.signal, progress);
      controller.signal.throwIfAborted();
      const feed = parseGeneratedThreadverseFeed(output);
      const saved = {
        id: crypto.randomUUID(),
        createdAt: new Date().toISOString(),
        label: label.trim() || "Selected scene",
        scene,
        feed
      };
      try {
        await this.repository.update((store) => {
          controller.signal.throwIfAborted();
          this.saving = true;
          onCommit();
          appendFeed(store, snapshot, saved);
        });
      } catch (error) {
        if (controller.signal.aborted)
          throw error;
        throw new SaveFeedError(saved, error);
      }
      return saved;
    } catch (error) {
      if (controller.signal.aborted)
        throw new DOMException("Generation canceled.", "AbortError");
      throw error;
    } finally {
      this.saving = false;
      if (this.active === controller)
        this.active = null;
    }
  }
}

// src/ui.ts
function element(tag, className = "", text = "") {
  const item = document.createElement(tag);
  item.className = className;
  item.textContent = text;
  return item;
}
function errorText(error) {
  if (!(error instanceof Error))
    return "Could not complete the operation.";
  const cause = error.cause instanceof Error ? ` ${error.cause.message}` : "";
  return error.message + cause;
}
async function mountUi(host) {
  const repository = new Repository(host);
  let store = await repository.read();
  const generation = new Generation(host, repository);
  let snapshot = null;
  let selection = new Set;
  let disposed = false;
  let revision = 0;
  let visibleCount = 100;
  let refreshTimer;
  let unsaved = null;
  let unsavedChat = null;
  let operationPending = false;
  const launcher = element("div", "sth-launcher");
  const openButton = element("button", "menu_button", "Open ST Threads");
  openButton.type = "button";
  launcher.append(element("strong", "", "ST Threads"), element("p", "", "See your story through the eyes of a fandom."), openButton);
  const target = document.querySelector("#extensions_settings2, #extensions_settings");
  if (!target)
    launcher.classList.add("sth-floating-launcher");
  (target || document.body).append(launcher);
  const dialog = element("dialog", "sth-dialog");
  dialog.setAttribute("aria-labelledby", "sth-title");
  dialog.innerHTML = `
    <header class="sth-header"><div><h2 id="sth-title">ST Threads</h2><p data-chat>Open a chat to get started.</p></div>
      <button type="button" data-close aria-label="Close panel">✕</button></header>
    <nav class="sth-tabs" aria-label="ST Threads sections">
      <button type="button" data-tab="make" aria-pressed="true">Create feed</button>
      <button type="button" data-tab="feeds" aria-pressed="false">Saved feeds</button>
      <button type="button" data-tab="settings" aria-pressed="false">Settings</button>
    </nav>
    <div class="sth-status" data-status role="status" aria-live="polite"></div>
    <div class="sth-content">
      <section data-panel="make">
        <div class="sth-card"><h3>Select a scene</h3>
          <p>Select the messages the fandom will discuss. The feed stays separate from your roleplay.</p>
          <div class="sth-toolbar"><button type="button" data-refresh>Refresh</button>
            <button type="button" data-clear>Clear selection</button><span data-count>0 selected</span></div>
          <div class="sth-range"><label>From message<input type="number" min="1" step="1" data-from></label>
            <label>To message<input type="number" min="1" step="1" data-to></label>
            <button type="button" data-range>Select range</button></div>
          <label class="sth-field">Search messages<input type="search" data-search placeholder="Scene text or name…"></label>
          <div class="sth-messages" data-messages></div>
          <button type="button" data-more hidden>Show earlier messages</button>
        </div>
        <div class="sth-card">
          <label class="sth-field">Scene title<input type="text" data-label maxlength="200" placeholder="Chapter, episode or scene"></label>
          <label class="sth-field">Generation profile<select data-profile><option value="">Choose a profile…</option></select></label>
          <p class="sth-hint" data-profile-hint></p>
          <div class="sth-toolbar"><button type="button" class="sth-primary" data-generate>Generate feed</button>
            <button type="button" data-cancel hidden>Cancel generation</button></div>
          <details><summary>Model response</summary><pre class="sth-output" data-output></pre></details>
        </div>
      </section>
      <section data-panel="feeds" hidden><p class="sth-hint">The latest 10 feeds are saved for each chat.</p><div data-feeds></div></section>
      <section data-panel="settings" hidden><div class="sth-card">
        <label class="sth-field">Response token limit<input type="number" data-tokens min="256" max="32768" step="1"></label>
        <label class="sth-field">Fandom instructions<textarea data-instructions rows="9"></textarea></label>
        <p class="sth-hint">This first version discusses only the selected scene. Continuity between feeds and regex support will follow in future updates.</p>
        <button type="button" data-save-settings>Save settings</button>
      </div></section>
    </div>`;
  document.body.append(dialog);
  function query(selector) {
    const result = dialog.querySelector(selector);
    if (!result)
      throw new Error(`Missing element: ${selector}`);
    return result;
  }
  const messages = query("[data-messages]");
  const profile = query("[data-profile]");
  const search = query("[data-search]");
  const sceneLabel = query("[data-label]");
  const instructions = query("[data-instructions]");
  const tokens = query("[data-tokens]");
  instructions.value = store.settings.instructions;
  tokens.value = String(store.settings.maxTokens);
  function status(text, error = false) {
    if (disposed)
      return;
    const node = query("[data-status]");
    node.textContent = text;
    node.classList.toggle("sth-error", error);
  }
  function tab(name) {
    for (const section of dialog.querySelectorAll("[data-panel]"))
      section.hidden = section.dataset.panel !== name;
    for (const button of dialog.querySelectorAll("[data-tab]")) {
      button.setAttribute("aria-pressed", String(button.dataset.tab === name));
    }
  }
  function settings() {
    const maxTokens = Number(tokens.value);
    if (!Number.isInteger(maxTokens) || maxTokens < 256 || maxTokens > 32768) {
      throw new Error("The token limit must be an integer between 256 and 32768.");
    }
    if (!instructions.value.trim())
      throw new Error("Enter the fandom instructions.");
    return normalizeSettings({ profileId: profile.value, maxTokens, instructions: instructions.value });
  }
  function controls() {
    const busy = operationPending || generation.running;
    query("[data-generate]").disabled = busy || !snapshot || selection.size === 0 || !profile.value || !!unsaved;
    query("[data-cancel]").hidden = !generation.running;
    query("[data-cancel]").disabled = generation.committing;
    query("[data-save-settings]").disabled = busy;
    profile.disabled = busy;
    query("[data-count]").textContent = `${selection.size} selected`;
  }
  function profiles() {
    const previous = profile.value || store.settings.profileId;
    const option = (text, value) => {
      const node = element("option", "", text);
      node.value = value;
      return node;
    };
    profile.replaceChildren(option("Choose a profile…", ""));
    try {
      const available = host.listProfiles();
      for (const item of available)
        profile.append(option(`${item.name}${item.model ? ` · ${item.model}` : ""}`, item.id));
      profile.value = available.some((item) => item.id === previous) ? previous : "";
      query("[data-profile-hint]").textContent = available.length ? "Uses the selected profile without changing your roleplay connection." : "Create a Chat Completion profile in Connection Manager, then refresh this panel.";
    } catch (error) {
      query("[data-profile-hint]").textContent = errorText(error);
    }
    controls();
  }
  function renderMessages() {
    const queryText = search.value.trim().toLocaleLowerCase();
    const matching = (snapshot?.messages || []).filter((item) => !queryText || `${item.name}
${item.content}`.toLocaleLowerCase().includes(queryText));
    const displayed = matching.slice(-visibleCount);
    const fragment = document.createDocumentFragment();
    if (!displayed.length)
      fragment.append(element("p", "sth-empty", snapshot ? "No messages found." : "Open a character or group chat."));
    for (const item of displayed) {
      const row = element("label", "sth-message");
      const checkbox = element("input");
      checkbox.type = "checkbox";
      checkbox.checked = selection.has(item.index);
      checkbox.dataset.index = String(item.index);
      const body = element("div");
      body.append(element("strong", "", `#${item.index + 1} · ${item.name}`), element("p", "", item.content));
      row.append(checkbox, body);
      fragment.append(row);
    }
    messages.replaceChildren(fragment);
    query("[data-more]").hidden = displayed.length === matching.length;
    controls();
  }
  function renderComment(comment) {
    const node = element("article", "sth-comment");
    node.append(element("strong", "sth-author", `u/${comment.username} · ${comment.score} votes`), element("p", "sth-body", comment.body));
    if (comment.replies.length) {
      const children = element("div", "sth-replies");
      for (const reply of comment.replies)
        children.append(renderComment(reply));
      node.append(children);
    }
    return node;
  }
  function feedCard(item) {
    const card = element("article", "sth-card sth-feed");
    card.append(element("p", "sth-hint", `${item.label} · ${new Date(item.createdAt).toLocaleString("en-US")}`), element("h3", "", item.feed.title), element("strong", "sth-author", `u/${item.feed.post.username} · ${item.feed.post.score} votes`), element("p", "sth-body", item.feed.post.body));
    const copy = element("button", "", "Copy feed");
    copy.type = "button";
    copy.addEventListener("click", () => {
      if (!navigator.clipboard?.writeText) {
        status("Select the feed text to copy it manually.", true);
        return;
      }
      navigator.clipboard.writeText(serializeFeedAsPlainText(item.feed)).then(() => status("Feed copied.")).catch(() => status("Could not copy the feed. Select the feed text to copy it manually.", true));
    });
    card.append(copy);
    const scene = element("details", "sth-scene");
    scene.append(element("summary", "", `Original scene · ${item.scene.length} messages`));
    for (const message of item.scene)
      scene.append(element("p", "sth-body", `#${message.index + 1} · ${message.name}
${message.content}`));
    card.append(scene);
    for (const comment of item.feed.comments)
      card.append(renderComment(comment));
    return card;
  }
  function renderFeeds() {
    const list = query("[data-feeds]");
    list.replaceChildren();
    if (unsaved) {
      const recovery = element("div", "sth-card");
      recovery.append(element("strong", "", "Feed generated but not saved"), element("p", "", `Original chat: ${unsavedChat?.name || ""}. The result has been kept in this panel.`));
      const retry = element("button", "", "Retry saving");
      retry.type = "button";
      retry.disabled = operationPending;
      retry.addEventListener("click", () => {
        saveRecovery();
      });
      recovery.append(retry);
      list.append(recovery, feedCard(unsaved));
    }
    const feeds = snapshot ? store.chats[snapshot.key]?.feeds || [] : [];
    if (!feeds.length)
      list.append(element("p", "sth-empty", "Feeds for this chat will appear here."));
    for (const feed of [...feeds].reverse())
      list.append(feedCard(feed));
  }
  async function refresh() {
    const request = ++revision;
    try {
      const [next, nextStore] = await Promise.all([host.readChat(), repository.read()]);
      if (disposed || request !== revision)
        return;
      if (next?.key !== snapshot?.key) {
        selection.clear();
        sceneLabel.value = "";
        visibleCount = 100;
      } else if (next && snapshot) {
        selection = new Set([...selection].filter((index) => {
          const before = snapshot.messages.find((item) => item.index === index);
          const after = next.messages.find((item) => item.index === index);
          return before && after && sameMessage(before, after);
        }));
      }
      snapshot = next;
      store = nextStore;
      query("[data-chat]").textContent = next?.name || "Open a chat to get started.";
      profiles();
      renderMessages();
      renderFeeds();
    } catch (error) {
      if (!disposed && request === revision) {
        snapshot = null;
        selection.clear();
        renderMessages();
        renderFeeds();
        status(errorText(error), true);
      }
    }
  }
  async function saveSettings() {
    if (operationPending || generation.running)
      return;
    try {
      const input = settings();
      operationPending = true;
      controls();
      store = await repository.update((data) => {
        data.settings = input;
      });
      status("Settings saved.");
    } catch (error) {
      status(errorText(error), true);
    } finally {
      operationPending = false;
      if (!disposed)
        controls();
    }
  }
  async function generate() {
    if (!snapshot || operationPending || generation.running || unsaved)
      return;
    const origin = structuredClone(snapshot);
    const indices = new Set(selection);
    const label = sceneLabel.value;
    try {
      const input = settings();
      operationPending = true;
      controls();
      store = await repository.update((data) => {
        data.settings = input;
      });
      if (disposed)
        return;
      query("[data-output]").textContent = "";
      status("Generating discussion…");
      const result = generation.run(origin, indices, label, input, (text) => {
        if (disposed)
          return;
        query("[data-output]").textContent = text;
        status(`Generating discussion… ${text.length.toLocaleString("en-US")} characters received.`);
      }, () => {
        status("Saving feed…");
        controls();
      });
      controls();
      await result;
      if (disposed)
        return;
      await refresh();
      status(snapshot?.key === origin.key ? "Feed generated and saved for this chat." : `Feed saved for the original chat: ${origin.name}.`);
      tab("feeds");
    } catch (error) {
      if (disposed)
        return;
      if (error instanceof SaveFeedError) {
        unsaved = error.saved;
        unsavedChat = origin;
        renderFeeds();
        tab("feeds");
        status("The feed was generated, but saving failed. Retry saving or copy the result.", true);
      } else
        status(error instanceof DOMException && error.name === "AbortError" ? "Generation canceled. No feed was saved." : errorText(error), !(error instanceof DOMException && error.name === "AbortError"));
    } finally {
      operationPending = false;
      if (!disposed) {
        controls();
        if (unsaved)
          renderFeeds();
      }
    }
  }
  async function saveRecovery() {
    if (!unsaved || !unsavedChat || operationPending)
      return;
    operationPending = true;
    controls();
    renderFeeds();
    try {
      const result = unsaved;
      const origin = unsavedChat;
      store = await repository.update((data) => appendFeed(data, origin, result));
      unsaved = null;
      unsavedChat = null;
      status("Feed saved for the original chat.");
    } catch (error) {
      status(errorText(error), true);
    } finally {
      operationPending = false;
      if (!disposed) {
        controls();
        renderFeeds();
      }
    }
  }
  function click(event) {
    const button = event.target.closest("button");
    if (!button)
      return;
    if (button.dataset.tab)
      tab(button.dataset.tab);
    else if (button.hasAttribute("data-close"))
      dialog.close();
    else if (button.hasAttribute("data-refresh")) {
      refresh();
    } else if (button.hasAttribute("data-clear")) {
      selection.clear();
      renderMessages();
    } else if (button.hasAttribute("data-more")) {
      visibleCount += 100;
      renderMessages();
    } else if (button.hasAttribute("data-save-settings")) {
      saveSettings();
    } else if (button.hasAttribute("data-generate")) {
      generate();
    } else if (button.hasAttribute("data-cancel")) {
      generation.cancel();
      status("Canceling generation…");
    } else if (button.hasAttribute("data-range")) {
      const from = Number(query("[data-from]").value);
      const to = Number(query("[data-to]").value);
      if (!snapshot || !Number.isInteger(from) || !Number.isInteger(to) || from < 1 || to < from || to > (snapshot.messages.at(-1)?.index ?? -1) + 1) {
        status("Enter a valid message range.", true);
        return;
      }
      selection = new Set(snapshot.messages.filter((item) => item.index + 1 >= from && item.index + 1 <= to).map((item) => item.index));
      renderMessages();
    }
  }
  function changed(event) {
    const input = event.target;
    if (input.matches("[data-index]")) {
      const index = Number(input.dataset.index);
      if (input.checked)
        selection.add(index);
      else
        selection.delete(index);
      controls();
    }
  }
  function open() {
    if (!dialog.open)
      dialog.showModal();
    refresh();
  }
  const unsubscribe = host.subscribe(() => {
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => {
      refresh();
    }, 120);
  });
  openButton.addEventListener("click", open);
  dialog.addEventListener("click", click);
  dialog.addEventListener("change", changed);
  search.addEventListener("input", () => {
    visibleCount = 100;
    renderMessages();
  });
  profile.addEventListener("change", controls);
  await refresh();
  return () => {
    disposed = true;
    ++revision;
    clearTimeout(refreshTimer);
    generation.cancel();
    unsubscribe();
    openButton.removeEventListener("click", open);
    dialog.close();
    dialog.remove();
    launcher.remove();
  };
}

// src/index.ts
var dispose;
var pending;
var enabled = true;
async function initialize() {
  if (!enabled || dispose)
    return;
  if (pending)
    return pending;
  pending = (async () => {
    await (window.__TAURITAVERN__?.ready ?? window.__TAURITAVERN_MAIN_READY__);
    if (!enabled)
      return;
    const tavern = window.SillyTavern;
    if (!tavern)
      throw new Error("The SillyTavern context is not available yet.");
    const cleanup = await mountUi(createHost(() => tavern.getContext(), window.__TAURITAVERN__));
    if (!enabled)
      cleanup();
    else
      dispose = cleanup;
  })().catch((error) => {
    console.error("[ST Threads] Initialization failed:", error);
  }).finally(() => {
    pending = undefined;
  });
  return pending;
}
function onDisable() {
  enabled = false;
  dispose?.();
  dispose = undefined;
}
function onEnable() {
  enabled = true;
  initialize();
}
var start = () => {
  setTimeout(() => {
    initialize();
  }, 0);
};
var context = window.SillyTavern?.getContext();
if (context?.eventTypes.APP_READY)
  context.eventSource.on(context.eventTypes.APP_READY, start);
else if (document.readyState === "loading")
  document.addEventListener("DOMContentLoaded", start, { once: true });
else
  start();
export {
  onDisable,
  onEnable
};
