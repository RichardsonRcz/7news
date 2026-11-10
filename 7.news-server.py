#!/usr/bin/env python3
"""Local public-news reader. Standard library only; serves only 7.html and its API."""
import argparse
import hashlib
import html
import json
import re
import threading
import time
import webbrowser
import xml.etree.ElementTree as ET
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import parse_qs, urlencode, urlsplit, urlunsplit
from urllib.request import Request, build_opener, HTTPRedirectHandler

APP = 'public-news-reader-v2'
HERE = Path(__file__).resolve().parent
CHANNELS = {
    'official': ('官方发布', '(site:gov.cn OR site:news.cn) (政策 OR 国务院 OR 经济) when:7d', 'zh', ('gov.cn', 'news.cn')),
    'reuters': ('Reuters', 'site:reuters.com (China OR Beijing OR PBOC) when:7d', 'en', ('reuters.com',)),
    'bloomberg': ('Bloomberg', 'site:bloomberg.com (China OR Beijing OR economy) when:7d', 'en', ('bloomberg.com',)),
    'policy': ('政策与产业', '(财政部 OR 卫健委 OR 工信部 OR 科技 OR 能源) 政策 when:7d', 'zh', ()),
}
LOCK = threading.RLock()
CACHE = {}
ARTICLES = {}
RESOLVED = {}
MAX_BYTES = 3 * 1024 * 1024


def public_url(value):
    try:
        p = urlsplit(str(value).strip())
        if p.scheme not in ('http', 'https') or not p.hostname or p.username or p.password:
            return ''
        if any(ord(c) < 32 for c in str(value)):
            return ''
        return urlunsplit((p.scheme, p.netloc, p.path, p.query, ''))
    except (ValueError, TypeError):
        return ''


def host(url):
    try:
        return (urlsplit(url).hostname or '').lower().rstrip('.')
    except ValueError:
        return ''


def under(name, suffix):
    return name == suffix or name.endswith('.' + suffix)


def canonical(url):
    p = urlsplit(url)
    if p.hostname == 'news.google.com':
        return urlunsplit((p.scheme, p.netloc, p.path, '', ''))
    return urlunsplit((p.scheme, p.netloc, p.path, p.query, ''))


def article_id(url):
    return 'article-' + hashlib.sha256(canonical(url).encode()).hexdigest()[:24]


