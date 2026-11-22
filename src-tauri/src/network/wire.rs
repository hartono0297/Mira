//! Frames and messages on the wire (plan 2.2).
//!
//! A frame is a `u32` big-endian length followed by that many bytes of UTF-8
//! JSON. Frames larger than the caller's limit (at most 4 MiB) are rejected
//! before any of the body is read, and the body buffer grows only as bytes
//! actually arrive.

use std::time::Duration;

use serde::{Deserialize, Serialize};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};

use super::feature::FeatureRecord;
use super::{JoinAccepted, JoinProof, WireOp};

/// Protocol version carried in `Hello`.
pub const PROTO_VERSION: u32 = 1;

/// Largest frame accepted anywhere.
pub const MAX_FRAME: usize = 4 * 1024 * 1024;

/// Largest frame accepted on the join ALPN, where only small messages exist.
pub const MAX_JOIN_FRAME: usize = 64 * 1024;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "t", rename_all = "snake_case")]
pub enum Msg {
    Hello {
        proto: u32,
        org: String,
        pk: String,
        listen_port: u16,
        addrs: Vec<String>,
    },
    SyncHave {
        ids: Vec<String>,
    },
    SyncWant {
        ids: Vec<String>,
    },
    SyncOps {
        ops: Vec<WireOp>,
    },
    Removed {
        op: WireOp,
    },
    JoinHello {
        tag: String,
    },
    JoinChallenge {
        org: String,
        invite: String,
    },
    JoinProof {
        proof: JoinProof,
    },
    JoinAccepted {
        accepted: JoinAccepted,
    },
    JoinRejected {
        code: String,
        message: String,
    },
    /// Feature sync (`feature.rs`): ids of one topic the sender offers. The
    /// first frame of a feature session's bidirectional stream.
    FeatureHave {
        topic: String,
        ids: Vec<String>,
    },
    /// Answer to each `FeatureHave`: the offered ids the receiver lacks.
    FeatureWant {
        topic: String,
        ids: Vec<String>,
    },
    /// Records the receiver asked for, at most `MAX_RECORDS_PER_BATCH`.
    FeatureRecords {
        topic: String,
        records: Vec<FeatureRecord>,
    },
    /// First frame of a blob download stream.
    BlobGet {
        hash: String,
    },
    /// The blob follows as `size` raw bytes right after this frame.
    BlobHeader {
        size: u64,
    },
    /// No blob on this stream. Codes: `unavailable` (missing or not
    /// allowed, deliberately the same), `busy`.
    BlobRefused {
        code: String,
    },
}

#[derive(Debug)]
pub enum WireError {
    /// The declared length is above the limit.
    TooLarge(usize),
    /// Zero length, invalid JSON or an unknown message.
    Malformed(String),
    /// The stream ended in the middle of a frame.
    Truncated,
    /// No complete frame within the time limit.
    Timeout,
    Io(String),
}

impl std::fmt::Display for WireError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            WireError::TooLarge(n) => write!(f, "frame terlalu besar ({n} byte)"),
            WireError::Malformed(e) => write!(f, "pesan rusak: {e}"),
            WireError::Truncated => write!(f, "pesan terpotong"),
            WireError::Timeout => write!(f, "waktu tunggu pesan habis"),
            WireError::Io(e) => write!(f, "gagal membaca atau menulis: {e}"),
        }
    }
}

impl std::error::Error for WireError {}

/// Serializes `msg` into a complete frame (length prefix included).
pub fn encode(msg: &Msg) -> Result<Vec<u8>, WireError> {
    let body = serde_json::to_vec(msg).map_err(|e| WireError::Malformed(e.to_string()))?;
    if body.len() > MAX_FRAME {
        return Err(WireError::TooLarge(body.len()));
    }
    let len = u32::try_from(body.len()).map_err(|_| WireError::TooLarge(body.len()))?;
    let mut out = Vec::with_capacity(4 + body.len());
    out.extend_from_slice(&len.to_be_bytes());
    out.extend_from_slice(&body);
    Ok(out)
}

/// Parses a frame body (without the length prefix).
pub fn decode(body: &[u8]) -> Result<Msg, WireError> {
    if body.is_empty() {
        return Err(WireError::Malformed("frame kosong".into()));
    }
    serde_json::from_slice(body).map_err(|e| WireError::Malformed(e.to_string()))
}

