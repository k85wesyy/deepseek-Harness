/**
 * 搜索结果去噪引擎。
 *
 * 解决的问题：中文专有名词一进搜索引擎就被污染——
 * 搜「步步高」返回零售集团、股票、网易云同名歌曲；
 * 搜「BBK」返回 vivo/OPPO 手机解锁工具；
 * 搜「紫光展锐解锁BL」被拆成「紫光」返回紫光股份公司简介。
 *
 * 三条规则各自独立，可分别开关：
 *   ① 黑名单域名   —— 命中的结果直接丢（如百度百科、股票、音乐站）
 *   ② 关键词不相关 —— 查询词的每个实词都没在标题/摘要/URL 里出现 → 判定不相关
 *   ③ 强污染词告警 —— 查询词本身是高污染词（BBK、步步高），提示可能全脏
 */

/** 默认黑名单：这些域名在技术检索里几乎从来不是想要的答案。 */
export const DEFAULT_BLOCKED_DOMAINS = [
	// ── ★★★ 头号屏蔽目标：豆包 / 千问 ────────────────────────────────
	// 这两个是 AI 对话产品，却靠 SEO 把自己的落地页顶到每个搜索结果最前面。
	// 它们会换域名、开子站、挂 .ai 后缀，所以只写一个域名拦不住，
	// 这里把已知的全部变体列上，再由 HARD_BLOCK_PATTERNS 兜底。
	'doubao.com', // 豆包主站
	'www.doubao.com',
	'tongyi.aliyun.com', // 千问（阿里通义）主站
	'tongyi.com',
	'qianwen.com', // 千问独立域名
	'www.qianwen.com',
	'qwen.ai', // 千问国际版
	'chat.qwen.ai',
	'wanx.aliyun.com', // 通义万相（同一套 SEO）
	// ── 百度系 ──────────────────────────────────────────────────────
	'baike.baidu.com', // 百度百科：泛泛的科普条目，技术问题里基本无用
	'zhidao.baidu.com', // 百度知道：质量极不稳定
	'jingyan.baidu.com', // 百度经验
	'wenku.baidu.com', // 百度文库：要会员，抓不到正文
	'baijiahao.baidu.com', // 百家号：SEO 农场
	// ── 问答/内容农场 ───────────────────────────────────────────────
	'www.zhihu.com', // 知乎：多数答案要登录且质量参差
	'zhuanlan.zhihu.com',
	'zhihu.com',
	'music.163.com', // 网易云音乐：同名歌曲是中文专有名词搜索的头号污染源
	'y.qq.com',
	'www.kugou.com',
	'i.y.qq.com',
	'quote.eastmoney.com', // 东方财富：股票
	'xueqiu.com',
	'www.tianyancha.com', // 天眼查：公司工商信息
	'www.qcc.com',
	'douban.com',
	'www.douban.com',
	'weibo.com',
	'www.weibo.com',
	'www.douyin.com', // 抖音
	'v.douyin.com',
	'douyin.com',
	'www.xiaohongshu.com', // 小红书：搜技术问题全是带货
	'xiaohongshu.com',
	'blog.csdn.net', // CSDN：洗稿 + 收费墙重灾区
	'csdn.net',
	'juejin.cn', // 掘金：大量洗稿
	'www.jianshu.com', // 简书：SEO 农场
	'www.cnblogs.com', // 博客园：大量过时转载
	'www.51cto.com',
	// ── 购物/生活类：中文专有名词的次要污染源 ───────────────────────
	'www.jd.com',
	'www.taobao.com',
	'www.tmall.com',
	'www.58.com',
	'www.chsi.com.cn',
]

/**
 * ★★★ 硬拦兜底：按主机名做正则匹配，专治换域名。
 * 域名黑名单是逐个写死的，对方换个主机名就绕过去了；
 * 这里用「主机名包含某片段」兜底，覆盖换了域名但没改品牌名的情形。
 */
export const HARD_BLOCK_PATTERNS = [
	/doubao/i, // 豆包任何域名变体
	/qwen/i, // 千问任何域名变体
	/qianwen/i,
	/tongyi/i, // 通义系
	/aliyun/i, // 阿里云系
	/\.baidu\.com/i, // 百度系整体（百科/知道/经验/文库/百家号/贴吧）
	/chatgpt\.com|chat\.openai\.com|openai\.com/i,
	/\bcsdn\b/i,
]

