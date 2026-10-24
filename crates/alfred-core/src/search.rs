//! Search router: Ceramic ($0.25/1k) -> Exa Lite ($4/1k) -> Exa auto ($7/1k).
//!
//! The Workers still do the HTTP (Ceramic via the Web Search API, Lite via the AI Gateway
//! custom provider, auto via the Web Search API). Every routing decision, thinness check,
//! Lite request shape and Lite result map lives here.
use regex_lite::Regex;
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::sync::OnceLock;

pub const MIN_GOOD_RESULTS: usize = 3;
pub const MIN_TERM_COVERAGE: f64 = 0.5;
pub const PRICE_CERAMIC: f64 = 0.25;
pub const PRICE_EXA_LITE: f64 = 4.0;
pub const PRICE_EXA: f64 = 7.0;

const STOP: &str = "a an and are as at be by for from how i in is it of on or that the this to was what when where which who why with you your";

fn deep_patterns() -> &'static [Regex] {
    static P: OnceLock<Vec<Regex>> = OnceLock::new();
    P.get_or_init(|| {
        [
            r"(?i)\b(research|in[- ]depth|deep dive|comprehensive|literature|survey|state of the art|sota)\b",
            r"(?i)\b(paper|papers|arxiv|doi|study|studies|peer[- ]reviewed|citation)\b",
            r"(?i)\b(ceo|founder|cto|linkedin|who (is|runs|founded)|biography|net worth)\b",
            r"(?i)\b(company|companies|startup|competitors?|funding|series [a-e]|acquisition|revenue|valuation)\b",
            r"(?i)\b(github|repo|repository|library|sdk|source code|implementation of)\b",
            r"(?i)\b(10-k|10-q|earnings|sec filing|annual report|market cap)\b",
            r"(?i)\b(compare|comparison|alternatives? to|vs\.?|versus)\b",
        ]
        .iter()
        .map(|p| Regex::new(p).unwrap())
        .collect()
    })
}

pub fn query_terms(query: &str) -> Vec<String> {
    static T: OnceLock<Regex> = OnceLock::new();
    let re = T.get_or_init(|| Regex::new(r"[a-z0-9][a-z0-9.+#-]*").unwrap());
    let stop: HashSet<&str> = STOP.split(' ').collect();
    let lower = query.to_lowercase();
    let mut seen = HashSet::new();
    let mut out = Vec::new();
    for m in re.find_iter(&lower) {
        let t = m.as_str();
        if seen.insert(t.to_string()) && t.len() > 1 && !stop.contains(t) {
            out.push(t.to_string());
        }
    }
    out
}

