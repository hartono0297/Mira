//! Kopi: positive-only reputation (docs/plans/kopi.md).
//!
//! - `types`: shared payloads, constants and results (the contract).
//! - `record`: sealing and checking signed records (`mira-kopi-v1`).
//! - `store`: SQLite tables (created on first use, no migration number).
//! - `rules`: the deterministic fold (limits, self, duplicates, hide,
//!   settings, work caps).
//! - `work`: Kopi from work, computed from the boards this laptop holds.
//! - `tier`: score and tiers.
//! - `sync`: `FeatureSync` for topic `kopi`.
//! - `runtime`: publishes this laptop's work snapshot.
//! - `view` and `commands`: what the screens read and do.

pub mod commands;
pub mod record;
pub mod rules;
pub mod runtime;
pub mod store;
pub mod sync;
pub mod tier;
pub mod types;
pub mod view;
pub mod work;

pub use types::*;
