//! Blob transfer for features (`feature.rs`): each download on its own
//! bidirectional stream of the member connection.
//!
//! Requester: `BlobGet { hash }`. Server: `BlobHeader { size }` followed by
//! exactly `size` raw bytes, or `BlobRefused { code }`. The server asks
//! `FeatureHub::blob_path_for(peer, hash)` for every request. The requester
//! writes to a temporary file next to `dest`, refuses more than `max_size`
//! bytes, checks BLAKE3, and only then moves the file to `dest`; on failure
//! nothing is left at `dest`.
//!
//! STUB: filled in by the implementation task (docs/plans/transport-fitur.md).

use std::path::PathBuf;
use std::sync::Arc;

use quinn::{RecvStream, SendStream};

use super::node::Inner;

/// Limits for blob transfers, held by `Inner`.
pub(crate) struct BlobState {}

impl BlobState {
    pub(crate) fn new() -> Self {
        Self {}
    }
}

impl Inner {
    /// Server side: answer one `BlobGet` from member `pk`. Applies its own
    /// time limits; the caller finishes `send` afterwards.
    pub(crate) async fn serve_blob(
        self: &Arc<Self>,
        _pk: &str,
        _hash: String,
        send: &mut SendStream,
        _recv: &mut RecvStream,
    ) {
        let _ = super::wire::write_msg_timeout(
            send,
            &super::wire::Msg::BlobRefused {
                code: "unavailable".into(),
            },
            super::node::WRITE_TIMEOUT,
        )
        .await;
    }

    /// Requester side, behind `FeatureLink::fetch_blob`.
    pub(crate) async fn fetch_blob(
        self: Arc<Self>,
        _hash: String,
        _max_size: u64,
        _prefer: Vec<String>,
        _dest: PathBuf,
    ) -> Result<u64, String> {
        Err("Belum diimplementasikan.".to_owned())
    }
}
