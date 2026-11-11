// Network collection runs in the reader tab, only after a user opens/refreshes it.
// This module never registers background, startup or timer-based fetches.
export const CHANNELS = [
  {
    id: "national_gov",
    name: "国务院与核心部委",
    query: "site:gov.cn (国务院 OR 国家发改委 OR 财政部 OR 中国人民银行 OR 工信部 OR 商务部) 政策 when:7d",
    lang: "zh",
    domains: ["gov.cn"],
  },
  {
    id: "national_media",
    name: "国家级主流媒体",
    query: "(site:xinhuanet.com OR site:people.com.cn OR site:cctv.com) (经济 OR 政策 OR 产业) when:7d",
    lang: "zh",
    domains: ["www.people.com.cn", "www.xinhuanet.com", "www.cctv.com"],
  },
  {
    id: "reuters",
    name: "Reuters (路透)",
    query: "site:reuters.com (China OR Beijing OR PBOC OR economy) when:7d",
    lang: "en",
    domains: ["reuters.com"],
  },
  {
    id: "bloomberg",
    name: "Bloomberg (彭博)",
    query: "site:bloomberg.com (China OR Beijing OR PBOC OR economy) when:7d",
    lang: "en",
    domains: ["bloomberg.com"],
  },
  {
    id: "ap",
    name: "AP 美联社",
    query: "site:apnews.com (China OR Beijing OR economy) when:7d",
    lang: "en",
    domains: ["apnews.com"],
  },
  {
    id: "afp",
    name: "AFP 法新社",
    query: "(site:barrons.com OR site:rfi.fr OR site:channelnewsasia.com) (AFP OR 法新社) (China OR Beijing) when:7d",
    lang: "en",
    domains: ["barrons.com", "rfi.fr", "channelnewsasia.com"],
  },
  {
    id: "kyodo",
    name: "共同社 Kyodo",
    query: "site:english.kyodonews.net (China OR Beijing OR economy) when:7d",
    lang: "en",
    domains: ["kyodonews.net"],
  },
  {
    id: "yonhap",
    name: "韩联社 Yonhap",
    query: "site:en.yna.co.kr (China OR Beijing OR economy) when:7d",
    lang: "en",
    domains: ["yna.co.kr"],
  }
];

// ===== 文章来源范围：只需要改这一段 =====
// enabled 改成 false 即可恢复"显示全部来源"。
// 命中 localName / localHost / localChannel 的来源视为省市级，采集与显示时都会排除。
// 判定顺序：地方频道域名 > 地方域名 > 名称白名单 > 名称地方关键词。
// 想放行某个地方来源：把它的完整名称加进 keepNames，或删掉对应正则片段。
export const SOURCE_SCOPE = {
  enabled: true,
  localName:
    /省|市|自治区|特别行政区|经济技术开发区|高新技术产业开发区|高新区|自治州|县委|省委|区委|地区行政公署|人民政府/,
  localHost:
    /(?:^|\.)(?:beijing|shanghai|tianjin|chongqing|hebei|shanxi|shaanxi|neimenggu|liaoning|jilin|heilongjiang|jiangsu|zhejiang|anhui|fujian|jiangxi|shandong|henan|hubei|hunan|guangdong|guangxi|hainan|sichuan|guizhou|yunnan|gansu|qinghai|ningxia|xinjiang|xizang|wuhan|baoji|shenzhen|guangzhou|nanjing|hangzhou|chengdu|kfqgw)(?:\.|-)/i,
  // 人民网 / 新华网 / 央视网的地方频道（2-4 字母子域）；负向前瞻放行国家级频道
  localChannel:
    /^(?!www$|politics|finance|world|cpc|theory|opinion|edu|health|sports|ent|house|auto|game|travel|food|pic|jingji|news|tv|military|english|paper|jjckb|xczx)[a-z]{2,4}\.(?:people\.com\.cn|news\.cn|xinhuanet\.com|cctv\.com)$/i,
  keepNames: new Set([
    "人民日报",
    "人民网",
    "人民网财经",
    "新华网",
    "新华社",
    "央视网",
    "央视新闻",
  ]),
};

export function isLocalSource(publisher = "", publisherUrl = "") {
  if (!SOURCE_SCOPE.enabled) return false;
  const name = String(publisher || "").trim();
  const h = host(publisherUrl).replace(/^www\./, "");
  if (SOURCE_SCOPE.localChannel.test(h) || SOURCE_SCOPE.localHost.test(h))
    return true;
  if (SOURCE_SCOPE.keepNames.has(name)) return false;
  return SOURCE_SCOPE.localName.test(name);
}