/// Splits records into `FeatureRecords` batches of at most `max_count`
/// records whose serialized JSON stays under about `max_bytes`. A record
/// that alone exceeds `max_bytes` gets a batch of its own; a record whose
/// serialized size exceeds `MAX_FRAME / 2` is left out (it cannot be framed
/// safely, and the receiver would drop it anyway).
pub fn batch_records(
    records: Vec<FeatureRecord>,
    max_count: usize,
    max_bytes: usize,
) -> Vec<Vec<FeatureRecord>> {
    let max_count = max_count.max(1);
    let mut out: Vec<Vec<FeatureRecord>> = Vec::new();
    let mut batch: Vec<FeatureRecord> = Vec::new();
    let mut bytes = 0usize;
    for r in records {
        let size = serde_json::to_vec(&r)
            .map(|v| v.len())
            .unwrap_or(usize::MAX);
        if size > MAX_FRAME / 2 {
            continue;
        }
        if !batch.is_empty() && (batch.len() >= max_count || bytes + size > max_bytes) {
            out.push(std::mem::take(&mut batch));
            bytes = 0;
        }
        bytes += size + 1;
        batch.push(r);
    }
    if !batch.is_empty() {
        out.push(batch);
    }
    out
}

/// Serialized size of a message body, used to batch ops under the frame limit.
pub fn encoded_len(msg: &Msg) -> usize {
    serde_json::to_vec(msg)
        .map(|v| v.len())
        .unwrap_or(usize::MAX)
}

pub async fn write_msg<W: AsyncWrite + Unpin>(w: &mut W, msg: &Msg) -> Result<(), WireError> {
    let frame = encode(msg)?;
    w.write_all(&frame)
        .await
        .map_err(|e| WireError::Io(e.to_string()))
}

/// Writes with a time limit so a peer that stops reading cannot stall us.
pub async fn write_msg_timeout<W: AsyncWrite + Unpin>(
    w: &mut W,
    msg: &Msg,
    limit: Duration,
) -> Result<(), WireError> {
    tokio::time::timeout(limit, write_msg(w, msg))
        .await
        .map_err(|_| WireError::Timeout)?
}

/// Reads one frame. `Ok(None)` means the stream ended cleanly before a new
/// frame started.
pub async fn read_msg<R: AsyncRead + Unpin>(
    r: &mut R,
    max: usize,
) -> Result<Option<Msg>, WireError> {
    let mut header = [0u8; 4];
    let mut filled = 0;
    while filled < header.len() {
        let n = r
            .read(&mut header[filled..])
            .await
            .map_err(|e| WireError::Io(e.to_string()))?;
        if n == 0 {
            return if filled == 0 {
                Ok(None)
            } else {
                Err(WireError::Truncated)
            };
        }
        filled += n;
    }
    let len = u32::from_be_bytes(header) as usize;
    if len > max.min(MAX_FRAME) {
        return Err(WireError::TooLarge(len));
    }
    if len == 0 {
        return Err(WireError::Malformed("frame kosong".into()));
    }
    let mut body = Vec::new();
    let read = (&mut *r)
        .take(len as u64)
        .read_to_end(&mut body)
        .await
        .map_err(|e| WireError::Io(e.to_string()))?;
    if read != len {
        return Err(WireError::Truncated);
    }
    decode(&body).map(Some)
}

/// `read_msg` with a time limit on the whole frame.
pub async fn read_msg_timeout<R: AsyncRead + Unpin>(
    r: &mut R,
    max: usize,
    limit: Duration,
) -> Result<Option<Msg>, WireError> {
    tokio::time::timeout(limit, read_msg(r, max))
        .await
        .map_err(|_| WireError::Timeout)?
}

/// 32 lowercase hex characters (org, invite, team ids).
pub fn is_hex_id32(s: &str) -> bool {
    s.len() == 32 && is_lower_hex(s)
}

/// 64 lowercase hex characters (public keys, op ids).
pub fn is_hex64(s: &str) -> bool {
    s.len() == 64 && is_lower_hex(s)
}

