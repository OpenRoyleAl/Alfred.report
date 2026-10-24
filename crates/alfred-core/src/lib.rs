//! Alfred.report hot paths, compiled to wasm32 and called from the Workers.
//!
//! This is a wasm *module* (not a workers-rs Worker): JSON in, JSON out over linear memory
//! (`alloc` / `dealloc`, results as packed `(ptr << 32) | len`). Cloudflare documents that
//! `import "*.wasm"` yields a `WebAssembly.Module`; `initCore` instantiates it in every
//! Worker entry. A missing init caused 1101s twice — do not skip it.
//!
//! In Rust: parallel search fusion (RRF) + per-kingdom Exa quota, Exa Lite request/result shape, model floor/primary/429, The Report,
//! MCP token format + scope/tool checks, sliding-window limiters.
//!
//! Not in Rust (needs the JS isolate / Agents SDK): Durable Objects, `routeAgentRequest`,
//! `env.AI.run` on the gateway, D1, Secrets Store, fetch to Ceramic/Exa, MCP JSON-RPC transport.
//!
//! ABI: no wasm-bindgen. workers-rs would pull wasm-bindgen and a JS glue entry, which cannot
//! host the Agents SDK Agent class.

pub mod durable;
pub mod limiter;
pub mod mcp;
pub mod memory;
pub mod notice;
pub mod models;
pub mod nav;
pub mod report;
pub mod review;
pub mod search;
pub mod untrusted;

use std::alloc::{alloc as raw_alloc, dealloc as raw_dealloc, Layout};

#[no_mangle]
pub extern "C" fn alloc(len: usize) -> *mut u8 {
    if len == 0 {
        return std::ptr::NonNull::dangling().as_ptr();
    }
    unsafe { raw_alloc(Layout::from_size_align_unchecked(len, 1)) }
}

#[no_mangle]
pub extern "C" fn dealloc(ptr: *mut u8, len: usize) {
    if len != 0 {
        unsafe { raw_dealloc(ptr, Layout::from_size_align_unchecked(len, 1)) }
    }
}

fn read(ptr: *const u8, len: usize) -> Result<&'static str, String> {
    let bytes = unsafe { std::slice::from_raw_parts(ptr, len) };
    std::str::from_utf8(bytes).map_err(|_| "invalid utf-8".into())
}

fn write(out: String) -> u64 {
    let bytes = out.into_bytes().into_boxed_slice();
    let len = bytes.len();
    let ptr = Box::into_raw(bytes) as *mut u8;
    ((ptr as u64) << 32) | len as u64
}

fn call(ptr: *const u8, len: usize, f: fn(&str) -> Result<String, String>) -> u64 {
    match read(ptr, len).and_then(f) {
        Ok(s) => write(s),
        Err(e) => write(serde_json::json!({ "error": e }).to_string()),
    }
}

#[no_mangle]
pub extern "C" fn search_fuse(ptr: *const u8, len: usize) -> u64 {
    call(ptr, len, search::fuse_json)
}

#[no_mangle]
pub extern "C" fn search_analyze(ptr: *const u8, len: usize) -> u64 {
    call(ptr, len, search::analyze_json)
}

#[no_mangle]
pub extern "C" fn search_lite_url(ptr: *const u8, len: usize) -> u64 {
    call(ptr, len, search::lite_url_json)
}

#[no_mangle]
pub extern "C" fn search_lite_body(ptr: *const u8, len: usize) -> u64 {
    call(ptr, len, search::lite_body_json)
}

#[no_mangle]
pub extern "C" fn search_lite_parse(ptr: *const u8, len: usize) -> u64 {
    call(ptr, len, search::lite_parse_json)
}

#[no_mangle]
pub extern "C" fn search_quota(ptr: *const u8, len: usize) -> u64 {
    call(ptr, len, search::quota_json)
}

#[no_mangle]
pub extern "C" fn models_floor(ptr: *const u8, len: usize) -> u64 {
    call(ptr, len, models::floor_json)
}

#[no_mangle]
pub extern "C" fn models_primary(ptr: *const u8, len: usize) -> u64 {
    call(ptr, len, models::primary_json)
}

#[no_mangle]
pub extern "C" fn models_headers(ptr: *const u8, len: usize) -> u64 {
    call(ptr, len, models::headers_json)
}

#[no_mangle]
pub extern "C" fn models_rate_limited(ptr: *const u8, len: usize) -> u64 {
    call(ptr, len, models::rate_limited_json)
}

#[no_mangle]
pub extern "C" fn models_text(ptr: *const u8, len: usize) -> u64 {
    call(ptr, len, models::text_json)
}

#[no_mangle]
pub extern "C" fn report_build(ptr: *const u8, len: usize) -> u64 {
    call(ptr, len, report::build_json)
}

#[no_mangle]
pub extern "C" fn report_speak(ptr: *const u8, len: usize) -> u64 {
    call(ptr, len, report::speak_json)
}

#[no_mangle]
pub extern "C" fn report_title(ptr: *const u8, len: usize) -> u64 {
    call(ptr, len, report::title_json)
}

