//! Model router hot paths: Workers AI floor, primary (DeepSeek Flash) selection, 429 detection.
use regex_lite::Regex;
use serde::Deserialize;
use std::sync::OnceLock;

pub const DEEPSEEK_FLASH: &str = "@cf/deepseek-ai/deepseek-v4.1-flash-1017";
pub const AUTO_MODEL_ID: &str = "cloudflare/auto";
pub const DEEPSEEK_RPM: u32 = 20;

pub const DEFAULT_AUTO_POOL: &[&str] = &[
    DEEPSEEK_FLASH,
    "@cf/moonshotai/kimi-k2.7-code",
    "@cf/zai-org/glm-5.2",
    "@cf/deepseek-ai/deepseek-v4-pro-0813",
    "@cf/qwen/qwen3.8-27b",
    "@cf/google/gemma-4-26b-a4b-it",
    "@cf/openai/gpt-oss-20b",
];

pub const DEFAULT_FLOOR: &[&str] = &[DEEPSEEK_FLASH, "@cf/moonshotai/kimi-k2.7-code", "@cf/zai-org/glm-5.2", "@cf/openai/gpt-oss-20b"];

#[derive(Deserialize)]
struct FloorIn {
    models: Vec<String>,
    /// Whether the rate-limited primary has a free slot right now.
    primary_available: bool,
    /// Exclude this id (the primary itself, when it is already tried first).
    #[serde(default)]
    exclude: Option<String>,
}

pub fn floor(models: &[String], primary_available: bool, exclude: Option<&str>) -> Vec<String> {
    let all: Vec<String> = models.iter().filter(|m| m.starts_with("@cf/")).cloned().collect();
    let usable: Vec<String> = all
        .iter()
        .filter(|m| Some(m.as_str()) != exclude)
        .filter(|m| m.as_str() != DEEPSEEK_FLASH || primary_available)
        .cloned()
        .collect();
    if usable.is_empty() {
        all.into_iter().filter(|m| m != DEEPSEEK_FLASH && Some(m.as_str()) != exclude).collect()
    } else {
        usable
    }
}

pub fn floor_json(s: &str) -> Result<String, String> {
    let i: FloorIn = serde_json::from_str(s).map_err(|e| e.to_string())?;
    Ok(serde_json::to_string(&floor(&i.models, i.primary_available, i.exclude.as_deref())).unwrap())
}

pub fn csv_or(v: &str, fallback: &[&str]) -> Vec<String> {
    let items: Vec<String> = v.split(',').map(|s| s.trim().to_string()).filter(|s| !s.is_empty()).collect();
    if items.is_empty() {
        fallback.iter().map(|s| s.to_string()).collect()
    } else {
        items
    }
}

/// `MISSIONS_MODEL` empty => DeepSeek Flash; `"auto"` or a non-`@cf/` id => Auto Router only.
pub fn primary_model(missions_model: &str) -> Option<String> {
    let m = missions_model.trim();
    let m = if m.is_empty() { DEEPSEEK_FLASH } else { m };
    if m == "auto" || !m.starts_with("@cf/") {
        None
    } else {
        Some(m.to_string())
    }
}

#[derive(Deserialize)]
struct PrimaryIn {
    #[serde(default)]
    missions_model: Option<String>,
}

pub fn primary_json(s: &str) -> Result<String, String> {
    let i: PrimaryIn = serde_json::from_str(s).map_err(|e| e.to_string())?;
    Ok(serde_json::to_string(&primary_model(i.missions_model.as_deref().unwrap_or(""))).unwrap())
}

fn rate_re() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    R.get_or_init(|| Regex::new(r"(?i)\b429\b|rate.?limit|capacity|too many requests").unwrap())
}

pub fn is_rate_limited(msg: &str) -> bool {
    rate_re().is_match(msg)
}

#[derive(Deserialize)]
struct RateIn {
    #[serde(default)]
    message: String,
}

pub fn rate_limited_json(s: &str) -> Result<String, String> {
    let i: RateIn = serde_json::from_str(s).map_err(|e| e.to_string())?;
    Ok(serde_json::json!({ "limited": is_rate_limited(&i.message) }).to_string())
}

