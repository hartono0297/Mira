//! Board per project (Tahap 3, local part). See docs/plans/tahap-3-lokal.md.
//!
//! Each project is one Automerge document (`doc`). Every local mutation is one
//! Automerge change signed with the laptop key (`sign`) and stored with the
//! document snapshot and the task index in one SQLite transaction (`store`).
//! Permission checks (`policy`), the assignee list (`assignees`) and network
//! sync (`sync`) are traits so later stages can swap them. `commands` holds
//! the Tauri commands; `reminder` the deadline reminders.

pub mod access;
pub mod assignees;
pub mod calendar;
pub mod commands;
pub mod doc;
pub mod feature;
pub mod membership;
pub mod model;
pub mod numbers;
pub mod outside;
pub mod policy;
pub mod rank;
pub mod reminder;
pub mod rules;
pub mod schema;
pub mod sign;
pub mod store;
pub mod sync;
pub mod timing;
pub mod view;

#[cfg(test)]
pub(crate) mod testutil;
