/**
 * Outbound knowledge tools for DeepSeek Harness.
 *
 * Six capabilities, all verified reachable from this device's network
 * (China-direct, no proxy): search open-source repositories, browse/read
 * repository files, read commit history, download files, search the web
 * through Bing, and fetch a page's readable text.
 *
 * GitHub's code search (api.github.com/search/code) and GraphQL require
 * authentication; both return 401/403 anonymously, so this plugin reports that
 * plainly instead of pretending to support them. A `token` unlocks neither of
 * the two remaining tools here but does raise the anonymous rate limit.
 *
 * @module @local/dsh-net
 */
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { denoise, DEFAULT_BLOCKED_DOMAINS, groupBySource } from './denoise.js'
import { loadWords, loadHosts, filterSensitive, filterDangerHosts, titleStartsWith91, adultTemplateHit, hardNumberHit, addWord, wordStats, WORDS_FILE } from './sensitive.js'
import { searchBilibili } from './bilibili.js'

export const name = 'net'
export const inject = ['tools']

const GITHUB_API = 'https://api.github.com'
const RAW_HOST = 'https://raw.githubusercontent.com'
const BING = 'https://cn.bing.com/search'
const UA = 'Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36'
const MAX_BYTES = 4 * 1024 * 1024
const TEXT_LIMIT = 200_000
/** Cap for one fetched page once tags and boilerplate are stripped. */
const PAGE_TEXT_LIMIT = 60_000

const DEFAULTS = {
  /** Directory downloads are written to. Empty = <cwd>/downloads. */
  downloadDir: '',
  /** GitHub personal access token; raises rate limits and unlocks code search. */
  token: '',
  /** Per-request timeout. */
  timeoutMs: 20_000,
  /** Drop search hits whose host is on this list. Empty = built-in default list. */
  blockedDomains: DEFAULT_BLOCKED_DOMAINS,
  /** Drop hits that share no term with the query. Set false to keep everything. */
  denoise: true,
}

/** Error carrying the HTTP status so callers can explain rather than guess. */
class NetError extends Error {
  constructor(message, status) {
    super(message)
    this.status = status
  }
}

/** GET a URL with a bounded deadline and an optional byte cap. */
async function request(url, { headers = {}, timeoutMs, signal, as = 'text', maxBytes = MAX_BYTES } = {}) {
  const controller = new AbortController()
  const onAbort = () => controller.abort()
  if (signal !== undefined) {
    if (signal.aborted) controller.abort()
    else signal.addEventListener('abort', onAbort, { once: true })
  }
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(url, {
      headers: { 'user-agent': UA, accept: '*/*', ...headers },
      redirect: 'follow',
      signal: controller.signal,
    })
    if (!response.ok) {
      const body = await response.text().catch(() => '')
      throw new NetError(`HTTP ${response.status} ${response.statusText} for ${url}${body === '' ? '' : `\n${body.slice(0, 300)}`}`, response.status)
    }
    if (as === 'json') return await response.json()
    const buffer = Buffer.from(await response.arrayBuffer())
    if (buffer.length > maxBytes) {
      throw new NetError(`response is ${buffer.length} bytes, over the ${maxBytes} byte cap`, 413)
    }
    return buffer
  } catch (error) {
    if (error instanceof NetError) throw error
    if (error?.name === 'AbortError') throw new NetError(`request timed out after ${timeoutMs}ms: ${url}`, 408)
    throw new NetError(`request failed: ${error?.message ?? error}`, 0)
  } finally {
    clearTimeout(timer)
    if (signal !== undefined) signal.removeEventListener('abort', onAbort)
  }
}

/**
 * Build the GitHub headers.
 *
 * Token precedence: the persisted keystore (set through `net_keystore`) wins,
 * because that is the value the user updated most recently; `settings.token`
 * from the profile config is the fallback for people who prefer editing YAML.
 */
function githubHeaders(settings) {
  const headers = { accept: 'application/vnd.github+json' }
  const token = resolveToken(settings, 'github')
  if (token !== '') headers.authorization = `Bearer ${token}`
  return headers
}

/**
 * Resolve one secret by name: keystore first, then the config field that shares
 * its name (so `github` falls back to `settings.token`).
 * @param {object} settings plugin settings
 * @param {string} name keystore key
 * @returns {string} the secret, or '' when unset
 */
function resolveToken(settings, name) {
  const cached = keystoreCache.get(name)
  if (typeof cached === 'string' && cached.trim() !== '') return cached.trim()
  const fromConfig = name === 'github' ? settings.token : settings[name]
  if (typeof fromConfig === 'string' && fromConfig.trim() !== '') return fromConfig.trim()
  return ''
}

