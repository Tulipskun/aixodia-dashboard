export interface AppConfig {
  id: string
  repo: string
  name: string
  subtitle: string
  tag: string
  accent: string
  highlights: string[]
}

export interface ConsoleConfig {
  console: { name: string; owner: string; tagline: string }
  apps: AppConfig[]
}

export interface Run {
  id: number
  name: string
  title: string
  event: string
  branch: string | null
  status: string
  conclusion: string | null
  url: string
  createdAt: string
  startedAt: string | null
  updatedAt: string
  durationSec: number | null
  actor: string | null
}

export interface CommitItem {
  sha: string
  short: string
  message: string
  author: string
  date: string | null
  url: string
}

export interface ReleaseAsset {
  name: string
  size: number
  downloads: number
  url: string
  contentType: string
}

export interface Release {
  name: string
  tag: string
  url: string
  publishedAt: string | null
  body: string
  versionCode: number | null
  assets: ReleaseAsset[]
}

export interface RepoInfo {
  name: string
  fullName: string
  url: string
  description: string
  stars: number
  forks: number
  watchers: number
  openIssues: number
  language: string | null
  pushedAt: string | null
  createdAt: string | null
  defaultBranch: string
  private: boolean
  archived: boolean
  sizeKb: number
  license: string | null
  topics: string[]
}

export interface Snapshot {
  app: AppConfig
  repo: RepoInfo
  release: Release | null
  runs: Run[]
  commits: CommitItem[]
  languages: Record<string, number>
  openPulls: number
  fetchedAt: string
}

export interface Summary {
  id: string
  name: string
  accent: string
  tag?: string
  ok: boolean
  error?: string
  openIssues?: number
  openPulls?: number
  stars?: number
  pushedAt?: string | null
  releaseName?: string | null
  versionCode?: number | null
  latestRun?: { conclusion: string | null; status: string; title: string } | null
  ciRate?: number | null
}

export interface Health {
  ok: boolean
  authenticated: boolean
  tokenSource: string
  login: string | null
  rate: { limit: number; remaining: number; reset: number; used: number } | null
  cacheTtlMs: number
  appCount: number
  consoleName: string
  owner: string
  tagline: string
}

export interface Overview {
  items: Summary[]
  fetchedAt: string
}
