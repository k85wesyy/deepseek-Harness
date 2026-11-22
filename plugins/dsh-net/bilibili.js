/**
 * B站（bilibili）搜索支持。
 *
 * 关键坑（2026-11-16 实测）：`api.bilibili.com/x/web-interface/search/type`
 * 直接请求一律返回 `412 request was banned`，无论请求头做得多像浏览器。
 * 必须**先访问一次主站拿到 buvid3 cookie**，再带着 cookie 请求，才返回 200。
 *
 * 本模块只取"看得到标题、看不到内容"的那一层信息：
 * 标题、BV 号、作者、播放量、时长、简介摘要、封面地址。
 * 不做视频下载，不碰字幕，不解析视频流——那些都需要额外的签名与登录态。
 */

/** 浏览器 UA：B站对非浏览器 UA 会直接 412。 */
const UA = 'Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36'

const API = 'https://api.bilibili.com/x/web-interface/search/type'
const HOME = 'https://www.bilibili.com/'

/** cookie 缓存：一次拿，多次用，避免每次搜索都多打一次主站。 */
let cachedCookie = { value: '', at: 0 }

/**
 * 取一个可用的 buvid3 cookie。缓存 30 分钟。
 * @param {number} timeoutMs 单次请求超时
 * @returns {Promise<string>} cookie 串；拿不到时返回空串
 */
async function acquireCookie(timeoutMs) {
	const now = Date.now()
	if (cachedCookie.value !== '' && now - cachedCookie.at < 30 * 60 * 1000) return cachedCookie.value
	try {
		const response = await fetch(HOME, {
			headers: { 'user-agent': UA, accept: 'text/html' },
			redirect: 'follow',
			signal: AbortSignal.timeout(timeoutMs),
		})
		const raw = typeof response.headers.getSetCookie === 'function' ? response.headers.getSetCookie() : []
		const cookie = raw.map((entry) => entry.split(';')[0]).filter((entry) => entry !== '').join('; ')
		if (cookie !== '') cachedCookie = { value: cookie, at: now }
		return cookie
	}
	catch {
		return ''
	}
}

/** 去掉 B站返回标题里的 `<em class="keyword">` 高亮标签。 */
function stripHighlight(text) {
	return String(text ?? '')
		.replace(/<\/?em[^>]*>/gu, '')
		.replace(/&quot;/gu, '"')
		.replace(/&amp;/gu, '&')
		.replace(/&lt;/gu, '<')
		.replace(/&gt;/gu, '>')
		.trim()
}

/**
 * 规范化时长。
 * 实测 B站搜索接口返回的是**已格式化好的字符串**（`"1:44"`），不是秒数；
 * 但别的接口（如 /x/web-interface/view）给的是秒数。两种都要接住。
 * @param {unknown} value 原始时长
 * @returns {string} mm:ss 或 h:mm:ss
 */
function formatDuration(value) {
	if (typeof value === 'string') {
		const trimmed = value.trim()
		// 已经是 "1:44" / "1:02:33" 这种形式，原样返回
		if (/^\d{1,2}(:\d{2}){1,2}$/u.test(trimmed)) return trimmed
		// "104" 这种纯数字字符串，落到下面按秒处理
	}
	const total = Math.max(0, Math.floor(Number(value) || 0))
	const hours = Math.floor(total / 3600)
	const minutes = Math.floor((total % 3600) / 60)
	const secs = total % 60
	const pad = (n) => String(n).padStart(2, '0')
	return hours > 0 ? `${hours}:${pad(minutes)}:${pad(secs)}` : `${pad(minutes)}:${pad(secs)}`
}

/** 把播放量格式化成中文习惯的「万」「亿」。 */
function formatPlay(count) {
	const value = Number(count) || 0
	if (value >= 100_000_000) return `${(value / 100_000_000).toFixed(1)}亿`
	if (value >= 10_000) return `${(value / 10_000).toFixed(1)}万`
	return String(value)
}

/**
 * 搜索 B站视频。
 * @param {string} keyword 搜索关键词
 * @param {{limit?: number, page?: number, order?: string, timeoutMs?: number, signal?: AbortSignal}} options 选项
 * @returns {Promise<{results: object[], total: number, note: string}>} 搜索结果
 */
export async function searchBilibili(keyword, options = {}) {
	const limit = Math.min(Math.max(Number(options.limit) || 10, 1), 50)
	const page = Math.max(Number(options.page) || 1, 1)
	const timeoutMs = Number(options.timeoutMs) || 20_000
	const order = options.order ?? 'totalrank'

	const cookie = await acquireCookie(timeoutMs)
	const url = `${API}?search_type=video&keyword=${encodeURIComponent(keyword)}&page=${page}&order=${order}`

	let response
	try {
		response = await fetch(url, {
			headers: {
				'user-agent': UA,
				referer: 'https://www.bilibili.com/',
				accept: 'application/json, text/plain, */*',
				'accept-language': 'zh-CN,zh;q=0.9',
				...(cookie === '' ? {} : { cookie }),
			},
			redirect: 'follow',
			signal: options.signal ?? AbortSignal.timeout(timeoutMs),
		})
	}
	catch (error) {
		throw new Error(`B站搜索请求失败：${error.name === 'TimeoutError' ? '超时' : error.message}`, { cause: error })
	}

	const body = await response.text()
	if (response.status === 412) {
		throw new Error('B站返回 412 request was banned：cookie 没拿到或被风控。稍等几分钟再试，或减少请求频率。')
	}
	if (!response.ok) {
		throw new Error(`B站返回 HTTP ${response.status}（${body.length} 字节）`)
	}

	let payload
	try {
		payload = JSON.parse(body)
	}
	catch {
		throw new Error(`B站返回的不是 JSON（前 120 字符：${body.slice(0, 120)}）`)
	}
	if (payload.code !== 0) {
		throw new Error(`B站业务错误 code=${payload.code} message=${payload.message ?? '(无)'}`)
	}

	const list = Array.isArray(payload.data?.result) ? payload.data.result : []
	const results = list.slice(0, limit).map((item) => ({
		title: stripHighlight(item.title),
		bvid: item.bvid ?? '',
		aid: item.aid ?? 0,
		url: item.bvid ? `https://www.bilibili.com/video/${item.bvid}` : (item.arcurl ?? ''),
		author: item.author ?? '',
		play: Number(item.play) || 0,
		playText: formatPlay(item.play),
		duration: formatDuration(item.duration),
		pubdate: item.pubdate ? new Date(Number(item.pubdate) * 1000).toISOString().slice(0, 10) : '',
		description: stripHighlight(item.description).slice(0, 120),
		cover: String(item.pic ?? '').startsWith('//') ? `https:${item.pic}` : (item.pic ?? ''),
	}))

	const total = Number(payload.data?.numResults) || results.length
	return { results, total, note: cookie === '' ? '未拿到 cookie，本次可能被风控' : '' }
}
