//! Navigation decisions: where a signed-out visitor goes, and which return paths are safe.
use serde::Deserialize;
use serde_json::json;

const DEFAULT_NEXT: &str = "/home";

/// A return path is safe only if it is a same-origin absolute path: starts with one `/`,
/// not `//` or `/\` (protocol-relative), no backslashes or control characters, bounded length.
pub fn safe_next(next: &str) -> String {
    let ok = next.len() <= 512
        && next.starts_with('/')
        && !next.starts_with("//")
        && !next.contains('\\')
        && !next.chars().any(|c| c.is_control());
    if ok { next.to_string() } else { DEFAULT_NEXT.to_string() }
}

fn enc(s: &str) -> String {
    let mut o = String::new();
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' | b'/' => o.push(b as char),
            _ => o.push_str(&format!("%{:02X}", b)),
        }
    }
    o
}

/// Sign-in page carrying a (sanitized) return path.
pub fn login_url(next: &str) -> String {
    format!("/login/?next={}", enc(&safe_next(next)))
}

/// Legacy app paths that used to bounce to /home for everyone.
pub fn is_app_alias(path: &str) -> bool {
    matches!(path.trim_end_matches('/'), "/board" | "/missions" | "/map" | "/evidence")
}

#[derive(Deserialize)]
struct NavIn {
    path: String,
    #[serde(default)]
    search: String,
    #[serde(default)]
    signed_in: bool,
    /// The board is owner-only; other signed-in accounts keep their tenant home.
    #[serde(default)]
    owner: bool,
}

/// Where an app page request should go: signed in owner -> the board (/); signed out -> /login/?next=<path>.
pub fn app_redirect_json(input: &str) -> Result<String, String> {
    let i: NavIn = serde_json::from_str(input).map_err(|e| e.to_string())?;
    let here = format!("{}{}", i.path, i.search);
    let location = match (i.signed_in, i.owner) {
        (true, true) => "/".to_string(),
        (true, false) => DEFAULT_NEXT.to_string(),
        _ => login_url(&here),
    };
    Ok(json!({ "location": location, "alias": is_app_alias(&i.path) }).to_string())
}

#[derive(Deserialize)]
struct NextIn {
    next: Option<String>,
}

pub fn safe_next_json(input: &str) -> Result<String, String> {
    let i: NextIn = serde_json::from_str(input).map_err(|e| e.to_string())?;
    Ok(json!({ "next": safe_next(i.next.as_deref().unwrap_or("")) }).to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn next_rejects_offsite() {
        assert_eq!(safe_next("/now"), "/now");
        assert_eq!(safe_next("/m/abc?x=1"), "/m/abc?x=1");
        for bad in ["//evil.com", "/\\evil.com", "https://evil.com", "", "evil", "/a\nb"] {
            assert_eq!(safe_next(bad), "/home", "{bad}");
        }
    }
    #[test]
    fn signed_out_goes_to_login_with_return() {
        let o = app_redirect_json(r#"{"path":"/board","search":"?a=1&b=2","signed_in":false}"#).unwrap();
        assert!(o.contains(r#""location":"/login/?next=/board%3Fa%3D1%26b%3D2""#), "{o}");
        let o = app_redirect_json(r#"{"path":"/missions/","signed_in":true,"owner":true}"#).unwrap();
        assert!(o.contains(r#""location":"/""#) && o.contains(r#""alias":true"#));
        let o = app_redirect_json(r#"{"path":"/board","signed_in":true}"#).unwrap();
        assert!(o.contains(r#""location":"/home""#), "{o}");
        assert!(login_url("//evil.com").ends_with("next=/home"));
    }
}
