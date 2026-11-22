//! Random pull orders between three laptops converge to the same messages
//! and statuses.

use std::collections::BTreeSet;

use proptest::prelude::*;

use super::super::testutil::{Office, Who, pull, sync};
use super::super::view::DeliveryState;
use super::messages;

proptest! {
    #![proptest_config(ProptestConfig::with_cases(12))]

    #[test]
    fn random_pull_orders_converge(
        pulls in proptest::collection::vec((0usize..3, 0usize..3), 0..14),
        offline in 0usize..4,
        delete_first in any::<bool>(),
    ) {
        let o = Office::new(&[("Sari", Who::Superadmin), ("Budi", Who::Member), ("Citra", Who::Member)]);
        let umum = o.umum();
        // `offline` < 3 marks one laptop as not connected when the others
        // send, so envelopes are part of the mix.
        for (i, l) in o.l.iter().enumerate() {
            let others: Vec<&str> = o
                .l
                .iter()
                .enumerate()
                .filter(|(j, _)| *j != i && *j != offline)
                .map(|(_, x)| x.pk.as_str())
                .collect();
            l.hooks.set_connected(&others);
        }
        let mut sent = Vec::new();
        for l in &o.l {
            for n in 0..2 {
                sent.push(l.chat.send(&umum, &format!("{} {n}", l.name), None, vec![], vec![]).unwrap().id);
            }
        }
        if delete_first {
            o.l[0].chat.delete_message(&umum, &sent[0]).unwrap();
        }
        for (from, to) in pulls {
            if from != to {
                pull(&o.l[from], &o.l[to]);
            }
        }
        let refs: Vec<_> = o.l.iter().collect();
        sync(&refs);

        let sets: Vec<BTreeSet<(String, bool)>> = o
            .l
            .iter()
            .map(|l| messages(l, &umum).into_iter().map(|m| (m.id, m.deleted)).collect())
            .collect();
        prop_assert_eq!(&sets[0], &sets[1]);
        prop_assert_eq!(&sets[1], &sets[2]);
        prop_assert_eq!(sets[0].len(), 6);
        for l in &o.l {
            for m in messages(l, &umum).into_iter().filter(|m| m.mine && !m.deleted) {
                let st = m.status.unwrap();
                prop_assert_eq!(st.state, DeliveryState::Delivered);
                prop_assert_eq!(st.delivered, 2);
            }
            prop_assert_eq!(
                l.count("SELECT count(*) FROM chat_records WHERE kind = 'envelope' AND body IS NOT NULL"),
                0
            );
        }
    }
}