#[derive(Deserialize)]
struct HeadersIn {
    #[serde(default)]
    providers: String,
    #[serde(default)]
    models: String,
}

pub fn router_headers(providers: &str, models: &str) -> serde_json::Value {
    let mut h = serde_json::Map::new();
    let p = providers.trim();
    if !p.is_empty() {
        h.insert("cf-aig-allowed-providers".into(), serde_json::Value::String(p.to_string()));
    }
    h.insert("cf-aig-allowed-models".into(), serde_json::Value::String(csv_or(models, DEFAULT_AUTO_POOL).join(",")));
    serde_json::Value::Object(h)
}

pub fn headers_json(s: &str) -> Result<String, String> {
    let i: HeadersIn = serde_json::from_str(s).map_err(|e| e.to_string())?;
    Ok(router_headers(&i.providers, &i.models).to_string())
}

/// Pull the completion text out of a Workers AI / OpenAI-shaped JSON body.
pub fn text_of(v: &serde_json::Value) -> (String, u64) {
    let text = v
        .pointer("/choices/0/message/content")
        .or_else(|| v.pointer("/choices/0/text"))
        .or_else(|| v.get("response"))
        .and_then(|x| x.as_str())
        .unwrap_or("")
        .to_string();
    let tokens = v.pointer("/usage/total_tokens").and_then(|x| x.as_u64()).unwrap_or(0);
    (text, tokens)
}

pub fn text_json(s: &str) -> Result<String, String> {
    let v: serde_json::Value = serde_json::from_str(s).map_err(|e| e.to_string())?;
    let (text, tokens) = text_of(&v);
    Ok(serde_json::json!({ "text": text, "tokens": tokens }).to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn v(x: &[&str]) -> Vec<String> {
        x.iter().map(|s| s.to_string()).collect()
    }
    #[test]
    fn drops_deepseek_when_limited() {
        let m = v(&[DEEPSEEK_FLASH, "@cf/moonshotai/kimi-k2.7-code", "anthropic/x"]);
        assert_eq!(floor(&m, true, None)[0], DEEPSEEK_FLASH);
        assert_eq!(floor(&m, false, None), v(&["@cf/moonshotai/kimi-k2.7-code"]));
        assert_eq!(floor(&m, true, Some(DEEPSEEK_FLASH)), v(&["@cf/moonshotai/kimi-k2.7-code"]));
    }
    #[test]
    fn primary_defaults_and_auto() {
        assert_eq!(primary_model(""), Some(DEEPSEEK_FLASH.into()));
        assert_eq!(primary_model("auto"), None);
        assert_eq!(primary_model("anthropic/claude"), None);
        assert_eq!(primary_model("  @cf/moonshotai/kimi-k2.7-code  "), Some("@cf/moonshotai/kimi-k2.7-code".into()));
    }
    #[test]
    fn rate_limit_strings() {
        assert!(is_rate_limited("429 Too Many Requests"));
        assert!(is_rate_limited("rate-limit exceeded"));
        assert!(is_rate_limited("no capacity"));
        assert!(!is_rate_limited("model not found"));
    }
    #[test]
    fn headers_restrict_to_workers_ai_pool() {
        let h = router_headers("", "");
        assert!(h["cf-aig-allowed-models"].as_str().unwrap().starts_with(DEEPSEEK_FLASH));
        assert!(h.get("cf-aig-allowed-providers").is_none());
        let h2 = router_headers("workers-ai", "anthropic/*");
        assert_eq!(h2["cf-aig-allowed-providers"], "workers-ai");
        assert_eq!(h2["cf-aig-allowed-models"], "anthropic/*");
    }
    #[test]
    fn text_of_openai_and_workers_shapes() {
        let (t, n) = text_of(&serde_json::json!({"choices":[{"message":{"content":"hi"}}],"usage":{"total_tokens":3}}));
        assert_eq!((t, n), ("hi".into(), 3));
        let (t, n) = text_of(&serde_json::json!({"response":"yo"}));
        assert_eq!((t, n), ("yo".into(), 0));
    }
}
