import { CHANNELS, fetchFeed, resolveOriginalUrl } from "./collector.js";

("use strict");
const DAY = 86400000,
  STORE_KEY = "public_news_reader_v2";
const TOPICS = [
  {
    id: "POLICY",
    name: "政治与公共政策",
    pattern: /国务院|国常会|政治局|财政|改革|央行|policy|stimulus|\bpboc\b/i,
  },
  {
    id: "TECH",
    name: "科技与产业",
    pattern:
      /科技|人工智能|算力|芯片|半导体|tech(?:nology)?|\bai\b|chip|semiconductor/i,
  },
  {
    id: "HEALTH",
    name: "医疗、养老与民生",
    pattern: /医疗|医药|健康|养老|民生|医保|health|medical|pension/i,
  },
  {
    id: "DEBT",
    name: "债务与房地产",
    pattern: /地方债|化债|债务|房地产|楼市|住房|debt|property|housing/i,
  },
  {
    id: "TRADE",
    name: "外交与经贸",
    pattern: /外交|关税|贸易|出口|进口|外交部|trade|tariff|export|diplomacy/i,
  },
  {
    id: "ENERGY",
    name: "能源与基础设施",
    pattern:
      /能源|电力|电网|基建|石油|天然气|energy|\boil\b|gas|infrastructure/i,
  },
];
let articles = [],
  bookmarks = [],
  lastSync = null,
  collectorReady = false,
  syncing = false;
let storageAvailable = true,
  lastResults = [],
  storageIssue = "",
  initialStorageIssue = "";
const pendingResolution = new Set(),
  $ = (id) => document.getElementById(id);
function el(tag, text, cls) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = String(text);
  if (cls) node.className = cls;
  return node;
}
function safeUrl(value) {
  try {
    if (/[\u0000-\u001f\u007f]/.test(String(value))) return "";
    const u = new URL(String(value));
    return ["http:", "https:"].includes(u.protocol) &&
      !u.username &&
      !u.password
      ? u.href
      : "";
  } catch {
    return "";
  }
}
function host(value) {
  try {
    return new URL(value).hostname.toLowerCase().replace(/\.$/, "");
  } catch {
    return "";
  }
}
function under(name, domain) {
  return name === domain || name.endsWith("." + domain);
}
function isAggregator(url) {
  return (
    host(url) === "news.google.com" &&
    /^\/(?:rss\/)?(?:articles|read)\/[^/]+$/.test(new URL(url).pathname)
  );
}
function canonical(url) {
  const u = new URL(url);
  u.hash = "";
  if (isAggregator(url)) u.search = "";
  return u.href;
}
function usableArticleUrl(value) {
  const url = safeUrl(value);
  if (!url) return "";
  const u = new URL(url);
  return u.pathname === "/" || u.pathname === "" ? "" : url;
}
function sourceKey(item) {
  return host(item.publisherUrl) || "name:" + item.publisher;
}
function dateText(value) {
  const d = new Date(value);
  return Number.isFinite(d.getTime())
    ? new Intl.DateTimeFormat("zh-CN", {
        timeZone: "Asia/Shanghai",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        hourCycle: "h23",
      }).format(d) + " 北京时间"
    : "日期无效";
}
function parseDate(value) {
  if (!value || !String(value).trim()) return null;
  const text = String(value).trim();
  if (
    !/(?:Z|[+-]\d{2}:?\d{2}|GMT|UTC|\b(?:UT|EST|EDT|CST|CDT|MST|MDT|PST|PDT))$/i.test(
      text,
    )
  )
    return null;
  const ms = Date.parse(text);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}
