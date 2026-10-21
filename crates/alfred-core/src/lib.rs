//! Alfred.report hot paths, compiled to wasm32 and called from the Workers.
//!
//! - Search router: which tier (Ceramic -> Exa Lite -> Exa auto) serves a query, and when a
//!   result set is too thin. The Workers do the I/O; every decision is made here.
//! - Sliding-window rate limiters (Exa 10 rps, DeepSeek V4.1 Flash 20 rpm) kept in wasm memory
//!   per isolate.
//! - Model floor: which Workers AI models a mission may fall back to right now.
//!
//! ABI: JSON in, JSON out over linear memory (`alloc` / `dealloc`, results returned as a
//! packed `(ptr << 32) | len` u64). No wasm-bindgen needed.

pub mod limiter;
pub mod models;
pub mod search;

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

fn read(ptr: *const u8, len: usize) -> &'static str {
    unsafe { std::str::from_utf8_unchecked(std::slice::from_raw_parts(ptr, len)) }
}

fn write(out: String) -> u64 {
    let bytes = out.into_bytes().into_boxed_slice();
    let len = bytes.len();
    let ptr = Box::into_raw(bytes) as *mut u8;
    ((ptr as u64) << 32) | len as u64
}

fn call(ptr: *const u8, len: usize, f: fn(&str) -> Result<String, String>) -> u64 {
    match f(read(ptr, len)) {
        Ok(s) => write(s),
        Err(e) => write(serde_json::json!({ "error": e }).to_string()),
    }
}

#[no_mangle]
pub extern "C" fn search_plan(ptr: *const u8, len: usize) -> u64 {
    call(ptr, len, search::plan_json)
}

#[no_mangle]
pub extern "C" fn search_analyze(ptr: *const u8, len: usize) -> u64 {
    call(ptr, len, search::analyze_json)
}

#[no_mangle]
pub extern "C" fn models_floor(ptr: *const u8, len: usize) -> u64 {
    call(ptr, len, models::floor_json)
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
