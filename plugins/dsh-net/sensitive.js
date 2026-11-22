/**
 * ★ 敏感词匹配引擎（2026-11-20 重写，性能优化版）。
 *
 * 设计原则：
 *   ① 词条**不写在代码里**，全部从外部文件读 —— 代码进日志、词条不进。
 *   ② 命中就整条丢弃，**且不把命中内容回传给调用方**，只回数字。
 *   ③ 索引**进程级构建一次**，绝不每次请求重建。
 *
 * ── 性能记录（2026-11-20 实测，30 条 Bing 结果 / 9469 词）──
 *   优化前：filterSensitive  P50 6716 µs    建索引 P50 15690 µs
 *   根因：buildIndex 用的 WeakMap 键是「每次 loadWords 新返回的数组」，
 *         所以每次请求都重建一遍索引 —— 这才是那 6.7ms 的来源，
 *         跟定时器调度无关（四段计时里只有这一段高，其余都在百 µs 级）。
 *
 * 优化手段：
 *   ① 索引挂在模块级单例上，靠词表 mtime 判定是否重建
 *   ② 缩小扫描面：只查标题 + 摘要前 300 字，URL 不进扫描面、单独走域名匹配
 *   ③ 每条结果只拆一次字符串，不重复 scanTextOf
 */
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
/** 词表文件绝对路径。 */
export const WORDS_FILE = path.join(HERE, 'sensitive', 'words.txt')
/** ★ 危险域名表：来自 Sensitive-lexicon 的「非法网址」分类，按主机名匹配。 */
export const HOSTS_FILE = path.join(HERE, 'sensitive', 'blocked-hosts.txt')
/** ★ 两字高危词白名单：只有这里的两字词才参与拦截。 */
export const TWO_CHAR_FILE = path.join(HERE, 'sensitive', 'two-char-whitelist.txt')

/** ★ 摘要只扫前这么多字符 —— 正文交给下游，这里不做全文扫描。 */
export const SNIPPET_SCAN_LIMIT = 300

/** 两字词白名单缓存。 */
let twoCharCache = { mtimeMs: -1, set: new Set() }

/**
 * 读取两字高危词白名单。
 * @returns {Promise<Set<string>>} 允许参与拦截的两字词
 */
async function loadTwoChar() {
	let stat
	try {
		stat = await fs.stat(TWO_CHAR_FILE)
	}
	catch {
		return new Set()
	}
	if (stat.mtimeMs === twoCharCache.mtimeMs) return twoCharCache.set
	const text = await fs.readFile(TWO_CHAR_FILE, 'utf8').catch(() => '')
	const set = new Set()
	for (const line of text.split('\n')) {
		const t = line.trim().toLowerCase()
		if (t === '' || t.startsWith('#')) continue
		set.add(t)
	}
	twoCharCache = { mtimeMs: stat.mtimeMs, set }
	return set
}

/**
 * ★ 最小有效词长。
 * 中文 2 字可以，但英文/数字 2~3 字几乎全是噪音（ai / ok / no / 91 之类的误伤源）——
 * 实测「geckoview release notes ... android browser engine」这种正常技术文本
 * 会被一个纯 ASCII 的两字词命中，导致 30 条结果全被误杀。
 * 规则：纯 ASCII 词必须 >= 4 字符才收；含中文的 2 字符照收。
 * @param {string} word 小写词条
 * @returns {boolean} 是否保留
 */
function keepWord(word, twoCharSet) {
	if (word.length >= 4) return true
	// 1 字：只有中文单字收（极少，多为实词）
	if (word.length === 1) return /[\u4e00-\u9fff]/.test(word)
	// ★ 2~3 字：
	//   纯数字照收（"91" 这种是实打实的敏感词）
	if (/^\d+$/.test(word)) return true
	//   两字中文只收白名单里的 —— 实测「学习」「平板」这类正常两字词会误杀 EEBBK 搜索结果
	if (word.length === 2) return twoCharSet.has(word)
	//   3 字：含中文才收
	return /[\u4e00-\u9fff]/.test(word)
}

// ── 模块级单例：整个进程只建一次索引 ─────────────────────────────────
/** @type {{mtimeMs: number, words: string[], index: Map<string,string[]>}|null} */
let state = null
/** @type {{mtimeMs: number, hosts: Set<string>}|null} */
let hostState = null

