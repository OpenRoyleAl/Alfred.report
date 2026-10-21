//! Model floor: Workers AI models a mission may fall back to right now.
use serde::Deserialize;

pub const DEEPSEEK_FLASH: &str = "@cf/deepseek-ai/deepseek-v4.1-flash-1017";

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

#[cfg(test)]
mod tests {
    use super::*;
    fn v(x: &[&str]) -> Vec<String> { x.iter().map(|s| s.to_string()).collect() }
    #[test]
    fn drops_deepseek_when_limited() {
        let m = v(&[DEEPSEEK_FLASH, "@cf/moonshotai/kimi-k2.7-code", "anthropic/x"]);
        assert_eq!(floor(&m, true, None)[0], DEEPSEEK_FLASH);
        assert_eq!(floor(&m, false, None), v(&["@cf/moonshotai/kimi-k2.7-code"]));
        assert_eq!(floor(&m, true, Some(DEEPSEEK_FLASH)), v(&["@cf/moonshotai/kimi-k2.7-code"]));
    }
}
