//! MCP token format, scope parsing, and tool allow-list. D1 hash lookup and DO RPC stay in TS.
use serde::{Deserialize, Serialize};
use serde_json::json;

pub const TOKEN_PREFIX: &str = "art_";
pub const TOKEN_MIN_LEN: usize = 40;
pub const AGENT_SCOPES: &[&str] = &["missions:read", "missions:write", "ask", "report:read", "spend:read", "memory:read"];
pub const SUPPORTED_PROTOCOL: &[&str] = &["2025-06-18", "2025-03-26", "2024-11-05"];

#[derive(Clone, Serialize)]
pub struct Tool {
    pub name: &'static str,
    pub scope: &'static str,
    #[serde(rename = "ownerOnly", skip_serializing_if = "std::ops::Not::not")]
    pub owner_only: bool,
    pub description: &'static str,
    #[serde(rename = "inputSchema")]
    pub input_schema: serde_json::Value,
}

fn no_args() -> serde_json::Value {
    json!({ "type": "object", "properties": {}, "additionalProperties": false })
}

pub fn tools() -> Vec<Tool> {
    vec![
        Tool { name: "mission_list", scope: "missions:read", owner_only: false, description: "List this tenant's missions (newest first).", input_schema: no_args() },
        Tool {
            name: "mission_get",
            scope: "missions:read",
            owner_only: false,
            description: "Get one Alfred mission: status, steps, verdict and evidence.",
            input_schema: json!({ "type": "object", "properties": { "id": { "type": "string" } }, "required": ["id"] }),
        },
        Tool {
            name: "mission_create",
            scope: "missions:write",
            owner_only: true,
            description: "Start an Alfred mission (owner tenant). Returns the missionId; poll mission_get.",
            input_schema: json!({
                "type": "object",
                "properties": { "objective": { "type": "string", "minLength": 3, "maxLength": 4000 }, "requireEvidence": { "type": "boolean" } },
                "required": ["objective"]
            }),
        },
        Tool {
            name: "mission_act",
            scope: "missions:write",
            owner_only: false,
            description: "Act on a mission: close | archive | open.",
            input_schema: json!({
                "type": "object",
                "properties": { "id": { "type": "string" }, "act": { "type": "string", "enum": ["close", "archive", "open"] } },
                "required": ["id", "act"]
            }),
        },
        Tool {
            name: "ask",
            scope: "ask",
            owner_only: false,
            description: "Ask Alfred (counts against the tenant's daily ask quota).",
            input_schema: json!({ "type": "object", "properties": { "prompt": { "type": "string", "maxLength": 8000 } }, "required": ["prompt"] }),
        },
        Tool { name: "report", scope: "report:read", owner_only: false, description: "The Report: recent missions, success/fail, synopsis, attention.", input_schema: no_args() },
        Tool { name: "spend", scope: "spend:read", owner_only: false, description: "Today's neuron spend vs the daily cap.", input_schema: no_args() },
        Tool {
            name: "memory_recall",
            scope: "memory:read",
            owner_only: false,
            description: "Recall this tenant's memory rows.",
            input_schema: json!({ "type": "object", "properties": { "limit": { "type": "number", "minimum": 1, "maximum": 50 } } }),
        },
    ]
}

pub fn token_format_ok(bearer: &str) -> bool {
    bearer.starts_with(TOKEN_PREFIX) && bearer.len() >= TOKEN_MIN_LEN
}

pub fn parse_scopes(list: &[String]) -> Result<Vec<String>, String> {
    let mut out: Vec<String> = Vec::new();
    for raw in list {
        let s = raw.trim();
        if s.is_empty() {
            continue;
        }
        if !AGENT_SCOPES.contains(&s) {
            return Err(format!("unknown scope: {s}"));
        }
        if !out.iter().any(|x| x == s) {
            out.push(s.to_string());
        }
    }
    Ok(out)
}

pub fn allowed(tool: &Tool, scopes: &[String], is_owner: bool) -> bool {
    scopes.iter().any(|s| s == tool.scope) && (!tool.owner_only || is_owner)
}

pub fn check_tool(name: &str, scopes: &[String], is_owner: bool) -> Result<(), String> {
    let tool = tools().into_iter().find(|t| t.name == name).ok_or_else(|| format!("Unknown tool: {name}"))?;
    if !allowed(&tool, scopes, is_owner) {
        let extra = if tool.owner_only { " (owner tenant)" } else { "" };
        return Err(format!("forbidden: {name} needs scope {}{extra}", tool.scope));
    }
    Ok(())
}

pub fn filtered_tools(scopes: &[String], is_owner: bool) -> Vec<serde_json::Value> {
    tools()
        .into_iter()
        .filter(|t| allowed(t, scopes, is_owner))
        .map(|t| json!({ "name": t.name, "description": t.description, "inputSchema": t.input_schema }))
        .collect()
}