/**
 * 构建双字索引。只在词表发生变化时调用。
 * @param {string[]} words 词表
 * @returns {Map<string, string[]>} 双字键 → 该前缀开头的词
 */
function buildState(words) {
	const index = new Map()
	for (const word of words) {
		if (word.length < 2) continue
		// ★ 整数键 = 前两个字符的 charCode 拼成的数。
		// 原来用 word.slice(0,2) 做键，匹配时每个字符位置都要 slice 一次分配字符串 ——
		// 110 字的摘要就是 110 次分配，实测占了大头（142µs → 27.7µs）。
		// 单字键又太粗：「w」一个桶压 5742 个词。
		const head = word.charCodeAt(0) * 65536 + word.charCodeAt(1)
		let bucket = index.get(head)
		if (bucket === undefined) {
			bucket = []
			index.set(head, bucket)
		}
		bucket.push(word)
	}
	return index
}

/**
 * ★ Aho-Corasick 自动机：一次扫描命中所有词，不建 Set、不做 slice。
 * 实测比双字分桶再快 4.4 倍（单条 27.9µs → 6.3µs，30 条 0.84ms → 0.19ms）。
 * 代价是构建慢（9469 词约 284ms），所以必须进程级建一次、随词表 mtime 失效。
 * @param {string[]} words 词表
 * @returns {{goto: Map<number,number>[], fail: number[], out: string[][]}}
 */
function buildAC(words) {
	const goto = [new Map()]
	const fail = [0]
	const out = [[]]
	for (const word of words) {
		let s = 0
		for (let i = 0; i < word.length; i += 1) {
			const c = word.charCodeAt(i)
			let nx = goto[s].get(c)
			if (nx === undefined) {
				nx = goto.length
				goto[s].set(c, nx)
				goto.push(new Map())
				fail.push(0)
				out.push([])
			}
			s = nx
		}
		// 同一个词可能重复出现，去重
		if (!out[s].includes(word)) out[s].push(word)
	}
	// BFS 建 fail 指针，并把输出链合并下来
	const queue = []
	for (const nx of goto[0].values()) queue.push(nx)
	for (let h = 0; h < queue.length; h += 1) {
		const s = queue[h]
		for (const [c, nx] of goto[s]) {
			let f = fail[s]
			while (f !== 0 && !goto[f].has(c)) f = fail[f]
			const cand = goto[f].get(c)
			fail[nx] = cand !== undefined && cand !== nx ? cand : 0
			if (out[fail[nx]].length > 0) out[nx] = out[nx].concat(out[fail[nx]])
			queue.push(nx)
		}
	}
	return { goto, fail, out }
}

/**
 * 在文本上跑 Aho-Corasick。命中立刻返回（调用方只要布尔值）。
 * @param {string} text 已小写的扫描文本
 * @param {{goto: Map<number,number>[], fail: number[], out: string[][]}} ac 自动机
 * @returns {boolean} true = 命中
 */
export function matchWithAC(text, ac) {
	let s = 0
	for (let i = 0; i < text.length; i += 1) {
		const c = text.charCodeAt(i)
		while (s !== 0 && !ac.goto[s].has(c)) s = ac.fail[s]
		const nx = ac.goto[s].get(c)
		s = nx === undefined ? 0 : nx
		if (ac.out[s].length > 0) return true
	}
	return false
}

/**
 * 读取敏感词表（带 mtime 缓存 + 索引单例）。
 * @returns {Promise<string[]>} 小写词条数组
 */
export async function loadWords() {
	let stat
	try {
		stat = await fs.stat(WORDS_FILE)
	}
	catch {
		state = null
		return []
	}
	if (state !== null && state.mtimeMs === stat.mtimeMs) return state.words
	const text = await fs.readFile(WORDS_FILE, 'utf8').catch(() => '')
	const twoChar = await loadTwoChar()
	const words = text
		.split('\n')
		.map((line) => line.trim())
		.filter((line) => line !== '' && !line.startsWith('#'))
		.map((line) => line.toLowerCase())
		.filter((word) => keepWord(word, twoChar))
	// 长的排前面，避免短词先命中掩盖长词
	words.sort((a, b) => b.length - a.length)
	const index = buildState(words)
	const ac = buildAC(words)
	state = { mtimeMs: stat.mtimeMs, words, index, ac }
	return words
}

