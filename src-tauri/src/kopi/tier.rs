//! Kopi score and tiers (docs/plans/kopi.md, 3.4).
//!
//! Score = `PEER_WEIGHT` x Kopi from colleagues + `WORK_WEIGHT` x Kopi from
//! work. The tier is the highest one whose minimum score is reached.

use super::types::Tier;

pub const PEER_WEIGHT: u32 = 3;
pub const WORK_WEIGHT: u32 = 1;

/// Tiers with their minimum score, ascending.
pub const THRESHOLDS: [(Tier, u32); 4] = [
    (Tier::AnakBaru, 0),
    (Tier::Andalan, 15),
    (Tier::Senior, 60),
    (Tier::Legenda, 180),
];

pub fn score(peer: u32, work: u32) -> u32 {
    peer.saturating_mul(PEER_WEIGHT)
        .saturating_add(work.saturating_mul(WORK_WEIGHT))
}

pub fn of(score: u32) -> Tier {
    THRESHOLDS
        .iter()
        .rev()
        .find(|(_, min)| score >= *min)
        .map_or(Tier::AnakBaru, |(t, _)| *t)
}

/// The next tier and its minimum score; `None` at the top tier.
pub fn next(score: u32) -> Option<(Tier, u32)> {
    THRESHOLDS.iter().find(|(_, min)| *min > score).copied()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn score_weights_peer_three_and_work_one() {
        assert_eq!(score(0, 0), 0);
        assert_eq!(score(1, 0), 3);
        assert_eq!(score(0, 1), 1);
        assert_eq!(score(4, 2), 14);
        assert_eq!(score(u32::MAX, u32::MAX), u32::MAX);
    }

    #[test]
    fn tier_changes_exactly_at_thresholds() {
        assert_eq!(of(0), Tier::AnakBaru);
        assert_eq!(of(14), Tier::AnakBaru);
        assert_eq!(of(15), Tier::Andalan);
        assert_eq!(of(59), Tier::Andalan);
        assert_eq!(of(60), Tier::Senior);
        assert_eq!(of(179), Tier::Senior);
        assert_eq!(of(180), Tier::Legenda);
        assert_eq!(of(u32::MAX), Tier::Legenda);
    }

    #[test]
    fn next_names_the_following_tier_and_its_minimum() {
        assert_eq!(next(0), Some((Tier::Andalan, 15)));
        assert_eq!(next(14), Some((Tier::Andalan, 15)));
        assert_eq!(next(15), Some((Tier::Senior, 60)));
        assert_eq!(next(60), Some((Tier::Legenda, 180)));
        assert_eq!(next(179), Some((Tier::Legenda, 180)));
        assert_eq!(next(180), None);
    }

    #[test]
    fn thresholds_ascend_from_zero() {
        assert_eq!(THRESHOLDS[0].1, 0);
        assert!(THRESHOLDS.windows(2).all(|w| w[0].1 < w[1].1 && w[0].0 < w[1].0));
    }
}