const MAX_BYTES = 3 * 1024 * 1024;
const WEEK = 7 * 86400000;
export function safeUrl(value) {
  try {
    if (/[\u0000-\u001f\u007f]/.test(String(value))) return "";
    const url = new URL(String(value));
    return ["https:", "http:"].includes(url.protocol) &&
      !url.username &&
      !url.password
      ? url.href
      : "";
  } catch {
    return "";
  }
}
export function host(value) {
  try {
    return new URL(value).hostname.toLowerCase().replace(/\.$/, "");
  } catch {
    return "";
  }
}
export function under(name, domain) {
  return !!domain && (name === domain || name.endsWith("." + domain));
}
export function canonical(value) {
  const url = new URL(value);
  url.hash = "";
  if (host(url) === "news.google.com") url.search = "";
  return url.href;
}
export function articleCode(value) {
  if (!safeUrl(value) || host(value) !== "news.google.com") return "";
  const match = new URL(value).pathname.match(
    /^\/(?:rss\/)?(?:articles|read)\/([A-Za-z0-9_-]+)$/,
  );
  return match ? match[1] : "";
}
export function parsePublicationDate(value) {
  if (
    typeof value !== "string" ||
    !/(?:Z|[+-]\d{2}:?\d{2}|GMT|UTC|\b(?:UT|EST|EDT|CST|CDT|MST|MDT|PST|PDT))$/i.test(
      value.trim(),
    )
  )
    return null;
  const time = Date.parse(value);
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
}
export function sourceMatches(articleUrl, publisherUrl) {
  const url = safeUrl(articleUrl),
    domain = host(publisherUrl).replace(/^www\./, "");
  return (
    !!url &&
    !!domain &&
    under(host(url), domain) &&
    !articleCode(url) &&
    !["", "/"].includes(new URL(url).pathname)
  );
}
export async function stableId(url) {
  const data = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(canonical(url)),
  );
  return (
    "article-" +
    Array.from(new Uint8Array(data), (x) => x.toString(16).padStart(2, "0"))
      .join("")
      .slice(0, 24)
  );
}
export function channelSpec(channel, query = "") {
  if (channel === "custom") {
    query = String(query).trim();
    if (!query || query.length > 300)
      throw Error("请输入 1 至 300 个字符的检索词。");
    return {
      id: "custom",
      name: "自定义检索",
      query: "(" + query + ") when:7d",
      lang: /[\u3400-\u9fff]/.test(query) ? "zh" : "en",
      domains: [],
    };
  }
  const spec = CHANNELS.find((item) => item.id === channel);
  if (!spec) throw Error("未知的新闻通道。");
  return spec;
}
export function feedUrl(spec) {
  const params =
    spec.lang === "zh"
      ? { q: spec.query, hl: "zh-CN", gl: "CN", ceid: "CN:zh-Hans" }
      : { q: spec.query, hl: "en-US", gl: "US", ceid: "US:en" };
  return "https://news.google.com/rss/search?" + new URLSearchParams(params);
}
async function googleText(url, { body, timeout = 18000 } = {}) {
  if (host(url) !== "news.google.com" || !String(url).startsWith("https://"))
    throw Error("只允许请求 Google News。");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const options = {
      signal: controller.signal,
      cache: "no-store",
      credentials: "omit",
      referrerPolicy: "no-referrer",
    };
    if (body !== undefined) {
      options.method = "POST";
      options.body = body;
      options.headers = {
        "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
      };
    }
    const response = await fetch(url, options);
    if (!response.ok) throw Error("Google News 返回 HTTP " + response.status);
    if (response.url && host(response.url) !== "news.google.com")
      throw Error("Google 返回登录或验证页面，请稍后重试。");
    const parts = [];
    let size = 0;
    if (response.body) {
      const reader = response.body.getReader();
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > MAX_BYTES) {
            controller.abort();
            throw Error("新闻响应超过 3 MB 限制。");
          }
          parts.push(value);
        }
      } finally {
        reader.releaseLock();
      }
    } else {
      const value = new Uint8Array(await response.arrayBuffer());
      size = value.byteLength;
      parts.push(value);
      if (size > MAX_BYTES) throw Error("新闻响应超过 3 MB 限制。");
    }
    const result = new Uint8Array(size);
    let offset = 0;
    for (const part of parts) {
      result.set(part, offset);
      offset += part.byteLength;
    }
    return new TextDecoder().decode(result);
  } catch (error) {
    if (error.name === "AbortError") throw Error("Google News 请求超时。");
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
export async function parseRss(text, spec, url, now = Date.now()) {
  if (/<!DOCTYPE|<!ENTITY/i.test(text))
    throw Error("不支持带文档类型或实体声明的新闻订阅。");
  const doc = new DOMParser().parseFromString(text, "application/xml");
  if (
    doc.querySelector("parsererror") ||
    doc.documentElement.localName !== "rss" ||
    !doc.querySelector("channel")
  )
    throw Error("Google News 未返回有效的 RSS，可能暂时无法访问。");
  const items = [],
    seen = new Set(),
    rejected = { date: 0, source: 0, invalid: 0, duplicate: 0 };
  const collectedAt = new Date(now).toISOString();
  for (const entry of doc.querySelectorAll("channel > item")) {
    const child = (name) =>
      Array.from(entry.children).find((node) => node.localName === name);
    const field = (name) => child(name)?.textContent.trim() || "";
    const title = field("title"),
      link = safeUrl(field("link"));
    if (!title || !articleCode(link)) {
      rejected.invalid++;
      continue;
    }
    const publishedAt = parsePublicationDate(field("pubDate")),
      age = now - Date.parse(publishedAt);
    if (!publishedAt || !Number.isFinite(age) || age < 0 || age > WEEK) {
      rejected.date++;
      continue;
    }
    const source = child("source"),
      publisher = source?.textContent.trim() || "来源未标注",
      publisherUrl = safeUrl(source?.getAttribute("url"));

    const pubHost = host(publisherUrl);
    if (spec.domains.length) {
      const matchesDomain = spec.domains.some((domain) => under(pubHost, domain));
      if (!matchesDomain) {
        rejected.source++;
        continue;
      }
      // 省市级 / 地方频道来源：按 SOURCE_SCOPE 统一排除
      // （旧规则会误杀 www.mofcom.gov.cn 等部委站点，已替换为精准匹配）
      if (isLocalSource(publisher, publisherUrl)) {
        rejected.source++;
        continue;
      }
    }

    const identity = canonical(link);
    if (seen.has(identity)) {
      rejected.duplicate++;
      continue;
    }
    seen.add(identity);
    items.push({
      id: await stableId(identity),
      title: title.slice(0, 2000),
      url: identity,
      publisher: publisher.slice(0, 200),
      publisherUrl,
      publishedAt,
      collectedAt,
      channel: spec.name,
      feedUrl: url,
      linkKind: "aggregator",
    });
  }
  return {
    app: "public-news-reader-extension-v1",
    items,
    channel: spec.name,
    feedUrl: url,
    collectedAt,
    cached: false,
    rejected,
  };
}
export async function fetchFeed(channel, query = "") {
  const spec = channelSpec(channel, query),
    url = feedUrl(spec);
  return parseRss(await googleText(url), spec, url);
}
export function parseRpcUrls(text) {
  const found = [];
  for (const line of text.split("\n")) {
    const clean = line.trim();
    if (!clean.startsWith("[")) continue;
    let data;
    try {
      data = JSON.parse(clean);
    } catch {
      continue;
    }
    const pending = [data];
    while (pending.length) {
      const value = pending.pop();
      if (!Array.isArray(value)) continue;
      if (value[0] === "garturlres" && typeof value[1] === "string")
        found.push(value[1]);
      for (const cell of value) {
        if (Array.isArray(cell)) pending.push(cell);
        else if (typeof cell === "string" && cell.startsWith('["garturlres"')) {
          try {
            pending.push(JSON.parse(cell));
          } catch { }
        }
      }
    }
  }
  return found;
}
export function decodeParameters(page) {
  const raw = /\bdata-n-a-sg\s*=\s*(["'])(.*?)\1/i.exec(page)?.[2];
  const stamp = /\bdata-n-a-ts\s*=\s*(["'])(\d+)\1/i.exec(page)?.[2];
  if (!raw || !stamp) throw Error("Google 未提供原文解析参数。");
  const names = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
  const signature = raw.replace(
    /&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos);/gi,
    (whole, value) => {
      if (value[0] !== "#") return names[value.toLowerCase()] || whole;
      const hex = value[1].toLowerCase() === "x";
      const number = parseInt(value.slice(hex ? 2 : 1), hex ? 16 : 10);
      return number >= 0 && number <= 0x10ffff
        ? String.fromCodePoint(number)
        : whole;
    },
  );
  return { signature, stamp };
}
export async function resolveOriginalUrl(item) {
  const code = articleCode(item.url),
    domain = host(item.publisherUrl);
  if (!code || !domain)
    throw Error("缺少聚合条目或来源域名，无法核对原文地址。");
  const page = await googleText(
    "https://news.google.com/rss/articles/" +
    code +
    "?hl=en-US&gl=US&ceid=US:en",
  );
  const { signature, stamp } = decodeParameters(page);
  const context = [
    [
      "X",
      "X",
      ["X", "X"],
      null,
      null,
      1,
      1,
      "US:en",
      null,
      1,
      null,
      null,
      null,
      null,
      null,
      0,
      1,
    ],
    "X",
    "X",
    1,
    [1, 1, 1],
    1,
    1,
    null,
    0,
    0,
    null,
    0,
  ];
  const request = ["garturlreq", context, code, Number(stamp), signature];
  const body = new URLSearchParams({
    "f.req": JSON.stringify([
      [["Fbv4je", JSON.stringify(request), null, "generic"]],
    ]),
  }).toString();
  const response = await googleText(
    "https://news.google.com/_/DotsSplashUi/data/batchexecute?rpcids=Fbv4je",
    { body },
  );
  for (const candidate of parseRpcUrls(response)) {
    const url = safeUrl(candidate);
    if (sourceMatches(url, item.publisherUrl))
      return { url, linkKind: "publisher" };
  }
  throw Error("原文地址缺失或与 RSS 标注来源域名不符。");
}
