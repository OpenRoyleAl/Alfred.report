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

/// Agent Memory profile names accept only `[a-z0-9-]` (tested live: `_`, `.`, `~`, `:` -> 1101).
/// Tenant ids use `[a-z0-9_]` (encoded emails, e.g. `martin_40example_2ecom`) or handles with `-`.
/// Injective mapping: `-` -> `--`, `_` -> `-x`, anything else -> `-u<hex>`. A single `-` followed by
/// `a` (archive) or `h` (hashed long name) is therefore never produced by a tenant id.
pub fn profile(tenant: &str) -> Result<String, String> {
    profile_of(tenant, false)
}

/// The kingdom's archive profile (e.g. imported Hermes memory): `<profile>-archive`. Kept apart so
/// bulk history does not crowd mission recall; read it with `archive: true`.
pub fn archive_profile(tenant: &str) -> Result<String, String> {
    profile_of(tenant, true)
}

fn profile_of(tenant: &str, archive: bool) -> Result<String, String> {
    let t = tenant.trim();
    if t.is_empty() || t.len() > 200 || t.chars().any(|c| c.is_control() || c.is_whitespace() || c == '/') {
        return Err("invalid tenant for memory profile".into());
    }
    let mut out = String::new();
    for c in t.chars() {
        match c {
            'a'..='z' | '0'..='9' => out.push(c),
            'A'..='Z' => return Err("invalid tenant for memory profile".into()),
            '-' => out.push_str("--"),
            '_' => out.push_str("-x"),
            c => out.push_str(&format!("-u{:x}", c as u32)),
        }
    }
    let suffix = if archive { "-archive" } else { "" };
    if out.len() + suffix.len() > MAX_PROFILE_LEN {
        use sha2::{Digest, Sha256};
        let h = Sha256::digest(t.as_bytes());
        let hex: String = h.iter().take(8).map(|b| format!("{b:02x}")).collect();
        let keep: String = out.chars().take(60).collect::<String>().trim_end_matches('-').to_string();
        out = format!("{keep}-h{hex}");
    }
    Ok(format!("{out}{suffix}"))
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
        strip_mem_refs(&redact(i.answer.trim())),
        strip_mem_refs(&redact(evidence))
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
    /// Opinion confidence per memory id (from past missions that cited it). Missing = neutral.
    #[serde(default)]
    pub confidence: std::collections::HashMap<String, f64>,
}

/// Memories at or below this confidence are not recalled into missions (cited, then failed twice+).
pub const MIN_CONFIDENCE: f64 = 0.3;

/// Laplace estimate: (passes + 1) / (passes + fails + 2). 0.5 when unused.
pub fn confidence_of(pass: u64, fail: u64) -> f64 {
    (pass as f64 + 1.0) / ((pass + fail) as f64 + 2.0)
}

/// Opinion confidence update after a mission review: every recalled memory the mission cited
/// (`mem:<id>`) gains a pass on verdict pass, a fail on verdict fail. Uncited memories are untouched.
pub fn confidence_update(v: &Value) -> Value {
    let recalled: Vec<String> = v["recalled"].as_array().map(|a| a.iter().filter_map(|x| x.as_str().map(String::from)).collect()).unwrap_or_default();
    let text = v["text"].as_str().unwrap_or("");
    let verdict = v["verdict"].as_str().unwrap_or("");
    let re = regex_lite::Regex::new(MEM_REF).expect("mem ref regex");
    let mut cited: Vec<String> = Vec::new();
    for cap in re.captures_iter(text) {
        let id = cap[1].to_string();
        if recalled.contains(&id) && !cited.contains(&id) {
            cited.push(id);
        }
    }
    let prior = |id: &str, k: &str| -> u64 {
        v["prior"].as_array().and_then(|a| a.iter().find(|p| p["id"].as_str() == Some(id))).and_then(|p| p[k].as_u64()).unwrap_or(0)
    };
    let mut updates = Vec::new();
    if verdict == "pass" || verdict == "fail" {
        for id in &cited {
            let (mut p, mut f) = (prior(id, "pass"), prior(id, "fail"));
            if verdict == "pass" { p += 1 } else { f += 1 }
            updates.push(json!({ "id": id, "pass": p, "fail": f, "confidence": confidence_of(p, f) }));
        }
    }
    json!({ "cited": cited, "updates": updates })
}

