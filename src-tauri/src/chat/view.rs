//! Data for the chat screen. Mirrors `src/api/chat.ts` exactly (camelCase
//! fields, enums as lowercase strings); that file is the contract.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Person {
    pub public_key: String,
    pub name: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ScopeKind {
    Org,
    Team,
    Project,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChannelScopeView {
    pub kind: ScopeKind,
    pub id: Option<String>,
    pub name: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ConversationKind {
    Channel,
    Dm,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConversationSummary {
    pub id: String,
    pub kind: ConversationKind,
    pub name: String,
    pub scope: Option<ChannelScopeView>,
    pub peer: Option<Person>,
    pub is_umum: bool,
    pub archived: bool,
    pub muted: bool,
    pub unread: u32,
    pub mention_unread: u32,
    pub last_at: Option<String>,
    pub last_preview: Option<String>,
    pub can_post: bool,
    pub can_archive: bool,
    pub can_delete: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum NotifyMode {
    All,
    Mentions,
    Off,
}

impl NotifyMode {
    pub fn as_str(self) -> &'static str {
        match self {
            NotifyMode::All => "all",
            NotifyMode::Mentions => "mentions",
            NotifyMode::Off => "off",
        }
    }

    /// Unknown values fall back to the default, `all`.
    pub fn parse(s: &str) -> Self {
        match s {
            "mentions" => NotifyMode::Mentions,
            "off" => NotifyMode::Off,
            _ => NotifyMode::All,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TeamRef {
    pub id: String,
    pub name: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectRef {
    pub id: String,
    pub name: String,
    pub team_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatOverview {
    pub me: String,
    pub can_create_channel: bool,
    /// Superadmins only (PRD F-CHAT-01).
    pub can_create_org_channel: bool,
    pub can_direct_message: bool,
    pub conversations: Vec<ConversationSummary>,
    pub people: Vec<Person>,
    pub teams: Vec<TeamRef>,
    pub projects: Vec<ProjectRef>,
    pub notify: NotifyMode,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum FileState {
    Local,
    Fetching,
    Remote,
    Missing,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileView {
    pub hash: String,
    pub name: String,
    pub size: u64,
    pub mime: String,
    pub state: FileState,
    pub auto_download: bool,
}

/// Ordered lowest to highest, so the combined state is the minimum.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum DeliveryState {
    Pending,
    Deposited,
    Delivered,
    Read,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MessageStatus {
    pub state: DeliveryState,
    pub read: u32,
    /// Includes those who read it.
    pub delivered: u32,
    pub deposited: u32,
    pub total: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReplyPreview {
    pub id: String,
    pub author: Option<Person>,
    pub preview: String,
    pub deleted: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MessageView {
    pub id: String,
    pub conv: String,
    pub author: Person,
    pub at: String,
    pub text: String,
    pub mentions: Vec<Person>,
    pub reply_to: Option<ReplyPreview>,
    pub files: Vec<FileView>,
    pub deleted: bool,
    pub mine: bool,
    pub status: Option<MessageStatus>,
    pub can_delete: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConversationView {
    pub conversation: ConversationSummary,
    pub members: Vec<Person>,
    pub messages: Vec<MessageView>,
    pub has_more: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReceiptView {
    pub person: Person,
    pub state: DeliveryState,
}

/// Argument of `chat_create_channel`.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NewChannelScope {
    pub kind: ScopeKind,
    pub id: Option<String>,
}

/// Cuts `s` to at most `max` characters, ending with "..." when cut.
pub fn truncate_chars(s: &str, max: usize) -> String {
    let flat: String = s
        .chars()
        .map(|c| if c == '\n' || c == '\t' { ' ' } else { c })
        .collect();
    if flat.chars().count() <= max {
        return flat;
    }
    let keep = max.saturating_sub(3);
    let mut out: String = flat.chars().take(keep).collect();
    out = out.trim_end().to_owned();
    out.push_str("...");
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn serializes_like_the_typescript_contract() {
        let s = ConversationSummary {
            id: "ch:x".into(),
            kind: ConversationKind::Dm,
            name: "Sari".into(),
            scope: Some(ChannelScopeView {
                kind: ScopeKind::Org,
                id: None,
                name: "Seluruh kantor".into(),
            }),
            peer: None,
            is_umum: true,
            archived: false,
            muted: false,
            unread: 2,
            mention_unread: 1,
            last_at: None,
            last_preview: None,
            can_post: true,
            can_archive: false,
            can_delete: false,
        };
        let v = serde_json::to_value(&s).unwrap();
        for key in [
            "id",
            "kind",
            "name",
            "scope",
            "peer",
            "isUmum",
            "archived",
            "muted",
            "unread",
            "mentionUnread",
            "lastAt",
            "lastPreview",
            "canPost",
            "canArchive",
            "canDelete",
        ] {
            assert!(v.get(key).is_some(), "missing {key}");
        }
        assert_eq!(v["kind"], "dm");
        assert_eq!(v["scope"]["kind"], "org");
        assert!(v["scope"]["id"].is_null());
        assert_eq!(
            serde_json::to_value(DeliveryState::Deposited).unwrap(),
            "deposited"
        );
        assert_eq!(serde_json::to_value(FileState::Missing).unwrap(), "missing");
        assert_eq!(
            serde_json::to_value(NotifyMode::Mentions).unwrap(),
            "mentions"
        );
        let scope: NewChannelScope = serde_json::from_str(r#"{"kind":"team","id":"ab"}"#).unwrap();
        assert_eq!(scope.kind, ScopeKind::Team);
    }

    #[test]
    fn truncation_counts_characters() {
        assert_eq!(truncate_chars("halo", 80), "halo");
        let long = "é".repeat(100);
        let cut = truncate_chars(&long, 80);
        assert_eq!(cut.chars().count(), 80);
        assert!(cut.ends_with("..."));
        assert!(DeliveryState::Pending < DeliveryState::Read);
    }
}
