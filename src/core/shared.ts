// Feed contracts adapted from Threadverse 1.15.0 (AGPL-3.0).
export interface ThreadverseComment {
  username: string
  body: string
  score: number
  replies: ThreadverseComment[]
}

export interface ThreadverseFeed {
  title: string
  post: { username: string; body: string; score: number }
  comments: ThreadverseComment[]
}
