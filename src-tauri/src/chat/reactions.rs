//! Reactions on messages (v0.5.1, docs/plans/chat-sticker.md 2 and 3).
//!
//! STUB: written by its own task. Signatures are the contract; do not
//! change them without updating the callers in `model`, `judge`, `store`,
//! `read`, `service` and `commands`.

use time::OffsetDateTime;

use super::audience::{ConvInfo, Ctx};
use super::judge::{Standing, Verdict};
use super::model::VerifiedRecord;
use super::store::Effects;
use super::sync::ChatSync;
use super::view::ReactionView;
use crate::error::AppResult;

/// Field check for `Body::Reaction::emoji` (called from `model`).
pub fn validate_emoji(_emoji: &str) -> Result<(), String> {
    Ok(())
}

/// May the author make this reaction record?
pub(crate) fn judge(_ctx: &Ctx, _rec: &VerifiedRecord, _st: Standing) -> AppResult<Verdict> {
    Ok(Verdict::Defer)
}

/// Stores an accepted reaction record and updates `chat_reactions`.
pub fn apply(
    _ctx: &Ctx,
    _rec: &VerifiedRecord,
    _from: Option<&str>,
    _now: OffsetDateTime,
    _fx: &mut Effects,
) -> AppResult<()> {
    Ok(())
}

/// Reaction chips of one message, in order of their first reaction.
pub fn reactions_for(_ctx: &Ctx, _message_id: &str) -> AppResult<Vec<ReactionView>> {
    Ok(Vec::new())
}

/// Whether I may react in this conversation now.
pub fn can_react(_ctx: &Ctx, _info: &ConvInfo) -> AppResult<bool> {
    Ok(false)
}

/// Emoji used most recently on this laptop, newest first (at most 24).
pub fn recent_emoji(_conn: &rusqlite::Connection) -> AppResult<Vec<String>> {
    Ok(Vec::new())
}

impl ChatSync {
    /// Turns my reaction `emoji` on `message_id` on or off.
    pub fn react(&self, _conv: &str, _message_id: &str, _emoji: &str, _on: bool) -> AppResult<()> {
        Ok(())
    }

    /// Remembers that I used `emoji` (recent list of this laptop).
    pub fn emoji_used(&self, _emoji: &str) -> AppResult<()> {
        Ok(())
    }
}