class GoogleRedirects(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        # Network requests stay on Google. Resolving a URL does not fetch the publisher page.
        target = public_url(newurl)
        if host(target) not in ('news.google.com', 'www.google.com', 'consent.google.com'):
            raise ValueError('Google request redirected outside the allowed hosts')
        return super().redirect_request(req, fp, code, msg, headers, target)


def google_request(url, data=None):
    if host(url) != 'news.google.com':
        raise ValueError('Only Google News endpoints are supported')
    headers = {'User-Agent': 'Mozilla/5.0 (compatible; LocalPublicNewsReader/2.0)', 'Accept-Encoding': 'identity'}
    if data is not None:
        headers['Content-Type'] = 'application/x-www-form-urlencoded;charset=UTF-8'
    req = Request(url, data=data, headers=headers)
    with build_opener(GoogleRedirects()).open(req, timeout=15) as response:
        payload = response.read(MAX_BYTES + 1)
        if len(payload) > MAX_BYTES:
            raise ValueError('Feed response exceeds size limit')
        return payload.decode('utf-8-sig'), response.geturl()


def publication_date(value):
    try:
        result = parsedate_to_datetime(value)
        if result.tzinfo is None:
            return None
        return result.astimezone(timezone.utc)
    except (TypeError, ValueError, OverflowError, IndexError):
        return None


def load_feed(channel, query=''):
    if channel == 'custom':
        query = query.strip()
        if not query or len(query) > 300:
            raise ValueError('Search query must contain 1 to 300 characters')
        # The actual publication date still controls eligibility, regardless of search operators.
        spec = ('自定义检索', '(' + query + ') when:7d', 'en' if not re.search(r'[\u3400-\u9fff]', query) else 'zh', ())
    elif channel in CHANNELS:
        spec = CHANNELS[channel]
    else:
        raise ValueError('Unknown news channel')
    key = (channel, query)
    now = time.time()
    with LOCK:
        cached = CACHE.get(key)
        if cached and now - cached[0] < 180:
            return dict(cached[1], cached=True)
    name, search, lang, allowed = spec
    locale = {'hl': 'zh-CN', 'gl': 'CN', 'ceid': 'CN:zh-Hans'} if lang == 'zh' else {'hl': 'en-US', 'gl': 'US', 'ceid': 'US:en'}
    feed_url = 'https://news.google.com/rss/search?' + urlencode(dict(q=search, **locale))
    text, _ = google_request(feed_url)
    if '<!DOCTYPE' in text.upper() or '<!ENTITY' in text.upper():
        raise ValueError('Unexpected XML document type')
    root = ET.fromstring(text)
    if root.tag != 'rss' or root.find('channel') is None:
        raise ValueError('Response is not a Google News RSS feed')
    collected = datetime.now(timezone.utc).isoformat()
    records, rejected = [], {'date': 0, 'source': 0, 'invalid': 0, 'duplicate': 0}
    seen = set()
    for entry in root.findall('./channel/item'):
        title = (entry.findtext('title') or '').strip()
        url = public_url(entry.findtext('link') or '')
        published = publication_date(entry.findtext('pubDate'))
        if not title or not url or host(url) != 'news.google.com' or not re.match(r'^/(rss/)?articles/[^/]+$', urlsplit(url).path):
            rejected['invalid'] += 1
            continue
        if published is None or not 0 <= now - published.timestamp() <= 7 * 86400:
            rejected['date'] += 1
            continue
        source = entry.find('source')
        publisher_name = (source.text or '').strip() if source is not None else ''
        publisher_url = public_url(source.get('url', '')) if source is not None else ''
        if allowed and not any(under(host(publisher_url), suffix) for suffix in allowed):
            rejected['source'] += 1
            continue
        identity = article_id(url)
        if identity in seen:
            rejected['duplicate'] += 1
            continue
        seen.add(identity)
        record = {'id': identity, 'title': title[:2000], 'url': canonical(url),
                  'publisher': publisher_name or '来源未标注', 'publisherUrl': publisher_url,
                  'publishedAt': published.isoformat(), 'collectedAt': collected,
                  'channel': name, 'feedUrl': feed_url, 'linkKind': 'aggregator'}
        with LOCK:
            ARTICLES[identity] = record
            known = RESOLVED.get(identity)
        if known and publisher_url and under(host(known), re.sub(r'^www\.', '', host(publisher_url))):
            record = dict(record, originalUrl=known, linkKind='publisher')
        elif known:
            with LOCK:
                RESOLVED.pop(identity, None)
        records.append(record)
    result = {'app': APP, 'items': records, 'channel': name, 'feedUrl': feed_url,
              'collectedAt': collected, 'cached': False, 'rejected': rejected}
    with LOCK:
        CACHE[key] = (now, result)
        # Bound process memory without discarding links needed by recent requests.
        if len(CACHE) > 80:
            CACHE.pop(next(iter(CACHE)))
        while len(ARTICLES) > 6000:
            ARTICLES.pop(next(iter(ARTICLES)))
    return result


def rpc_urls(text):
    decoder = json.JSONDecoder()
    for match in re.finditer(r'(?m)^\s*(?=\[)', text):
        try:
            data, _ = decoder.raw_decode(text[match.end():])
        except (ValueError, TypeError):
            continue
        stack = [data]
        while stack:
            value = stack.pop()
            if isinstance(value, list):
                if value and value[0] == 'garturlres' and len(value) > 1 and isinstance(value[1], str):
                    yield value[1]
                for cell in value:
                    if isinstance(cell, list):
                        stack.append(cell)
                    elif isinstance(cell, str) and cell.startswith('["garturlres"'):
                        try:
                            stack.append(json.loads(cell))
                        except ValueError:
                            pass


def resolve_article(identity):
    with LOCK:
        item = ARTICLES.get(identity)
        known = RESOLVED.get(identity)
    if item is None:
        raise ValueError('Article is not in this session; refresh its news channel first')
    if known:
        return {'url': known, 'linkKind': 'publisher'}
    source_host = host(item['publisherUrl'])
    if not source_host:
        raise ValueError('Publisher domain is missing; original URL cannot be checked')
    encoded = urlsplit(item['url']).path.rsplit('/', 1)[-1]
    page, _ = google_request('https://news.google.com/rss/articles/' + encoded + '?hl=en-US&gl=US&ceid=US:en')
    sig = re.search(r'data-n-a-sg=[\"\x27]([^\"\x27]+)', page)
    stamp = re.search(r'data-n-a-ts=[\"\x27](\d+)', page)
    if not sig or not stamp:
        raise ValueError('Google did not provide original-link decoding parameters')
    context = [['X', 'X', ['X', 'X'], None, None, 1, 1, 'US:en', None, 1, None, None, None, None, None, 0, 1],
               'X', 'X', 1, [1, 1, 1], 1, 1, None, 0, 0, None, 0]
    request = ['garturlreq', context, encoded, int(stamp.group(1)), html.unescape(sig.group(1))]
    body = urlencode({'f.req': json.dumps([[['Fbv4je', json.dumps(request), None, 'generic']]])}).encode()
    response, _ = google_request('https://news.google.com/_/DotsSplashUi/data/batchexecute?rpcids=Fbv4je', body)
    base_host = source_host.removeprefix('www.') if hasattr(source_host, 'removeprefix') else re.sub(r'^www\.', '', source_host)
    for candidate in rpc_urls(response):
        url = public_url(candidate)
        if url and under(host(url), base_host) and urlsplit(url).path not in ('', '/'):
            with LOCK:
                RESOLVED[identity] = url
                if len(RESOLVED) > 6000:
                    RESOLVED.pop(next(iter(RESOLVED)))
            return {'url': url, 'linkKind': 'publisher'}
    raise ValueError('Decoded URL is missing or does not match the RSS publisher domain')


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def send(self, status, payload, content_type='application/json; charset=utf-8'):
        if not isinstance(payload, bytes):
            payload = json.dumps(payload, ensure_ascii=False).encode('utf-8')
        self.send_response(status)
        self.send_header('Content-Type', content_type)
        self.send_header('Content-Length', str(len(payload)))
        self.send_header('Cache-Control', 'no-store')
        self.send_header('X-Content-Type-Options', 'nosniff')
        self.send_header('Referrer-Policy', 'no-referrer')
        self.end_headers()
        self.wfile.write(payload)

    def do_GET(self):
        expected = '127.0.0.1:' + str(self.server.server_port)
        if self.headers.get('Host') != expected:
            self.send(403, {'error': 'Unexpected Host header'})
            return
        origin = self.headers.get('Origin')
        if origin and origin != 'http://' + expected:
            self.send(403, {'error': 'Open this page from its local launch address'})
            return
        p = urlsplit(self.path)
        args = parse_qs(p.query)
        try:
            if p.path in ('/', '/7.html'):
                self.send(200, (HERE / '7.html').read_bytes(), 'text/html; charset=utf-8')
            elif p.path == '/api/health':
                self.send(200, {'app': APP})
            elif p.path == '/api/feeds':
                self.send(200, load_feed(args.get('channel', [''])[0], args.get('query', [''])[0]))
            elif p.path == '/api/resolve':
                self.send(200, resolve_article(args.get('id', [''])[0]))
            elif p.path == '/favicon.ico':
                self.send(204, b'')
            else:
                self.send(404, {'error': 'Not found'})
        except (BrokenPipeError, ConnectionResetError):
            pass
        except (HTTPError, URLError, TimeoutError, OSError, ValueError, ET.ParseError) as exc:
            self.send(502, {'error': str(exc)[:400]})


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--port', type=int, default=8767)
    parser.add_argument('--no-browser', action='store_true')
    options = parser.parse_args()
    if not (HERE / '7.html').is_file():
        parser.error('Keep 7.html in the same folder as this script')
    try:
        server = ThreadingHTTPServer(('127.0.0.1', options.port), Handler)
    except OSError as exc:
        parser.exit(1, 'Cannot start local news reader: %s\n' % exc)
    address = 'http://127.0.0.1:%d/7.html' % server.server_port
    print('Public News Reader: ' + address + '\nPress Ctrl+C to stop.', flush=True)
    if not options.no_browser:
        webbrowser.open(address)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == '__main__':
    main()