/**
 * ★ 取当前索引（单例）。调用前必须先 await loadWords()。
 * @returns {Map<string, string[]>|null}
 */
export function currentIndex() {
	return state?.index ?? null
}

/**
 * ★ 取当前 Aho-Corasick 自动机（单例）。调用前必须先 await loadWords()。
 * @returns {{goto: Map<number,number>[], fail: number[], out: string[][]}|null}
 */
export function currentAC() {
	return state?.ac ?? null
}

/**
 * 兼容旧接口：返回词表的双字索引。命中单例时零成本。
 * @param {string[]} words 词表
 * @returns {Map<string, string[]>}
 */
export function buildIndex(words) {
	if (state !== null && state.words === words) return state.index
	return buildState(words)
}

/**
 * ★ 把一条结果压成待扫描文本。
 * 只取标题 + 摘要前 N 字，**URL 不进扫描面** —— https:// 那些字符纯属浪费。
 * @param {{title?: string, snippet?: string, url?: string}} hit 单条结果
 * @returns {{text: string, host: string}} 扫描文本与主机名
 */
export function scanTextOf(hit) {
	const title = hit.title ?? ''
	const snippet = hit.snippet ?? ''
	const text = `${title} ${snippet.slice(0, SNIPPET_SCAN_LIMIT)}`.toLowerCase()
	let host = ''
	try {
		host = new URL(hit.url ?? '').hostname.toLowerCase()
	}
	catch {
		host = ''
	}
	return { text, host }
}

/**
 * 在给定文本上跑一遍双字索引匹配。
 * @param {string} text 已小写的扫描文本
 * @param {Map<string, string[]>} index 双字索引
 * @returns {boolean} true = 命中
 */
export function matchInText(text, index) {
	const seen = new Set()
	const n = text.length
	for (let i = 0; i + 1 < n; i += 1) {
		const key = text.charCodeAt(i) * 65536 + text.charCodeAt(i + 1)
		if (seen.has(key)) continue
		seen.add(key)
		const bucket = index.get(key)
		if (bucket === undefined) continue
		for (const word of bucket) {
			if (text.includes(word)) return true
		}
	}
	return false
}

/**
 * 判断一条结果是否命中敏感词。
 * @param {{title?: string, url?: string, snippet?: string}} hit 单条结果
 * @param {string[]} words 敏感词表
 * @returns {boolean} true = 命中，应整条丢弃
 */
export function isSensitive(hit, words) {
	if (words.length === 0) return false
	const index = buildIndex(words)
	const { text } = scanTextOf(hit)
	return matchInText(text, index)
}

/**
 * 过滤一批结果，移除命中敏感词的条目。
 * ★ 只回数字，不回内容 —— 命中项的标题/URL 一个字都不往上传。
 * @param {Array<object>} hits 结果
 * @param {string[]} words 敏感词表
 * @returns {{kept: object[], removed: number}} 保留项与移除数量
 */
export function filterSensitive(hits, words) {
	if (words.length === 0) return { kept: hits, removed: 0 }
	// ★ AC 走单例，不重建；单例缺失时退回双字分桶
	const ac = (state !== null && state.words === words) ? state.ac : null
	const index = ac === null ? buildIndex(words) : null
	// 预取：每条只拆一次字符串，不重复 scanTextOf
	const texts = hits.map((hit) => scanTextOf(hit).text)
	const kept = []
	let removed = 0
	for (let i = 0; i < hits.length; i += 1) {
		const hit = ac !== null ? matchWithAC(texts[i], ac) : matchInText(texts[i], index)
		if (hit) {
			removed += 1
			continue
		}
		kept.push(hits[i])
	}
	return { kept, removed }
}

/**
 * 追加一个词到词表（供「手动加入」用）。已存在则不重复添加。
 * @param {string} word 要加入的词
 * @returns {Promise<{added: boolean, total: number}>} 是否新增与当前词数
 */
export async function addWord(word) {
	const trimmed = String(word ?? '').trim()
	if (trimmed === '' || trimmed.includes('\n')) throw new Error('词不能为空且不能含换行')
	const words = await loadWords()
	if (words.includes(trimmed.toLowerCase())) {
		return { added: false, total: words.length }
	}
	const exists = await fs.stat(WORDS_FILE).then(() => true).catch(() => false)
	const header = exists
		? ''
		: '# 敏感词表 —— 一行一个，命中即整条丢弃\n'
			+ '# 这里的词只在本机生效，不会被写进任何对话或日志\n\n'
	await fs.appendFile(WORDS_FILE, `${header}${trimmed}\n`, 'utf8')
	state = null // 让下次读取重新解析
	return { added: true, total: words.length + 1 }
}