/**
 * ★★★ 标题/摘要硬拦：这些词出现在结果里，说明是 AI 产品的推广落地页。
 * 只看域名不够——有些结果挂在第三方站上，但内容是「豆包帮你做…」。
 */
export const HARD_BLOCK_TITLES = [
	'豆包',
	'千问',
	'通义千问',
	'通义',
	'Qwen',
	'Doubao',
	'立即下载app',
	'官方下载',
	'免费试用',
	'限时免费',
	'AI写作神器',
]

/**
 * ★★★ .cn 高危识别。
 *
 * 用户的判断：.cn 注册不需要实名备案的走法太多，骗子站、赌博站、91 类站点
 * 最爱用，且这类站往往活不过几天就换域名，靠人工黑名单永远追不上。
 * 所以对 .cn 做「结构可疑即拦」——不机械拦所有 .cn（gov.cn / edu.cn / org.cn
 * 这些反而是可信的），而是拦那些一眼就是垃圾站的结构。
 */
/** 可信的 .cn 二级域：这些放行，不参与结构可疑判定。 */
export const TRUSTED_CN_SUFFIXES = [
	'gov.cn', 'edu.cn', 'org.cn', 'ac.cn', 'mil.cn',
	// 常见的正规机构二级域
	'aliyun.cn', 'qq.cn', 'baidu.cn', 'mozilla.org.cn', 'chinaz.com.cn',
]

/**
 * 判断一个 .cn 域名是否为「结构可疑」的危险站。
 * 判据（命中任意一条即可疑）：
 *   ① 纯数字二级域            123456.cn / 8888.cn
 *   ② 二级域只有 1~3 个字符    a1.cn / x9.cn（正规站点不会这么起）
 *   ③ 二级域含数字与字母混杂   t66y.cn / zz123.cn（典型擦边站形态）
 *   ④ 含敏感词                91 / av / sex / porno / casino / bet / 彩票 / 棋牌
 * 可信二级域（gov.cn / edu.cn 等）直接放行，不参与判定。
 * @param {string} host 主机名
 * @returns {string} 命中的原因，未命中返回空串
 */
export function suspiciousCnReason(host) {
	if (!/\.cn$/i.test(host)) return ''
	const lower = host.toLowerCase()
	if (TRUSTED_CN_SUFFIXES.some((suffix) => lower === suffix || lower.endsWith(`.${suffix}`))) return ''
	// 取二级域（host 去掉 .cn 后的最后一段）
	const parts = lower.split('.')
	const second = parts.length >= 2 ? parts[parts.length - 2] : ''
	if (second === '') return ''
	// ① 纯数字
	if (/^\d+$/.test(second)) return `.cn-pure-digits:${second}`
	// ② 太短
	if (second.length <= 3 && !/^(cn|net|com|org|gov|edu)$/.test(second)) return `.cn-too-short:${second}`
	// ③ 数字字母混杂且数字占比高
	if (/\d/.test(second) && /[a-z]/.test(second) && (second.match(/\d/g) ?? []).length >= 2) return `.cn-mixed-digits:${second}`
	// ④ 敏感词
	if (/(91|av\d|sex|porn|casino|bet|lottery|彩票|棋牌|六合|博彩)/i.test(second)) return `.cn-sensitive:${second}`
	return ''
}

/**
 * 来源分组：把搜索结果按「来自哪个站」归类，同站结果聚在一起。
 * 顺序即展示顺序——技术检索里 GitHub 最该排前面。
 */
export const SOURCE_GROUPS = [
	{ id: 'github', label: 'GitHub', test: (host) => /(^|\.)github\.com$|(^|\.)githubusercontent\.com$|(^|\.)github\.io$/i.test(host) },
	{ id: 'mozilla', label: 'Mozilla', test: (host) => /(^|\.)mozilla\.(org|com)$|(^|\.)mozilla\.org\.cn$/i.test(host) },
	{ id: 'gitee', label: 'Gitee', test: (host) => /(^|\.)gitee\.com$/i.test(host) },
	{ id: 'sourceforge', label: 'SourceForge', test: (host) => /(^|\.)sourceforge\.net$/i.test(host) },
	{ id: 'bilibili', label: 'B站', test: (host) => /(^|\.)bilibili\.com$/i.test(host) },
	{ id: 'google', label: 'Google', test: (host) => /(^|\.)google\.(com|com\.hk|cn)$/i.test(host) },
	{ id: 'bing', label: '必应', test: (host) => /(^|\.)bing\.com$/i.test(host) },
	{ id: 'social', label: '社交/论坛', test: (host) => /(^|\.)(twitter\.com|x\.com|reddit\.com|t\.me|telegram\.org|discord\.com|tieba\.baidu\.com)$/i.test(host) },
]

