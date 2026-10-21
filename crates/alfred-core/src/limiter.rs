//! Sliding-window limiters, one table per isolate.
use std::cell::RefCell;
use std::collections::VecDeque;

pub const EXA: u32 = 0;
pub const DEEPSEEK: u32 = 1;

pub struct Window {
    cap: usize,
    window: f64,
    starts: VecDeque<f64>,
    cool_until: f64,
}

impl Window {
    pub fn new(cap: u32, window: f64) -> Self {
        Self { cap: cap as usize, window, starts: VecDeque::new(), cool_until: 0.0 }
    }
    fn prune(&mut self, now: f64) {
        while matches!(self.starts.front(), Some(t) if now - *t >= self.window) {
            self.starts.pop_front();
        }
    }
    pub fn available(&mut self, now: f64) -> bool {
        self.prune(now);
        now >= self.cool_until && self.starts.len() < self.cap
    }
    /// 0 = taken; otherwise how long to wait before trying again.
    pub fn take(&mut self, now: f64) -> f64 {
        self.prune(now);
        if now < self.cool_until {
            return self.cool_until - now;
        }
        if self.starts.len() < self.cap {
            self.starts.push_back(now);
            return 0.0;
        }
        (self.window - (now - self.starts[0])).max(1.0)
    }
}

thread_local! {
    static TABLE: RefCell<Vec<Window>> = RefCell::new(vec![Window::new(10, 1_000.0), Window::new(20, 60_000.0)]);
}

fn with<R>(id: u32, f: impl FnOnce(&mut Window) -> R) -> R {
    TABLE.with(|t| {
        let mut t = t.borrow_mut();
        while t.len() <= id as usize {
            t.push(Window::new(u32::MAX, 1.0));
        }
        f(&mut t[id as usize])
    })
}

pub fn take(id: u32, now: f64) -> f64 { with(id, |w| w.take(now)) }
pub fn available(id: u32, now: f64) -> bool { with(id, |w| w.available(now)) }
pub fn cooldown(id: u32, until: f64) { with(id, |w| w.cool_until = until) }
pub fn config(id: u32, cap: u32, window: f64) { with(id, |w| *w = Window::new(cap, window)) }

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn twenty_per_minute_then_wait_then_slides() {
        let mut w = Window::new(20, 60_000.0);
        for _ in 0..20 { assert_eq!(w.take(1_000.0), 0.0); }
        assert!(w.take(1_000.0) > 0.0);
        assert!(!w.available(1_000.0));
        assert_eq!(w.take(61_001.0), 0.0);
    }
    #[test]
    fn exa_ten_per_second() {
        let mut w = Window::new(10, 1_000.0);
        for i in 0..10 { assert_eq!(w.take(i as f64), 0.0); }
        let wait = w.take(10.0);
        assert!(wait > 0.0 && wait <= 1_000.0);
    }
    #[test]
    fn cooldown_blocks() {
        config(DEEPSEEK, 20, 60_000.0);
        cooldown(DEEPSEEK, 5_000.0);
        assert!(!available(DEEPSEEK, 1_000.0));
        assert!(available(DEEPSEEK, 5_000.0));
    }
}