#[no_mangle]
pub extern "C" fn mcp_parse_scopes(ptr: *const u8, len: usize) -> u64 {
    call(ptr, len, mcp::parse_scopes_json)
}

#[no_mangle]
pub extern "C" fn mcp_tools(ptr: *const u8, len: usize) -> u64 {
    call(ptr, len, mcp::tools_json)
}

#[no_mangle]
pub extern "C" fn mcp_allow(ptr: *const u8, len: usize) -> u64 {
    call(ptr, len, mcp::allow_json)
}

#[no_mangle]
pub extern "C" fn mcp_token_ok(ptr: *const u8, len: usize) -> u64 {
    call(ptr, len, mcp::token_ok_json)
}

#[no_mangle]
pub extern "C" fn mcp_protocol(ptr: *const u8, len: usize) -> u64 {
    call(ptr, len, mcp::protocol_json)
}

#[no_mangle]
pub extern "C" fn mcp_scopes(ptr: *const u8, len: usize) -> u64 {
    call(ptr, len, mcp::scopes_catalog_json)
}

#[no_mangle]
pub extern "C" fn durable_create(ptr: *const u8, len: usize) -> u64 {
    call(ptr, len, durable::create_json)
}

#[no_mangle]
pub extern "C" fn durable_plan(ptr: *const u8, len: usize) -> u64 {
    call(ptr, len, durable::plan_json)
}

#[no_mangle]
pub extern "C" fn durable_recover(ptr: *const u8, len: usize) -> u64 {
    call(ptr, len, durable::recover_json)
}

#[no_mangle]
pub extern "C" fn durable_next_alarm(ptr: *const u8, len: usize) -> u64 {
    call(ptr, len, durable::next_alarm_json)
}

#[no_mangle]
pub extern "C" fn durable_rank(ptr: *const u8, len: usize) -> u64 {
    call(ptr, len, durable::rank_json)
}

#[no_mangle]
pub extern "C" fn durable_catalog(ptr: *const u8, len: usize) -> u64 {
    call(ptr, len, durable::catalog_json)
}

#[no_mangle]
pub extern "C" fn durable_fetch_check(ptr: *const u8, len: usize) -> u64 {
    call(ptr, len, durable::fetch_check_json)
}

#[no_mangle]
pub extern "C" fn durable_html_text(ptr: *const u8, len: usize) -> u64 {
    call(ptr, len, durable::html_text_json)
}

#[no_mangle]
pub extern "C" fn review_mission(ptr: *const u8, len: usize) -> u64 {
    call(ptr, len, review::review_json)
}

#[no_mangle]
pub extern "C" fn durable_op(ptr: *const u8, len: usize) -> u64 {
    call(ptr, len, durable::op_json)
}

#[no_mangle]
pub extern "C" fn durable_board_id(ptr: *const u8, len: usize) -> u64 {
    call(ptr, len, durable::board_id_json)
}

/// Take a slot on limiter `id` at `now_ms`. Returns 0 when taken, else ms to wait.
#[no_mangle]
pub extern "C" fn limiter_take(id: u32, now_ms: f64) -> f64 {
    limiter::take(id, now_ms)
}

/// 1 when limiter `id` has a free slot at `now_ms` (does not take it).
#[no_mangle]
pub extern "C" fn limiter_available(id: u32, now_ms: f64) -> u32 {
    limiter::available(id, now_ms) as u32
}

/// Block limiter `id` until `until_ms` (e.g. after a 429).
#[no_mangle]
pub extern "C" fn limiter_cooldown(id: u32, until_ms: f64) {
    limiter::cooldown(id, until_ms)
}

/// Configure limiter `id`: `cap` starts per `window_ms`. Resets its state.
#[no_mangle]
pub extern "C" fn limiter_config(id: u32, cap: u32, window_ms: f64) {
    limiter::config(id, cap, window_ms)
}

#[no_mangle]
pub extern "C" fn nav_app_redirect(ptr: *const u8, len: usize) -> u64 {
    call(ptr, len, nav::app_redirect_json)
}

#[no_mangle]
pub extern "C" fn nav_safe_next(ptr: *const u8, len: usize) -> u64 {
    call(ptr, len, nav::safe_next_json)
}

#[no_mangle]
pub extern "C" fn untrusted_wrap(ptr: *const u8, len: usize) -> u64 {
    call(ptr, len, untrusted::wrap_json)
}

#[no_mangle]
pub extern "C" fn memory_profile(ptr: *const u8, len: usize) -> u64 {
    call(ptr, len, memory::profile_json)
}

#[no_mangle]
pub extern "C" fn memory_query(ptr: *const u8, len: usize) -> u64 {
    call(ptr, len, memory::query_json)
}

#[no_mangle]
pub extern "C" fn memory_store(ptr: *const u8, len: usize) -> u64 {
    call(ptr, len, memory::store_json)
}

#[no_mangle]
pub extern "C" fn memory_shape(ptr: *const u8, len: usize) -> u64 {
    call(ptr, len, memory::shape_json)
}

#[no_mangle]
pub extern "C" fn memory_op(ptr: *const u8, len: usize) -> u64 {
    call(ptr, len, memory::op_json)
}