fn is_lower_hex(s: &str) -> bool {
    s.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

/// Invite tag: 8 characters of Crockford base32 (uppercase, no I, L, O, U).
pub fn is_invite_tag(s: &str) -> bool {
    s.len() == 8
        && s.bytes()
            .all(|b| b.is_ascii_digit() || (b.is_ascii_uppercase() && !b"ILOU".contains(&b)))
}

/// Content address of an op: BLAKE3 of the payload bytes, hex.
pub fn op_id(op: &WireOp) -> String {
    blake3::hash(op.payload.as_bytes()).to_hex().to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_ops() -> Vec<Msg> {
        vec![
            Msg::Hello {
                proto: PROTO_VERSION,
                org: "a".repeat(32),
                pk: "b".repeat(64),
                listen_port: 47800,
                addrs: vec!["192.168.1.10:47800".into()],
            },
            Msg::SyncHave {
                ids: vec!["c".repeat(64)],
            },
            Msg::SyncWant { ids: vec![] },
            Msg::SyncOps {
                ops: vec![WireOp {
                    payload: "{\"v\":1}".into(),
                    sig: "0".repeat(128),
                }],
            },
            Msg::JoinHello {
                tag: "ABCD2345".into(),
            },
            Msg::JoinRejected {
                code: "invite_not_found".into(),
                message: "x".into(),
            },
        ]
    }

    #[tokio::test]
    async fn round_trip_over_a_stream() {
        let (mut a, mut b) = tokio::io::duplex(1 << 16);
        for m in sample_ops() {
            write_msg(&mut a, &m).await.unwrap();
            let got = read_msg(&mut b, MAX_FRAME).await.unwrap().unwrap();
            assert_eq!(got, m);
        }
        drop(a);
        assert!(read_msg(&mut b, MAX_FRAME).await.unwrap().is_none());
    }

    #[test]
    fn tag_is_t_snake_case() {
        let json = serde_json::to_string(&Msg::SyncWant { ids: vec![] }).unwrap();
        assert_eq!(json, r#"{"t":"sync_want","ids":[]}"#);
    }

    #[tokio::test]
    async fn oversize_frame_is_rejected_without_reading_body() {
        let (mut a, mut b) = tokio::io::duplex(64);
        let len = (MAX_FRAME as u32) + 1;
        a.write_all(&len.to_be_bytes()).await.unwrap();
        match read_msg(&mut b, MAX_FRAME).await {
            Err(WireError::TooLarge(n)) => assert_eq!(n, MAX_FRAME + 1),
            other => panic!("expected TooLarge, got {other:?}"),
        }
        // A smaller per-call limit applies too.
        let (mut a, mut b) = tokio::io::duplex(64);
        a.write_all(&((MAX_JOIN_FRAME as u32) + 1).to_be_bytes())
            .await
            .unwrap();
        assert!(matches!(
            read_msg(&mut b, MAX_JOIN_FRAME).await,
            Err(WireError::TooLarge(_))
        ));
    }

    #[tokio::test]
    async fn garbage_and_truncated_frames_are_rejected() {
        let garbage: &[&[u8]] = &[
            b"not json",
            b"{\"t\":\"nope\"}",
            b"{\"t\":\"sync_have\",\"ids\":5}",
            &[0xff, 0xfe, 0x00],
        ];
        for body in garbage {
            let (mut a, mut b) = tokio::io::duplex(1024);
            a.write_all(&(body.len() as u32).to_be_bytes())
                .await
                .unwrap();
            a.write_all(body).await.unwrap();
            assert!(
                matches!(
                    read_msg(&mut b, MAX_FRAME).await,
                    Err(WireError::Malformed(_))
                ),
                "{body:?}"
            );
        }

        let (mut a, mut b) = tokio::io::duplex(1024);
        a.write_all(&0u32.to_be_bytes()).await.unwrap();
        assert!(matches!(
            read_msg(&mut b, MAX_FRAME).await,
            Err(WireError::Malformed(_))
        ));

        let (mut a, mut b) = tokio::io::duplex(1024);
        a.write_all(&10u32.to_be_bytes()).await.unwrap();
        a.write_all(b"{\"t\"").await.unwrap();
        drop(a);
        assert!(matches!(
            read_msg(&mut b, MAX_FRAME).await,
            Err(WireError::Truncated)
        ));

        let (mut a, mut b) = tokio::io::duplex(1024);
        a.write_all(&[0, 0]).await.unwrap();
        drop(a);
        assert!(matches!(
            read_msg(&mut b, MAX_FRAME).await,
            Err(WireError::Truncated)
        ));
    }

    #[tokio::test]
    async fn stalled_peer_times_out() {
        let (_a, mut b) = tokio::io::duplex(1024);
        let r = read_msg_timeout(&mut b, MAX_FRAME, Duration::from_millis(50)).await;
        assert!(matches!(r, Err(WireError::Timeout)));
    }

    #[test]
    fn feature_and_blob_messages_round_trip_with_snake_case_tags() {
        let rec = FeatureRecord::new("{\"x\":1}");
        let msgs = vec![
            Msg::FeatureHave {
                topic: "chat".into(),
                ids: vec![rec.id.clone()],
            },
            Msg::FeatureWant {
                topic: "chat".into(),
                ids: vec![],
            },
            Msg::FeatureRecords {
                topic: "chat".into(),
                records: vec![rec],
            },
            Msg::BlobGet {
                hash: "a".repeat(64),
            },
            Msg::BlobHeader { size: 12 },
            Msg::BlobRefused {
                code: "unavailable".into(),
            },
        ];
        let tags = [
            "feature_have",
            "feature_want",
            "feature_records",
            "blob_get",
            "blob_header",
            "blob_refused",
        ];
        for (m, tag) in msgs.iter().zip(tags) {
            let frame = encode(m).unwrap();
            assert_eq!(decode(&frame[4..]).unwrap(), *m);
            let json = String::from_utf8(frame[4..].to_vec()).unwrap();
            assert!(json.starts_with(&format!("{{\"t\":\"{tag}\"")), "{json}");
        }
    }

    #[test]
    fn batch_records_respects_count_and_bytes() {
        use crate::network::feature::{MAX_RECORD_BYTES, MAX_RECORDS_PER_BATCH};
        let small: Vec<FeatureRecord> = (0..1300)
            .map(|i| FeatureRecord::new(format!("r{i}")))
            .collect();
        let batches = batch_records(small.clone(), MAX_RECORDS_PER_BATCH, 1024 * 1024);
        assert_eq!(
            batches.iter().map(Vec::len).collect::<Vec<_>>(),
            vec![512, 512, 276]
        );
        assert_eq!(batches.concat(), small);

        // Byte budget: eight records of about 200 KiB under a 1 MiB budget.
        let big: Vec<FeatureRecord> = (0..8)
            .map(|i| FeatureRecord::new(format!("{i}{}", "x".repeat(200 * 1024))))
            .collect();
        let batches = batch_records(big.clone(), MAX_RECORDS_PER_BATCH, 1024 * 1024);
        assert!(batches.len() >= 2);
        for b in &batches {
            let m = Msg::FeatureRecords {
                topic: "docs".into(),
                records: b.clone(),
            };
            assert!(encoded_len(&m) <= MAX_FRAME);
        }
        assert_eq!(batches.concat(), big);

        // A maximal record with worst-case JSON escaping still fits a frame.
        let nasty = FeatureRecord::new("\u{1}".repeat(MAX_RECORD_BYTES));
        let batches = batch_records(vec![nasty], MAX_RECORDS_PER_BATCH, 1024 * 1024);
        assert_eq!(batches.len(), 1);
        let m = Msg::FeatureRecords {
            topic: "docs".into(),
            records: batches[0].clone(),
        };
        assert!(encoded_len(&m) <= MAX_FRAME);
    }

    #[test]
    fn format_checks() {
        assert!(is_hex64(&"a".repeat(64)));
        assert!(!is_hex64(&"A".repeat(64)));
        assert!(!is_hex64(&"a".repeat(63)));
        assert!(is_hex_id32(&"0".repeat(32)));
        assert!(is_invite_tag("ABCD2345"));
        assert!(!is_invite_tag("ABCDEFGI"));
        assert!(!is_invite_tag("abcd2345"));
        assert!(!is_invite_tag("ABCD234"));
    }
}
