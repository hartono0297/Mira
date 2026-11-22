//! What chat needs from the rest of the app: telling the transport about new
//! records, refreshing the UI, Windows notifications, the download loop.
//!
//! `ChatSync` decides everything (which notification, whether a record was
//! created); the Tauri implementation only forwards: `notify_changed` to
//! `FeatureHub::notify_changed("chat")`, `ui_changed` to the `mira://feature`
//! event, `notify_message` to a Windows toast when the window is not focused.
//! It holds the hub as `Weak<FeatureHub>` so there is no `Arc` cycle.

use std::sync::Mutex;

/// A Windows notification for a new message.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MessageNotification {
    pub conv: String,
    /// Sender name, plus the channel name for channels ("Sari di #umum").
    pub title: String,
    /// Up to 120 characters of text, or "Mengirim file".
    pub body: String,
}

pub trait ChatHooks: Send + Sync + 'static {
    /// New local records exist: offer them to connected peers soon.
    fn notify_changed(&self);
    /// Something visible changed: the chat screen should reload.
    fn ui_changed(&self);
    /// Public keys of peers with a live member connection right now.
    fn connected_peers(&self) -> Vec<String>;
    /// Show a notification (the implementation skips it while focused).
    fn notify_message(&self, n: &MessageNotification);
    /// The download queue has new work.
    fn wake_fetcher(&self);
}

/// Hooks that do nothing, for code paths without a running app.
#[derive(Debug, Default, Clone, Copy)]
pub struct NoopHooks;

impl ChatHooks for NoopHooks {
    fn notify_changed(&self) {}
    fn ui_changed(&self) {}
    fn connected_peers(&self) -> Vec<String> {
        Vec::new()
    }
    fn notify_message(&self, _n: &MessageNotification) {}
    fn wake_fetcher(&self) {}
}

/// Test hooks: counts calls, keeps notifications, `connected_peers` settable.
#[derive(Debug, Default)]
pub struct RecordingHooks {
    inner: Mutex<Recorded>,
}

#[derive(Debug, Default, Clone)]
pub struct Recorded {
    pub notify_changed: usize,
    pub ui_changed: usize,
    pub wake_fetcher: usize,
    pub notifications: Vec<MessageNotification>,
    pub connected: Vec<String>,
}

impl RecordingHooks {
    pub fn set_connected(&self, peers: &[&str]) {
        self.lock().connected = peers.iter().map(|p| p.to_string()).collect();
    }

    pub fn snapshot(&self) -> Recorded {
        self.lock().clone()
    }

    pub fn take_notifications(&self) -> Vec<MessageNotification> {
        std::mem::take(&mut self.lock().notifications)
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Recorded> {
        self.inner.lock().unwrap_or_else(|e| e.into_inner())
    }
}

impl ChatHooks for RecordingHooks {
    fn notify_changed(&self) {
        self.lock().notify_changed += 1;
    }
    fn ui_changed(&self) {
        self.lock().ui_changed += 1;
    }
    fn connected_peers(&self) -> Vec<String> {
        self.lock().connected.clone()
    }
    fn notify_message(&self, n: &MessageNotification) {
        self.lock().notifications.push(n.clone());
    }
    fn wake_fetcher(&self) {
        self.lock().wake_fetcher += 1;
    }
}
