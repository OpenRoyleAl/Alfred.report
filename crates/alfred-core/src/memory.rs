//! Agent Memory policy (Cloudflare Agent Memory is the store; the binding calls stay in TS).
//!
//! Kingdom model: one namespace per Cloudflare account (`alfred` on alfred.report), one profile per
//! tenant (= the tenant id, the king of that kingdom). The profile always comes from the verified
//! identity, never from a request, so one king can never read another kingdom's memory.
//!
//! In Rust: profile naming, the store gate (only reviewed, passing, evidenced, uninterrupted
//! missions are remembered), what is stored (experience vs world, secrets redacted, size caps),
//! the recall query cap, the token budget on recalled memory, the "cite only recalled ids" check,
//! and validation for forget / export / import.
use serde::Deserialize;
use serde_json::{json, Value};

/// Agent Memory limits (developers.cloudflare.com/agent-memory/platform/limits/).
pub const MAX_QUERY_BYTES: usize = 1024;
pub const MAX_MESSAGE_BYTES: usize = 32 * 1024;
pub const MAX_SESSION_LEN: usize = 64;
pub const MAX_PROFILE_LEN: usize = 100;
pub const DEFAULT_BUDGET_TOKENS: usize = 600;
/// Recalled memory a mission may cite looks like `mem:<ULID>`.
const MEM_REF: &str = r"mem:([0-9A-HJKMNP-TV-Z]{26})";

fn cut_bytes(s: &str, max: usize) -> String {
    if s.len() <= max {
        return s.to_string();
    }
    let mut end = max;
    while end > 0 && !s.is_char_boundary(end) {
        end -= 1;
    }
    s[..end].to_string()
}

/// Profile name for a tenant: the tenant id itself, validated (KISS, matches existing `hans`).
pub fn profile(tenant: &str) -> Result<String, String> {
    let t = tenant.trim();
    let ok = !t.is_empty()
        && t.len() <= MAX_PROFILE_LEN
        && t.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.' || c == '~');
    if ok {
        Ok(t.to_string())
    } else {
        Err("invalid tenant for memory profile".into())
    }
}

pub fn valid_memory_id(id: &str) -> bool {
    id.len() == 26 && id.chars().all(|c| c.is_ascii_digit() || c.is_ascii_uppercase())
}

pub fn valid_session(s: &str) -> bool {
    !s.is_empty() && s.len() <= MAX_SESSION_LEN && !s.chars().any(|c| c.is_control())
}

/// Recall query: trimmed, whitespace-collapsed, cut to 1 KB on a char boundary.
pub fn query(text: &str) -> String {
    let q = text.split_whitespace().collect::<Vec<_>>().join(" ");
    cut_bytes(&q, MAX_QUERY_BYTES)
}

/// Remove obvious credentials before anything is remembered.
pub fn redact(text: &str) -> String {
    let pats = [
        r"art_[A-Za-z0-9_\-]{16,}",
        r"sk-[A-Za-z0-9_\-]{16,}",
        r"(?i)bearer\s+[A-Za-z0-9._\-]{16,}",
        r"AKIA[0-9A-Z]{16}",
        r"gh[pousr]_[A-Za-z0-9]{20,}",
        r"-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----",
        r"(?i)(password|passwd|secret|api[_-]?key|token)\s*[:=]\s*\S+",
    ];
    let mut out = text.to_string();
    for p in pats {
        if let Ok(re) = regex_lite::Regex::new(p) {
            out = re.replace_all(&out, "[redacted]").into_owned();
        }
    }
    out
}

#[derive(Deserialize)]
pub struct StoreIn {
    pub mission_id: String,
    pub objective: String,
    #[serde(default)]
    pub answer: String,
    #[serde(default)]
    pub evidence: Option<String>,
    #[serde(default)]
    pub lesson_ok: bool,
    #[serde(default)]
    pub verdict: String,
    #[serde(default)]
    pub interrupted: u32,
    #[serde(default)]
    pub tools: Vec<String>,
}

/// The store gate + what to remember. Returns `{store, reason, session_id, messages}`.
/// Experience = what Alfred did; world = what the fetched evidence says. Never from a failed run.
pub fn plan_store(i: &StoreIn) -> Value {
    let evidence = i.evidence.as_deref().unwrap_or("").trim();
    let reason = if !i.lesson_ok {
        Some("review did not pass (lessonOk=false)")
    } else if i.verdict != "pass" {
        Some("verdict is not pass")
    } else if evidence.is_empty() {
        Some("no evidence")
    } else if i.interrupted > 0 {
        Some("a step was interrupted")
    } else if i.answer.trim().is_empty() {
        Some("empty answer")
    } else {
        None
    };
    let session = cut_bytes(&i.mission_id, MAX_SESSION_LEN);
    if let Some(r) = reason {
        return json!({ "store": false, "reason": r, "session_id": session, "messages": [] });
    }
    let tools = if i.tools.is_empty() { "no tools".to_string() } else { i.tools.join(", ") };
    let user = format!("[mission {}] {}", i.mission_id, redact(i.objective.trim()));
    let assistant = format!(
        "[experience] Alfred completed this mission (review passed; tools: {tools}).\n{}\n[world] Evidence fetched: {}",
        redact(i.answer.trim()),
        redact(evidence)
    );
    json!({
        "store": true,
        "reason": "passed review with evidence",
        "session_id": session,
        "messages": [
            { "role": "user", "content": cut_bytes(&user, 2000) },
            { "role": "assistant", "content": cut_bytes(&assistant, MAX_MESSAGE_BYTES - 64) }
        ]
    })
}

