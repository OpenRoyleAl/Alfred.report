//! The Report: deterministic spoken status of recent missions. No model writes it.
use serde::{Deserialize, Serialize};

pub const REPORT_LIMIT: usize = 5;
pub const STUCK_AFTER_MS: u64 = 30 * 60 * 1000;

#[derive(Deserialize, Clone)]
pub struct Flag {
    pub kind: String,
    #[serde(default)]
    pub blocking: bool,
}

#[derive(Deserialize, Clone)]
#[serde(untagged)]
pub enum Done {
    Gate { done: bool },
    Unavailable(String),
}

#[derive(Deserialize, Clone, Default)]
pub struct Review {
    #[serde(default)]
    pub flags: Vec<Flag>,
    #[serde(default)]
    pub done: Option<Done>,
}

#[derive(Deserialize, Clone)]
pub struct MissionRow {
    pub id: String,
    #[serde(default)]
    pub objective: String,
    #[serde(default)]
    pub status: String,
    #[serde(default)]
    pub verdict: Option<String>,
    #[serde(default)]
    pub started_at: u64,
    #[serde(default)]
    pub finished_at: Option<u64>,
    #[serde(default)]
    pub review: Option<Review>,
}

#[derive(Serialize, Deserialize, Clone, PartialEq, Debug)]
pub struct ReportItem {
    pub id: String,
    pub title: String,
    pub outcome: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    #[serde(rename = "clefDone")]
    pub clef_done: Option<bool>,
}

#[derive(Serialize, Deserialize, Clone, PartialEq, Debug)]
pub struct Counts {
    pub success: u32,
    pub fail: u32,
    pub running: u32,
}

#[derive(Serialize, Deserialize, Clone, PartialEq, Debug)]
pub struct TheReport {
    pub brand: String,
    #[serde(rename = "generatedAt")]
    pub generated_at: u64,
    pub items: Vec<ReportItem>,
    pub counts: Counts,
    pub synopsis: String,
    pub attention: Vec<String>,
}

fn flag_words(kind: &str) -> String {
    match kind {
        "escalated" => "needs your approval".into(),
        "clef_not_done" => "not finished".into(),
        "no_evidence" => "no proof it was done".into(),
        "unanswered" => "did not finish".into(),
        "failed_tool" => "tools kept failing".into(),
        "loop" => "got stuck in a loop".into(),
        "wasted_tokens" => "wasted effort".into(),
        "failed_request" => "model calls failed".into(),
        "logs_missing" => "logs missing".into(),
        "clef_unavailable" => "done check unavailable".into(),
        other => other.into(),
    }
}

fn strip_forwarded(s: &str) -> &str {
    const P: &str = "forwarded email:";
    if s.len() >= P.len() && s[..P.len()].eq_ignore_ascii_case(P) {
        s[P.len()..].trim_start()
    } else {
        s
    }
}

fn first_sentence(s: &str) -> &str {
    let mut prev: Option<(usize, char)> = None;
    for (i, c) in s.char_indices() {
        if c == '\n' {
            if let Some((pi, pc)) = prev {
                if matches!(pc, '.' | '!' | '?') {
                    return &s[..pi + pc.len_utf8()];
                }
            }
            return &s[..i];
        }
        if let Some((pi, pc)) = prev {
            if matches!(pc, '.' | '!' | '?') && c.is_whitespace() {
                return &s[..pi + pc.len_utf8()];
            }
        }
        prev = Some((i, c));
    }
    s
}

pub fn short_title(objective: &str, words: usize) -> String {
    let first = first_sentence(strip_forwarded(objective));
    let w: Vec<&str> = first.split_whitespace().collect();
    if w.is_empty() {
        return "untitled mission".into();
    }
    let mut t = w.iter().take(words).copied().collect::<Vec<_>>().join(" ");
    while t.chars().last().is_some_and(|c| matches!(c, '.' | ',' | ';' | ':' | '!' | '?')) {
        t.pop();
    }
    if w.len() > words {
        format!("{t}...")
    } else if t.is_empty() {
        "untitled mission".into()
    } else {
        t
    }
}

pub fn outcome_of(m: &MissionRow) -> &'static str {
    if m.status == "running" || (m.finished_at.is_none() && m.verdict.as_deref().is_none_or(|v| v.is_empty())) {
        "running"
    } else if m.status == "done" && m.verdict.as_deref() == Some("pass") {
        "success"
    } else {
        "fail"
    }
}

