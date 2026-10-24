//! Agent sign-up for the MCP (auth.md / WorkOS agent-auth "service_auth" pattern, RFC 8628 shape).
//!
//! An agent registers with a `login_hint`; it gets a claim (user_code, verification_uri, expires_in,
//! interval) plus a claim_token it keeps in memory. A king signs in on the instance, enters the
//! code and approves scopes for their own kingdom; the agent's next poll gets a scoped, revocable,
//! per-agent key (stored hashed by the Worker). All decisions here are pure; TS does D1 + crypto.

use serde::Deserialize;
use serde_json::{json, Value};

pub const CLAIM_TTL_S: u64 = 600;
pub const POLL_INTERVAL_S: u64 = 5;
/// Registrations per network (hashed IP) and per login_hint, per hour.
pub const REG_PER_IP_HOUR: u32 = 5;
pub const REG_PER_HINT_HOUR: u32 = 3;
/// Wrong user codes a signed-in king may enter per 10 minutes.
pub const CODE_TRIES_PER_10M: u32 = 5;
pub const DEFAULT_SCOPES: &[&str] = &["missions:read", "report:read"];
/// No vowels or look-alikes (0/O, 1/I/L): codes cannot spell words and survive being read aloud.
const ALPHABET: &[u8] = b"BCDFGHJKMNPQRSTVWXZ";

/// XXXX-XXXX from 8 random bytes (rejection sampling keeps the alphabet uniform).
pub fn user_code(bytes: &[u8]) -> Result<String, String> {
    let n = ALPHABET.len() as u8;
    let lim = 255 - (255 % n as u16) as u8; // accept b < lim
    let picked: Vec<char> = bytes.iter().filter(|b| **b < lim).map(|b| ALPHABET[(b % n) as usize] as char).take(8).collect();
    if picked.len() < 8 {
        return Err("need more random bytes".into());
    }
    let s: String = picked.into_iter().collect();
    Ok(format!("{}-{}", &s[..4], &s[4..]))
}

/// Canonical form for lookup: upper-case, separators dropped; None if it cannot be a code.
pub fn normalize_code(s: &str) -> Option<String> {
    let c: String = s.chars().filter(|c| !matches!(c, '-' | ' ' | '_')).map(|c| c.to_ascii_uppercase()).collect();
    (c.len() == 8 && c.bytes().all(|b| ALPHABET.contains(&b))).then_some(c)
}

fn email_ok(e: &str) -> bool {
    let e = e.trim();
    let Some((l, d)) = e.split_once('@') else { return false };
    !l.is_empty() && e.len() <= 254 && d.contains('.') && !d.starts_with('.') && !d.ends_with('.') && !e.chars().any(|c| c.is_whitespace() || c == '<' || c == '>')
}

fn clean_name(v: &Value, fallback: &str) -> String {
    let s: String = v.as_str().unwrap_or("").chars().filter(|c| !c.is_control()).take(60).collect();
    let s = s.trim().to_string();
    if s.is_empty() { fallback.to_string() } else { s }
}

/// Validate a registration body. Scopes go through the MCP scope parser (one scope list).
pub fn register(v: &Value) -> Result<Value, String> {
    let t = v["type"].as_str().unwrap_or("service_auth");
    if t != "service_auth" {
        return Err("unsupported_identity_type".into());
    }
    let hint = v["login_hint"].as_str().unwrap_or("").trim().to_ascii_lowercase();
    if !email_ok(&hint) {
        return Err("invalid_request: login_hint must be the user's email".into());
    }
    let scopes = match &v["scope"] {
        Value::String(s) if !s.trim().is_empty() => crate::mcp::parse_scopes(&s.split_whitespace().map(String::from).collect::<Vec<_>>())?,
        Value::Array(a) => crate::mcp::parse_scopes(&a.iter().filter_map(|x| x.as_str().map(String::from)).collect::<Vec<_>>())?,
        _ => DEFAULT_SCOPES.iter().map(|s| s.to_string()).collect(),
    };
    if scopes.is_empty() {
        return Err("invalid_scope".into());
    }
    Ok(json!({
        "login_hint": hint,
        "api_key_name": clean_name(&v["api_key_name"], "Agent"),
        "client_name": clean_name(&v["client_name"], "unknown client"),
        "scopes": scopes,
    }))
}

