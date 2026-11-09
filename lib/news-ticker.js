// Headlines for the slideshow's news ticker, read from RSS 2.0 or Atom feeds.
// Each feed is fetched at most every CACHE_MS; a feed that fails keeps its last headlines.
// A headline's story (its first paragraphs and picture) is read from its web page when it's opened.
import axios from 'axios';
import xml2js from 'xml2js';

const CACHE_MS = 10 * 60 * 1000;
const MAX_PER_FEED = 20;
const cache = new Map(); // url -> { at, source, headlines: [{ title, link, summary, image, date }] }
const STORY_CACHE_MS = 60 * 60 * 1000;
const MAX_STORIES = 100;
const stories = new Map(); // link -> { at, story }
const USER_AGENT = 'Mozilla/5.0 (compatible; AMMUI news ticker)';

export const DEFAULT_TICKER_FEEDS = ['https://feeds.bbci.co.uk/news/rss.xml'];

// An http(s) URL, or null
export function cleanFeedUrl(value) {
    let url = String(value || '').trim();
    if (!url) return null;
    if (!/^[a-z]+:\/\//i.test(url)) url = `https://${url}`;
    try {
        const u = new URL(url);
        return ['http:', 'https:'].includes(u.protocol) ? u.href : null;
    } catch {
        return null;
    }
}

// The text of an xml2js node, whether it's a string or { _: text, $: attrs }
const text = (node) => {
    if (Array.isArray(node)) node = node[0];
    if (node == null) return '';
    if (typeof node === 'object') node = node._ ?? '';
    return String(node);
};

const decode = (s) => s
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&quot;/g, '"').replace(/&apos;|&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ').replace(/&rsquo;|&lsquo;/g, "'").replace(/&rdquo;|&ldquo;/g, '"')
    .replace(/&mdash;/g, '—').replace(/&ndash;/g, '–').replace(/&hellip;/g, '…')
    .replace(/&amp;/g, '&');

// Headlines and summaries carry plain text, but feeds and pages put HTML and entities in them
// (inline tags such as a drop cap's <span> are part of a word, so they go without leaving a space)
const plain = (s) => decode(String(s || '')
    .replace(/<\/?(?:span|a|b|i|em|strong|u|small|sup|sub|abbr|mark)\b[^>]*>/gi, '')
    .replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();

const list = (v) => (v == null ? [] : Array.isArray(v) ? v : [v]);

const httpUrl = (u) => (typeof u === 'string' && /^https?:\/\//i.test(u) ? u : '');

// The item's picture: media:content or media:thumbnail (the widest), an image enclosure, or an Atom enclosure link
function itemImage(item) {
    const media = [...list(item['media:content']), ...list(item['media:group']?.['media:content']), ...list(item['media:thumbnail'])]
        .map(m => m?.$ || {})
        .filter(a => httpUrl(a.url) && (!a.medium || a.medium === 'image') && (!a.type || a.type.startsWith('image/')))
        .sort((a, b) => (Number(b.width) || 0) - (Number(a.width) || 0));
    if (media[0]) return media[0].url;
    const enclosure = list(item.enclosure).map(e => e?.$ || {}).find(a => httpUrl(a.url) && String(a.type || '').startsWith('image/'));
    if (enclosure) return enclosure.url;
    const link = list(item.link).map(l => l?.$ || {}).find(a => a.rel === 'enclosure' && String(a.type || '').startsWith('image/'));
    return httpUrl(link?.href);
}

// RSS has <link>url</link>; Atom has <link href rel="alternate"/>
function itemLink(item) {
    for (const l of list(item.link)) {
        if (typeof l === 'string' && httpUrl(l.trim())) return l.trim();
        const a = l?.$;
        if (a && httpUrl(a.href) && (!a.rel || a.rel === 'alternate')) return a.href;
    }
    const guid = text(item.guid).trim();
    return httpUrl(guid);
}

async function readFeed(url) {
    const response = await axios.get(url, {
        timeout: 10000,
        responseType: 'text',
        maxContentLength: 5 * 1024 * 1024,
        headers: { 'User-Agent': USER_AGENT, Accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml, */*' }
    });
    const xml = await new xml2js.Parser({ explicitArray: false }).parseStringPromise(response.data);
    let source = '', items = [];
    if (xml?.rss?.channel) {
        const channel = Array.isArray(xml.rss.channel) ? xml.rss.channel[0] : xml.rss.channel;
        source = text(channel.title);
        items = list(channel.item);
    } else if (xml?.feed) {
        source = text(xml.feed.title);
        items = list(xml.feed.entry);
    } else if (xml?.['rdf:RDF']) {
        source = text(xml['rdf:RDF'].channel?.title);
        items = list(xml['rdf:RDF'].item);
    } else {
        throw new Error('Not an RSS or Atom feed');
    }
    source = plain(source).replace(/\s+-\s+.*$/, ''); // "BBC News - Home" -> "BBC News"
    const seen = new Set();
    const headlines = [];
    for (const item of items) {
        const title = plain(text(item.title));
        if (!title || seen.has(title)) continue;
        seen.add(title);
        const date = new Date(text(item.pubDate || item.published || item.updated || item['dc:date']));
        headlines.push({
            title,
            link: itemLink(item),
            summary: plain(text(item.description || item.summary || item.content)).slice(0, 1000),
            image: itemImage(item),
            date: isNaN(date) ? null : date.toISOString()
        });
        if (headlines.length >= MAX_PER_FEED) break;
    }
    return { source, headlines };
}

async function feedHeadlines(url) {
    const cached = cache.get(url);
    if (cached && Date.now() - cached.at < CACHE_MS) return cached;
    try {
        const feed = { at: Date.now(), ...(await readFeed(url)) };
        cache.set(url, feed);
        return feed;
    } catch (err) {
        console.warn(`[TICKER] ${url}: ${err.message}`);
        if (cached) {
            cached.at = Date.now() - CACHE_MS + 60 * 1000; // try again in a minute
            return cached;
        }
        return { source: '', headlines: [] };
    }
}

// [{ title, source, link, summary, image, date }] from all the feeds, taking turns so one feed doesn't fill the ticker
export async function getTickerHeadlines(urls) {
    for (const url of cache.keys()) if (!urls.includes(url)) cache.delete(url);
    const feeds = await Promise.all(urls.map(feedHeadlines));
    const out = [];
    const longest = Math.max(0, ...feeds.map(f => f.headlines.length));
    for (let i = 0; i < longest; i++) {
        for (const feed of feeds) {
            if (i < feed.headlines.length) out.push({ ...feed.headlines[i], source: feed.source });
        }
    }
    return out;
}

// The headline a link belongs to, if it's one the feeds gave (so only those pages are fetched)
function findHeadline(link) {
    for (const feed of cache.values()) {
        const headline = feed.headlines.find(h => h.link === link);
        if (headline) return { ...headline, source: feed.source };
    }
    return null;
}

const metaContent = (html, name) => {
    const tag = html.match(new RegExp(`<meta[^>]+(?:property|name)=["']${name}["'][^>]*>`, 'i'))?.[0];
    return tag ? decode(tag.match(/content=["']([^"']*)["']/i)?.[1] || '') : '';
};

// The story's opening paragraphs from its page: those in its <article> (or <main>) where it has
// one, leaving out short lines such as captions, bylines and sharing prompts
function storyParagraphs(html) {
    html = html.replace(/<(script|style|noscript|svg|figure|figcaption|aside|nav|header|footer|form)\b[\s\S]*?<\/\1>/gi, ' ');
    const region = (tag) => {
        const start = html.search(new RegExp(`<${tag}\\b`, 'i'));
        const end = html.toLowerCase().lastIndexOf(`</${tag}>`);
        return start >= 0 && end > start ? html.slice(start, end) : '';
    };
    const body = region('article') || region('main') || html;
    const paragraphs = [];
    let length = 0;
    for (const m of body.matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/gi)) {
        const p = plain(m[1]);
        if (p.length < 60 || /cookie|subscribe|sign up|newsletter|all rights reserved|copyright|©/i.test(p)) continue;
        if (paragraphs.includes(p)) continue;
        paragraphs.push(p);
        length += p.length;
        if (paragraphs.length >= 8 || length > 2000) break;
    }
    return paragraphs;
}

// { title, source, link, summary, image, date, paragraphs } for a headline's link, or null if the
// link isn't one of the ticker's. Without the page, paragraphs is empty and the feed's summary stands.
export async function getTickerStory(link) {
    const headline = findHeadline(link);
    if (!headline) return null;
    const cached = stories.get(link);
    if (cached && Date.now() - cached.at < STORY_CACHE_MS) return cached.story;
    const story = { ...headline, paragraphs: [] };
    try {
        const response = await axios.get(link, {
            timeout: 10000,
            responseType: 'text',
            maxContentLength: 5 * 1024 * 1024,
            maxRedirects: 5,
            headers: { 'User-Agent': USER_AGENT, Accept: 'text/html,application/xhtml+xml' }
        });
        const html = String(response.data || '');
        story.paragraphs = storyParagraphs(html);
        const image = httpUrl(metaContent(html, 'og:image'));
        if (image) story.image = image; // the page's picture is bigger than the feed's thumbnail
        // Some feeds' summaries run on into the story itself, so with the story to hand the page's own
        // short description is used, and a paragraph that only repeats it is left out
        const description = plain(metaContent(html, 'og:description'));
        if (description && (story.paragraphs.length || !story.summary)) story.summary = description;
        const key = (s) => s.toLowerCase().replace(/\W+/g, '');
        story.paragraphs = story.paragraphs.filter(p => key(p) !== key(story.summary));
    } catch (err) {
        console.warn(`[TICKER] Story ${link}: ${err.message}`);
    }
    stories.set(link, { at: Date.now(), story });
    while (stories.size > MAX_STORIES) stories.delete(stories.keys().next().value);
    return story;
}
