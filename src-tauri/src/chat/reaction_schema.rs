//! Migration v12 (v0.5.1): reactions (docs/plans/chat-sticker.md 3).
//!
//! One row per (message, author, emoji), holding the winning record: the
//! one with the greatest `(at, record_id)`. `active` 0 means the reaction
//! was taken back. The message may not be here yet; rows wait for it.

pub const REACTION_SCHEMA: &str = r#"
CREATE TABLE chat_reactions (
    message_id    TEXT NOT NULL CHECK (length(message_id) = 64),
    author        TEXT NOT NULL CHECK (length(author) = 64),
    emoji         TEXT NOT NULL,
    conv          TEXT NOT NULL,
    active        INTEGER NOT NULL CHECK (active IN (0, 1)),
    at            TEXT NOT NULL,
    record_id     TEXT NOT NULL CHECK (length(record_id) = 64),
    PRIMARY KEY (message_id, author, emoji)
) STRICT;
CREATE INDEX chat_reactions_message ON chat_reactions (message_id, active);
"#;
