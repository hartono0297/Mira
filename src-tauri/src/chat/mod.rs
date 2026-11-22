//! Chat (Tahap 2). See docs/plans/tahap-2.md.
//!
//! Every piece of chat data is a signed record in the `chat` topic of the
//! feature sync contract (`network::feature`): channels, messages, deletes,
//! delivery and read receipts, and sealed envelopes for offline recipients.
//!
//! - `model`: record format, signatures, conversation ids, field checks.
//! - `seal`: envelopes sealed for one recipient, encrypted attachments.

pub mod model;
pub mod seal;
