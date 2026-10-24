//! Owner notices (kingdom model): Alfred tells the default king (Hans) when someone joins.
//! Metadata only, from the signup itself: who (name, email, tenant handle), how, when. Never
//! anything from inside the new kingdom (missions, memory, mail, files).

use serde_json::{json, Value};

fn clean(s: &str, max: usize) -> String {
    s.chars().filter(|c| !c.is_control()).collect::<String>().trim().chars().take(max).collect()
}

pub fn new_user(v: &Value) -> Result<Value, String> {
    let tenant = clean(v["tenant_id"].as_str().unwrap_or(""), 100);
    let email = clean(v["email"].as_str().unwrap_or(""), 254).to_lowercase();
    if tenant.is_empty() || !email.contains('@') {
        return Err("notice: tenant_id and email required".into());
    }
    let name = clean(v["name"].as_str().unwrap_or(""), 80);
    let method = match v["method"].as_str() {
        Some("google") => "google",
        _ => "password",
    };
    let at = v["at"].as_i64().unwrap_or(0);
    let who = if name.is_empty() { email.clone() } else { format!("{name} <{email}>") };
    Ok(json!({
        "kind": "new_user",
        "tenant_id": tenant,
        "email": email,
        "name": name,
        "method": method,
        "at": at,
        "text": format!("New user: {who} joined as {tenant} via {method}."),
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn metadata_only_and_clean() {
        let n = new_user(&json!({ "tenant_id": "martin", "email": "Martin@Example.com", "name": "Martin\u{7} K", "method": "google", "at": 5, "missions": ["secret"] })).unwrap();
        assert_eq!(n["text"], "New user: Martin K <martin@example.com> joined as martin via google.");
        assert!(n.get("missions").is_none());
        assert!(new_user(&json!({ "tenant_id": "", "email": "a@b" })).is_err());
    }
}