/** Split "owner/repo" into its two halves, rejecting anything else. */
function splitRepo(repo) {
  const text = String(repo ?? '').trim().replace(/^https?:\/\/github\.com\//i, '').replace(/\.git$/i, '')
  const parts = text.split('/').filter(Boolean)
  if (parts.length < 2) throw new Error(`repo must look like "owner/name", got ${JSON.stringify(repo)}`)
  return { owner: parts[0], name: parts[1], ref: parts[2] ?? '' }
}

/** Render one repository search hit for the model. */
function formatRepo(hit) {
  const meta = [hit.language, hit.stars != null ? `★${hit.stars}` : null, hit.updatedAt ? `updated ${hit.updatedAt.slice(0, 10)}` : null]
    .filter(Boolean).join(' · ')
  return `- ${hit.fullName} (${meta})\n  ${hit.description ?? '(no description)'}`.trimEnd()
}

/** Decode basic HTML entities Bing emits in result titles and snippets. */
function decodeEntities(text) {
  return text
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .trim()
}

/**
 * Extract Bing results from its server-rendered HTML. Structured blocks are
 * preferred, with a looser anchor scrape as the fallback for layout changes.
 */
function parseBing(html) {
  const results = []
  const seen = new Set()
  const push = entry => {
    if (entry.url === '' || seen.has(entry.url)) return
    seen.add(entry.url)
    results.push(entry)
  }
  const blockRe = /<li class="b_algo"[\s\S]*?<\/li>/g
  for (const block of html.match(blockRe) ?? []) {
    const link = block.match(/<h2[^>]*>\s*<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/)
    if (link === null) continue
    const snippet = block.match(/<p[^>]*>([\s\S]*?)<\/p>/)
    push({
      title: decodeEntities(link[2]),
      url: decodeEntities(link[1]),
      snippet: snippet === null ? '' : decodeEntities(snippet[1]).slice(0, 400),
    })
  }
  if (results.length === 0) {
    const anchorRe = /<h2[^>]*>\s*<a[^>]*href="(https?:\/\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/g
    for (const match of html.matchAll(anchorRe)) {
      push({ title: decodeEntities(match[2]), url: decodeEntities(match[1]), snippet: '' })
    }
  }
  return results
}

/**
 * Reduce one HTML page to readable text: drop scripts, styles, and chrome,
 * turn block-level tags into line breaks, strip the rest, and decode entities.
 * Deliberately regex-based (no DOM in this runtime) and conservative: unknown
 * tags are simply removed, so the worst case is slightly noisy text.
 */
function htmlToText(html) {
  let text = html
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|noscript|svg|iframe|template)\b[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<head\b[\s\S]*?<\/head>/gi, ' ')
    .replace(/<\/(p|div|article|section|header|footer|li|tr|h[1-6]|blockquote|pre)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/t[dh]>/gi, '\t')
    .replace(/<[^>]+>/g, ' ')
  text = decodeEntities(text)
  return text
    .split('\n')
    .map(line => line.replace(/[ \t\u00a0]+/g, ' ').trim())
    .filter((line, index, all) => line !== '' || (index > 0 && all[index - 1] !== ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/** Best-effort page title, for orienting the model before it reads the body. */
function pageTitle(html) {
  const match = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)
  return match === null ? '' : decodeEntities(match[1]).slice(0, 300)
}

/**
 * 密钥库的内存缓存。
 * 启动时载入一次，`net_keystore` 每次改动后同步更新；
 * 这样同步的 `githubHeaders` 也能读到已保存的密钥。
 */
const keystoreCache = new Map()

/** 密钥库文件位置：<profile>/data/keystore.json，与插件配置分开存。 */
function keystorePath(SETTINGS) {
	return path.join(SETTINGS.downloadDir !== '' ? path.resolve(SETTINGS.downloadDir) + '/..' : process.cwd(), 'net-keystore.json')
}

/** 读密钥库；文件不存在或损坏时返回空对象而不是抛错。 */
async function readKeystore(SETTINGS) {
	try {
		const raw = await fs.readFile(keystorePath(SETTINGS), 'utf8')
		const parsed = JSON.parse(raw)
		if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
		const clean = {}
		for (const [key, value] of Object.entries(parsed)) {
			if (typeof value === 'string') {
				clean[key] = value
				keystoreCache.set(key, value)
			}
		}
		return clean
	}
	catch {
		return {}
	}
}

/** 原子写密钥库：先写临时文件再 rename，避免写一半崩了留下坏 JSON。 */
async function writeKeystore(SETTINGS, store) {
	const target = keystorePath(SETTINGS)
	const temp = `${target}.tmp-${process.pid}`
	await fs.mkdir(path.dirname(target), { recursive: true })
	await fs.writeFile(temp, `${JSON.stringify(store, null, 2)}\n`, { mode: 0o600 })
	await fs.rename(temp, target)
	keystoreCache.clear()
	for (const [key, value] of Object.entries(store)) keystoreCache.set(key, value)
}

/** 规范化密钥名：只允许小写字母、数字、下划线、连字符。 */
function normalizeKeyName(raw) {
	const name = String(raw ?? '').trim().toLowerCase()
	return /^[a-z0-9_-]{1,48}$/u.test(name) ? name : ''
}

/** 把密钥变成掩码，只露头尾各 4 个字符。 */
function maskSecret(secret) {
	const text = String(secret ?? '')
	if (text.length <= 8) return '*'.repeat(text.length)
	return `${text.slice(0, 4)}${'*'.repeat(Math.min(text.length - 8, 24))}${text.slice(-4)}`
}

/** Register the outbound tools. */
export function apply(ctx, config) {  const settings = { ...DEFAULTS, ...(config ?? {}) }
  const downloadRoot = typeof settings.downloadDir === 'string' && settings.downloadDir.trim() !== ''
    ? path.resolve(settings.downloadDir)
    : path.resolve(process.cwd(), 'downloads')

  ctx.effect(() => {
    const disposers = []

    // 启动时把密钥库预热进内存缓存，让同步的 githubHeaders 立刻拿到已保存的密钥。
    // 读失败不算错误（首次运行根本没有文件），静默跳过即可。
    void readKeystore(settings).catch(() => {})

    disposers.push(ctx.tools.register({
      name: 'repo_search',
      description: 'Search open-source repositories on GitHub by keyword, best matches and most-starred first. '
        + 'Use it to find a library, a project, or a reference implementation; follow up with repo_files to read the code.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Search keywords, optionally with GitHub qualifiers such as `language:python` or `stars:>1000`.' },
          language: { type: 'string', description: 'Restrict to one language, e.g. `javascript`.' },
          limit: { type: 'integer', description: 'Number of repositories to return (default 10, max 30).' },
          sort: { type: 'string', enum: ['best-match', 'stars', 'updated'], description: 'Ranking; default best-match.' },
        },
        required: ['query'],
        additionalProperties: false,
      },
      output: { schema: {}, render: (_a, v) => [{ type: 'text', text: v.text }] },
      isConcurrencySafe: () => true,
      async execute(args, exec) {
        const limit = Math.min(Math.max(Number(args.limit) || 10, 1), 30)
        const sort = args.sort === 'stars' ? 'stars' : args.sort === 'updated' ? 'updated' : ''
        const language = typeof args.language === 'string' && args.language.trim() !== ''
          ? ` language:${args.language.trim()}` : ''
        const base = String(args.query ?? '').trim()
        if (base === '') return { count: 0, text: 'Empty query: nothing to search for.' }

        // GitHub 的 q 参数把空格当 AND：放进多个词就要求它们同时出现，词越多越必然 0 命中。
        // 所以先按原串搜；0 命中时自动拆词逐个再搜一遍并合并 —— 这样"我堆了三个词"不会变成"什么都没有"。
        const attempt = async (q) => {
          const url = `${GITHUB_API}/search/repositories?q=${encodeURIComponent(q + language)}&per_page=${limit}`
            + (sort === '' ? '' : `&sort=${sort}`)
          return await request(url, { headers: githubHeaders(settings), timeoutMs: settings.timeoutMs, signal: exec.signal, as: 'json' })
        }

        const words = base.split(/\s+/u).filter(w => w !== '')
        let usedQuery = base
        let data = await attempt(base)
        let merged = false
        if ((!Array.isArray(data.items) || data.items.length === 0) && words.length > 1) {
          // 拆词逐个搜，把命中的仓库按 full_name 去重合并
          const seen = new Map()
          const parts = []
          // ★只收"有区分度"的词：一个词命中几千上万个仓库时它什么也没筛，
          //   把它的结果并进来只会造出一堆无关仓库（实测："步步高"2859 个 / "kernel"18 万个
          //   → 合并后返回微信框架和 MySQL 同步工具，纯噪音）。
          const DISTINCTIVE_MAX = 60
          const skipped = []
          for (const w of words) {
            try {
              const one = await attempt(w)
              const n = one.total_count ?? 0
              if (n === 0) { parts.push(`${w}: 0`); continue }
              if (n > DISTINCTIVE_MAX) {
                skipped.push(`${w}(${n})`)
                parts.push(`${w}: ${n} — skipped, too broad to be meaningful`)
                continue
              }
              parts.push(`${w}: ${n}`)
              for (const item of (Array.isArray(one.items) ? one.items : [])) {
                const key = String(item.full_name ?? '')
                if (key !== '' && !seen.has(key)) seen.set(key, item)
              }
            } catch (error) {
              parts.push(`${w}: failed (${error?.message ?? error})`)
            }
          }
          if (seen.size > 0) {
            merged = true
            usedQuery = words.join(' + ')
            data = { total_count: seen.size, items: [...seen.values()].slice(0, limit) }
            data._parts = parts
          } else {
            // 拆了也没有：如实报告每个词的结果，别只说"没有"
            return {
              count: 0,
              text: `No repository matches ${JSON.stringify(base)}.\n`
                + `Tried the whole string and each word separately — both empty:\n`
                + parts.map(p => `  · ${p}`).join('\n')
                + `\nNote: GitHub treats spaces in \`q\` as AND. Join words without spaces `
                + `(e.g. "步步高内核" instead of "步步高 内核 kernel"), or try a single distinctive word.`,
            }
          }
        }
        const items = Array.isArray(data.items) ? data.items : []
        if (items.length === 0) {
          return {
            count: 0,
            text: `No repository matches ${JSON.stringify(base)}.`
              + (words.length > 1 ? `\nNote: GitHub treats spaces in \`q\` as AND — all words must appear together. `
                + `Join them without spaces (e.g. "步步高内核") or search one distinctive word at a time.` : '')
              + `\nIf you expected results, check the exact spelling before concluding the repository does not exist.`,
          }
        }
        const hits = items.map(item => ({
          fullName: String(item.full_name ?? ''),
          description: typeof item.description === 'string' ? item.description : null,
          stars: item.stargazers_count,
          language: item.language,
          updatedAt: item.updated_at,
          url: item.html_url,
        }))
        const header = merged
          ? `Original query ${JSON.stringify(base)} had 0 matches (spaces are AND in GitHub). `
            + `Split into words found ${hits.length} repositories:\n`
            + (Array.isArray(data._parts) ? `${data._parts.map(p => `  · ${p}`).join('\n')}\n` : '')
          : `Found ${data.total_count} repositories, top ${hits.length}:\n`
        return {
          count: hits.length,
          total: data.total_count,
          mergedFrom: merged ? words : undefined,
          text: header + hits.map(formatRepo).join('\n'),
        }
      },
    }))

    disposers.push(ctx.tools.register({
      name: 'repo_files',
      description: 'List a directory inside a GitHub repository, or read one of its files. '
        + 'Reading a file returns its text (capped); omit `path` to list the repository root.',
      parameters: {
        type: 'object',
        properties: {
          repo: { type: 'string', description: 'Repository as "owner/name", e.g. `nodejs/node`.' },
          path: { type: 'string', description: 'Path inside the repository. Omit to list the root.' },
          ref: { type: 'string', description: 'Branch, tag, or commit. Defaults to the repository\'s default branch.' },
        },
        required: ['repo'],
        additionalProperties: false,
      },
      output: { schema: {}, render: (_a, v) => [{ type: 'text', text: v.text }] },
      isConcurrencySafe: () => true,
      async execute(args, exec) {
        const { owner, name } = splitRepo(args.repo)
        const target = typeof args.path === 'string' ? args.path.trim().replace(/^\/+/, '') : ''
        const ref = typeof args.ref === 'string' && args.ref.trim() !== '' ? args.ref.trim() : ''
        const query = ref === '' ? '' : `?ref=${encodeURIComponent(ref)}`
        const url = `${GITHUB_API}/repos/${owner}/${name}/contents/${target.split('/').map(encodeURIComponent).join('/')}${query}`
        const data = await request(url, { headers: githubHeaders(settings), timeoutMs: settings.timeoutMs, signal: exec.signal, as: 'json' })

        if (Array.isArray(data)) {
          const entries = data.map(entry => ({
            name: String(entry.name ?? ''),
            type: String(entry.type ?? ''),
            size: entry.size,
            path: String(entry.path ?? ''),
          })).sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1))
          const lines = entries.map(entry => `- ${entry.type === 'dir' ? 'dir ' : 'file'} ${entry.path}${entry.type === 'file' ? ` (${entry.size ?? 0}B)` : ''}`)
          return {
            kind: 'directory',
            count: entries.length,
            entries,
            text: `${owner}/${name}${target === '' ? '/' : `/${target}`} — ${entries.length} entries\n${lines.join('\n')}`,
          }
        }

        if (data !== null && typeof data === 'object') {
          const entry = {
            name: String(data.name ?? ''),
            path: String(data.path ?? target),
            type: String(data.type ?? ''),
            size: data.size,
            sha: data.sha,
          }
          if (data.type !== 'file') {
            return { kind: 'symlink', entry, text: `${entry.path} is a ${entry.type}, not a regular file; pass its target path instead.` }
          }
          let content
          let truncated = false
          if (typeof data.content === 'string' && data.encoding === 'base64') {
            const buffer = Buffer.from(data.content, 'base64')
            const binary = buffer.subarray(0, 8000).includes(0)
            if (binary) {
              return { kind: 'binary', entry, text: `${entry.path} is binary (${buffer.length} bytes); use repo_download to save it.` }
            }
            content = buffer.toString('utf8')
          } else {
            const raw = await request(`${RAW_HOST}/${owner}/${name}/${ref === '' ? 'HEAD' : encodeURIComponent(ref)}/${target.split('/').map(encodeURIComponent).join('/')}`,
              { timeoutMs: settings.timeoutMs, signal: exec.signal })
            content = raw.toString('utf8')
          }
          if (content.length > TEXT_LIMIT) {
            truncated = true
            content = `${content.slice(0, TEXT_LIMIT)}\n\n… [truncated at ${TEXT_LIMIT} characters; the full file is ${entry.size ?? '?'} bytes]`
          }
          return {
            kind: 'file',
            entry,
            truncated,
            text: `${owner}/${name}/${entry.path} (${entry.size ?? 0} bytes${truncated ? ', truncated' : ''})\n---\n${content}`,
          }
        }

        throw new Error(`unexpected contents response for ${owner}/${name}/${target}`)
      },
    }))

    disposers.push(ctx.tools.register({
      name: 'net_add_sensitive',
      description: 'Add one word (or a domain from a search result) to the local sensitive-word list. '
        + 'Hits are dropped from future searches entirely — the matched content is never returned to the model. '
        + 'Takes effect immediately, no restart needed. '
        + 'Pass either a plain word/phrase, or a URL/host to block that site.',
      parameters: {
        type: 'object',
        properties: {
          word: { type: 'string', description: 'A word or phrase to block (substring match, case-insensitive).' },
          url: { type: 'string', description: 'Alternative: a URL or hostname whose domain should be blocked. e.g. "example.com" or a full result URL.' },
        },
        additionalProperties: false,
      },
      output: { schema: {}, render: (_a, v) => [{ type: 'text', text: v.text }] },
      isConcurrencySafe: () => false,
      async execute(args) {
        let target = typeof args.word === 'string' ? args.word.trim() : ''
        if (target === '' && typeof args.url === 'string' && args.url.trim() !== '') {
          const raw = args.url.trim()
          try {
            target = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`).hostname.toLowerCase()
          }
          catch {
            throw new Error(`无法从 ${JSON.stringify(raw)} 解析出域名`)
          }
        }
        if (target === '') throw new Error('请给出 word 或 url')
        const { added, total } = await addWord(target)
        return {
          added,
          total,
          text: added
            ? `已加入敏感词表：${target}\n当前共 ${total} 条，立即生效。\n词表：${WORDS_FILE}`
            : `「${target}」已在词表中（共 ${total} 条），未重复添加。`,
        }
      },
    }))

    disposers.push(ctx.tools.register({
      name: 'net_sensitive_stats',
      description: 'Show how many sensitive words are configured and where the list lives. '
        + 'The words themselves are never returned — only the count.',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      output: { schema: {}, render: (_a, v) => [{ type: 'text', text: v.text }] },
      isConcurrencySafe: () => true,
      async execute() {
        const { count, file } = await wordStats()
        const hosts = await loadHosts()
        const lines = [
          `敏感词：${count} 条  (${file})`,
          `危险域名：${hosts.size} 条`,
        ]
        if (count === 0 && hosts.size === 0) {
          lines.push('', '两张表都是空的。把词写进文件，或用 net_add_sensitive 逐条添加。')
        }
        return {
          count,
          hostCount: hosts.size,
          file,
          text: lines.join('\n'),
        }
      },
    }))

    disposers.push(ctx.tools.register({
      name: 'repo_download',
      description: 'Download one file from a public URL (a raw GitHub file, a release asset, or any direct link) '
        + 'and save it to the downloads directory. Returns the saved path, size, and a short preview for text files.',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'Direct http(s) URL of the file.' },
          filename: { type: 'string', description: 'File name to save under. Defaults to the name at the end of the URL.' },
        },
        required: ['url'],
        additionalProperties: false,
      },
      output: { schema: {}, render: (_a, v) => [{ type: 'text', text: v.text }] },
      isConcurrencySafe: () => true,
      async execute(args, exec) {
        const raw = String(args.url ?? '').trim()
        if (!/^https?:\/\//i.test(raw)) throw new Error('url must start with http:// or https://')
        const requested = typeof args.filename === 'string' ? args.filename.trim() : ''
        const fromUrl = decodeURIComponent(new URL(raw).pathname.split('/').filter(Boolean).pop() ?? '')
        const safe = (requested || fromUrl || 'download').replace(/[^\w.\-]+/g, '_').replace(/^\.+/, '').slice(0, 120) || 'download'
        const buffer = await request(raw, { timeoutMs: settings.timeoutMs * 3, signal: exec.signal })
        await fs.mkdir(downloadRoot, { recursive: true })
        let target = path.join(downloadRoot, safe)
        for (let n = 1; ; n++) {
          if (!(await fs.stat(target).catch(() => null))) break
          const ext = path.extname(safe)
          target = path.join(downloadRoot, `${path.basename(safe, ext)}-${n}${ext}`)
        }
        await fs.writeFile(target, buffer)
        const binary = buffer.subarray(0, 8000).includes(0)
        const preview = binary ? '' : buffer.toString('utf8').slice(0, 400)
        return {
          path: target,
          bytes: buffer.length,
          binary,
          text: `Saved ${buffer.length} bytes to ${target}`
            + (binary ? '' : `\n--- preview ---\n${preview}${buffer.length > 400 ? '\n…' : ''}`),
        }
      },
    }))

    disposers.push(ctx.tools.register({
      name: 'web_search_bing',
      description: 'Search the open web through Bing (works from a China-direct network where other search '
        + 'providers are unreachable). Returns titles, URLs, and snippets.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'What to search for.' },
          limit: { type: 'integer', description: 'Number of results to return (default 10, max 30).' },
        },
        required: ['query'],
        additionalProperties: false,
      },
      output: { schema: {}, render: (_a, v) => [{ type: 'text', text: v.text }] },
      isConcurrencySafe: () => true,
      async execute(args, exec) {
        const limit = Math.min(Math.max(Number(args.limit) || 10, 1), 30)
        const url = `${BING}?q=${encodeURIComponent(args.query)}&count=${Math.min(limit * 2, 50)}&setlang=zh-CN`
        const html = (await request(url, {
          headers: { accept: 'text/html,application/xhtml+xml', 'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8' },
          timeoutMs: settings.timeoutMs,
          signal: exec.signal,
        })).toString('utf8')
        const raw = parseBing(html)
        if (raw.length === 0) {
          return { count: 0, text: `Bing returned no parsable results for ${JSON.stringify(args.query)} (page was ${html.length} chars).` }
        }
        const { kept, dropped, polluted } = denoise(raw, args.query, {
          blockedDomains: settings.blockedDomains,
          denoise: settings.denoise,
        })
        // ★ 敏感词过滤：命中即整条丢弃，只回数字不回内容
        const sensitiveWords = await loadWords()
        const dangerHosts = await loadHosts()
        const byWord = filterSensitive(kept, sensitiveWords)
        const byHost = filterDangerHosts(byWord.kept, dangerHosts)
        // ★ 标题「91」打头 + 落地页模板特征：补域名规则的漏网
        const afterTitle = []
        let titleRemoved = 0
        for (const hit of byHost.kept) {
          if (hardNumberHit(hit) || titleStartsWith91(hit) || adultTemplateHit(hit) !== '') {
            titleRemoved += 1
            continue
          }
          afterTitle.push(hit)
        }
        const sensitiveRemoved = byWord.removed + byHost.removed + titleRemoved
        const results = afterTitle.slice(0, limit)
        const warn = polluted.length === 0
          ? ''
          : `\n\n⚠ ${polluted.map((entry) => `「${entry.term}」是高污染词：${entry.hint}`).join('\n⚠ ')}`
        const filtered = dropped.length === 0 ? '' : ` (去噪丢弃 ${dropped.length} 条)`
        const sensitiveNote = sensitiveRemoved === 0 ? '' : ` (敏感词屏蔽 ${sensitiveRemoved} 条)`
        if (results.length === 0) {
          return {
            count: 0,
            text: `Bing 返回 ${raw.length} 条，全部被过滤规则丢弃${filtered}${sensitiveNote}。`
              + `\n可把 denoise 关掉重搜，或检查查询词是否太泛。${warn}`,
          }
        }
        // ★ 按来源网站分组：同站结果聚在一起，跨站一眼能对比
        const groups = groupBySource(results)
        const lines = []
        let n = 0
        for (const group of groups) {
          lines.push(`【${group.label}】${group.hits.length} 条`)
          for (const hit of group.hits) {
            n += 1
            lines.push(`${n}. ${hit.title}`)
            lines.push(`   ${hit.url}`)
            if (hit.snippet !== '') lines.push(`   ${hit.snippet}`)
          }
          lines.push('')
        }
        return {
          count: results.length,
          results,
          groups: groups.map((g) => ({ id: g.id, label: g.label, count: g.hits.length })),
          dropped: dropped.length,
          sensitiveRemoved,
          text: `Bing 搜索 ${JSON.stringify(args.query)}${filtered}${sensitiveNote} · 按来源分组 ${groups.length} 组：\n`
            + lines.join('\n').trimEnd()
            + warn
            + '\n\n💡 想把某条结果的域名加入敏感词，用 net_add_sensitive(url=<那条的域名>)',
        }
      },
    }))


    // 一次列出某个账号的全部仓库 —— 比反复换关键词搜强十倍（记忆里记过：某账号有 70 个仓库，
    // 关键词搜索一个都搜不出来）。也用于确认"这个人的仓库里到底有没有这个项目"。
    disposers.push(ctx.tools.register({
      name: 'repo_owner_repos',
      description: 'List every public repository of a GitHub user or organization, newest first. '
        + 'Cheaper and far more complete than keyword search when you know the owner: '
        + 'one call replaces a dozen guesses at keywords. Use it to answer "does this person even have such a repo".',
      parameters: {
        type: 'object',
        properties: {
          owner: { type: 'string', description: 'GitHub user or organization name, e.g. `rtyutechstudio`.' },
          limit: { type: 'integer', description: 'Max repositories to return (default 100, max 100).' },
          filter: { type: 'string', description: 'Optional substring filter on repository name (case-insensitive).' },
        },
        required: ['owner'],
        additionalProperties: false,
      },
      output: { schema: {}, render: (_a, v) => [{ type: 'text', text: v.text }] },
      isConcurrencySafe: () => true,
      async execute(args, exec) {
        const owner = String(args.owner ?? '').trim().replace(/^@/u, '')
        if (owner === '') return { count: 0, text: 'Empty owner: nothing to list.' }
        const limit = Math.min(Math.max(Number(args.limit) || 100, 1), 100)
        const url = `${GITHUB_API}/users/${encodeURIComponent(owner)}/repos?per_page=${limit}&sort=updated`
        const data = await request(url, { headers: githubHeaders(settings), timeoutMs: settings.timeoutMs, signal: exec.signal, as: 'json' })
        if (!Array.isArray(data)) {
          return { count: 0, text: `Unexpected response for ${JSON.stringify(owner)}: expected a repository list.` }
        }
        const needle = typeof args.filter === 'string' ? args.filter.trim().toLowerCase() : ''
        const kept = data.filter(item => needle === '' || String(item.name ?? '').toLowerCase().includes(needle))
        if (kept.length === 0) {
          return {
            count: 0,
            text: `No repositories for ${JSON.stringify(owner)}`
              + (needle === '' ? ` (the account has none, or it does not exist).`
                : ` matching ${JSON.stringify(args.filter)} — but the account has ${data.length} repositories total; retry without \`filter\` to see them.`),
          }
        }
        const hits = kept.map(item => ({
          fullName: String(item.full_name ?? ''),
          description: typeof item.description === 'string' ? item.description : null,
          stars: item.stargazers_count,
          language: item.language,
          updatedAt: item.updated_at,
          url: item.html_url,
        }))
        return {
          count: hits.length,
          totalInAccount: data.length,
          text: `${JSON.stringify(owner)} has ${data.length} public repositories`
            + (needle === '' ? '' : `, ${hits.length} matching ${JSON.stringify(args.filter)}`)
            + `:\n${hits.map(formatRepo).join('\n')}`,
        }
      },
    }))
    disposers.push(ctx.tools.register({
      name: 'repo_commits',
      description: 'List a GitHub repository\'s recent commits (newest first), optionally limited to one path or author. '
        + 'Use it to judge how active a project is or to see what changed recently.',
      parameters: {
        type: 'object',
        properties: {
          repo: { type: 'string', description: 'Repository as "owner/name", e.g. `nodejs/node`.' },
          path: { type: 'string', description: 'Only commits touching this path, e.g. `src/`.' },
          ref: { type: 'string', description: 'Branch, tag, or commit to walk. Defaults to the default branch.' },
          author: { type: 'string', description: 'GitHub login or e-mail to filter by.' },
          limit: { type: 'integer', description: 'Number of commits to return (default 10, max 30).' },
        },
        required: ['repo'],
        additionalProperties: false,
      },
      output: { schema: {}, render: (_a, v) => [{ type: 'text', text: v.text }] },
      isConcurrencySafe: () => true,
      async execute(args, exec) {
        const { owner, name } = splitRepo(args.repo)
        const limit = Math.min(Math.max(Number(args.limit) || 10, 1), 30)
        const params = new URLSearchParams({ per_page: String(limit) })
        if (typeof args.ref === 'string' && args.ref.trim() !== '') params.set('sha', args.ref.trim())
        const targetPath = typeof args.path === 'string' ? args.path.trim() : ''
        if (targetPath !== '') params.set('path', targetPath)
        if (typeof args.author === 'string' && args.author.trim() !== '') params.set('author', args.author.trim())
        const url = `${GITHUB_API}/repos/${owner}/${name}/commits?${params.toString()}`
        const data = await request(url, { headers: githubHeaders(settings), timeoutMs: settings.timeoutMs, signal: exec.signal, as: 'json' })
        const list = Array.isArray(data) ? data : []
        if (list.length === 0) return { count: 0, text: `No commits found in ${owner}/${name}${targetPath === '' ? '' : ` for ${targetPath}`}.` }
        const commits = list.map((entry) => {
          const commit = entry.commit ?? {}
          const message = String(commit.message ?? '').split('\n')[0].slice(0, 200)
          return {
            sha: String(entry.sha ?? '').slice(0, 12),
            message,
            author: commit.author?.name ?? null,
            date: commit.author?.date ?? null,
            url: entry.html_url,
          }
        })
        const lines = commits.map((c) => `- ${c.sha} ${c.date ? c.date.slice(0, 10) : '????????'} ${c.author ?? '?'}: ${c.message}`)
        return {
          count: commits.length,
          commits,
          text: `${owner}/${name}${targetPath === '' ? '' : ` (${targetPath})`} — ${commits.length} commits:\n${lines.join('\n')}`,
        }
      },
    }))

    disposers.push(ctx.tools.register({
      name: 'web_fetch_text',
      description: 'Fetch one http(s) page and return its readable text (tags, scripts, and styles stripped), with the title. '
        + 'Use it after web_search_bing when a snippet is not enough. HTML becomes text; text/JSON pass through.',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'Absolute http(s) URL to read.' },
          maxChars: { type: 'integer', description: `Characters of text to return (default 20000, max ${PAGE_TEXT_LIMIT}).` },
          raw: { type: 'boolean', description: 'Return the body as-is instead of stripping HTML.' },
        },
        required: ['url'],
        additionalProperties: false,
      },
      output: { schema: {}, render: (_a, v) => [{ type: 'text', text: v.text }] },
      isConcurrencySafe: () => true,
      async execute(args, exec) {
        const raw = String(args.url ?? '').trim()
        if (!/^https?:\/\//i.test(raw)) throw new Error('url must start with http:// or https://')
        const maxChars = Math.min(Math.max(Number(args.maxChars) || 20_000, 200), PAGE_TEXT_LIMIT)
        const response = await request(raw, {
          headers: { accept: 'text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.8', 'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8' },
          timeoutMs: settings.timeoutMs,
          signal: exec.signal,
        })
        const bytes = Buffer.isBuffer(response) ? response : Buffer.from(String(response))
        if (bytes.subarray(0, 8000).includes(0)) {
          throw new NetError(`${raw} looks binary (${bytes.length} bytes); use repo_download to save it instead.`, 415)
        }
        const body = bytes.toString('utf8')
        const isHtml = /<html|<body|<!doctype html/i.test(body.slice(0, 4000))
        const title = isHtml ? pageTitle(body) : ''
        let text = args.raw === true || !isHtml ? body : htmlToText(body)
        const total = text.length
        let truncated = false
        if (text.length > maxChars) {
          truncated = true
          text = `${text.slice(0, maxChars)}\n\n… [truncated at ${maxChars} of ${total} characters]`
        }
        // SPA 检测：HTML 抓下来正文极短，多半是 JS 渲染的页面，纯 HTML 抓取拿不到内容。
        const looksSpa = isHtml && total < 400
        const hint = looksSpa
          ? `\n\n⚠ 正文只有 ${total} 字符，这个页面八成是 JS 渲染的（SPA）。`
            + `纯 HTML 抓取拿不到它的内容 —— 改用 browser_open + browser_read 走真实浏览器。`
          : ''
        return {
          url: raw,
          title,
          contentType: isHtml ? 'html' : 'text',
          chars: total,
          truncated,
          looksSpa,
          text: `${title === '' ? raw : `${title}\n${raw}`}\n---\n${text}${hint}`,
        }
      },
    }))

    // ═══════════════════════════════════════════════════════════
    // 对话守护工具（用户 2026-10-18 要求）
    //
    //   每次对话自动保存快照，出 bug 可回滚到上一轮，
    //   且保留出 bug 那轮的提问。
    //
    //   用户原话：
    //     "再加一个锁定每次对话完成后自动保留此对话的脚本
    //      如果这一次对话出现了bug，就回滚到上一个对话，
    //      不过出bug的那一个提问也要保留"
    //     "能不能加长一点，保留的时间"
    // ═══════════════════════════════════════════════════════════

    const GUARD_DIR = '/storage/emulated/0/BBK_A2_总结/_轮次快照'
    const GUARD_SESS = '/data/user/0/com.deepseek.harness.compat/files/payload/dshhome/sessions/'
      + '--data-user-0-com.deepseek.harness.compat-files-1--'
      + '/session-9eed9507-4bc8-451f-af97-f3cef59aa9ba/session.v4.jsonl.zstd'

    // 保留时间（用户要求加长）
    // 原来 10 个快照 × 22MB = 220MB
    // 现在：保留 30 个 + 7 天内不删
    const GUARD_KEEP_MAX = 30
    const GUARD_KEEP_DAYS = 7

    // 北京时间格式化（toISOString 给的是 UTC，看着差 8 小时容易误解）
    function bjStamp() {
      const d = new Date(Date.now() + 8 * 3600 * 1000)
      const p = n => String(n).padStart(2, '0')
      return d.getUTCFullYear() + '-' + p(d.getUTCMonth() + 1) + '-' + p(d.getUTCDate())
        + 'T' + p(d.getUTCHours()) + '-' + p(d.getUTCMinutes()) + '-' + p(d.getUTCSeconds())
    }

    async function guardAnalyze() {
      const fs = await import('node:fs/promises')
      const zlib = await import('node:zlib')
      let buf
      try { buf = await fs.readFile(GUARD_SESS) } catch { return null }
      // 多帧 zstd
      const parts = []
      let i = 0
      while (i < buf.length - 3) {
        if (buf[i] === 0x28 && buf[i+1] === 0xb5 && buf[i+2] === 0x2f && buf[i+3] === 0xfd) {
          let j = i + 4
          while (j < buf.length - 3) {
            if (buf[j] === 0x28 && buf[j+1] === 0xb5 && buf[j+2] === 0x2f && buf[j+3] === 0xfd) break
            j++
          }
          if (j >= buf.length - 3) j = buf.length
          try { parts.push(zlib.zstdDecompressSync(buf.subarray(i, j))); i = j; continue } catch {}
        }
        i++
      }
      const text = Buffer.concat(parts).toString('utf8')
      const lines = text.split('\n').filter(Boolean)
      let turns = 0, lastUser = ''
      for (const l of lines) {
        try {
          const o = JSON.parse(l)
          if (o.type === 'turn/start') turns++
          if (o.type === 'user/message') {
            const c = o.data && o.data.content
            if (Array.isArray(c)) {
              let t = ''
              for (const x of c) if (x && typeof x.text === 'string') t += x.text
              if (t.trim()) lastUser = t.slice(0, 200)
            }
          }
        } catch {}
      }
      return { lines: lines.length, turns, lastUser, raw: buf }
    }

    // ═════════════════════════════════════════════════════════════
    // 增量快照（2026-10-18 改）
    //
    // 为什么改：
    //   原来是【全量复制】，每次 23MB。存 7 个 = 156MB，
    //   但内容只差 1-6 轮对话 —— 99.99% 是重复的。
    //
    // 现在怎么做：
    //   · 第一个快照 = 全量（.full）
    //   · 后续快照   = 只存【新增的行】（.delta）
    //     会话是追加式日志，所以新增的内容就是"上次行数之后的部分"
    //   · 恢复时：找最近的 .full，然后把后续 .delta 依次追加
    //
    // 效果：
    //   30 个快照从 690MB → 约 25MB
    //
    // 文件命名：
    //   snapshot-<时间>-turn<N>.full    全量
    //   snapshot-<时间>-turn<N>-from<M>.delta   从第 M 行开始的新增
    // ═════════════════════════════════════════════════════════════

    // 找一个快照的"基准行数"（从文件名解析，或读 .full）
    function parseSnapMeta(name) {
      const m = name.match(/turn(\d+)/)
      const turns = m ? parseInt(m[1], 10) : 0
      const f = name.match(/-from(\d+)\.delta$/)
      const fromLine = f ? parseInt(f[1], 10) : 0
      const isDelta = /\-from\d+\.delta$/.test(name)
      return { turns, fromLine, isDelta }
    }

    async function guardSave(note) {
      const fs = await import('node:fs/promises')
      const info = await guardAnalyze()
      if (!info) throw new Error('读不到会话文件')
      await fs.mkdir(GUARD_DIR, { recursive: true })

      // 读当前会话的全部行
      const curText = info.raw.toString('utf8')
      const curLines = curText.split('\n').filter(Boolean)
      const curLineCount = curLines.length

      // 找最新的一个快照，决定是全量还是增量
      const names = (await fs.readdir(GUARD_DIR)).filter(n => /^snapshot-.*\.(full|delta)$/.test(n))
      let latest = null
      for (const n of names) {
        const fp = `${GUARD_DIR}/${n}`
        try {
          const st = await fs.stat(fp)
          if (!latest || st.mtimeMs > latest.mtime) latest = { n, fp, mtime: st.mtimeMs }
        } catch {}
      }

      const stamp = bjStamp()
      let target, mode, fromLine = 0

      if (!latest) {
        // 第一个快照：全量
        target = `${GUARD_DIR}/snapshot-${stamp}-turn${info.turns}.full`
        mode = 'full'
        await fs.writeFile(target, info.raw)
      } else {
        // 算出上一个快照记录到第几行
        const meta = parseSnapMeta(latest.n)
        let prevEnd = meta.fromLine  // delta 记录的起始行

        // 如果是 .full，需要知道它有多少行 —— 直接读
        if (!meta.isDelta) {
          try {
            const zlib = await import('node:zlib')
            const buf = await fs.readFile(latest.fp)
            // 多帧 zstd 解压
            const parts = []
            let i = 0
            while (i < buf.length - 3) {
              if (buf[i] === 0x28 && buf[i+1] === 0xb5 && buf[i+2] === 0x2f && buf[i+3] === 0xfd) {
                let j = i + 4
                while (j < buf.length - 3) {
                  if (buf[j] === 0x28 && buf[j+1] === 0xb5 && buf[j+2] === 0x2f && buf[j+3] === 0xfd) break
                  j++
                }
                if (j >= buf.length - 3) j = buf.length
                try { parts.push(zlib.zstdDecompressSync(buf.subarray(i, j))); i = j; continue } catch {}
              }
              i++
            }
            prevEnd = Buffer.concat(parts).toString('utf8').split('\n').filter(Boolean).length
          } catch { prevEnd = 0 }
        } else {
          // delta 的 fromLine 是起点，终点要读文件末尾行数 —— 用总行数估算
          // 简化：delta 文件里存了当时的总行数，文件名里没有，那就重新算
          // 这里用「上次快照的 turn 数」对不上行数，所以直接读 delta 看它有多少行
          try {
            const zlib = await import('node:zlib')
            const buf = await fs.readFile(latest.fp)
            const parts = []
            let i = 0
            while (i < buf.length - 3) {
              if (buf[i] === 0x28 && buf[i+1] === 0xb5 && buf[i+2] === 0x2f && buf[i+3] === 0xfd) {
                let j = i + 4
                while (j < buf.length - 3) {
                  if (buf[j] === 0x28 && buf[j+1] === 0xb5 && buf[j+2] === 0x2f && buf[j+3] === 0xfd) break
                  j++
                }
                if (j >= buf.length - 3) j = buf.length
                try { parts.push(zlib.zstdDecompressSync(buf.subarray(i, j))); i = j; continue } catch {}
              }
              i++
            }
            const dl = Buffer.concat(parts).toString('utf8').split('\n').filter(Boolean).length
            prevEnd = meta.fromLine + dl
          } catch { prevEnd = 0 }
        }

        if (prevEnd >= curLineCount || prevEnd <= 0) {
          // 没有新内容，或算不出来 → 存全量兜底
          target = `${GUARD_DIR}/snapshot-${stamp}-turn${info.turns}.full`
          mode = 'full'
          await fs.writeFile(target, info.raw)
        } else {
          // 增量：只存 prevEnd 之后的行
          fromLine = prevEnd
          const deltaLines = curLines.slice(prevEnd)
          const deltaText = deltaLines.join('\n') + '\n'
          target = `${GUARD_DIR}/snapshot-${stamp}-turn${info.turns}-from${fromLine}.delta`
          mode = 'delta'
          // 还是用 zstd 压一下（复用原始多帧逻辑不方便，这里直接存原始文本压缩）
          const zlib = await import('node:zlib')
          await fs.writeFile(target, zlib.zstdCompressSync(Buffer.from(deltaText, 'utf8')))
        }
      }

      // 清理：超过 KEEP_DAYS 天的，或超出 KEEP_MAX 个的
      // ⚠️ 增量模式下不能随便删中间的 delta，会断链
      // 所以：删的时候连同它依赖的链一起删
      const all = []
      for (const n of (await fs.readdir(GUARD_DIR))) {
        if (!/^snapshot-.*\.(full|delta)$/.test(n)) continue
        const fp = `${GUARD_DIR}/${n}`
        try { const st = await fs.stat(fp); all.push({ n, fp, mtime: st.mtimeMs, ...parseSnapMeta(n) }) } catch {}
      }
      all.sort((a, b) => a.mtime - b.mtime)   // 旧→新

      const cutoff = Date.now() - GUARD_KEEP_DAYS * 24 * 3600 * 1000
      let removed = 0
      // 从旧的开始删；但删除时必须保证剩下的链是完整的
      while (all.length > GUARD_KEEP_MAX) {
        const victim = all[0]
        // 如果被删的是 full，而下一个是 delta，那 delta 就断了 —— 也一起删
        const next = all[1]
        try { await fs.unlink(victim.fp); removed++ } catch {}
        all.shift()
        if (!victim.isDelta && next && next.isDelta) {
          // next 依赖 victim 的 full，链断了 → 删掉 next 直到遇到下一个 full
          while (all.length > 0 && all[0].isDelta) {
            try { await fs.unlink(all[0].fp); removed++ } catch {}
            all.shift()
          }
        }
      }
      // 过期的也删（同样要保链）
      while (all.length > 0 && all[0].mtime < cutoff) {
        const victim = all[0]
        const next = all[1]
        try { await fs.unlink(victim.fp); removed++ } catch {}
        all.shift()
        if (!victim.isDelta && next && next.isDelta) {
          while (all.length > 0 && all[0].isDelta) {
            try { await fs.unlink(all[0].fp); removed++ } catch {}
            all.shift()
          }
        }
      }

      return {
        path: target, turns: info.turns, lines: curLineCount,
        removed, mode, fromLine,
        savedBytes: mode === 'delta' ? (info.raw.length - (curLines.length - fromLine) * 30) : info.raw.length
      }
    }

    // 解压一个 .full 或 .delta 文件，返回文本
    async function readSnapText(fp) {
      const fs = await import('node:fs/promises')
      const zlib = await import('node:zlib')
      const buf = await fs.readFile(fp)
      // .delta 是单帧 zstd；.full 是多帧 zstd（原始会话文件）
      // 统一用多帧方式解（单帧也能解出来）
      const parts = []
      let i = 0
      while (i < buf.length - 3) {
        if (buf[i] === 0x28 && buf[i+1] === 0xb5 && buf[i+2] === 0x2f && buf[i+3] === 0xfd) {
          let j = i + 4
          while (j < buf.length - 3) {
            if (buf[j] === 0x28 && buf[j+1] === 0xb5 && buf[j+2] === 0x2f && buf[j+3] === 0xfd) break
            j++
          }
          if (j >= buf.length - 3) j = buf.length
          try { parts.push(zlib.zstdDecompressSync(buf.subarray(i, j))); i = j; continue } catch {}
        }
        i++
      }
      if (parts.length === 0) {
        // 兜底：不是 zstd，直接当文本
        return buf.toString('utf8')
      }
      return Buffer.concat(parts).toString('utf8')
    }

    // 列快照（带依赖链信息）
    async function guardList() {
      const fs = await import('node:fs/promises')
      try { await fs.mkdir(GUARD_DIR, { recursive: true }) } catch {}
      const names = (await fs.readdir(GUARD_DIR))
        .filter(n => /^snapshot-.*\.(full|delta)$/.test(n))
      const out = []
      for (const n of names) {
        const fp = `${GUARD_DIR}/${n}`
        try {
          const st = await fs.stat(fp)
          const meta = parseSnapMeta(n)
          out.push({
            name: n,
            kb: (st.size / 1024).toFixed(0),
            mode: meta.isDelta ? '增量' : '全量',
            turns: meta.turns,
            mtime: st.mtimeMs,
            at: new Date(st.mtimeMs + 8 * 3600 * 1000).toISOString().replace('Z','').slice(0, 19) + ' (北京)'
          })
        } catch {}
      }
      out.sort((a, b) => b.mtime - a.mtime)   // 新→旧
      return out
    }

    // 重建某个快照的完整内容（沿依赖链往回找 .full，再依次追加 delta）
    async function rebuildSnapshot(snapName) {
      const fs = await import('node:fs/promises')
      const all = (await fs.readdir(GUARD_DIR))
        .filter(n => /^snapshot-.*\.(full|delta)$/.test(n))
      const metas = []
      for (const n of all) {
        try {
          const st = await fs.stat(`${GUARD_DIR}/${n}`)
          metas.push({ n, mtime: st.mtimeMs, ...parseSnapMeta(n) })
        } catch {}
      }
      metas.sort((a, b) => a.mtime - b.mtime)   // 旧→新

      const targetIdx = metas.findIndex(m => m.n === snapName)
      if (targetIdx < 0) throw new Error('找不到快照 ' + snapName)

      // 往回找最近的 .full
      let baseIdx = -1
      for (let k = targetIdx; k >= 0; k--) {
        if (!metas[k].isDelta) { baseIdx = k; break }
      }
      if (baseIdx < 0) throw new Error('快照链断了：找不到基准全量')

      // 从 base 开始依次拼
      let text = await readSnapText(`${GUARD_DIR}/${metas[baseIdx].n}`)
      let lineCount = text.split('\n').filter(Boolean).length

      for (let k = baseIdx + 1; k <= targetIdx; k++) {
        const m = metas[k]
        if (!m.isDelta) {
          // 又遇到一个 full，直接替换
          text = await readSnapText(`${GUARD_DIR}/${m.n}`)
          lineCount = text.split('\n').filter(Boolean).length
        } else {
          // 校验 fromLine 是否对得上
          if (m.fromLine !== lineCount) {
            throw new Error('快照链不连续：' + m.n + ' 期望从第 ' + m.fromLine + ' 行，实际当前 ' + lineCount + ' 行')
          }
          const dt = await readSnapText(`${GUARD_DIR}/${m.n}`)
          text = text + dt
          lineCount += dt.split('\n').filter(Boolean).length
        }
      }
      return text
    }

    async function guardRollback(index) {
      const fs = await import('node:fs/promises')
      const list = await guardList()
      if (list.length === 0) throw new Error('没有快照可回滚')
      const pick = list[Math.min(Math.max(index, 0), list.length - 1)]
      const snapPath = `${GUARD_DIR}/${pick.name}`

      // ① 先备份当前状态（绝不能丢）
      const cur = await guardAnalyze()
      if (!cur) throw new Error('读不到当前会话文件')
      const stamp = bjStamp()
      const safePath = `${GUARD_DIR}/_回滚前备份-${stamp}.zstd`
      await fs.writeFile(safePath, cur.raw)

      // ② 提取出 bug 那轮的提问（用户要求保留）
      const bugPath = `${GUARD_DIR}/_出bug的提问-${stamp}.txt`
      const bugText = `出 bug 那轮的提问（回滚前保存）\n`
        + `时间: ${new Date().toISOString()}\n`
        + `轮数: ${cur.turns}\n`
        + `\n=== 你说的最后一句 ===\n${cur.lastUser}\n`
      await fs.writeFile(bugPath, bugText)

      // ③ 重建快照内容（增量模式要沿链拼接）再覆盖
      const fullText = await rebuildSnapshot(pick.name)
      // 用原始会话格式写回：多帧 zstd
      const zlib = await import('node:zlib')
      const compressed = zlib.zstdCompressSync(Buffer.from(fullText, 'utf8'))
      await fs.writeFile(GUARD_SESS, compressed)

      return {
        rolledTo: pick.name,
        safePath, bugPath,
        bugQuestion: cur.lastUser,
        restoredLines: fullText.split('\n').filter(Boolean).length
      }
    }

    disposers.push(ctx.tools.register({
      name: 'dialog_snapshot',
      description: 'Save a snapshot of the current conversation so it can be rolled back later. '
        + `Keeps up to ${GUARD_KEEP_MAX} snapshots / ${GUARD_KEEP_DAYS} days. `
        + 'Use this at the end of a good turn; if the next turn goes wrong, call dialog_rollback.',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['save', 'list'], description: 'save = take a snapshot; list = list snapshots.' },
          note: { type: 'string', description: 'Optional note recorded with the snapshot.' },
        },
        required: ['action'],
        additionalProperties: false,
      },
      output: { schema: {}, render: (_a, v) => [{ type: 'text', text: v.text }] },
      isConcurrencySafe: () => false,
      async execute(args, exec) {
        if (args.action === 'list') {
          const list = await guardList()
          if (list.length === 0) return { count: 0, text: '还没有快照。用 action="save" 存一个。' }
          const lines = list.map((s, k) => `[${k + 1}] ${s.name}  ${s.mb}MB  ${s.at}`)
          return { count: list.length, list, text: `共 ${list.length} 个快照（保留 ${GUARD_KEEP_MAX} 个 / ${GUARD_KEEP_DAYS} 天）\n${lines.join('\n')}` }
        }
        const r = await guardSave(args.note ?? '')
        return {
          ...r,
          text: `已存快照\n  文件: ${r.path}\n  轮数: ${r.turns}\n  行数: ${r.lines}`
            + (r.removed > 0 ? `\n  清理旧快照: ${r.removed} 个` : '')
            + `\n\n保留策略: 最多 ${GUARD_KEEP_MAX} 个 / ${GUARD_KEEP_DAYS} 天`,
        }
      },
    }))

    disposers.push(ctx.tools.register({
      name: 'dialog_rollback',
      description: 'Roll the conversation back to an earlier snapshot. '
        + 'Always backs up the current state first, and always saves the failing question to a text file. '
        + 'IMPORTANT: the app must be fully restarted after a rollback for it to take effect.',
      parameters: {
        type: 'object',
        properties: {
          index: { type: 'integer', description: 'Which snapshot to roll back to: 0 = most recent (default), 1 = one before that, etc.' },
        },
        required: [],
        additionalProperties: false,
      },
      output: { schema: {}, render: (_a, v) => [{ type: 'text', text: v.text }] },
      isConcurrencySafe: () => false,
      async execute(args, exec) {
        const r = await guardRollback(Number(args.index) || 0)
        return {
          ...r,
          text: `已回滚到: ${r.rolledTo}\n\n`
            + `① 当前状态已备份: ${r.safePath}\n`
            + `② 出 bug 那轮的提问已保存: ${r.bugPath}\n`
            + `   内容: ${r.bugQuestion}\n\n`
            + `⚠️ 必须完全退出 App 再重开，回滚才生效。`,
        }
      },
    }))


    disposers.push(ctx.tools.register({
      name: 'bilibili_search',
      description: 'Search Bilibili videos. Returns titles, BV ids, uploaders, play counts, durations and '
        + 'descriptions — but NOT the video content (no stream, no subtitles). Use the BV id to reference a '
        + 'specific video. Handles Bilibili\'s 412 anti-bot gate by acquiring a buvid3 cookie first.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'What to search for.' },
          limit: { type: 'integer', description: 'Number of results to return (default 10, max 50).' },
          order: {
            type: 'string',
            description: 'Sort order: totalrank (default), click (most played), pubdate (newest), dm (most danmaku).',
          },
        },
        required: ['query'],
        additionalProperties: false,
      },
      output: {
        schema: {},
        render: (args, value) => [{ type: 'text', text: value.text }],
      },
      isConcurrencySafe: () => true,
      async execute(args, exec) {
        const limit = Math.min(Math.max(Number(args.limit) || 10, 1), 50)
        const { results, total, note } = await searchBilibili(args.query, {
          limit,
          order: typeof args.order === 'string' && args.order !== '' ? args.order : 'totalrank',
          timeoutMs: settings.timeoutMs,
          signal: exec.signal,
        })
        if (results.length === 0) {
          return { count: 0, results, text: `B站没有搜到 ${JSON.stringify(args.query)} 的结果。${note === '' ? '' : `\n(${note})`}` }
        }
        const denoised = denoise(results, args.query, {
          blockedDomains: settings.blockedDomains,
          denoise: settings.denoise,
        })
        const lines = denoised.kept.map((video, index) => `${index + 1}. ${video.title}\n`
          + `   BV: ${video.bvid}  时长 ${video.duration}  播放 ${video.playText}  UP主 ${video.author}  ${video.pubdate}\n`
          + `   ${video.url}`
          + (video.description === '' ? '' : `\n   ${video.description}`))
        const filtered = denoised.dropped.length === 0 ? '' : `\n\n(已按规则屏蔽 ${denoised.dropped.length} 条)`
        return {
          count: denoised.kept.length,
          results: denoised.kept,
          total,
          text: `B站搜索 ${JSON.stringify(args.query)}：共 ${total} 条，返回 ${denoised.kept.length} 条${filtered}\n`
            + `${lines.join('\n')}${note === '' ? '' : `\n\n⚠️ ${note}`}`,
        }
      },
    }))

    disposers.push(ctx.tools.register({
      name: 'net_keystore',
      description: 'Read or write persisted API keys for outbound tools. Values are stored on disk and survive '
        + 'restarts, so keys do not have to be re-entered or re-read from memory each session. '
        + 'action=list shows which keys are set (never the values); action=get returns one value; '
        + 'action=set stores one; action=unset removes one.',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', description: 'list | get | set | unset', enum: ['list', 'get', 'set', 'unset'] },
          key: { type: 'string', description: 'Key name, e.g. "github", "bilibili", "gemini". Lowercase letters, digits, _ and -.' },
          value: { type: 'string', description: 'The secret. Required for action=set. Never echoed back.' },
        },
        required: ['action'],
        additionalProperties: false,
      },
      output: { schema: {}, render: (_a, v) => [{ type: 'text', text: v.text }] },
      isConcurrencySafe: () => false,
      async execute(args) {
        const action = String(args.action ?? '')
        if (action === 'list') {
          const store = await readKeystore(settings)
          const names = Object.keys(store)
          if (names.length === 0) return { text: `密钥库是空的。\n位置: ${keystorePath(settings)}` }
          const lines = names.map((name) => `  ${name.padEnd(16)} ${maskSecret(store[name])}  (${String(store[name]).length} 字符)`)
          return { keys: names, text: `已保存 ${names.length} 个密钥（只显示掩码）:\n${lines.join('\n')}\n\n位置: ${keystorePath(settings)}` }
        }
        if (action === 'get') {
          const name = normalizeKeyName(args.key)
          if (name === '') return { text: '需要 key 参数。' }
          const store = await readKeystore(settings)
          if (!(name in store)) return { text: `密钥库里没有 "${name}"。已保存的: ${Object.keys(store).join(', ') || '(空)'}` }
          return { key: name, value: store[name], text: `"${name}" = ${store[name]}` }
        }
        if (action === 'set') {
          const name = normalizeKeyName(args.key)
          if (name === '') return { text: '需要 key 参数（小写字母/数字/_/-）。' }
          if (typeof args.value !== 'string' || args.value.trim() === '') return { text: '需要 value 参数。' }
          const store = await readKeystore(settings)
          const existed = name in store
          store[name] = args.value.trim()
          await writeKeystore(settings, store)
          return {
            key: name,
            text: `${existed ? '已更新' : '已保存'}密钥 "${name}"（${store[name].length} 字符，掩码 ${maskSecret(store[name])}）\n`
              + `位置: ${keystorePath(settings)}\n重启后依然有效。`,
          }
        }
        if (action === 'unset') {
          const name = normalizeKeyName(args.key)
          if (name === '') return { text: '需要 key 参数。' }
          const store = await readKeystore(settings)
          if (!(name in store)) return { text: `密钥库里没有 "${name}"。` }
          delete store[name]
          await writeKeystore(settings, store)
          return { key: name, text: `已删除密钥 "${name}"。` }
        }
        return { text: `未知 action "${action}"，可用: list / get / set / unset` }
      },
    }))

    return () => { for (const dispose of disposers.reverse()) dispose() }
  })
}