#[derive(Deserialize)]
pub struct RateIn {
    pub ip_hour: u32,
    pub hint_hour: u32,
}

pub fn rate(r: &RateIn) -> Value {
    let ok = r.ip_hour < REG_PER_IP_HOUR && r.hint_hour < REG_PER_HINT_HOUR;
    json!({ "ok": ok, "retry_after": if ok { 0 } else { 3600 } })
}

#[derive(Deserialize)]
pub struct PollIn {
    /// pending | approved | denied | issued | expired | missing
    pub status: String,
    #[serde(default)]
    pub expires_at: f64,
    #[serde(default)]
    pub last_poll_at: Option<f64>,
    pub now: f64,
}

/// Token-endpoint decision for one poll (RFC 8628 error codes).
pub fn poll(p: &PollIn) -> Value {
    let err = |e: &str, d: &str| json!({ "action": "deny", "code": e, "detail": d });
    match p.status.as_str() {
        "missing" => err("invalid_grant", "unknown claim_token"),
        "issued" => err("invalid_grant", "this claim was already exchanged; start a new registration"),
        "denied" => err("access_denied", "the user denied this agent"),
        _ if p.now >= p.expires_at || p.status == "expired" => err("expired_token", "the setup code expired; start a new registration with the user's agreement"),
        "approved" => json!({ "action": "issue" }),
        "pending" => match p.last_poll_at {
            Some(t) if p.now - t < (POLL_INTERVAL_S as f64) * 1000.0 - 250.0 => json!({ "action": "deny", "code": "slow_down", "detail": format!("poll at most every {POLL_INTERVAL_S} s"), "touch": true }),
            _ => json!({ "action": "deny", "code": "authorization_pending", "detail": "waiting for the user to enter the code and approve", "touch": true }),
        },
        _ => err("invalid_grant", "claim in an unknown state"),
    }
}

/// Scopes the king approved: a non-empty subset of what the agent asked for.
pub fn grant(requested: &[String], approved: &[String]) -> Result<Vec<String>, String> {
    let g: Vec<String> = approved.iter().filter(|s| requested.contains(s)).cloned().collect();
    if g.is_empty() {
        return Err("approve at least one requested scope".into());
    }
    Ok(g)
}

/// Owner notice (metadata only): which agent connected to which kingdom with which scopes.
pub fn notice(v: &Value) -> Value {
    let name = clean_name(&v["api_key_name"], "Agent");
    let client = clean_name(&v["client_name"], "unknown client");
    let tenant = v["tenant_id"].as_str().unwrap_or("");
    let scopes: Vec<String> = v["scopes"].as_array().map(|a| a.iter().filter_map(|x| x.as_str().map(String::from)).collect()).unwrap_or_default();
    json!({
        "kind": "agent",
        "tenant_id": tenant,
        "text": format!("New agent connected: {name} ({client}) to kingdom {tenant} with {}.", scopes.join(", ")),
    })
}

