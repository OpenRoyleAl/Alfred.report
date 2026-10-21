//! Search router decisions: Ceramic ($0.25/1k) -> Exa Lite ($4/1k) -> Exa auto ($7/1k).
use regex_lite::Regex;
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::sync::OnceLock;

pub const MIN_GOOD_RESULTS: usize = 3;
pub const MIN_TERM_COVERAGE: f64 = 0.5;

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

#[derive(Deserialize, Default, Clone)]
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
}

const fn p(action: &'static str, reason: &'static str) -> Plan {
    Plan { action, reason }
}

pub fn plan(i: &PlanIn) -> Plan {
    let exa_ok = i.has_exa && i.under_cap;
    let lite_ok = i.has_lite && i.under_cap;
    match i.stage.as_str() {
        "start" if exa_ok && wants_deep(&i.query) => p("exa", "deep_intent"),
        "start" => p("ceramic", "default"),
        "after_ceramic" if !is_thin(&i.query, &i.items) => p("return", "default"),
        "after_ceramic" if lite_ok => p("exa-lite", "ceramic_thin"),
        "after_ceramic" if exa_ok => p("exa", "ceramic_thin"),
        "after_lite" if !i.failed && !is_thin(&i.query, &i.items) => p("return", "lite_ok"),
        "after_lite" if exa_ok => p("exa", "lite_thin"),
        _ => p("return", "best_so_far"),
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
        assert_eq!(plan(&input("start", "who founded Exa and their funding", vec![])), p("exa", "deep_intent"));
        assert_eq!(plan(&input("start", "weather manila", vec![])), p("ceramic", "default"));
    }
    #[test]
    fn thin_ceramic_escalates_lite_then_exa() {
        let q = "cloudflare workers pricing";
        assert_eq!(plan(&input("after_ceramic", q, items(5, "cloudflare workers pricing"))), p("return", "default"));
        assert_eq!(plan(&input("after_ceramic", q, items(1, "x"))), p("exa-lite", "ceramic_thin"));
        let mut i = input("after_ceramic", q, items(1, "x"));
        i.has_lite = false;
        assert_eq!(plan(&i), p("exa", "ceramic_thin"));
        assert_eq!(plan(&input("after_lite", q, items(1, "x"))), p("exa", "lite_thin"));
        let mut f = input("after_lite", q, items(5, "cloudflare workers pricing"));
        f.failed = true;
        assert_eq!(plan(&f), p("exa", "lite_thin"));
    }
    #[test]
    fn cap_reached_stays_on_ceramic() {
        let mut i = input("after_ceramic", "x y z", items(0, ""));
        i.under_cap = false;
        assert_eq!(plan(&i), p("return", "best_so_far"));
    }
}
