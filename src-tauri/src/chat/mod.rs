//! Chat (Tahap 2). See docs/plans/tahap-2.md.
//!
//! Every piece of chat data is a signed record in the `chat` topic of the
//! feature sync contract (`network::feature`): channels, messages, deletes,
//! delivery and read receipts, and sealed envelopes for offline recipients.
//!
//! - `model`: record format, signatures, conversation ids, field checks.
//! - `seal`: envelopes sealed for one recipient, encrypted attachments.
//! - `schema`: migration v6.
//! - `audience`: who is in which conversation, who administers it, and the
//!   `ProjectAudience` connection point for board projects.
//! - `judge`: may this author make this record (accept, defer, reject).
//! - `store`: storing and applying records, purges, envelopes.
//! - `fetch`: the local download queue and the blobs chat owns.
//! - `hooks`: what chat needs from the app (`ChatHooks`).
//! - `sync`: `ChatSync`, implementing `FeatureSync` and `BlobSource`.
//! - `service`, `files`: methods behind the Tauri commands.
//! - `read`, `view`: data for the chat screen (`src/api/chat.ts`).

pub mod audience;
pub mod fetch;
pub mod files;
pub mod hooks;
pub mod judge;
pub mod model;
pub mod read;
pub mod schema;
pub mod seal;
pub mod service;
pub mod store;
pub mod sync;
pub mod view;

#[cfg(test)]
mod testutil;
#[cfg(test)]
mod tests;

pub use audience::{BoardTeamAudience, ProjectAudience, ProjectInfo};
pub use fetch::{FetchJob, FetchKind};
pub use hooks::{ChatHooks, MessageNotification, NoopHooks, RecordingHooks};
pub use sync::ChatSync;