#[derive(Deserialize, Clone)]
pub struct Candidate {
    pub id: String,
    #[serde(default)]
    pub summary: String,
    #[serde(default)]
    pub score: f64,
}

#[derive(Deserialize)]
pub struct ShapeIn {
    #[serde(default)]
    pub answer: String,
    #[serde(default)]
    pub candidates: Vec<Candidate>,
    #[serde(default)]
    pub budget_tokens: Option<usize>,
}

fn tokens(s: &str) -> usize {
    s.chars().count().div_ceil(4)
}

/// Fit recalled memory into a token budget: highest score first, whole items only.
/// The ids returned are the only memory ids a mission may cite.
pub fn shape_recall(i: &ShapeIn) -> Value {
    let budget = i.budget_tokens.unwrap_or(DEFAULT_BUDGET_TOKENS).clamp(50, 8000);
    let mut c: Vec<Candidate> = i.candidates.iter().filter(|c| valid_memory_id(&c.id)).cloned().collect();
    c.sort_by(|a, b| b.score.partial_cmp(&a.score).unwrap_or(std::cmp::Ordering::Equal));
    let mut used = 0usize;
    let mut items = Vec::new();
    for x in c {
        let s: String = x.summary.chars().take(400).collect();
        let t = tokens(&s) + 8;
        if used + t > budget {
            break;
        }
        used += t;
        items.push(json!({ "id": x.id, "summary": s, "score": x.score }));
    }
    let answer_budget = budget.saturating_sub(used);
    let answer: String = i.answer.chars().take(answer_budget * 4).collect();
    used += tokens(&answer);
    let ids: Vec<Value> = items.iter().map(|x| x["id"].clone()).collect();
    json!({ "answer": answer, "items": items, "ids": ids, "tokens": used, "budget": budget })
}

/// Memory ids cited as `mem:<id>` that were not recalled for this mission.
pub fn uncited_ids(text: &str, allowed: &[String]) -> Vec<String> {
    let re = regex_lite::Regex::new(MEM_REF).expect("mem ref regex");
    let mut bad: Vec<String> = Vec::new();
    for cap in re.captures_iter(text) {
        let id = cap[1].to_string();
        if !allowed.iter().any(|a| a == &id) && !bad.contains(&id) {
            bad.push(format!("mem:{id}"));
        }
    }
    bad
}

/// Forget request: exactly one of a memory id, a session id, or (owner of the profile) everything.
pub fn forget(v: &Value) -> Result<Value, String> {
    let id = v["id"].as_str().unwrap_or("").trim();
    let session = v["sessionId"].as_str().unwrap_or("").trim();
    match (id.is_empty(), session.is_empty()) {
        (false, true) if valid_memory_id(id) => Ok(json!({ "kind": "memory", "id": id })),
        (true, false) if valid_session(session) => Ok(json!({ "kind": "session", "sessionId": session })),
        (false, false) => Err("forget takes id or sessionId, not both".into()),
        (true, true) => Err("forget needs id or sessionId".into()),
        _ => Err("invalid id or sessionId".into()),
    }
}

/// Remember request from an agent/king: content cleaned and capped.
pub fn remember(v: &Value) -> Result<Value, String> {
    let content = redact(v["content"].as_str().unwrap_or("").trim());
    if content.chars().count() < 3 {
        return Err("content required".into());
    }
    let session = v["sessionId"].as_str().map(|s| s.trim().to_string()).filter(|s| !s.is_empty());
    if let Some(s) = &session {
        if !valid_session(s) {
            return Err("invalid sessionId".into());
        }
    }
    Ok(json!({ "content": cut_bytes(&content, MAX_MESSAGE_BYTES - 64), "sessionId": session }))
}

/// Export page size (list + get per memory).
pub fn export_limit(v: &Value) -> usize {
    v["limit"].as_u64().unwrap_or(50).clamp(1, 100) as usize
}