fn clef_done_of(r: Option<&Review>) -> Option<bool> {
    match r.and_then(|x| x.done.as_ref()) {
        Some(Done::Gate { done }) => Some(*done),
        Some(Done::Unavailable(s)) if s == "unavailable" => None,
        _ => None,
    }
}

fn reason_of(m: &MissionRow) -> Option<String> {
    let flags = m.review.as_ref().map(|r| r.flags.as_slice()).unwrap_or(&[]);
    let outcome = outcome_of(m);
    let f = flags.iter().find(|x| x.blocking).or_else(|| if outcome == "fail" { flags.first() } else { None });
    if let Some(f) = f {
        return Some(flag_words(&f.kind));
    }
    if outcome == "fail" {
        return Some(if m.status == "done" { "failed review".into() } else { "did not finish".into() });
    }
    None
}

pub fn build_report(brand: &str, rows: &[MissionRow], now: u64, limit: usize) -> TheReport {
    let mut recent: Vec<MissionRow> = rows.to_vec();
    recent.sort_by(|a, b| b.started_at.cmp(&a.started_at));
    recent.truncate(limit);
    let items: Vec<ReportItem> = recent
        .iter()
        .map(|m| ReportItem {
            id: m.id.clone(),
            title: short_title(&m.objective, 8),
            outcome: outcome_of(m).into(),
            reason: reason_of(m),
            clef_done: clef_done_of(m.review.as_ref()),
        })
        .collect();
    let mut counts = Counts { success: 0, fail: 0, running: 0 };
    for i in &items {
        match i.outcome.as_str() {
            "success" => counts.success += 1,
            "fail" => counts.fail += 1,
            _ => counts.running += 1,
        }
    }
    let mut attention = Vec::new();
    for (m, i) in recent.iter().zip(items.iter()) {
        if i.outcome == "fail" {
            attention.push(format!("{}: {}", i.title, i.reason.clone().unwrap_or_default()));
        } else if i.outcome == "running" && now.saturating_sub(m.started_at) > STUCK_AFTER_MS {
            let mins = ((now - m.started_at) as f64 / 60_000.0).round() as u64;
            attention.push(format!("{}: still running after {mins} minutes", i.title));
        }
    }
    let synopsis = if items.is_empty() {
        "No missions yet.".into()
    } else {
        let mut parts = Vec::new();
        if counts.success > 0 {
            parts.push(format!("{} succeeded", counts.success));
        }
        if counts.fail > 0 {
            parts.push(format!("{} failed", counts.fail));
        }
        if counts.running > 0 {
            parts.push(format!("{} running", counts.running));
        }
        let n = items.len();
        format!("{n} recent mission{}: {}.", if n == 1 { "" } else { "s" }, parts.join(", "))
    };
    TheReport { brand: brand.into(), generated_at: now, items, counts, synopsis, attention }
}

pub fn speak_report(r: &TheReport) -> String {
    let mut out = vec![format!("{} The Report.", r.brand), r.synopsis.clone()];
    for i in &r.items {
        match i.outcome.as_str() {
            "success" => out.push(format!("Success: {}{}.", i.title, if i.clef_done == Some(true) { ", verified done" } else { "" })),
            "fail" => out.push(format!("Fail: {}.", i.title)),
            _ => out.push(format!("Running: {}.", i.title)),
        }
    }
    out.push(if r.attention.is_empty() {
        "Nothing needs your attention.".into()
    } else {
        format!("Needs attention: {}.", r.attention.iter().take(3).cloned().collect::<Vec<_>>().join("; "))
    });
    out.join(" ")
}

#[derive(Deserialize)]
struct BuildIn {
    brand: String,
    #[serde(default)]
    rows: Vec<MissionRow>,
    now: u64,
    #[serde(default)]
    limit: Option<usize>,
}

pub fn build_json(s: &str) -> Result<String, String> {
    let i: BuildIn = serde_json::from_str(s).map_err(|e| e.to_string())?;
    Ok(serde_json::to_string(&build_report(&i.brand, &i.rows, i.now, i.limit.unwrap_or(REPORT_LIMIT))).unwrap())
}

pub fn speak_json(s: &str) -> Result<String, String> {
    let r: TheReport = serde_json::from_str(s).map_err(|e| e.to_string())?;
    Ok(serde_json::to_string(&speak_report(&r)).unwrap())
}

#[derive(Deserialize)]
struct TitleIn {
    objective: String,
    #[serde(default)]
    words: Option<usize>,
}

