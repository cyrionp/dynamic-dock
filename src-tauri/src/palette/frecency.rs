//! What the launcher learns: how often and how lately each result was
//! picked, and which result was picked for which typed text. "vs" + Enter
//! on Visual Studio Code a few times, and "vs" puts it first from then on.
//!
//! Kept as a small JSON file next to the settings; it never grows past
//! `MAX_ITEMS` results and `MAX_QUERIES` typed texts.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;

const MAX_ITEMS: usize = 600;
const MAX_QUERIES: usize = 400;
/// A typed text is remembered by its first few letters, so "vs", "vsc" and
/// "vsco" all count for the same result.
const QUERY_KEY_LEN: usize = 4;

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
pub struct Use {
    pub count: u32,
    /// Seconds since 1970.
    pub last: u64,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct History {
    pub items: HashMap<String, Use>,
    /// Typed text (folded, shortened) → result key → times picked.
    pub queries: HashMap<String, HashMap<String, u32>>,
}

pub fn query_key(folded_query: &str) -> String {
    folded_query.trim().chars().take(QUERY_KEY_LEN).collect()
}

impl History {
    /// Notes that `key` was picked after typing `folded_query`.
    pub fn record(&mut self, key: &str, folded_query: &str, now: u64) {
        let u = self.items.entry(key.to_string()).or_default();
        u.count = u.count.saturating_add(1);
        u.last = now;
        let q = query_key(folded_query);
        if !q.is_empty() {
            *self.queries.entry(q).or_default().entry(key.to_string()).or_default() += 1;
        }
        self.prune(now);
    }

    /// Forgets a result entirely ("Remove from suggestions").
    pub fn forget(&mut self, key: &str) {
        self.items.remove(key);
        for picks in self.queries.values_mut() {
            picks.remove(key);
        }
        self.queries.retain(|_, p| !p.is_empty());
    }

    /// Extra points for `key`: up to about 300 for something picked often
    /// and lately, up to 400 more when it was picked for this very text.
    pub fn boost(&self, key: &str, folded_query: &str, now: u64) -> i32 {
        let mut points = self.items.get(key).map(|u| frecency(u, now)).unwrap_or(0.0);
        let q = query_key(folded_query);
        if !q.is_empty() {
            if let Some(n) = self.queries.get(&q).and_then(|p| p.get(key)) {
                points += 120.0 + (*n as f64).ln_1p() * 90.0;
            }
        }
        points.min(700.0) as i32
    }

    /// The most used results, best first, for the empty launcher.
    pub fn top(&self, now: u64, n: usize) -> Vec<(String, f64)> {
        let mut all: Vec<(String, f64)> = self.items.iter().map(|(k, u)| (k.clone(), frecency(u, now))).collect();
        all.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
        all.truncate(n);
        all
    }

    fn prune(&mut self, now: u64) {
        if self.items.len() > MAX_ITEMS {
            let mut ranked = self.top(now, usize::MAX);
            let gone: Vec<String> = ranked.drain(MAX_ITEMS..).map(|(k, _)| k).collect();
            for k in gone {
                self.forget(&k);
            }
        }
        if self.queries.len() > MAX_QUERIES {
            let mut sizes: Vec<(String, u32)> = self.queries.iter().map(|(k, p)| (k.clone(), p.values().sum())).collect();
            sizes.sort_by_key(|s| std::cmp::Reverse(s.1));
            for (k, _) in sizes.drain(MAX_QUERIES..) {
                self.queries.remove(&k);
            }
        }
    }
}

/// Uses weighed by how long ago the last one was.
fn frecency(u: &Use, now: u64) -> f64 {
    let age = now.saturating_sub(u.last);
    let recency = match age {
        a if a < 4 * 3600 => 1.0,
        a if a < 86_400 => 0.8,
        a if a < 7 * 86_400 => 0.6,
        a if a < 30 * 86_400 => 0.35,
        _ => 0.15,
    };
    ((u.count as f64).ln_1p() * 110.0 * recency).min(300.0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn learns_typed_text() {
        let mut h = History::default();
        let now = 1_700_000_000;
        for _ in 0..3 {
            h.record("app:code", "vs", now);
        }
        h.record("app:vs2022", "visual", now);
        assert!(h.boost("app:code", "vs", now) > h.boost("app:vs2022", "vs", now));
        // Typed text it was never picked for gives no extra points.
        assert!(h.boost("app:code", "vs", now) > h.boost("app:code", "zz", now));
        assert_eq!(h.top(now, 1)[0].0, "app:code");
    }

    #[test]
    fn old_use_counts_less() {
        let mut h = History::default();
        h.record("a", "", 0);
        h.record("b", "", 100 * 86_400);
        assert!(h.boost("b", "", 100 * 86_400) > h.boost("a", "", 100 * 86_400));
    }

    #[test]
    fn stays_small() {
        let mut h = History::default();
        for i in 0..(MAX_ITEMS + 50) {
            h.record(&format!("k{i}"), &format!("q{i}"), i as u64);
        }
        assert!(h.items.len() <= MAX_ITEMS);
        assert!(h.queries.len() <= MAX_QUERIES);
        h.forget("k700");
        assert!(!h.items.contains_key("k700"));
    }
}
