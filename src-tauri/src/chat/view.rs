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
    Group,
}

/// The five sections of the chat list (v0.3), in display order.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ChatSection {
    Umum,
    Departemen,
    Proyek,
    Grup,
    Pribadi,
}

impl ChatSection {
    pub const ALL: [ChatSection; 5] = [
        ChatSection::Umum,
        ChatSection::Departemen,
        ChatSection::Proyek,
        ChatSection::Grup,
        ChatSection::Pribadi,
    ];

    pub fn as_str(self) -> &'static str {
        match self {
            ChatSection::Umum => "umum",
            ChatSection::Departemen => "departemen",
            ChatSection::Proyek => "proyek",
            ChatSection::Grup => "grup",
            ChatSection::Pribadi => "pribadi",
        }
    }

    pub fn parse(s: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|c| c.as_str() == s)
    }

    /// Known sections among `names`, unique, in display order.
    pub fn known(names: &[String]) -> Vec<ChatSection> {
        Self::ALL
            .into_iter()
            .filter(|c| names.iter().any(|n| ChatSection::parse(n) == Some(*c)))
            .collect()
    }
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
    Group,
    /// The built-in chat of a project (v0.4).
    Project,
    Dm,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConversationSummary {
    pub id: String,
    pub kind: ConversationKind,
    pub section: ChatSection,
    pub name: String,
    pub scope: Option<ChannelScopeView>,
    pub peer: Option<Person>,
    pub is_umum: bool,
    pub archived: bool,
    /// Umum channel only superadmins may write in.
    pub locked: bool,
    /// This laptop is not in the audience any more; old messages stay.
    pub former: bool,
    pub member_count: u32,
    pub muted: bool,
    pub unread: u32,
    pub mention_unread: u32,
    pub last_at: Option<String>,
    pub last_preview: Option<String>,
    pub can_post: bool,
    pub post_blocked_reason: Option<String>,
    pub can_archive: bool,
    pub can_delete: bool,
    pub can_lock: bool,
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
    pub is_superadmin: bool,
    pub is_guest: bool,
    pub can_create_channel: bool,
    /// Superadmins only (PRD F-CHAT-01).
    pub can_create_org_channel: bool,
    pub can_create_group: bool,
    pub can_direct_message: bool,
    pub conversations: Vec<ConversationSummary>,
    pub people: Vec<Person>,
    pub teams: Vec<TeamRef>,
    pub my_department: Option<TeamRef>,
    pub projects: Vec<ProjectRef>,
    /// Registered projects this laptop's person is not in.
    pub other_projects: u32,
    pub notify: NotifyMode,
    /// Sidebar sections folded on this laptop (v0.4), in display order.
    pub folded: Vec<ChatSection>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GroupMemberView {
    pub person: Person,
    pub owner: bool,
    pub me: bool,
    pub added_by: Option<Person>,
    pub can_remove: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GroupView {
    pub conv: String,
    pub name: String,
    pub owner: Option<Person>,
    pub created_by: Person,
    pub created_at: String,
    pub members: Vec<GroupMemberView>,
    pub candidates: Vec<Person>,
    pub can_add: bool,
    pub can_rename: bool,
    pub can_leave: bool,
    pub former: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectChatMember {
    pub person: Person,
    pub me: bool,
    /// Project manager on the board (may change the project's members).
    pub manager: bool,
}

/// Members of a project chat: the project's members now.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectChatView {
    pub conv: String,
    pub project_id: String,
    pub name: String,
    /// Sorted by name.
    pub members: Vec<ProjectChatMember>,
    pub can_manage: bool,
    pub former: bool,
}

/// A group event shown between messages.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConversationEvent {
    pub id: String,
    pub at: String,
    pub text: String,
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
    pub events: Vec<ConversationEvent>,
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
            section: ChatSection::Pribadi,
            name: "Sari".into(),
            scope: Some(ChannelScopeView {
                kind: ScopeKind::Org,
                id: None,
                name: "Seluruh kantor".into(),
            }),
            peer: None,
            is_umum: true,
            archived: false,
            locked: false,
            former: false,
            member_count: 2,
            muted: false,
            unread: 2,
            mention_unread: 1,
            last_at: None,
            last_preview: None,
            can_post: true,
            post_blocked_reason: None,
            can_archive: false,
            can_delete: false,
            can_lock: false,
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
            "section",
            "locked",
            "former",
            "memberCount",
            "postBlockedReason",
            "canLock",
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
        assert_eq!(v["section"], "pribadi");
        assert_eq!(
            serde_json::to_value(ConversationKind::Group).unwrap(),
            "group"
        );
        assert!(ChatSection::Umum < ChatSection::Departemen);
        assert!(ChatSection::Grup < ChatSection::Pribadi);
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
