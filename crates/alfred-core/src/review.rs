//! End-of-mission review: the gate in front of the lessons store (Pi and durable missions).
//! Ported from src/alfred/review.ts so both engines share one decision. A run with any
//! blocking flag is quarantined and NEVER becomes a lesson; `lesson_ok` additionally needs
//! evidence and no interrupted step.
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

pub const WASTE_RATIO_LIMIT: f64 = 0.25;

#[derive(Deserialize, Clone)]
pub struct Event {
    pub tool: String,
    #[serde(default)]
    pub args_hash: String,
    pub ok: bool,
    #[serde(default)]
    pub blocked: Option<String>,
}

#[derive(Deserialize, Serialize, Clone)]
pub struct Log {
    #[serde(default)]
    pub id: String,
    #[serde(default)]
    pub model: String,
    pub success: bool,
    #[serde(default)]
    pub status: f64,
    #[serde(default)]
    pub tokens_in: f64,
    #[serde(default)]
    pub tokens_out: f64,
    #[serde(default)]
    pub cost: f64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewIn {
    pub mission_id: String,
    pub status: String,
    #[serde(default)]
    pub final_text: String,
    #[serde(default)]
    pub events: Vec<Event>,
    #[serde(default)]
    pub logs: Vec<Log>,
    #[serde(default)]
    pub missing_logs: u32,
    #[serde(default)]
    pub evidence: Option<String>,
    #[serde(default)]
    pub require_evidence: bool,
    /// {done,pDone,pEvidence} | "unavailable" | absent.
    #[serde(default)]
    pub clef_done: Option<Value>,
    #[serde(default)]
    pub escalation: Option<String>,
    /// Durable engine: steps interrupted by an eviction (outcome unknown).
    #[serde(default)]
    pub interrupted: u32,
    /// Durable engine: URLs/sources cited in the answer that were never fetched.
    #[serde(default)]
    pub uncited: Vec<String>,
}

fn flag(kind: &str, blocking: bool, detail: String) -> Value {
    json!({ "kind": kind, "blocking": blocking, "detail": detail })
}

pub fn review(i: ReviewIn) -> Value {
    let mut flags: Vec<Value> = vec![];
    let ran: Vec<&Event> = i.events.iter().filter(|e| e.blocked.is_none()).collect();
    let failures: Vec<&&Event> = ran.iter().filter(|e| !e.ok).collect();
    let blocked: Vec<&Event> = i.events.iter().filter(|e| e.blocked.is_some()).collect();

    if !failures.is_empty() {
        let mut by: Vec<(String, u32)> = vec![];
        for f in &failures {
            match by.iter_mut().find(|(t, _)| *t == f.tool) {
                Some(x) => x.1 += 1,
                None => by.push((f.tool.clone(), 1)),
            }
        }
        let blocking = failures.len() >= 3 || (failures.len() as f64) > ran.len() as f64 / 2.0;
        flags.push(flag("failed_tool", blocking, by.iter().map(|(t, n)| format!("{t}×{n}")).collect::<Vec<_>>().join(", ")));
    }

    let mut repeats: Vec<(String, u32)> = vec![];
    for e in &ran {
        let k = format!("{}:{}", e.tool, e.args_hash);
        match repeats.iter_mut().find(|(x, _)| *x == k) {
            Some(x) => x.1 += 1,
            None => repeats.push((k, 1)),
        }
    }
    let looped: Vec<&(String, u32)> = repeats.iter().filter(|(_, n)| *n >= 3).collect();
    if !blocked.is_empty() || !looped.is_empty() {
        let mut d: Vec<String> = blocked.iter().map(|b| format!("{} blocked ({})", b.tool, b.blocked.clone().unwrap_or_default())).collect();
        d.extend(looped.iter().map(|(k, n)| format!("{} identical ×{n}", k.split(':').next().unwrap_or(""))));
        flags.push(flag("loop", true, d.join("; ")));
    }

    let tokens = |l: &Log| l.tokens_in + l.tokens_out;
    let failed_req: Vec<&Log> = i.logs.iter().filter(|l| !l.success || l.status >= 400.0).collect();
    if !failed_req.is_empty() {
        flags.push(flag("failed_request", false, format!("{} gateway request(s) failed", failed_req.len())));
    }
    let total: f64 = i.logs.iter().map(tokens).sum();
    let failed_tokens: f64 = failed_req.iter().map(|l| tokens(l)).sum();
    let share = if i.events.is_empty() { 0.0 } else { (failures.len() + blocked.len()) as f64 / i.events.len() as f64 };
    let wasted = (failed_tokens + (total - failed_tokens) * share).round();
    if total > 0.0 && wasted / total > WASTE_RATIO_LIMIT {
        flags.push(flag("wasted_tokens", true, format!("{wasted}/{total} tokens ({}%) wasted", ((wasted / total) * 100.0).round())));
    }
    if i.status != "done" || i.final_text.trim().is_empty() {
        flags.push(flag("unanswered", true, format!("run status {}", i.status)));
    }
    let has_evidence = i.evidence.as_deref().is_some_and(|e| !e.trim().is_empty());
    if i.require_evidence && !has_evidence {
        flags.push(flag("no_evidence", true, "mission ended without mission_complete evidence".into()));
    }
    match &i.clef_done {
        Some(Value::String(s)) if s == "unavailable" => flags.push(flag("clef_unavailable", false, "mission-done gate could not run".into())),
        Some(v @ Value::Object(_)) if v["done"] == Value::Bool(false) => flags.push(flag(
            "clef_not_done",
            true,
            format!("clef done p={:.2}, evidence p={:.2}", v["pDone"].as_f64().unwrap_or(0.0), v["pEvidence"].as_f64().unwrap_or(0.0)),
        )),
        _ => {}
    }
    if let Some(e) = i.escalation.as_ref().filter(|e| !e.is_empty()) {
        flags.push(flag("escalated", true, e.clone()));
    }
    if i.interrupted > 0 {
        // Not a failure of the model, but not plain success either: The Report shows "partial".
        flags.push(flag("interrupted", false, format!("{} step(s) interrupted by an eviction; outcome unknown", i.interrupted)));
    }
    if !i.uncited.is_empty() {
        flags.push(flag("uncited_source", true, format!("cited without reading: {}", i.uncited.join(", "))));
    }
    if i.missing_logs > 0 {
        flags.push(flag("logs_missing", false, format!("{} gateway log(s) not retrievable", i.missing_logs)));
    }

    let verdict = if flags.iter().any(|f| f["blocking"] == Value::Bool(true)) { "fail" } else { "pass" };
    let mut models: Vec<String> = vec![];
    for l in &i.logs {
        if !l.model.is_empty() && !models.contains(&l.model) {
            models.push(l.model.clone());
        }
    }
    let lesson_ok = verdict == "pass" && has_evidence && i.interrupted == 0;
    let mut out = json!({
        "missionId": i.mission_id,
        "verdict": verdict,
        "flags": flags,
        "totals": {
            "requests": i.logs.len(),
            "tokens_in": i.logs.iter().map(|l| l.tokens_in).sum::<f64>(),
            "tokens_out": i.logs.iter().map(|l| l.tokens_out).sum::<f64>(),
            "cost": (i.logs.iter().map(|l| l.cost).sum::<f64>() * 1e6).round() / 1e6,
            "wasted_tokens": wasted,
            "tool_calls": ran.len(),
            "tool_failures": failures.len(),
        },
        "models": models,
        "lessonOk": lesson_ok,
    });
    if let Some(d) = i.clef_done {
        out["done"] = d;
    }
    out
}

pub fn review_json(s: &str) -> Result<String, String> {
    Ok(review(serde_json::from_str(s).map_err(|e| e.to_string())?).to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn base() -> ReviewIn {
        serde_json::from_value(json!({
            "missionId": "m", "status": "done", "finalText": "ok", "events": [{ "tool": "web_search", "args_hash": "a", "ok": true }],
            "logs": [{ "model": "x", "success": true, "status": 200, "tokens_in": 100, "tokens_out": 50 }], "evidence": "https://a.b"
        }))
        .unwrap()
    }
    #[test]
    fn pass_and_lesson() {
        let r = review(base());
        assert_eq!(r["verdict"], "pass");
        assert_eq!(r["lessonOk"], true);
    }
    #[test]
    fn interrupted_is_partial_no_lesson() {
        let mut b = base();
        b.interrupted = 1;
        let r = review(b);
        assert_eq!(r["verdict"], "pass");
        assert_eq!(r["lessonOk"], false);
        assert!(r["flags"].to_string().contains("interrupted"));
    }
    #[test]
    fn uncited_fails_and_no_evidence_no_lesson() {
        let mut b = base();
        b.uncited = vec!["https://x.y".into()];
        assert_eq!(review(b)["verdict"], "fail");
        let mut b = base();
        b.evidence = None;
        assert_eq!(review(b)["lessonOk"], false);
    }
    #[test]
    fn clef_not_done_blocks() {
        let mut b = base();
        b.clef_done = Some(json!({ "done": false, "pDone": 0.3, "pEvidence": 0.2 }));
        assert_eq!(review(b)["verdict"], "fail");
    }
}