/**
 * 取一条结果所属的来源分组 id。
 * @param {string} host 主机名
 * @returns {string} 分组 id，未命中返回 'other'
 */
export function groupOf(host) {
	for (const group of SOURCE_GROUPS) {
		if (group.test(host)) return group.id
	}
	return 'other'
}

/**
 * 取分组的中文标签。
 * @param {string} id 分组 id
 * @returns {string} 标签
 */
export function groupLabel(id) {
	const found = SOURCE_GROUPS.find((group) => group.id === id)
	return found === undefined ? '其他站点' : found.label
}

/**
 * 中文里出现频率极高、不构成区分度的词：判定相关性时忽略。
 * 判定用「实词」——去掉这些之后剩下的词才参与匹配。
 */
const STOPWORDS = new Set([
	'的', '了', '和', '与', '及', '或', '在', '是', '有', '我', '你', '他', '它',
	'怎么', '如何', '什么', '为什么', '哪些', '哪个', '怎样', '可以', '能不能',
	'the', 'a', 'an', 'and', 'or', 'of', 'to', 'in', 'on', 'for', 'how', 'what',
	'is', 'are', 'was', 'were', 'be', 'with', 'by', 'at', 'from',
])

/** 强污染词：单独使用时搜索结果会被完全不同领域的内容淹没。 */
export const POLLUTED_TERMS = [
	{ term: 'bbk', hint: 'BBK 在 Android 圈默认指 vivo/OPPO 母公司，跟步步高教育电子（eebbk）是两条线，改用 eebbk / 学习机 / P22H190' },
	{ term: '步步高', hint: '步步高同时是零售集团（步步高商业）、股票、同名歌曲，改用 eebbk / 家教机 / 学习机' },
	{ term: '紫光', hint: '紫光会被拆成紫光股份/紫光集团（公司简介），改用「紫光展锐」「unisoc」「ums512」' },
	{ term: '小天才', hint: '小天才与步步高教育电子产品线交叉，结果混杂' },
]

/**
 * 从查询串里切出用于相关性判断的实词。
 * 中文按 2 字以上连续片段切，英文按空白切。
 * @param {string} query 原始查询串
 * @returns {string[]} 去重后的实词（小写）
 */
