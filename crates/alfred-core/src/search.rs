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

/// Prefer the set with at least as many items (Lite/auto escalation keeps the denser page).
pub fn pick_better<'a>(a: &'a [Item], b: &'a [Item]) -> &'a [Item] {
    if b.len() >= a.len() { b } else { a }
}

#[derive(Deserialize)]
pub struct PlanIn {
    pub query: String,
    /// "start" | "after_ceramic" | "after_lite" | "after_exa"
    pub stage: String,
    #[serde(default)]
    pub items: Vec<Item>,
    #[serde(default)]
    pub failed: bool,
    pub has_lite: bool,
    pub has_exa: bool,
    pub under_cap: bool,
}

#[derive(Serialize, PartialEq, Debug)]
pub struct Plan {
    /// "ceramic" | "exa-lite" | "exa" | "return"
    pub action: &'static str,
    pub reason: &'static str,
    /// "throw" when a failed fetch should surface (deep-intent Exa at start); else "continue".
    pub on_fail: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub served: Option<&'static str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub next_stage: Option<&'static str>,
}

fn p(action: &'static str, reason: &'static str, on_fail: &'static str, served: Option<&'static str>, next_stage: Option<&'static str>) -> Plan {
    Plan { action, reason, on_fail, served, next_stage }
}

pub fn plan(i: &PlanIn) -> Plan {
    let exa_ok = i.has_exa && i.under_cap;
    let lite_ok = i.has_lite && i.under_cap;
    match i.stage.as_str() {
        "start" if exa_ok && wants_deep(&i.query) => p("exa", "deep_intent", "throw", None, Some("after_exa")),
        "start" => p("ceramic", "default", "continue", None, Some("after_ceramic")),
        "after_ceramic" if !is_thin(&i.query, &i.items) => p("return", "default", "continue", Some("ceramic"), None),
        "after_ceramic" if lite_ok => p("exa-lite", "ceramic_thin", "continue", None, Some("after_lite")),
        "after_ceramic" if exa_ok => p("exa", "ceramic_thin", "continue", None, Some("after_exa")),
        "after_lite" if !i.failed && !is_thin(&i.query, &i.items) => p("return", "lite_ok", "continue", Some("exa-lite"), None),
        "after_lite" if exa_ok => p("exa", "lite_thin", "continue", None, Some("after_exa")),
        _ => p("return", "best_so_far", "continue", None, None),
    }
}

pub fn plan_json(s: &str) -> Result<String, String> {
    let i: PlanIn = serde_json::from_str(s).map_err(|e| e.to_string())?;
    Ok(serde_json::to_string(&plan(&i)).unwrap())
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

#[derive(Deserialize)]
struct BetterIn {
    a: Vec<Item>,
    b: Vec<Item>,
}

pub fn better_json(s: &str) -> Result<String, String> {
    let i: BetterIn = serde_json::from_str(s).map_err(|e| e.to_string())?;
    let pick = if pick_better(&i.a, &i.b).as_ptr() == i.b.as_ptr() || i.b.len() >= i.a.len() { "b" } else { "a" };
    Ok(serde_json::json!({ "pick": pick }).to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn items(n: usize, text: &str) -> Vec<Item> {
        (0..n).map(|k| Item { title: format!("{text} {k}"), description: None, url: format!("https://x/{k}") }).collect()
    }
    fn input(stage: &str, query: &str, its: Vec<Item>) -> PlanIn {
        PlanIn { query: query.into(), stage: stage.into(), items: its, failed: false, has_lite: true, has_exa: true, under_cap: true }
    }
    #[test]
    fn terms_drop_stopwords_and_dupes() {
        assert_eq!(query_terms("What is the Cloudflare Workers AI? workers"), vec!["cloudflare", "workers", "ai"]);
    }
    #[test]
    fn deep_intent_goes_straight_to_exa() {
        let d = plan(&input("start", "who founded Exa and their funding", vec![]));
        assert_eq!(d.action, "exa");
        assert_eq!(d.reason, "deep_intent");
        assert_eq!(d.on_fail, "throw");
        assert_eq!(d.next_stage, Some("after_exa"));
        let c = plan(&input("start", "weather manila", vec![]));
        assert_eq!(c.action, "ceramic");
        assert_eq!(c.on_fail, "continue");
        assert_eq!(c.next_stage, Some("after_ceramic"));
        assert!(!wants_deep("weather in manila"));
        assert!(wants_deep("who founded anthropic and what is its valuation"));
        assert!(wants_deep(r#"find "exact phrase here""#));
        assert!(wants_deep("research the competitors of cloudflare"));
    }
    #[test]
    fn thin_ceramic_escalates_lite_then_exa() {
        let q = "cloudflare workers pricing";
        let ok = plan(&input("after_ceramic", q, items(5, "cloudflare workers pricing")));
        assert_eq!(ok.action, "return");
        assert_eq!(ok.served, Some("ceramic"));
        assert_eq!(plan(&input("after_ceramic", q, items(1, "x"))).action, "exa-lite");
        let mut i = input("after_ceramic", q, items(1, "x"));
        i.has_lite = false;
        assert_eq!(plan(&i).action, "exa");
        assert_eq!(plan(&input("after_lite", q, items(1, "x"))).action, "exa");
        let mut f = input("after_lite", q, items(5, "cloudflare workers pricing"));
        f.failed = true;
        assert_eq!(plan(&f).action, "exa");
        assert!(is_thin(q, &items(1, "x")));
        assert!(!is_thin(q, &items(5, "cloudflare workers pricing")));
        assert!(is_thin("tokio runtime scheduler", &items(5, "unrelated")));
    }
    #[test]
    fn cap_reached_stays_on_ceramic() {
        let mut i = input("after_ceramic", "x y z", items(0, ""));
        i.under_cap = false;
        assert_eq!(plan(&i).action, "return");
        assert_eq!(plan(&i).reason, "best_so_far");
    }
    #[test]
    fn no_exa_key_stays_ceramic_even_for_research() {
        let mut i = input("start", "deep research on rust async", vec![]);
        i.has_exa = false;
        i.has_lite = false;
        assert_eq!(plan(&i).action, "ceramic");
        let mut after = input("after_ceramic", "deep research on rust async", items(1, "x"));
        after.has_exa = false;
        after.has_lite = false;
        assert_eq!(plan(&after).action, "return");
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
    fn pick_denser_page() {
        assert_eq!(pick_better(&items(1, "a"), &items(5, "b")).len(), 5);
        assert_eq!(pick_better(&items(5, "a"), &items(5, "b")).len(), 5);
        let a = items(3, "a");
        let b = items(1, "b");
        assert_eq!(pick_better(&a, &b).len(), 3);
    }
}