pub fn title_json(s: &str) -> Result<String, String> {
    let i: TitleIn = serde_json::from_str(s).map_err(|e| e.to_string())?;
    Ok(serde_json::to_string(&short_title(&i.objective, i.words.unwrap_or(8))).unwrap())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn row(id: &str, objective: &str, status: &str, verdict: Option<&str>, started: u64, finished: Option<u64>, review: Option<Review>) -> MissionRow {
        MissionRow {
            id: id.into(),
            objective: objective.into(),
            status: status.into(),
            verdict: verdict.map(|s| s.into()),
            started_at: started,
            finished_at: finished,
            review,
        }
    }
    fn pass_review(done: bool) -> Review {
        Review { flags: vec![], done: Some(Done::Gate { done }) }
    }

    #[test]
    fn empty_report() {
        let r = build_report("acme.report!", &[], 5000, REPORT_LIMIT);
        assert_eq!(r.synopsis, "No missions yet.");
        assert_eq!(speak_report(&r), "acme.report! The Report. No missions yet. Nothing needs your attention.");
    }

    #[test]
    fn success_fail_running() {
        let now = 10_000_000u64;
        let rows = vec![
            row("a", "Renew the domain for the shop.", "done", Some("pass"), now - 3000, Some(now), Some(pass_review(true))),
            row(
                "b",
                "Send the invoice to the client",
                "done",
                Some("fail"),
                now - 2000,
                Some(now),
                Some(Review { flags: vec![Flag { kind: "escalated".into(), blocking: true }], done: Some(Done::Gate { done: true }) }),
            ),
            row("c", "Check the uptime", "running", None, now - STUCK_AFTER_MS - 60_000, None, None),
        ];
        let r = build_report("acme.report!", &rows, now, REPORT_LIMIT);
        assert_eq!(r.counts, Counts { success: 1, fail: 1, running: 1 });
        assert_eq!(r.synopsis, "3 recent missions: 1 succeeded, 1 failed, 1 running.");
        assert_eq!(r.items.iter().map(|i| i.outcome.as_str()).collect::<Vec<_>>(), vec!["fail", "success", "running"]);
        assert_eq!(
            r.attention,
            vec!["Send the invoice to the client: needs your approval".to_string(), "Check the uptime: still running after 31 minutes".to_string()]
        );
        let spoken = speak_report(&r);
        assert!(spoken.starts_with("acme.report! The Report. 3 recent missions"));
        assert!(spoken.contains("Success: Renew the domain for the shop, verified done."));
        assert!(spoken.contains("Fail: Send the invoice to the client."));
    }

    #[test]
    fn clef_not_done_and_unavailable() {
        let fail = row(
            "m1",
            "Renew the domain for the shop.",
            "done",
            Some("fail"),
            1000,
            Some(2000),
            Some(Review { flags: vec![Flag { kind: "clef_not_done".into(), blocking: true }], done: Some(Done::Gate { done: false }) }),
        );
        let r = build_report("x.report!", &[fail], 3000, REPORT_LIMIT);
        assert_eq!(r.items[0].outcome, "fail");
        assert_eq!(r.items[0].clef_done, Some(false));
        assert_eq!(r.attention, vec!["Renew the domain for the shop: not finished"]);

        let ok = row(
            "m1",
            "Renew the domain for the shop.",
            "done",
            Some("pass"),
            1000,
            Some(2000),
            Some(Review { flags: vec![Flag { kind: "clef_unavailable".into(), blocking: false }], done: Some(Done::Unavailable("unavailable".into())) }),
        );
        let r = build_report("x.report!", &[ok], 3000, REPORT_LIMIT);
        assert_eq!(r.items[0].clef_done, None);
        assert!(speak_report(&r).contains("Success: Renew the domain for the shop."));
        assert!(!speak_report(&r).contains("verified"));
    }

    #[test]
    fn limit_and_titles() {
        let rows: Vec<_> = (0..9).map(|i| row(&i.to_string(), "Renew the domain for the shop.", "done", Some("pass"), i, Some(i), Some(pass_review(true)))).collect();
        assert_eq!(build_report("x!", &rows, 100, REPORT_LIMIT).items.len(), 5);
        assert_eq!(
            short_title("Forwarded email: please book the venue for the twelve person team offsite next month", 8),
            "please book the venue for the twelve person..."
        );
        let unanswered = row("u", "x", "unanswered", Some("fail"), 1, Some(2), None);
        assert_eq!(outcome_of(&unanswered), "fail");
    }
}
