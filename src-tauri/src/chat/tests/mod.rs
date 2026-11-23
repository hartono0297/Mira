//! Three-laptop tests over `network::feature::testing` (plan section 13).

mod basic;
mod prop;
mod rejects;
mod review;
mod scoping;
mod titipan;
mod v03_groups;
mod v03_scoping;
mod v03_umum;

use super::model::{self, Body, VerifiedRecord};
use super::testutil::Laptop;
use super::view::{DeliveryState, MessageView};
use crate::network::feature::FeatureRecord;

/// Signs `body` with `laptop`'s key at `at` (for forged or backdated records).
pub fn sign_as(laptop: &Laptop, org: &str, at: time::OffsetDateTime, body: Body) -> VerifiedRecord {
    laptop
        .state
        .with_core(|c| Ok(model::sign_record(&c.identity, org, at, body)))
        .unwrap()
}

pub fn text_message(conv: &str, text: &str) -> Body {
    Body::Message {
        conv: conv.to_owned(),
        text: text.to_owned(),
        reply_to: None,
        mentions: vec![],
        files: vec![],
    }
}

pub fn feature(rec: &VerifiedRecord) -> FeatureRecord {
    rec.to_feature_record()
}

pub fn messages(l: &Laptop, conv: &str) -> Vec<MessageView> {
    l.chat.conversation(conv, None, 500).unwrap().messages
}

pub fn status_of(l: &Laptop, conv: &str, id: &str) -> DeliveryState {
    messages(l, conv)
        .into_iter()
        .find(|m| m.id == id)
        .and_then(|m| m.status)
        .map(|s| s.state)
        .expect("own message with status")
}