/// ISO week label, e.g. 2026-W43, from unix ms.
pub fn iso_week(ms: i64) -> String {
    let days = ms.div_euclid(86_400_000);
    let wd = (days + 3).rem_euclid(7); // 0 = Monday (1970-01-01 was a Thursday)
    let thursday = days - wd + 3;
    let (y, _, _) = civil(thursday);
    let jan1 = days_from_civil(y, 1, 1);
    let week = (thursday - jan1) / 7 + 1;
    format!("{y}-W{week:02}")
}
fn civil(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (yoe + era * 400 + if m <= 2 { 1 } else { 0 }, m, d)
}
fn days_from_civil(y: i64, m: u32, d: u32) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let mp = (m as i64 + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d as i64 - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

/// Weekly consolidation: one deterministic summary memory per kingdom per ISO week, built only
/// from missions that passed review AND were stored (no model writes it). Session `weekly-<week>`
/// so a re-run replaces it (deleteSession first) and forget-by-session removes it.
pub fn consolidate(v: &Value) -> Value {
    let now = v["now"].as_i64().unwrap_or(0);
    let week = iso_week(now);
    let session = format!("weekly-{week}");
    let mut lines = Vec::new();
    for m in v["missions"].as_array().cloned().unwrap_or_default() {
        let stored = m["memory_status"].as_str().unwrap_or("").contains("stored (");
        if m["verdict"].as_str() != Some("pass") || !stored {
            continue;
        }
        let title: String = m["objective"].as_str().unwrap_or("").split_whitespace().take(14).collect::<Vec<_>>().join(" ");
        let ev = m["evidence"].as_str().unwrap_or("");
        let url = regex_lite::Regex::new(r"https?://[^\s)\]>\x22']+").expect("url").find(ev).map(|x| x.as_str().to_string()).unwrap_or_default();
        // Strip mem:<id> refs: a later mission would see them in recall and cite ids it never recalled.
        let raw = strip_mem_refs(m["answer"].as_str().unwrap_or(""));
        let ans: String = raw.split_whitespace().take(40).collect::<Vec<_>>().join(" ");
        lines.push(format!("- {title}: {ans}{}", if url.is_empty() { String::new() } else { format!(" (source {url})") }));
        if lines.len() >= 25 {
            break;
        }
    }
    if lines.is_empty() {
        return json!({ "store": false, "reason": "no passing stored missions this week", "session_id": session, "week": week });
    }
    let mut weak = Vec::new();
    for c in v["confidence"].as_array().cloned().unwrap_or_default() {
        let conf = c["confidence"].as_f64().unwrap_or(0.5);
        if conf <= MIN_CONFIDENCE {
            if let Some(id) = c["id"].as_str() {
                weak.push(format!("{id} ({conf:.2})"));
            }
        }
    }
    let mut content = format!("[weekly {week} consolidation] {} mission(s) passed review with evidence:\n{}", lines.len(), lines.join("\n"));
    if !weak.is_empty() {
        content.push_str(&format!("\nLow-confidence memories (cited in failed missions, not recalled): {}", weak.join(", ")));
    }
    let content: String = redact(&content).chars().take(30_000).collect();
    json!({ "store": true, "reason": "ok", "session_id": session, "week": week, "count": lines.len(), "content": content })
}

fn tokens(s: &str) -> usize {
    s.chars().count().div_ceil(4)
}

/// Fit recalled memory into a token budget: highest score first, whole items only.
/// The ids returned are the only memory ids a mission may cite.
pub fn shape_recall(i: &ShapeIn) -> Value {
    let budget = i.budget_tokens.unwrap_or(DEFAULT_BUDGET_TOKENS).clamp(50, 8000);
    let conf = |id: &str| i.confidence.get(id).copied().unwrap_or(0.5);
    let mut c: Vec<Candidate> = i.candidates.iter().filter(|c| valid_memory_id(&c.id) && conf(&c.id) > MIN_CONFIDENCE).cloned().collect();
    // Rank by search score weighted by opinion confidence (neutral 0.5 keeps the search order).
    c.sort_by(|a, b| (b.score * conf(&b.id)).partial_cmp(&(a.score * conf(&a.id))).unwrap_or(std::cmp::Ordering::Equal));
    let mut used = 0usize;
    let mut items = Vec::new();
    for x in c {
        let s: String = x.summary.chars().take(400).collect();
        let t = tokens(&s) + 8;
        if used + t > budget {
            break;
        }
        used += t;
        items.push(json!({ "id": x.id, "summary": s, "score": x.score, "confidence": conf(&x.id) }));
    }
    let answer_budget = budget.saturating_sub(used);
    let answer: String = i.answer.chars().take(answer_budget * 4).collect();
    used += tokens(&answer);
    let ids: Vec<Value> = items.iter().map(|x| x["id"].clone()).collect();
    json!({ "answer": answer, "items": items, "ids": ids, "tokens": used, "budget": budget })
}

/// Stored memory must not carry `mem:<id>` refs: a later mission would read them in recall and
/// cite ids it never recalled (seen live: dm-d3aeab09c14240cd failed review this way).
pub fn strip_mem_refs(text: &str) -> String {
    regex_lite::Regex::new(MEM_REF).expect("mem ref regex").replace_all(text, "a memory").to_string()
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
    let t = v["tenant"].as_str().unwrap_or("");
    let p = if v["archive"].as_bool().unwrap_or(false) { archive_profile(t)? } else { profile(t)? };
    Ok(json!({ "profile": p }).to_string())
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
        "confidence" => confidence_update(&v["args"]),
        "consolidate" => consolidate(&v["args"]),
        "notice" => crate::notice::new_user(&v["args"])?,
        other => return Err(format!("unknown memory op: {other}")),
    };
    Ok(out.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    const ID: &str = "01M0RWH2SGDZJRBQ6S82RH823B";

    #[test]
    fn stored_memory_has_no_mem_refs() {
        assert_eq!(strip_mem_refs(&format!("per mem:{ID}.")), "per a memory.");
    }

    #[test]
    fn confidence_tracks_cited_outcomes_only() {
        const B: &str = "01M0RWH2SGDZJRBQ6S82RH823C";
        let r = confidence_update(&json!({ "recalled": [ID, B], "text": format!("per mem:{ID} and mem:01M0RWH2SGDZJRBQ6S82RH8999"), "verdict": "fail", "prior": [{ "id": ID, "pass": 0, "fail": 1 }] }));
        assert_eq!(r["cited"], json!([ID]));
        assert_eq!(r["updates"][0]["fail"], 2);
        assert!((r["updates"][0]["confidence"].as_f64().unwrap() - 0.25).abs() < 1e-9);
        assert_eq!(confidence_update(&json!({ "recalled": [ID], "text": format!("mem:{ID}"), "verdict": "partial" }))["updates"], json!([]));
        // Low confidence drops out of recall; higher confidence ranks first.
        let mut conf = std::collections::HashMap::new();
        conf.insert(ID.to_string(), 0.25);
        conf.insert(B.to_string(), 0.9);
        let i = ShapeIn { answer: "a".into(), candidates: vec![Candidate { id: ID.into(), summary: "x".into(), score: 0.9 }, Candidate { id: B.into(), summary: "y".into(), score: 0.5 }], budget_tokens: None, confidence: conf };
        assert_eq!(shape_recall(&i)["ids"], json!([B]));
    }

    #[test]
    fn weekly_consolidation_uses_only_passing_stored_missions() {
        assert_eq!(iso_week(1_792_800_000_000), "2026-W43");
        assert_eq!(iso_week(1_735_689_600_000), "2025-W01"); // 2025-01-01
        let v = json!({ "now": 1_792_800_000_000i64, "missions": [
            { "objective": "Check Agent Memory docs", "answer": "Limits are listed per mem:01M0RWH2SGDZJRBQ6S82RH8999", "evidence": "fetched https://developers.cloudflare.com/agent-memory/ ok", "verdict": "pass", "memory_status": "recalled 1/2; stored (session dm-1)" },
            { "objective": "Failed one", "answer": "x", "verdict": "fail", "memory_status": "not stored: fail" },
            { "objective": "Passed not stored token=abc123", "answer": "y", "verdict": "pass", "memory_status": "not stored: no evidence" } ],
            "confidence": [{ "id": ID, "confidence": 0.25 }] });
        let r = consolidate(&v);
        assert_eq!(r["store"], true);
        assert_eq!(r["session_id"], "weekly-2026-W43");
        assert_eq!(r["count"], 1);
        let c = r["content"].as_str().unwrap();
        assert!(c.contains("source https://developers.cloudflare.com/agent-memory/") && c.contains(ID) && !c.contains("Failed one") && !c.contains("mem:"));
        assert_eq!(consolidate(&json!({ "now": 0, "missions": [] }))["store"], false);
    }

    #[test]
    fn profile_is_tenant_safe_and_injective() {
        assert_eq!(profile("hans").unwrap(), "hans");
        assert_eq!(archive_profile("hans").unwrap(), "hans-archive");
        assert_eq!(profile("martin_40example_2ecom").unwrap(), "martin-x40example-x2ecom");
        assert_eq!(profile("qa-kingdom-b").unwrap(), "qa--kingdom--b");
        assert_ne!(profile("a_b").unwrap(), profile("a-b").unwrap());
        assert_ne!(profile("hans-archive").unwrap(), archive_profile("hans").unwrap());
        assert!(profile("../martin").is_err());
        assert!(profile("").is_err());
        let long = profile(&"a".repeat(150)).unwrap();
        assert!(long.len() <= MAX_PROFILE_LEN && long.contains("-h"));
        for p in [profile("x_y.z").unwrap(), archive_profile(&"b_".repeat(80)).unwrap()] {
            assert!(p.len() <= MAX_PROFILE_LEN && p.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-'), "{p}");
        }
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
        let out = shape_recall(&ShapeIn { answer: "y".repeat(5000), candidates: cands, budget_tokens: Some(300), confidence: Default::default() });
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