pub fn profile_json(input: &str) -> Result<String, String> {
    let v: Value = serde_json::from_str(input).map_err(|e| e.to_string())?;
    Ok(json!({ "profile": profile(v["tenant"].as_str().unwrap_or(""))? }).to_string())
}
pub fn query_json(input: &str) -> Result<String, String> {
    let v: Value = serde_json::from_str(input).map_err(|e| e.to_string())?;
    Ok(json!({ "query": query(v["text"].as_str().unwrap_or("")) }).to_string())
}
pub fn store_json(input: &str) -> Result<String, String> {
    let i: StoreIn = serde_json::from_str(input).map_err(|e| e.to_string())?;
    Ok(plan_store(&i).to_string())
}
pub fn shape_json(input: &str) -> Result<String, String> {
    let i: ShapeIn = serde_json::from_str(input).map_err(|e| e.to_string())?;
    Ok(shape_recall(&i).to_string())
}
pub fn op_json(input: &str) -> Result<String, String> {
    let v: Value = serde_json::from_str(input).map_err(|e| e.to_string())?;
    let out = match v["op"].as_str().unwrap_or("") {
        "forget" => forget(&v["args"])?,
        "remember" => remember(&v["args"])?,
        "export" => json!({ "limit": export_limit(&v["args"]) }),
        "uncited" => {
            let allowed: Vec<String> = v["args"]["allowed"].as_array().map(|a| a.iter().filter_map(|x| x.as_str().map(String::from)).collect()).unwrap_or_default();
            json!({ "uncited": uncited_ids(v["args"]["text"].as_str().unwrap_or(""), &allowed) })
        }
        other => return Err(format!("unknown memory op: {other}")),
    };
    Ok(out.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    const ID: &str = "01M0RWH2SGDZJRBQ6S82RH823B";

    #[test]
    fn profile_is_tenant_and_rejects_injection() {
        assert_eq!(profile("hans").unwrap(), "hans");
        assert!(profile("../martin").is_err());
        assert!(profile("").is_err());
        assert!(profile(&"a".repeat(101)).is_err());
    }

    #[test]
    fn gate_blocks_failed_unevidenced_interrupted() {
        let base = |ok: bool, verdict: &str, ev: Option<&str>, intr: u32| StoreIn {
            mission_id: "M-1".into(), objective: "o".into(), answer: "a".into(), evidence: ev.map(String::from),
            lesson_ok: ok, verdict: verdict.into(), interrupted: intr, tools: vec![],
        };
        assert_eq!(plan_store(&base(false, "pass", Some("https://x"), 0))["store"], false);
        assert_eq!(plan_store(&base(true, "fail", Some("https://x"), 0))["store"], false);
        assert_eq!(plan_store(&base(true, "pass", None, 0))["store"], false);
        assert_eq!(plan_store(&base(true, "pass", Some("https://x"), 1))["store"], false);
        let ok = plan_store(&base(true, "pass", Some("https://x"), 0));
        assert_eq!(ok["store"], true);
        assert_eq!(ok["messages"].as_array().unwrap().len(), 2);
        assert!(ok["messages"][1]["content"].as_str().unwrap().contains("[experience]"));
        assert!(ok["messages"][1]["content"].as_str().unwrap().contains("[world]"));
    }

    #[test]
    fn redacts_secrets() {
        let r = redact("key art_abcdefghijklmnopqrstuvwxyz and Bearer abcdefghijklmnopqrstu password=hunter2");
        assert!(!r.contains("art_abc") && !r.contains("hunter2") && !r.contains("abcdefghijklmnopqrstu"));
    }

    #[test]
    fn budget_and_ids() {
        let cands: Vec<Candidate> = (0..20).map(|n| Candidate { id: format!("01M0RWH2SGDZJRBQ6S82RH82{:02}", n), summary: "x".repeat(200), score: n as f64 }).collect();
        let out = shape_recall(&ShapeIn { answer: "y".repeat(5000), candidates: cands, budget_tokens: Some(300) });
        assert!(out["tokens"].as_u64().unwrap() <= 300);
        assert_eq!(out["items"][0]["score"], 19.0);
        let ids: Vec<String> = out["ids"].as_array().unwrap().iter().map(|x| x.as_str().unwrap().to_string()).collect();
        assert!(uncited_ids(&format!("per mem:{}", ids[0]), &ids).is_empty());
        assert_eq!(uncited_ids(&format!("per mem:{ID}"), &ids), vec![format!("mem:{ID}")]);
    }

    #[test]
    fn forget_and_query() {
        assert!(forget(&json!({ "id": ID })).is_ok());
        assert!(forget(&json!({ "sessionId": "M-1" })).is_ok());
        assert!(forget(&json!({})).is_err());
        assert!(forget(&json!({ "id": "nope" })).is_err());
        assert!(forget(&json!({ "id": ID, "sessionId": "x" })).is_err());
        assert!(query(&"é".repeat(2000)).len() <= MAX_QUERY_BYTES);
    }
}