pub fn op_json(input: &str) -> Result<String, String> {
    let v: Value = serde_json::from_str(input).map_err(|e| e.to_string())?;
    let a = &v["args"];
    let out = match v["op"].as_str().unwrap_or("") {
        "user_code" => {
            let bytes: Vec<u8> = a["bytes"].as_array().map(|x| x.iter().filter_map(|b| b.as_u64().map(|n| n as u8)).collect()).unwrap_or_default();
            json!({ "code": user_code(&bytes)? })
        }
        "normalize" => json!({ "code": normalize_code(a["code"].as_str().unwrap_or("")) }),
        "register" => register(a)?,
        "rate" => rate(&serde_json::from_value(a.clone()).map_err(|e| e.to_string())?),
        "poll" => poll(&serde_json::from_value(a.clone()).map_err(|e| e.to_string())?),
        "grant" => {
            let l = |k: &str| -> Vec<String> { a[k].as_array().map(|x| x.iter().filter_map(|s| s.as_str().map(String::from)).collect()).unwrap_or_default() };
            json!({ "scopes": grant(&l("requested"), &l("approved"))? })
        }
        "notice" => notice(a),
        "limits" => json!({ "ttl": CLAIM_TTL_S, "interval": POLL_INTERVAL_S, "ip_hour": REG_PER_IP_HOUR, "hint_hour": REG_PER_HINT_HOUR, "code_tries": CODE_TRIES_PER_10M }),
        other => return Err(format!("unknown agent op: {other}")),
    };
    Ok(out.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn codes_are_uniform_and_normalize() {
        let c = user_code(&[0, 1, 2, 3, 4, 5, 6, 7, 255, 254]).unwrap();
        assert_eq!(c.len(), 9);
        assert_eq!(normalize_code(&c.to_lowercase()).unwrap(), c.replace('-', ""));
        assert!(normalize_code("AAAA-AAAA").is_none(), "vowels are not in the alphabet");
        assert!(normalize_code("BCD").is_none());
        assert!(user_code(&[250, 251, 252]).is_err());
    }
    #[test]
    fn register_validates() {
        let r = register(&json!({ "login_hint": "Martin@Example.com", "api_key_name": "Bot\u{7}", "scope": "memory:read ask" })).unwrap();
        assert_eq!(r["login_hint"], "martin@example.com");
        assert_eq!(r["api_key_name"], "Bot");
        assert_eq!(r["scopes"], json!(["memory:read", "ask"]));
        assert_eq!(register(&json!({ "login_hint": "x@y.co" })).unwrap()["scopes"], json!(DEFAULT_SCOPES));
        assert!(register(&json!({ "login_hint": "nope" })).is_err());
        assert!(register(&json!({ "type": "password", "login_hint": "x@y.co" })).is_err());
        assert!(register(&json!({ "login_hint": "x@y.co", "scope": "root" })).is_err());
    }
    #[test]
    fn poll_states() {
        let p = |s: &str, last: Option<f64>, now: f64| poll(&PollIn { status: s.into(), expires_at: 10_000.0, last_poll_at: last, now });
        assert_eq!(p("pending", None, 1.0)["code"], "authorization_pending");
        assert_eq!(p("pending", Some(1000.0), 2000.0)["code"], "slow_down");
        assert_eq!(p("pending", Some(1000.0), 6000.0)["code"], "authorization_pending");
        assert_eq!(p("approved", None, 1.0)["action"], "issue");
        assert_eq!(p("approved", None, 10_000.0)["code"], "expired_token");
        assert_eq!(p("issued", None, 1.0)["code"], "invalid_grant");
        assert_eq!(p("denied", None, 1.0)["code"], "access_denied");
        assert_eq!(p("missing", None, 1.0)["code"], "invalid_grant");
    }
    #[test]
    fn rate_and_grant() {
        assert_eq!(rate(&RateIn { ip_hour: 4, hint_hour: 2 })["ok"], true);
        assert_eq!(rate(&RateIn { ip_hour: 5, hint_hour: 0 })["ok"], false);
        assert_eq!(rate(&RateIn { ip_hour: 0, hint_hour: 3 })["ok"], false);
        let req = vec!["ask".to_string(), "memory:read".to_string()];
        assert_eq!(grant(&req, &["memory:read".into(), "missions:write".into()]).unwrap(), vec!["memory:read".to_string()]);
        assert!(grant(&req, &["missions:write".into()]).is_err());
    }
}