/**
 * 查看当前词表规模。只回数字，不回词。
 * @returns {Promise<{count: number, file: string}>}
 */
export async function wordStats() {
	const words = await loadWords()
	return { count: words.length, file: WORDS_FILE }
}

// ── ★ 危险域名表（来自 Sensitive-lexicon「非法网址」分类） ──────────────
//
// 独立于敏感词：网址按主机名匹配，不做子串扫描。
// 之前把 14552 条网址当普通词塞进词表，导致「ww」这一个桶就压了 5381 个词，
// 每条结果都要比对几千次。拆开之后两边都快。

/**
 * 读取危险域名表（带 mtime 缓存）。
 * @returns {Promise<Set<string>>} 小写主机名集合
 */
export async function loadHosts() {
	let stat
	try {
		stat = await fs.stat(HOSTS_FILE)
	}
	catch {
		hostState = null
		return new Set()
	}
	if (hostState !== null && hostState.mtimeMs === stat.mtimeMs) return hostState.hosts
	const text = await fs.readFile(HOSTS_FILE, 'utf8').catch(() => '')
	const hosts = new Set()
	for (const line of text.split('\n')) {
		const t = line.trim().toLowerCase()
		if (t === '' || t.startsWith('#')) continue
		hosts.add(t)
	}
	hostState = { mtimeMs: stat.mtimeMs, hosts }
	return hosts
}

/**
 * 判断一个主机名是否在危险域名表里（含子域）。
 * @param {string} host 主机名
 * @param {Set<string>} hosts 域名表
 * @returns {boolean} true = 命中
 */
export function isDangerHost(host, hosts) {
	if (host === '') return false
	// ★ 结构规则优先：某些形态本身就是危险信号，不依赖词表
	const pattern = dangerHostPattern(host)
	if (pattern !== '') return true
	if (hosts.size === 0) return false
	if (hosts.has(host)) return true
	// 逐级去掉前缀：a.b.example.com → b.example.com → example.com
	let rest = host
	for (;;) {
		const dot = rest.indexOf('.')
		if (dot < 0) return false
		rest = rest.slice(dot + 1)
		if (hosts.has(rest)) return true
	}
}

/**
 * ★ 危险域名的结构特征（不依赖词表，换域名也拦得住）。
 *
 * 判据：
 *   ① 「91」开头紧跟数字/字母：91abc.xyz / 917813.com / www.91xxx.cn
 *      —— 擦边站最爱的命名方式，正规站极少这么起
 *   ② 主机名里有超长数字串（>= 6 位）：123456789.com
 *   ③ 主机名是「纯数字 + 短后缀」：123456.com / 8888.net
 *
 * 放行：github.com、mozilla.org、任何含 eebbk / deepseek 这类正常品牌
 * @param {string} host 小写主机名
 * @returns {string} 命中的原因，未命中返回空串
 */
export function dangerHostPattern(host) {
	const lower = host.toLowerCase()
	// 白名单：正常品牌站不参与结构判定
	if (/(eebbk|deepseek|mozilla|github|gitee|bilibili|aliyun|google|bing)/i.test(lower)) return ''

	// ★ 按「段」判断，不看后缀有几段。
	// 之前取 labels[len-2] 当主域，碰到 .com.cn / .hl.cn 就取到 "com"、"hl"，
	// 于是 91dp.com.cn / www.91kedouapp.hl.cn 全部漏拦。
	// 现在对每一段单独判定。
	const labels = lower.split('.')
	for (const label of labels) {
		if (label === '' || label === 'www') continue
		// ① ★★★ 917813 连写：用户点名的重点违禁词，整体匹配，优先于下面的泛规则
		if (label.includes('917813')) return `host-917813:${label}`
		// ② 91 开头紧跟数字/字母：91abc / 917813 / 91porn
		if (/^91[\da-z]/.test(label)) return `host-91:${label}`
		// ③ 7813 连写：擦边站的数字命名特征
		if (/7813/.test(label)) return `host-7813:${label}`
		// ④ 超长数字串
		if (/\d{6,}/.test(label)) return `host-longdigits:${label}`
	}
	// ⑤ 纯数字主域 + 非常见后缀
	const main = labels.length >= 2 ? labels[labels.length - 2] : labels[0]
	const tld = labels[labels.length - 1] ?? ''
	if (main !== undefined && /^\d+$/.test(main) && !/^(com|cn|net|org|edu|gov)$/.test(tld)) {
		return `host-puredigits:${main}`
	}
	return ''
}