pub fn wants_deep(query: &str) -> bool {
    static Q: OnceLock<Regex> = OnceLock::new();
    if deep_patterns().iter().any(|r| r.is_match(query)) {
        return true;
    }
    if Q.get_or_init(|| Regex::new(r#""[^"]{3,}""#).unwrap()).is_match(query) {
        return true;
    }
    query_terms(query).len() >= 12
}

#[derive(Deserialize, Serialize, Default, Clone)]
pub struct Item {
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub url: String,
}

pub fn term_coverage(query: &str, items: &[Item]) -> f64 {
    let terms = query_terms(query);
    if terms.is_empty() {
        return 1.0;
    }
    let text = items
        .iter()
        .map(|i| format!("{} {} {}", i.title, i.description.clone().unwrap_or_default(), i.url))
        .collect::<Vec<_>>()
        .join(" ")
        .to_lowercase();
    terms.iter().filter(|t| text.contains(t.as_str())).count() as f64 / terms.len() as f64
}

pub fn is_thin(query: &str, items: &[Item]) -> bool {
    items.len() < MIN_GOOD_RESULTS || term_coverage(query, items) < MIN_TERM_COVERAGE
}

// ─── Parallel search: Ceramic + Exa at once, fused by reciprocal rank ─────────

/// RRF constant (Cormack et al. 2009): rank r contributes 1/(K + r).
pub const RRF_K: f64 = 60.0;

/// Canonical URL for dedup: lower-case scheme/host, http->https, no www., no fragment, no
/// trailing slash, tracking params (utm_*, gclid, fbclid, ref) dropped.
pub fn canonical_url(u: &str) -> String {
    let u = u.trim();
    let u = u.split('#').next().unwrap_or(u);
    let (scheme_host, rest) = match u.find("://") {
        Some(i) => {
            let after = &u[i + 3..];
            let cut = after.find(['/', '?']).unwrap_or(after.len());
            (format!("https://{}", after[..cut].to_ascii_lowercase().trim_start_matches("www.")), &after[cut..])
        }
        None => return u.to_ascii_lowercase(),
    };
    let (path, query) = match rest.split_once('?') {
        Some((p, q)) => (p, q),
        None => (rest, ""),
    };
    let kept: Vec<&str> = query
        .split('&')
        .filter(|kv| !kv.is_empty())
        .filter(|kv| {
            let k = kv.split('=').next().unwrap_or("").to_ascii_lowercase();
            !(k.starts_with("utm_") || k == "gclid" || k == "fbclid" || k == "ref")
        })
        .collect();
    let path = path.trim_end_matches('/');
    if kept.is_empty() { format!("{scheme_host}{path}") } else { format!("{scheme_host}{path}?{}", kept.join("&")) }
}

#[derive(Deserialize)]
pub struct ProviderList {
    pub provider: String,
    #[serde(default)]
    pub items: Vec<Item>,
}

/// Merge provider result lists: dedup by canonical URL, score by summed RRF, keep the first
/// title and the longest description, record which providers returned each URL.
pub fn fuse(lists: &[ProviderList], limit: usize) -> serde_json::Value {
    struct Acc { item: Item, score: f64, providers: Vec<String>, first: usize }
    let mut acc: Vec<(String, Acc)> = vec![];
    let mut order = 0usize;
    for l in lists {
        let mut seen: Vec<String> = vec![];
        for (rank, it) in l.items.iter().enumerate() {
            if it.url.trim().is_empty() { continue; }
            let key = canonical_url(&it.url);
            if seen.contains(&key) { continue; }
            seen.push(key.clone());
            let add = 1.0 / (RRF_K + rank as f64 + 1.0);
            match acc.iter_mut().find(|(k, _)| *k == key) {
                Some((_, a)) => {
                    a.score += add;
                    if !a.providers.contains(&l.provider) { a.providers.push(l.provider.clone()); }
                    let d = it.description.clone().unwrap_or_default();
                    if d.len() > a.item.description.as_deref().unwrap_or("").len() { a.item.description = Some(d); }
                    if a.item.title.trim().is_empty() { a.item.title = it.title.clone(); }
                }
                None => {
                    acc.push((key, Acc { item: it.clone(), score: add, providers: vec![l.provider.clone()], first: order }));
                    order += 1;
                }
            }
        }
    }
    acc.sort_by(|a, b| b.1.score.partial_cmp(&a.1.score).unwrap().then(a.1.first.cmp(&b.1.first)));
    let items: Vec<serde_json::Value> = acc
        .iter()
        .take(limit.clamp(1, 20))
        .map(|(_, a)| serde_json::json!({ "title": a.item.title, "description": a.item.description, "url": a.item.url, "providers": a.providers, "score": (a.score * 1e6).round() / 1e6 }))
        .collect();
    serde_json::json!({ "items": items })
}

#[derive(Deserialize)]
struct FuseIn {
    lists: Vec<ProviderList>,
    #[serde(default)]
    limit: Option<usize>,
}

pub fn fuse_json(s: &str) -> Result<String, String> {
    let i: FuseIn = serde_json::from_str(s).map_err(|e| e.to_string())?;
    Ok(fuse(&i.lists, i.limit.unwrap_or(6)).to_string())
}

/// Default daily Exa searches for a kingdom that is not the default king (Hans's key and credits).
pub const KINGDOM_EXA_DAILY_DEFAULT: u32 = 20;

#[derive(Deserialize)]
struct QuotaIn {
    owner: bool,
    used: u32,
    #[serde(default)]
    cap: Option<u32>,
    has_exa: bool,
}

/// Per-kingdom Exa quota: the owner kingdom is unlimited; others get `cap` (default above) per
/// UTC day, then Ceramic only.
pub fn quota_json(s: &str) -> Result<String, String> {
    let i: QuotaIn = serde_json::from_str(s).map_err(|e| e.to_string())?;
    let cap = i.cap.unwrap_or(KINGDOM_EXA_DAILY_DEFAULT);
    let (exa, reason) = if !i.has_exa {
        (false, "no exa key configured")
    } else if i.owner {
        (true, "owner kingdom: unlimited")
    } else if i.used < cap {
        (true, "within kingdom cap")
    } else {
        (false, "kingdom over daily exa cap: ceramic only")
    };
    Ok(serde_json::json!({ "exa": exa, "reason": reason, "cap": if i.owner { serde_json::Value::Null } else { cap.into() }, "used": i.used }).to_string())
}

#[derive(Deserialize)]
struct AnalyzeIn {
    query: String,
    #[serde(default)]
    items: Vec<Item>,
}

/// terms, deep intent, coverage and thinness in one call (for tests and observability).
pub fn analyze_json(s: &str) -> Result<String, String> {
    let i: AnalyzeIn = serde_json::from_str(s).map_err(|e| e.to_string())?;
    Ok(serde_json::json!({
        "terms": query_terms(&i.query),
        "deep": wants_deep(&i.query),
        "coverage": term_coverage(&i.query, &i.items),
        "thin": is_thin(&i.query, &i.items),
    })
    .to_string())
}

#[derive(Deserialize)]
struct LiteUrlIn {
    account_id: String,
    gateway: String,
    slug: String,
}

pub fn lite_url(account_id: &str, gateway: &str, slug: &str) -> String {
    format!("https://gateway.ai.cloudflare.com/v1/{account_id}/{gateway}/custom-{slug}/search")
}

pub fn lite_url_json(s: &str) -> Result<String, String> {
    let i: LiteUrlIn = serde_json::from_str(s).map_err(|e| e.to_string())?;
    Ok(serde_json::to_string(&lite_url(&i.account_id, &i.gateway, &i.slug)).unwrap())
}

#[derive(Deserialize)]
struct LiteBodyIn {
    query: String,
    #[serde(default)]
    limit: Option<u32>,
}

pub fn lite_body(query: &str, limit: Option<u32>) -> serde_json::Value {
    let n = limit.unwrap_or(6).clamp(1, 10);
    serde_json::json!({ "query": query, "type": "lite", "numResults": n })
}

pub fn lite_body_json(s: &str) -> Result<String, String> {
    let i: LiteBodyIn = serde_json::from_str(s).map_err(|e| e.to_string())?;
    Ok(lite_body(&i.query, i.limit).to_string())
}

#[derive(Deserialize)]
struct ExaHit {
    url: String,
    #[serde(default)]
    title: Option<String>,
    #[serde(default)]
    text: Option<String>,
    #[serde(default)]
    summary: Option<String>,
    #[serde(default)]
    highlights: Option<Vec<String>>,
}

#[derive(Deserialize)]
struct ExaOut {
    #[serde(default)]
    #[serde(rename = "requestId")]
    request_id: Option<String>,
    #[serde(default)]
    results: Option<Vec<ExaHit>>,
}

pub fn lite_parse(raw: &str) -> Result<serde_json::Value, String> {
    let j: ExaOut = serde_json::from_str(raw).map_err(|e| e.to_string())?;
    let items: Vec<Item> = j
        .results
        .unwrap_or_default()
        .into_iter()
        .map(|x| {
            let description = x
                .summary
                .filter(|s| !s.is_empty())
                .or_else(|| x.highlights.map(|h| h.join(" ")).filter(|s| !s.is_empty()))
                .or(x.text)
                .unwrap_or_default();
            let description: String = description.chars().take(400).collect();
            Item {
                url: x.url.clone(),
                title: x.title.filter(|t| !t.is_empty()).unwrap_or_else(|| x.url.clone()),
                description: Some(description),
            }
        })
        .collect();
    Ok(serde_json::json!({
        "items": items,
        "requestId": j.request_id.unwrap_or_default(),
    }))
}

pub fn lite_parse_json(s: &str) -> Result<String, String> {
    Ok(lite_parse(s)?.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn items(n: usize, text: &str) -> Vec<Item> {
        (0..n).map(|k| Item { title: format!("{text} {k}"), description: None, url: format!("https://x/{k}") }).collect()
    }
    #[test]
    fn terms_drop_stopwords_and_dupes() {
        assert_eq!(query_terms("What is the Cloudflare Workers AI? workers"), vec!["cloudflare", "workers", "ai"]);
    }
    #[test]
    fn thin_detection() {
        let q = "cloudflare workers pricing";
        assert!(is_thin(q, &items(1, "x")));
        assert!(!is_thin(q, &items(5, "cloudflare workers pricing")));
        assert!(is_thin("tokio runtime scheduler", &items(5, "unrelated")));
        assert!(!wants_deep("weather in manila"));
        assert!(wants_deep("who founded anthropic and what is its valuation"));
    }
    #[test]
    fn lite_url_body_parse() {
        assert_eq!(lite_url("acct", "gw", "exa"), "https://gateway.ai.cloudflare.com/v1/acct/gw/custom-exa/search");
        assert_eq!(lite_body("q", Some(3)), serde_json::json!({"query":"q","type":"lite","numResults":3}));
        assert_eq!(lite_body("q", Some(0))["numResults"], 1);
        assert_eq!(lite_body("q", Some(99))["numResults"], 10);
        let parsed = lite_parse(r#"{"requestId":"x1","results":[{"url":"https://a.com","title":"A","highlights":["hi"]}]}"#).unwrap();
        assert_eq!(parsed["requestId"], "x1");
        assert_eq!(parsed["items"][0]["title"], "A");
        assert_eq!(parsed["items"][0]["description"], "hi");
    }
    #[test]
    fn rrf_dedups_and_merges() {
        let it = |t: &str, u: &str| Item { title: t.into(), description: Some(t.into()), url: u.into() };
        let lists = vec![
            ProviderList { provider: "ceramic".into(), items: vec![it("a", "https://www.A.com/x/?utm_source=z"), it("b", "https://b.com/"), it("c", "https://c.com")] },
            ProviderList { provider: "exa-lite".into(), items: vec![it("b longer", "http://b.com"), it("a", "https://a.com/x#frag"), it("d", "https://d.com")] },
        ];
        let r = fuse(&lists, 10);
        let urls: Vec<&str> = r["items"].as_array().unwrap().iter().map(|i| i["url"].as_str().unwrap()).collect();
        assert_eq!(urls.len(), 4, "a and b deduplicated across providers");
        assert_eq!(r["items"][0]["providers"].as_array().unwrap().len(), 2);
        assert!(urls[..2].iter().all(|u| { let u = u.to_lowercase(); u.contains("a.com") || u.contains("b.com") }));
        assert_eq!(canonical_url("HTTP://www.Ex.com/p/?a=1&utm_medium=x"), "https://ex.com/p?a=1");
        // One provider failed (empty list): the other's order is kept.
        let one = fuse(&[ProviderList { provider: "ceramic".into(), items: vec![it("a", "https://a.com"), it("b", "https://b.com")] }], 10);
        assert_eq!(one["items"][0]["url"], "https://a.com");
    }
    #[test]
    fn kingdom_quota() {
        let q = |s: &str| serde_json::from_str::<serde_json::Value>(&quota_json(s).unwrap()).unwrap();
        assert_eq!(q(r#"{"owner":true,"used":9999,"has_exa":true}"#)["exa"], true);
        assert_eq!(q(r#"{"owner":false,"used":19,"has_exa":true}"#)["exa"], true);
        assert_eq!(q(r#"{"owner":false,"used":20,"has_exa":true}"#)["exa"], false);
        assert_eq!(q(r#"{"owner":false,"used":3,"cap":3,"has_exa":true}"#)["exa"], false);
        assert_eq!(q(r#"{"owner":true,"used":0,"has_exa":false}"#)["exa"], false);
    }
}