function inWindow(item, days = 7, now = Date.now()) {
  const age = now - Date.parse(item.publishedAt);
  return Number.isFinite(age) && age >= 0 && age <= days * DAY;
}
function topicIds(item) {
  const ids = TOPICS.filter((t) => t.pattern.test(item.title)).map((t) => t.id);
  return ids.length ? ids : ["OTHER"];
}
function normalize(raw) {
  if (
    !raw ||
    typeof raw !== "object" ||
    typeof raw.title !== "string" ||
    !raw.title.trim()
  )
    return null;
  const url = usableArticleUrl(raw.url),
    date = Date.parse(parseDate(raw.publishedAt));
  if (!url || !Number.isFinite(date) || date > Date.now()) return null;
  let publisher = String(raw.publisher || "来源未标注")
      .trim()
      .slice(0, 200),
    publisherUrl = safeUrl(raw.publisherUrl);
  const aggregator = isAggregator(url);
  // A direct link's actual host wins over a contradictory imported publisher claim.
  if (
    !aggregator &&
    publisherUrl &&
    !under(host(url), host(publisherUrl).replace(/^www\./, ""))
  ) {
    publisher = host(url);
    publisherUrl = new URL(url).origin;
  }
  if (!aggregator && !publisherUrl) {
    publisher = host(url);
    publisherUrl = new URL(url).origin;
  }
  const original = usableArticleUrl(raw.originalUrl),
    matched =
      original &&
      !isAggregator(original) &&
      publisherUrl &&
      under(host(original), host(publisherUrl).replace(/^www\./, ""));
  return {
    id:
      typeof raw.id === "string" && /^article-[a-f0-9]{24}$/.test(raw.id)
        ? raw.id
        : "import:" + canonical(url),
    title: raw.title.trim().slice(0, 2000),
    url: canonical(url),
    publisher,
    publisherUrl,
    publishedAt: new Date(date).toISOString(),
    collectedAt: parseDate(raw.collectedAt),
    feedUrl: safeUrl(raw.feedUrl),
    channel: String(raw.channel || "离线导入").slice(0, 200),
    originalUrl: matched ? original : "",
    linkKind: matched ? "publisher" : aggregator ? "aggregator" : "feed",
    imported: !!raw.imported,
  };
}
function articleKey(item) {
  return canonical(item.url);
}
function mergeArticle(previous, current) {
  return (
    normalize({
      ...previous,
      ...current,
      originalUrl: current.originalUrl || previous.originalUrl,
    }) || current
  );
}
function unique(items) {
  const map = new Map();
  items.forEach((item) => {
    const key = articleKey(item),
      old = map.get(key);
    map.set(key, old ? mergeArticle(old, item) : item);
  });
  return [...map.values()];
}
async function persist() {
  const snapshot = JSON.parse(
    JSON.stringify({
      version: 2,
      articles: articles.filter((a) => inWindow(a)).slice(0, 600),
      bookmarks,
      lastSync,
    }),
  );
  try {
    await chrome.storage.local.set({ [STORE_KEY]: snapshot });
    storageAvailable = true;
    storageIssue = "";
  } catch {
    storageAvailable = false;
    storageIssue = "扩展存储不可用或空间不足，关闭页面前请导出 JSON 备份。";
  }
  $("storageState").textContent = storageAvailable
    ? "数据保存在此 Chrome 扩展的本地存储中。"
    : storageIssue;
}
async function loadState() {
  try {
    const saved = await chrome.storage.local.get(STORE_KEY);
    const data = saved[STORE_KEY];
    if (!data) return;
    if (
      data.version !== 2 ||
      !Array.isArray(data.articles) ||
      !Array.isArray(data.bookmarks)
    )
      throw Error("Invalid extension storage");
    articles = unique(data.articles.map(normalize).filter(Boolean))
      .filter((a) => inWindow(a))
      .slice(0, 600);
    bookmarks = unique(data.bookmarks.map(normalize).filter(Boolean)).slice(
      0,
      1000,
    );
    lastSync = parseDate(data.lastSync);
  } catch {
    initialStorageIssue =
      "扩展缓存无效或无法读取，已使用空列表启动；也可导入有效 JSON 备份。";
  }
}
function status(message, kind = "info") {
  $("status").textContent = message + (storageIssue ? "\n" + storageIssue : "");
  $("status").dataset.kind = kind;
}
function tab(name) {
  document
    .querySelectorAll("[data-tab]")
    .forEach((b) => b.classList.toggle("active", b.dataset.tab === name));
  ["feed", "topics", "sources"].forEach(
    (t) => ($("view-" + t).hidden = t !== name),
  );
}
function link(url, text) {
  const a = el("a", text);
  a.href = url;
  a.target = "_blank";
  a.rel = "noopener noreferrer";
  return a;
}
function rebuildPublishers() {
  const select = $("publisherFilter"),
    before = select.value,
    choices = new Map();
  articles
    .filter((a) => inWindow(a))
    .forEach((a) =>
      choices.set(
        sourceKey(a),
        a.publisher +
          (host(a.publisherUrl) ? " · " + host(a.publisherUrl) : ""),
      ),
    );
  select.replaceChildren(new Option("全部来源", "ALL"));
  [...choices]
    .sort((a, b) => a[1].localeCompare(b[1], "zh-CN"))
    .forEach(([id, name]) => select.add(new Option(name, id)));
  select.value = choices.has(before) ? before : "ALL";
}
function filteredArticles() {
  const now = Date.now(),
    days = Number($("timeFilter").value),
    query = $("searchInput").value.trim().toLocaleLowerCase();
  return articles
    .filter((a) => {
      if (!inWindow(a, days, now)) return false;
      if (
        $("publisherFilter").value !== "ALL" &&
        sourceKey(a) !== $("publisherFilter").value
      )
        return false;
      if (
        $("topicFilter").value !== "ALL" &&
        !topicIds(a).includes($("topicFilter").value)
      )
        return false;
      const zh = /[\u3400-\u9fff]/.test(a.title);
      if (
        ($("languageFilter").value === "ZH" && !zh) ||
        ($("languageFilter").value === "OTHER" && zh)
      )
        return false;
      return (
        !query ||
        [
          a.title,
          a.publisher,
          host(a.publisherUrl),
          ...TOPICS.filter((t) => topicIds(a).includes(t.id)).map(
            (t) => t.name,
          ),
        ]
          .join(" ")
          .toLocaleLowerCase()
          .includes(query)
      );
    })
    .sort((a, b) =>
      $("sortSelect").value === "SOURCE"
        ? a.publisher.localeCompare(b.publisher, "zh-CN") ||
          Date.parse(b.publishedAt) - Date.parse(a.publishedAt)
        : Date.parse(b.publishedAt) - Date.parse(a.publishedAt),
    );
}
function empty(message, explanation) {
  const box = el("div", undefined, "empty");
  box.append(el("strong", message), el("p", explanation, "muted"));
  return box;
}
function renderCard(item, saved = false) {
  const card = el("article", undefined, "news-card");
  card.dataset.articleId = item.id;
  const badges = el("div", undefined, "pills"),
    kind = item.originalUrl
      ? "publisher"
      : isAggregator(item.url)
        ? "aggregator"
        : "feed";
  badges.append(
    el(
      "span",
      kind === "publisher"
        ? "原站文章 · 域名匹配"
        : kind === "aggregator"
          ? "Google News 跳转"
          : "订阅文件链接 · 未联网核验",
      "badge" + (kind === "publisher" ? " publisher" : ""),
    ),
  );
  topicIds(item).forEach((id) =>
    badges.append(
      el("span", TOPICS.find((t) => t.id === id)?.name || "其他主题", "badge"),
    ),
  );
  if (item.imported) badges.append(el("span", "离线导入", "badge"));
  if (saved && !inWindow(item))
    badges.append(el("span", "已超出 7 天窗口", "badge"));
  const heading = el("h3");
  heading.append(link(item.originalUrl || item.url, item.title));
  const meta = el("div", undefined, "meta");
  meta.append(
    el("span", "RSS 标注来源：" + item.publisher),
    el("span", "发布：" + dateText(item.publishedAt)),
  );
  if (item.publisherUrl)
    meta.append(el("span", "来源域名：" + host(item.publisherUrl)));
  const actions = el("div", undefined, "card-actions");
  actions.append(
    link(
      item.originalUrl || item.url,
      kind === "publisher"
        ? "打开原站文章 ↗"
        : kind === "aggregator"
          ? "通过 Google News 阅读 ↗"
          : "打开订阅文件提供的链接 ↗",
    ),
  );
  const fav = el(
    "button",
    bookmarks.some((b) => articleKey(b) === articleKey(item))
      ? "取消收藏"
      : "收藏",
    "subtle",
  );
  fav.addEventListener("click", () => toggleBookmark(item));
  actions.append(fav);
  if (
    kind === "aggregator" &&
    collectorReady &&
    item.id.startsWith("article-")
  ) {
    const resolve = el(
      "button",
      pendingResolution.has(item.id) ? "正在解析原文…" : "解析原文地址",
      "subtle",
    );
    resolve.disabled = pendingResolution.has(item.id);
    resolve.addEventListener("click", () => resolveOriginal(item));
    actions.append(resolve);
  }
  const detail = el("details"),
    summary = el("summary", "查看来源与采集记录");
  detail.append(
    summary,
    el(
      "p",
      "采集：" +
        (item.collectedAt
          ? dateText(item.collectedAt)
          : "导入文件未提供采集时间"),
    ),
    el("p", "检索通道：" + item.channel + "（通道名称不作为文章来源）"),
  );
  if (item.publisherUrl) {
    const p = el("p");
    p.append(link(item.publisherUrl, "RSS 标注的发布站首页"));
    detail.append(p);
  }
  if (item.feedUrl) {
    const p = el("p");
    p.append(link(item.feedUrl, "查看对应 RSS 订阅源"));
    detail.append(p);
  }
  const original = el("p", undefined, "word-break");
  original.append(el("span", "订阅条目链接："), link(item.url, item.url));
  detail.append(original);
  card.append(badges, heading, meta, actions, detail);
  return card;
}
function render() {
  const current = articles.filter((a) => inWindow(a));
  lastResults = filteredArticles();
  $("statTotal").textContent = current.length;
  $("statSources").textContent = new Set(current.map(sourceKey)).size;
  $("statVisible").textContent = lastResults.length;
  $("bookmarkCount").textContent = bookmarks.length;
  $("lastSync").textContent = lastSync
    ? "最近成功同步：" + dateText(lastSync)
    : "尚未成功采集";
  $("feedCount").textContent =
    "过去 " +
    $("timeFilter").value +
    " 天 · 当前 " +
    lastResults.length +
    " 条 / 缓存近 7 天 " +
    current.length +
    " 条";
  const container = $("newsContainer");
  container.replaceChildren();
  if (!lastResults.length)
    container.append(
      empty(
        current.length ? "当前筛选无匹配新闻" : "尚无近 7 天真实新闻",
        current.length
          ? "可重置筛选或调整搜索词。"
          : "请刷新新闻，或在采集设置中导入 RSS / JSON。页面不填充模拟报道。",
      ),
    );
  else {
    const fragment = document.createDocumentFragment();
    lastResults.forEach((a) => fragment.append(renderCard(a)));
    container.append(fragment);
  }
  const grid = $("topicGrid");
  grid.replaceChildren();
  [...TOPICS, { id: "OTHER", name: "其他主题" }].forEach((topic) => {
    const count = current.filter((a) => topicIds(a).includes(topic.id)).length;
    const b = el("button");
    b.append(
      el("span", topic.name),
      el("strong", count),
      el("span", "条标题匹配 · 点击筛选", "small muted"),
    );
    b.addEventListener("click", () => {
      $("topicFilter").value = topic.id;
      tab("feed");
      render();
    });
    grid.append(b);
  });
  renderBookmarks();
}
function resetFilters() {
  $("timeFilter").value = "7";
  $("publisherFilter").value = "ALL";
  $("topicFilter").value = "ALL";
  $("languageFilter").value = "ALL";
  $("searchInput").value = "";
  $("sortSelect").value = "TIME";
  render();
}
async function toggleBookmark(item) {
  const key = articleKey(item),
    index = bookmarks.findIndex((a) => articleKey(a) === key);
  if (index >= 0) bookmarks.splice(index, 1);
  else if (bookmarks.length >= 1000) {
    status("收藏已达 1000 条，请先导出并整理收藏。", "error");
    return;
  } else bookmarks.push({ ...item });
  await persist();
  render();
}
function renderBookmarks() {
  const list = $("bookmarkList");
  list.replaceChildren();
  if (!bookmarks.length)
    list.append(empty("暂无收藏", "在新闻卡片上点击“收藏”。"));
  else
    bookmarks
      .slice()
      .sort((a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt))
      .forEach((a) => list.append(renderCard(a, true)));
}
function explainError(error) {
  return error.name === "AbortError"
    ? "请求超时"
    : String(error.message || error);
}
function busy(value) {
  syncing = value;
  $("syncBtn").disabled = value;
  $("customFetchBtn").disabled = value;
  document
    .querySelectorAll("[data-fetch-channel]")
    .forEach((b) => (b.disabled = value));
  $("syncBtn").textContent = value ? "正在采集…" : "刷新新闻";
}
async function syncNews(custom = null, channel = null) {
  if (syncing) return;
  const query = custom === null ? null : String(custom).trim();
  if (custom !== null && (!query || query.length > 300)) {
    status("请输入 1 至 300 个字符的检索词。", "error");
    return;
  }
  busy(true);
  tab("feed");
  status("正在读取公开 RSS；逐条检查真实日期与文章来源…");
  try {
    const jobs =
      query !== null
        ? [{ id: "custom", name: "自定义主题" }]
        : channel
          ? CHANNELS.filter((c) => c.id === channel)
          : CHANNELS;
    const results = await Promise.allSettled(
      jobs.map(async (job) => {
        const data = await fetchFeed(job.id, query || "");
        if (
          data.app !== "public-news-reader-extension-v1" ||
          !Array.isArray(data.items)
        )
          throw Error("订阅数据格式不正确");
        return data;
      }),
    );
    let successful = 0,
      added = 0,
      received = 0,
      discarded = 0;
    const failures = [],
      report = [],
      known = new Set(articles.map(articleKey)),
      incoming = [];
    results.forEach((result, index) => {
      if (result.status === "rejected") {
        failures.push(jobs[index].name + "：" + explainError(result.reason));
        return;
      }
      successful++;
      const data = result.value;
      let valid = 0;
      data.items.forEach((raw) => {
        const item = normalize(raw);
        if (!item || !inWindow(item)) {
          discarded++;
          return;
        }
        incoming.push(item);
        valid++;
        received++;
        if (!known.has(articleKey(item))) {
          known.add(articleKey(item));
          added++;
        }
      });
      discarded += Object.values(data.rejected || {}).reduce(
        (sum, v) => sum + (Number(v) || 0),
        0,
      );
      report.push(jobs[index].name + " " + valid + " 条" + "");
    });
    articles = unique([...articles, ...incoming])
      .filter((a) => inWindow(a))
      .sort((a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt))
      .slice(0, 600);
    bookmarks = bookmarks.map((b) => {
      const update = incoming.find((a) => articleKey(a) === articleKey(b));
      return update ? mergeArticle(b, update) : b;
    });
    if (successful) {
      lastSync = new Date().toISOString();
      await persist();
    }
    rebuildPublishers();
    render();
    const summary = successful
      ? "采集完成 " +
        successful +
        "/" +
        jobs.length +
        " 个通道，收到 " +
        received +
        " 条有效记录，新增 " +
        added +
        " 条；排除 " +
        discarded +
        " 条重复、无效日期或来源不符记录。\n" +
        report.join("；")
      : "本次所有通道均采集失败；保留已有缓存，未校验成功的条目不会伪装成新新闻。";
    status(
      summary +
        (initialStorageIssue ? "\n" + initialStorageIssue : "") +
        (failures.length ? "\n失败通道：" + failures.join("；") : "") +
        (successful && !lastResults.length
          ? "\n当前筛选没有结果，可重置筛选查看本次采集。"
          : ""),
      !successful ? "error" : failures.length ? "info" : "success",
    );
    initialStorageIssue = "";
  } catch (error) {
    status(
      "采集失败：" + explainError(error) + "。已有新闻与收藏保留。",
      "error",
    );
  } finally {
    busy(false);
  }
}
async function resolveOriginal(item) {
  if (pendingResolution.has(item.id)) return;
  pendingResolution.add(item.id);
  render();
  try {
    const data = await resolveOriginalUrl(item);
    const url = usableArticleUrl(data.url);
    const domain = host(item.publisherUrl).replace(/^www\./, "");
    if (!url || !domain || isAggregator(url) || !under(host(url), domain))
      throw Error("解析地址与 RSS 标注的发布站域名不符");
    const update = (article) =>
      articleKey(article) === articleKey(item)
        ? { ...article, originalUrl: url, linkKind: "publisher" }
        : article;
    articles = articles.map(update);
    bookmarks = bookmarks.map(update);
    await persist();
    status(
      "已取得与 RSS 来源域名匹配的文章地址，可以点击“打开原站文章”。未逐篇核验全文。",
      "success",
    );
  } catch (error) {
    status(
      "原文地址未能解析：" +
        explainError(error) +
        "。仍可使用该条 Google News 跳转链接。",
      "error",
    );
  } finally {
    pendingResolution.delete(item.id);
    render();
  }
}
function download(content, type, name) {
  const url = URL.createObjectURL(new Blob([content], { type })),
    a = el("a");
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function mdText(value) {
  return String(value || "")
    .replace(/\\/g, "\\\\")
    .replace(/([\[\]*_`<>#|])/g, "\\$1")
    .replace(/[\r\n]+/g, " ");
}
function markdown(list) {
  let text =
    "# 公开新闻阅读清单\n\n生成时间：" +
    dateText(new Date()) +
    "\n\n来源与发布时间来自 RSS；原英文标题保留，未自动生成摘要或投资判断。\n\n";
  list.forEach((a, i) => {
    text +=
      "## " +
      (i + 1) +
      ". " +
      mdText(a.title) +
      "\n\n- RSS 标注来源：" +
      mdText(a.publisher) +
      "\n- 发布时间：" +
      dateText(a.publishedAt) +
      "\n- 采集时间：" +
      (a.collectedAt ? dateText(a.collectedAt) : "未提供") +
      "\n- 阅读链接（" +
      (a.originalUrl
        ? "原站文章，域名匹配"
        : isAggregator(a.url)
          ? "Google News 跳转"
          : "导入链接，未联网核验") +
      "）：[打开报道](<" +
      (a.originalUrl || a.url).replace(/[<>]/g, (c) => encodeURIComponent(c)) +
      ">)\n";
    if (a.publisherUrl)
      text +=
        "- 来源站点：[发布站](<" +
        a.publisherUrl.replace(/[<>]/g, (c) => encodeURIComponent(c)) +
        ">)\n";
    if (a.originalUrl)
      text +=
        "- RSS 条目：[Google News / 订阅条目](<" +
        a.url.replace(/[<>]/g, (c) => encodeURIComponent(c)) +
        ">)\n";
    text += "\n";
  });
  return text;
}
function exportMarkdown(onlyBookmarks = false) {
  const list = onlyBookmarks ? bookmarks.slice() : filteredArticles();
  if (!list.length) {
    status("当前没有可导出的新闻。", "info");
    return;
  }
  download(
    markdown(list),
    "text/markdown;charset=utf-8",
    "新闻" +
      (onlyBookmarks ? "收藏" : "筛选清单") +
      "-" +
      new Date().toISOString().slice(0, 10) +
      ".md",
  );
}
function parseFeed(xml) {
  if (/<!DOCTYPE|<!ENTITY/i.test(xml))
    throw Error("不支持带文档类型或实体声明的订阅文件");
  const doc = new DOMParser().parseFromString(xml, "application/xml");
  if (doc.querySelector("parsererror")) throw Error("RSS / Atom XML 格式错误");
  if (!["rss", "feed", "RDF"].includes(doc.documentElement.localName))
    throw Error("文件不是 RSS / Atom");
  return [...doc.querySelectorAll("item, entry")].map((node) => {
    const child = (name) =>
        [...node.children].find((n) => n.localName === name),
      get = (name) => child(name)?.textContent.trim() || "";
    const source = child("source");
    let url = get("link");
    if (node.localName === "entry") {
      const alternate = [...node.children].find(
        (n) =>
          n.localName === "link" &&
          (!n.getAttribute("rel") || n.getAttribute("rel") === "alternate"),
      );
      url = alternate?.getAttribute("href") || "";
    }
    return {
      title: get("title"),
      url,
      publisher: source
        ? source.querySelector("title")?.textContent ||
          source.textContent ||
          "来源未标注"
        : "来源未标注",
      publisherUrl:
        source?.getAttribute("url") ||
        source?.querySelector("link")?.getAttribute("href") ||
        "",
      publishedAt: parseDate(get("pubDate") || get("published")),
      collectedAt: new Date().toISOString(),
      channel: "离线导入",
      imported: true,
    };
  });
}
async function importFile(file) {
  if (!file) return;
  try {
    if (file.size > 5 * 1024 * 1024) throw Error("文件不能超过 5 MB");
    const text = await file.text();
    let rawItems = [],
      rawBookmarks = [];
    if (text.trim().startsWith("{") || text.trim().startsWith("[")) {
      const data = JSON.parse(text);
      if (Array.isArray(data)) rawItems = data;
      else {
        rawItems = data.articles || data.items;
        if (!Array.isArray(rawItems))
          throw Error("JSON 必须包含 articles 或 items 数组");
        rawBookmarks = Array.isArray(data.bookmarks) ? data.bookmarks : [];
      }
    } else rawItems = parseFeed(text);
    const mapped = rawItems
        .map((a) => normalize({ ...a, imported: true }))
        .filter(Boolean),
      valid = mapped.filter((a) => inWindow(a)),
      saved = rawBookmarks
        .map((a) => normalize({ ...a, imported: true }))
        .filter(Boolean);
    articles = unique([...articles, ...valid])
      .filter((a) => inWindow(a))
      .slice(0, 600);
    bookmarks = unique([...bookmarks, ...saved]).slice(0, 1000);
    await persist();
    rebuildPublishers();
    render();
    tab("feed");
    status(
      "离线导入完成：" +
        valid.length +
        " 条近 7 天新闻，" +
        saved.length +
        " 条收藏；排除 " +
        (rawItems.length - valid.length) +
        " 条无效或超期记录。未联网核验这些条目。",
      "success",
    );
  } catch (error) {
    status("导入失败：" + explainError(error), "error");
  } finally {
    $("importFile").value = "";
  }
}
function openSearch(query) {
  query = (query || $("customQuery").value).trim();
  const params = new URLSearchParams({
    q: "(" + query + ") when:7d",
    hl: "zh-CN",
    gl: "CN",
    ceid: "CN:zh-Hans",
  });
  window.open(
    "https://news.google.com/search?" + params,
    "_blank",
    "noopener,noreferrer",
  );
}
async function init() {
  await loadState();
  TOPICS.forEach((t) => $("topicFilter").add(new Option(t.name, t.id)));
  $("topicFilter").add(new Option("其他主题", "OTHER"));
  document
    .querySelectorAll("[data-tab]")
    .forEach((b) => b.addEventListener("click", () => tab(b.dataset.tab)));
  [
    "timeFilter",
    "publisherFilter",
    "topicFilter",
    "languageFilter",
    "sortSelect",
  ].forEach((id) => $(id).addEventListener("change", render));
  $("searchInput").addEventListener("input", render);
  $("resetBtn").addEventListener("click", resetFilters);
  $("syncBtn").addEventListener("click", () => syncNews());
  $("customFetchBtn").addEventListener("click", () =>
    syncNews($("customQuery").value),
  );
  $("customQuery").addEventListener("keydown", (event) => {
    if (event.key === "Enter") syncNews($("customQuery").value);
  });
  $("openSearchBtn").addEventListener("click", () => openSearch());
  $("bookmarksBtn").addEventListener("click", () => {
    renderBookmarks();
    $("bookmarkDialog").showModal();
  });
  $("closeBookmarksBtn").addEventListener("click", () =>
    $("bookmarkDialog").close(),
  );
  $("bookmarkDialog").addEventListener("click", (event) => {
    if (event.target === $("bookmarkDialog")) {
      const r = $("bookmarkDialog").getBoundingClientRect();
      if (
        event.clientX < r.left ||
        event.clientX > r.right ||
        event.clientY < r.top ||
        event.clientY > r.bottom
      )
        $("bookmarkDialog").close();
    }
  });
  $("clearBookmarksBtn").addEventListener("click", async () => {
    bookmarks = [];
    await persist();
    render();
  });
  $("exportBtn").addEventListener("click", () => exportMarkdown());
  $("exportBookmarksBtn").addEventListener("click", () => exportMarkdown(true));
  $("backupBtn").addEventListener("click", () =>
    download(
      JSON.stringify({ version: 2, articles, bookmarks, lastSync }, null, 2),
      "application/json;charset=utf-8",
      "新闻阅读台备份.json",
    ),
  );
  $("importFile").addEventListener("change", (e) =>
    importFile(e.target.files[0]),
  );
  $("themeBtn").addEventListener("click", () => {
    const light = document.documentElement.dataset.theme !== "light";
    document.documentElement.dataset.theme = light ? "light" : "dark";
    $("themeBtn").textContent = light ? "深色" : "浅色";
  });
  CHANNELS.forEach((channel) => {
    const row = el("div", undefined, "notice"),
      top = el("div", undefined, "row");
    top.append(el("strong", channel.name));
    const fetchButton = el("button", "采集此通道", "small subtle");
    fetchButton.dataset.fetchChannel = channel.id;
    fetchButton.addEventListener("click", () => syncNews(null, channel.id));
    const search = el("button", "查看搜索", "small subtle");
    search.addEventListener("click", () => openSearch(channel.query));
    top.append(fetchButton, search);
    row.append(top, el("p", channel.query, "small muted word-break"));
    $("channelList").append(row);
  });
  rebuildPublishers();
  render();
  $("liveClock").textContent = "页面打开：" + dateText(new Date());
  collectorReady = true;
  $("backendState").textContent =
    "扩展直接读取公开 RSS。每次打开本页、按 F5 或点击刷新按钮时采集一次；不设置后台或定时采集。";
  await syncNews();
}
window.addEventListener("DOMContentLoaded", init);