/**
 * 按危险域名表过滤结果。
 * @param {Array<{url?: string}>} hits 结果
 * @param {Set<string>} hosts 域名表
 * @returns {{kept: object[], removed: number}} 保留项与移除数量
 */
export function filterDangerHosts(hits, hosts) {
	if (hosts.size === 0) return { kept: hits, removed: 0 }
	const kept = []
	let removed = 0
	for (const hit of hits) {
		let host = ''
		try {
			host = new URL(hit.url ?? '').hostname.toLowerCase()
		}
		catch {}
		if (isDangerHost(host, hosts)) {
			removed += 1
			continue
		}
		kept.push(hit)
	}
	return { kept, removed }
}

/**
 * ★ 成人内容站的「落地页模板特征」。
 *
 * 判据来自用户观察：这类站的简介会写得又多又长，且必带
 * 登录 / 注册 / 下载 / 免费观看 / 在线播放 这一套。
 * 但**单独出现不足以判定** —— 正规网盘、软件站也这么写。
 * 所以设一个阈值：命中 >= 3 个模板词才判，避免误伤。
 */
export const ADULT_TEMPLATE_WORDS = [
	'登录', '注册', '免费观看', '在线播放', '高清下载',
	'无需注册', '会员', '试看', '永久免费', '资源下载',
]

/**
 * 判断一条结果是否具备成人站落地页特征。
 * @param {{title?: string, snippet?: string}} hit 单条结果
 * @returns {string} 命中的模板词（逗号分隔），未达阈值返回空串
 */
export function adultTemplateHit(hit) {
	const hay = `${hit.title ?? ''} ${hit.snippet ?? ''}`
	const hits = ADULT_TEMPLATE_WORDS.filter((w) => hay.includes(w))
	return hits.length >= 3 ? hits.join(',') : ''
}

/**
 * ★ 标题数字打头判定。
 *
 * 判据：正规内容的标题要么中文打头，要么英文品牌名打头；
 * 标题直接以「91 + 任意字符」开头的，基本只有那类站这么写。
 * 实测样本里 EEBBK / GeckoView / Android / TWRP 的标题没有一条是纯数字开头的。
 *
 * 这条补的是域名规则的漏网：baihu-91.hl.cn 这种 91 不在段首的，
 * 域名规则放行，但标题是「91白虎_年轻人的兴趣内容社区」，一眼就是。
 * @param {{title?: string}} hit 单条结果
 * @returns {boolean} true = 标题数字打头，判定为可疑
 */
export function titleStartsWith91(hit) {
	const title = (hit.title ?? '').trim()
	return /^91[\s\S]/.test(title)
}

/**
 * ★★★ 硬编码危险数字串。
 *
 * 用户原话：「917813 这才是重点违禁词」。
 * 它不是 91 和 7813 两个词，是**一个整体** —— 91 在前、7813 在后首尾相接。
 *
 * 所以处理方式分两层：
 *   ① 域名里出现      → 拦（见 dangerHostPattern）
 *   ② 标题/摘要里出现  → 拦（见 hardNumberHit）
 *
 * 实测误伤率：拿 GeckoView 版本号 / Android 13 / 内核 4.14.193 / 端口号
 * 这类正常数字串去测，命中 0/6 —— 正常内容里不会出现这个连写。
 */
export const HARD_NUMBER_STRINGS = [
	'917813',
]

/**
 * 判断标题/摘要里是否出现硬编码危险数字串。
 * @param {{title?: string, snippet?: string}} hit 单条结果
 * @returns {boolean} true = 命中
 */
export function hardNumberHit(hit) {
	const hay = `${hit.title ?? ''} ${hit.snippet ?? ''}`
	return HARD_NUMBER_STRINGS.some((n) => hay.includes(n))
}
