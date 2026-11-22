//! Pure test harness: an organization and actors with raw signing keys, ops
//! folded in memory without a database.

use ed25519_dalek::{Signer, SigningKey};
use rand_core::{OsRng, RngCore};
use time::OffsetDateTime;

use crate::org::Organization;
use crate::permissions::format::{format_time, parse_time};
use crate::permissions::invite::sign_proof;
use crate::permissions::op::{OP_VERSION, sign_payload};
use crate::permissions::{
    Body, InviteRole, NormalizedCode, OrgState, Outcome, Payload, Scope, SignedOp, VerifiedOp,
    fold, invite_key_message, invite_public_key, normalize_code, sign_invite_key, verify_op,
};

pub fn rand_hex16() -> String {
    let mut b = [0u8; 16];
    OsRng.fill_bytes(&mut b);
    hex::encode(b)
}

pub fn t(s: &str) -> OffsetDateTime {
    parse_time(s).unwrap()
}

pub struct Actor {
    pub sk: SigningKey,
    pub pk: String,
}

impl Actor {
    pub fn new() -> Actor {
        let sk = SigningKey::generate(&mut OsRng);
        let pk = hex::encode(sk.verifying_key().as_bytes());
        Actor { sk, pk }
    }
}

pub fn signed_org(founder: &Actor, created_at: &str) -> Organization {
    let mut org = Organization {
        id: rand_hex16(),
        name: "CV Uji Coba".into(),
        founder_public_key: founder.pk.clone(),
        created_at: created_at.into(),
        genesis_signature: String::new(),
    };
    org.genesis_signature = hex::encode(founder.sk.sign(&org.genesis_message()).to_bytes());
    org
}

pub fn new_code() -> NormalizedCode {
    normalize_code(&crate::permissions::generate_invite_code()).unwrap()
}

pub struct Sim {
    pub org: Organization,
    pub founder: Actor,
    pub ops: Vec<VerifiedOp>,
    pub lamport: u64,
    pub now: OffsetDateTime,
}

pub struct Invite {
    pub id: String,
    pub code: NormalizedCode,
    pub outcome: Outcome,
}

impl Sim {
    pub fn new() -> Sim {
        let founder = Actor::new();
        let org = signed_org(&founder, "2026-11-22T00:00:00Z");
        Sim {
            org,
            founder,
            ops: Vec::new(),
            lamport: 0,
            now: t("2026-11-22T01:00:00Z"),
        }
    }

    pub fn payload(&self, by: &Actor, lamport: u64, scope: Scope, body: Body) -> Payload {
        Payload {
            v: OP_VERSION,
            org: self.org.id.clone(),
            author: by.pk.clone(),
            lamport,
            at: format_time(self.now),
            nonce: rand_hex16(),
            scope,
            body,
        }
    }

    pub fn sign(by: &Actor, payload: &Payload) -> SignedOp {
        sign_payload(payload, |m| by.sk.sign(m))
    }

    /// Signed and verified op with an explicit lamport.
    pub fn make_at(&self, by: &Actor, lamport: u64, body: Body) -> VerifiedOp {
        let scope = match &body {
            Body::ChannelCreate { team, .. } => Scope::Team { team: team.clone() },
            _ => Scope::Org,
        };
        let signed = Self::sign(by, &self.payload(by, lamport, scope, body));
        verify_op(&signed, &self.org.id, self.now).expect("test op must be well formed")
    }

    /// Appends an op with the next lamport; returns its outcome in the fold.
    pub fn push(&mut self, by: &Actor, body: Body) -> Outcome {
        self.lamport += 1;
        let op = self.make_at(by, self.lamport, body);
        self.add(op)
    }

    pub fn add(&mut self, op: VerifiedOp) -> Outcome {
        let id = op.id.clone();
        self.ops.push(op);
        self.outcome(&id)
    }

    pub fn outcome(&self, id: &str) -> Outcome {
        fold(&self.org, &self.ops)
            .outcomes
            .into_iter()
            .find(|(i, _)| i == id)
            .map(|(_, o)| o)
            .expect("op in fold")
    }

    pub fn state(&self) -> OrgState {
        fold(&self.org, &self.ops).state
    }

    pub fn team(&mut self, name: &str) -> String {
        let id = rand_hex16();
        let founder = self.founder();
        let r = self.push(
            &founder,
            Body::TeamCreate {
                team: id.clone(),
                name: name.into(),
            },
        );
        assert_eq!(r, Ok(()));
        id
    }

    pub fn founder(&self) -> Actor {
        Actor {
            sk: self.founder.sk.clone(),
            pk: self.founder.pk.clone(),
        }
    }

    /// `invite_create` body made by `by`, with a valid `key_sig`.
    pub fn invite_body(
        &self,
        by: &Actor,
        team: &str,
        role: InviteRole,
        single_use: bool,
        hours: i64,
        code: &NormalizedCode,
    ) -> (String, Body) {
        let id = rand_hex16();
        let projects = if role == InviteRole::Guest {
            vec![rand_hex16(), rand_hex16()]
        } else {
            vec![]
        };
        let expires = format_time(self.now + time::Duration::hours(hours));
        let key_sig = self.key_sig(by, &id, team, role, &projects, &expires, single_use, code);
        (
            id.clone(),
            Body::InviteCreate {
                invite: id,
                team: team.into(),
                role,
                projects,
                expires,
                single_use,
                tag: code.tag().into(),
                key: invite_public_key(code),
                key_sig,
            },
        )
    }

    #[allow(clippy::too_many_arguments)]
    pub fn key_sig(
        &self,
        by: &Actor,
        invite: &str,
        team: &str,
        role: InviteRole,
        projects: &[String],
        expires: &str,
        single_use: bool,
        code: &NormalizedCode,
    ) -> String {
        sign_invite_key(
            code,
            &invite_key_message(
                &self.org.id,
                &self.org.founder_public_key,
                &by.pk,
                invite,
                team,
                role,
                projects,
                expires,
                single_use,
                code.tag(),
            ),
        )
    }

    pub fn invite(&mut self, by: &Actor, team: &str, role: InviteRole, single_use: bool) -> Invite {
        let code = new_code();
        let (id, body) = self.invite_body(by, team, role, single_use, 24, &code);
        let outcome = self.push(by, body);
        Invite { id, code, outcome }
    }

    pub fn accept_body(&self, inv: &Invite, member: &Actor, name: &str) -> Body {
        let proof = sign_proof(&inv.code, &self.org.id, &inv.id, &member.pk, name, |m| {
            member.sk.sign(m)
        });
        Body::InviteAccept {
            invite: inv.id.clone(),
            member: proof.member,
            name: proof.name,
            invite_sig: proof.invite_sig,
            member_sig: proof.member_sig,
        }
    }

    /// `checker` authors the accept for `member`.
    pub fn accept(&mut self, checker: &Actor, inv: &Invite, member: &Actor, name: &str) -> Outcome {
        let body = self.accept_body(inv, member, name);
        self.push(checker, body)
    }

    /// New member admitted to `team` with `role` by the founder.
    pub fn join(&mut self, team: &str, role: InviteRole, name: &str) -> Actor {
        let f = self.founder();
        let inv = self.invite(&f, team, role, true);
        assert_eq!(inv.outcome, Ok(()));
        let a = Actor::new();
        assert_eq!(self.accept(&f, &inv, &a, name), Ok(()));
        a
    }
}