export function extractTerms(query) {
	const raw = String(query ?? '').toLowerCase()
	const terms = new Set()
	// 英文/数字词
	for (const word of raw.split(/[^a-z0-9_+#.-]+/u)) {
		if (word.length >= 2 && !STOPWORDS.has(word)) terms.add(word)
	}
	// 中文连续片段里取 2 字滑窗，长度 >= 2
	for (const run of raw.match(/[\u4e00-\u9fff]{2,}/gu) ?? []) {
		if (STOPWORDS.has(run)) continue
		if (run.length <= 4) {
			terms.add(run)
		}
		else {
			for (let i = 0; i + 2 <= run.length; i += 1) terms.add(run.slice(i, i + 2))
		}
	}
	return [...terms]
}

/**
 * 判断一条结果是否与查询无关。
 * 规则：所有实词都没在这个结果的 标题 + 摘要 + URL 里出现 → 无关。
 * @param {{title?: string, url?: string, snippet?: string}} hit 单条搜索结果
 * @param {string[]} terms 查询实词
 * @returns {boolean} true = 判定为无关
 */
export function isIrrelevant(hit, terms) {
	if (terms.length === 0) return false
	const haystack = `${hit.title ?? ''} ${hit.snippet ?? ''} ${hit.url ?? ''}`.toLowerCase()
	return !terms.some((term) => haystack.includes(term))
}

/**
 * 取 URL 的主机名，失败返回空串。
 * @param {string} url 完整 URL
 * @returns {string} 小写主机名
 */
export function hostOf(url) {
	try {
		return new URL(url).hostname.toLowerCase()
	}
	catch {
		return ''
	}
}

/**
 * 判断主机名是否命中黑名单（含子域）。
 * @param {string} host 主机名
 * @param {string[]} blocked 黑名单域名列表
 * @returns {boolean} true = 应屏蔽
 */
export function isBlockedHost(host, blocked) {
	if (host === '') return false
	return blocked.some((domain) => host === domain || host.endsWith(`.${domain}`))
}

/**
 * 检查查询串里是否含强污染词。
 * @param {string} query 原始查询串
 * @returns {{term: string, hint: string}[]} 命中的污染词
 */
export function detectPolluted(query) {
	const raw = String(query ?? '').toLowerCase()
	return POLLUTED_TERMS.filter((entry) => raw.includes(entry.term))
}

/**
 * 检查主机名是否命中硬拦正则（专治换域名）。
 * @param {string} host 主机名
 * @returns {boolean} true = 应屏蔽
 */
export function isHardBlockedHost(host) {
	if (host === '') return false
	return HARD_BLOCK_PATTERNS.some((pattern) => pattern.test(host))
}

/**
 * 检查标题/摘要里有没有硬拦词。
 * @param {{title?: string, snippet?: string}} hit 单条结果
 * @returns {string} 命中的词，未命中返回空串
 */
export function findHardBlockedTitle(hit) {
	const haystack = `${hit.title ?? ''} ${hit.snippet ?? ''}`
	for (const word of HARD_BLOCK_TITLES) {
		if (haystack.includes(word)) return word
	}
	return ''
}

/**
 * 对一批搜索结果执行去噪。
 * @param {Array<{title?: string, url?: string, snippet?: string}>} hits 原始结果
 * @param {string} query 原始查询串
 * @param {{blockedDomains?: string[], denoise?: boolean}} options 去噪选项
 * @returns {{kept: object[], dropped: Array<{hit: object, reason: string}>, polluted: {term: string, hint: string}[]}}
 */
export function denoise(hits, query, options = {}) {
	const blocked = Array.isArray(options.blockedDomains) && options.blockedDomains.length > 0
		? options.blockedDomains
		: DEFAULT_BLOCKED_DOMAINS
	const enabled = options.denoise !== false
	const polluted = detectPolluted(query)
	const terms = extractTerms(query)
	const kept = []
	const dropped = []
	for (const hit of hits) {
		if (!enabled) {
			kept.push(hit)
			continue
		}
		const host = hostOf(hit.url ?? '')
		// ① 域名黑名单
		if (isBlockedHost(host, blocked)) {
			dropped.push({ hit, reason: `blocked-domain:${host}` })
			continue
		}
		// ② ★硬拦：主机名正则兜底（豆包/千问换域名也拦得住）
		if (isHardBlockedHost(host)) {
			dropped.push({ hit, reason: `hard-blocked-host:${host}` })
			continue
		}
		// ③ ★硬拦：.cn 结构可疑（纯数字 / 超短 / 数字字母混杂 / 敏感词）
		const cnReason = suspiciousCnReason(host)
		if (cnReason !== '') {
			dropped.push({ hit, reason: `suspicious-cn:${cnReason}` })
			continue
		}
		// ④ ★硬拦：标题/摘要里的推广词
		const spamWord = findHardBlockedTitle(hit)
		if (spamWord !== '') {
			dropped.push({ hit, reason: `hard-blocked-title:${spamWord}` })
			continue
		}
		// ⑤ 相关性：所有实词都不在结果里 → 无关
		if (isIrrelevant(hit, terms)) {
			dropped.push({ hit, reason: 'irrelevant' })
			continue
		}
		kept.push(hit)
	}
	return { kept, dropped, polluted }
}

/**
 * ★ 把去噪后的结果按来源网站分组，同站聚在一起。
 * 组内保持原有顺序，组间按 SOURCE_GROUPS 的优先级排，'other' 垫底。
 * @param {Array<{title?: string, url?: string, snippet?: string}>} hits 去噪后的结果
 * @returns {Array<{id: string, label: string, hits: object[]}>} 分组结果
 */
export function groupBySource(hits) {
	const order = [...SOURCE_GROUPS.map((group) => group.id), 'other']
	const buckets = new Map()
	for (const hit of hits) {
		const id = groupOf(hostOf(hit.url ?? ''))
		if (!buckets.has(id)) buckets.set(id, [])
		buckets.get(id).push(hit)
	}
	const out = []
	for (const id of order) {
		const bucket = buckets.get(id)
		if (bucket === undefined || bucket.length === 0) continue
		out.push({ id, label: groupLabel(id), hits: bucket })
	}
	return out
}