pub fn negotiate_protocol(asked: &str) -> &'static str {
    SUPPORTED_PROTOCOL.iter().copied().find(|p| *p == asked).unwrap_or(SUPPORTED_PROTOCOL[0])
}

#[derive(Deserialize)]
struct ScopesIn {
    #[serde(default)]
    input: serde_json::Value,
}

fn values_to_list(v: &serde_json::Value) -> Vec<String> {
    match v {
        serde_json::Value::Array(a) => a.iter().filter_map(|x| x.as_str().map(|s| s.to_string())).collect(),
        serde_json::Value::String(s) => s.split(',').map(|x| x.to_string()).collect(),
        serde_json::Value::Null => vec![],
        _ => vec![],
    }
}

pub fn parse_scopes_json(s: &str) -> Result<String, String> {
    let i: ScopesIn = serde_json::from_str(s).map_err(|e| e.to_string())?;
    let list = values_to_list(&i.input);
    Ok(serde_json::to_string(&parse_scopes(&list)?).unwrap())
}

#[derive(Deserialize)]
struct WhoIn {
    #[serde(default)]
    scopes: Vec<String>,
    #[serde(default)]
    is_owner: bool,
}

pub fn tools_json(s: &str) -> Result<String, String> {
    let i: WhoIn = serde_json::from_str(s).map_err(|e| e.to_string())?;
    Ok(serde_json::to_string(&filtered_tools(&i.scopes, i.is_owner)).unwrap())
}

#[derive(Deserialize)]
struct AllowIn {
    name: String,
    #[serde(default)]
    scopes: Vec<String>,
    #[serde(default)]
    is_owner: bool,
}

pub fn allow_json(s: &str) -> Result<String, String> {
    let i: AllowIn = serde_json::from_str(s).map_err(|e| e.to_string())?;
    check_tool(&i.name, &i.scopes, i.is_owner)?;
    Ok(json!({ "ok": true }).to_string())
}

#[derive(Deserialize)]
struct TokenIn {
    #[serde(default)]
    bearer: String,
}

pub fn token_ok_json(s: &str) -> Result<String, String> {
    let i: TokenIn = serde_json::from_str(s).map_err(|e| e.to_string())?;
    Ok(json!({ "ok": token_format_ok(&i.bearer) }).to_string())
}

#[derive(Deserialize)]
struct ProtoIn {
    #[serde(default)]
    asked: String,
}

pub fn protocol_json(s: &str) -> Result<String, String> {
    let i: ProtoIn = serde_json::from_str(s).map_err(|e| e.to_string())?;
    Ok(serde_json::to_string(negotiate_protocol(&i.asked)).unwrap())
}

pub fn scopes_catalog_json(_s: &str) -> Result<String, String> {
    Ok(serde_json::to_string(&AGENT_SCOPES).unwrap())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tools_filtered_by_scope_and_owner() {
        let names = |scopes: &[&str], owner: bool| {
            filtered_tools(&scopes.iter().map(|s| s.to_string()).collect::<Vec<_>>(), owner)
                .into_iter()
                .map(|t| t["name"].as_str().unwrap().to_string())
                .collect::<Vec<_>>()
        };
        assert_eq!(names(&["report:read"], false), vec!["report"]);
        assert!(!names(&["missions:write", "missions:read"], false).contains(&"mission_create".into()));
        assert!(names(&["missions:write"], true).contains(&"mission_create".into()));
    }

    #[test]
    fn unknown_scopes_rejected() {
        assert!(parse_scopes(&["admin".into()]).unwrap_err().contains("unknown scope"));
        assert_eq!(parse_scopes(&["ask".into(), "ask".into()]).unwrap(), vec!["ask"]);
        assert_eq!(parse_scopes(&[" report:read ".into()]).unwrap(), vec!["report:read"]);
    }

    #[test]
    fn allow_refuses_out_of_scope() {
        let scopes = vec!["report:read".into()];
        assert!(check_tool("spend", &scopes, false).unwrap_err().contains("forbidden"));
        assert!(check_tool("report", &scopes, false).is_ok());
        assert!(check_tool("nope", &scopes, false).unwrap_err().contains("Unknown tool"));
        assert!(check_tool("mission_create", &["missions:write".into()], false).unwrap_err().contains("owner tenant"));
        assert!(check_tool("mission_create", &["missions:write".into()], true).is_ok());
    }

    #[test]
    fn token_format_and_protocol() {
        assert!(!token_format_ok("art_short"));
        assert!(!token_format_ok("tok_abcdefghijklmnopqrstuvwxyz0123456789"));
        assert!(token_format_ok("art_abcdefghijklmnopqrstuvwxyz0123456789"));
        assert_eq!(negotiate_protocol("2025-03-26"), "2025-03-26");
        assert_eq!(negotiate_protocol("nope"), "2025-06-18");
    }
}
