//! Fractional indexing for card order within a column.
//!
//! A rank is a non-empty string of base-62 digits (`0-9A-Za-z`, which is also
//! their ASCII order) that never ends in `0` and is at most
//! [`MAX_RANK_LEN`] long. Between two valid ranks `a < b` there is almost
//! always another valid rank, so moving a card between two neighbours
//! rewrites only that card's rank; when there is none, [`place`] renumbers
//! the fewest neighbours that make room. Ported from the "midpoint"
//! algorithm of David Greenspan's fractional-indexing (without integer part).

const DIGITS: &[u8; 62] = b"0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

/// Longest rank a document may hold. Ranks come from other laptops too, so
/// the length is capped; [`between`] never returns a longer one.
pub const MAX_RANK_LEN: usize = 64;

fn digit(b: u8) -> Option<usize> {
    match b {
        b'0'..=b'9' => Some((b - b'0') as usize),
        b'A'..=b'Z' => Some((b - b'A') as usize + 10),
        b'a'..=b'z' => Some((b - b'a') as usize + 36),
        _ => None,
    }
}

/// Non-empty, at most [`MAX_RANK_LEN`] long, only base-62 digits, no
/// trailing `0`.
pub fn is_valid(rank: &str) -> bool {
    !rank.is_empty()
        && rank.len() <= MAX_RANK_LEN
        && rank.bytes().all(|b| digit(b).is_some())
        && !rank.ends_with('0')
}

/// A rank strictly between `before` and `after` (`None` = open end).
/// Returns `None` when the bounds are invalid or not in order, or when the
/// only rank between them would be longer than [`MAX_RANK_LEN`]; the caller
/// then renumbers with [`place`].
pub fn between(before: Option<&str>, after: Option<&str>) -> Option<String> {
    let a = before.unwrap_or("");
    if !a.is_empty() && !is_valid(a) {
        return None;
    }
    if let Some(b) = after
        && (!is_valid(b) || a >= b)
    {
        return None;
    }
    let out = String::from_utf8(midpoint(a.as_bytes(), after.map(str::as_bytes))).ok()?;
    is_valid(&out).then_some(out)
}

/// The midpoint digit string of `a < b` (`b = None`: open end). Iterative,
/// so a long input cannot exhaust the stack.
fn midpoint(mut a: &[u8], mut b: Option<&[u8]>) -> Vec<u8> {
    let mut out = Vec::new();
    loop {
        if let Some(bs) = b {
            // Strip the common prefix, padding `a` with zeros.
            let mut n = 0;
            while n < bs.len() && a.get(n).copied().unwrap_or(b'0') == bs[n] {
                n += 1;
            }
            out.extend_from_slice(&bs[..n]);
            a = a.get(n..).unwrap_or(&[]);
            b = Some(&bs[n..]);
        }
        let digit_a = a.first().and_then(|&c| digit(c)).unwrap_or(0);
        let digit_b = b
            .and_then(|b| b.first())
            .and_then(|&c| digit(c))
            .unwrap_or(DIGITS.len());
        if digit_b > digit_a + 1 {
            out.push(DIGITS[(digit_a + digit_b).div_ceil(2)]);
            return out;
        }
        if let Some(bs) = b.filter(|b| b.len() > 1) {
            out.push(bs[0]);
            return out;
        }
        out.push(DIGITS[digit_a]);
        a = a.get(1..).unwrap_or(&[]);
        b = None;
    }
}

/// `n` increasing valid ranks strictly between `before` and `after`, made by
/// halving the gap, so they stay short (one more character for about every
/// six doublings of `n`). `None` when the gap cannot hold them.
pub fn spread_between(before: Option<&str>, after: Option<&str>, n: usize) -> Option<Vec<String>> {
    let mut out = vec![String::new(); n];
    let mut todo = vec![(before.map(str::to_owned), after.map(str::to_owned), 0, n)];
    while let Some((lo, hi, start, end)) = todo.pop() {
        if start >= end {
            continue;
        }
        let mid = start + (end - start) / 2;
        let r = between(lo.as_deref(), hi.as_deref())?;
        todo.push((lo, Some(r.clone()), start, mid));
        todo.push((Some(r.clone()), hi, mid + 1, end));
        out[mid] = r;
    }
    Some(out)
}

/// `n` increasing valid ranks (used to renumber a whole list).
pub fn spread(n: usize) -> Vec<String> {
    // An open gap always holds them: 62^64 ranks fit in 64 characters.
    spread_between(None, None, n).unwrap_or_default()
}

/// Where an item goes when it is put at `index` of a list whose current
/// ranks, in display order and without the item, are `ranks`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Placement {
    /// The item's new rank.
    pub rank: String,
    /// Neighbours that need a new rank too: `(index in ranks, new rank)`.
    /// Empty in the common case.
    pub renumber: Vec<(usize, String)>,
}

/// The rank for an item put at `index` (clamped) among `ranks`. When the
/// neighbours leave no room (equal ranks after concurrent moves, or a rank
/// that is invalid or too long), the smallest window of neighbours around
/// `index` whose outer bounds leave room is renumbered with it, so a change
/// rewrites as few ranks as possible. `None` only if even the whole list
/// cannot be renumbered, which does not happen for any list that fits in
/// memory.
pub fn place(ranks: &[&str], index: usize) -> Option<Placement> {
    let n = ranks.len();
    let index = index.min(n);
    let mut radius = 0usize;
    loop {
        let lo = index.saturating_sub(radius);
        let hi = index.saturating_add(radius).min(n);
        let lower = lo.checked_sub(1).map(|i| ranks[i]);
        let upper = ranks.get(hi).copied();
        if let Some(mut new) = spread_between(lower, upper, hi - lo + 1) {
            let rank = new.remove(index - lo);
            let renumber = (lo..hi).zip(new).collect();
            return Some(Placement { rank, renumber });
        }
        if lo == 0 && hi == n {
            return None;
        }
        radius = if radius == 0 { 1 } else { radius.saturating_mul(2) };
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use proptest::prelude::*;

    #[test]
    fn simple_cases() {
        assert_eq!(between(None, None).unwrap(), "V");
        let first = between(None, None).unwrap();
        let after = between(Some(&first), None).unwrap();
        assert!(after > first);
        let before = between(None, Some(&first)).unwrap();
        assert!(before < first);
        let mid = between(Some(&before), Some(&first)).unwrap();
        assert!(before < mid && mid < first);
        assert_eq!(between(Some("1"), Some("2")).unwrap(), "1V");
        assert_eq!(between(Some("a"), Some("a")), None);
        assert_eq!(between(Some("b"), Some("a")), None);
        assert_eq!(between(Some("a0"), None), None);
        assert_eq!(between(Some("a!"), None), None);
        assert_eq!(between(None, Some("")), None);
    }

    #[test]
    fn spread_is_increasing_and_valid() {
        let r = spread(50);
        assert!(r.windows(2).all(|w| w[0] < w[1]));
        assert!(r.iter().all(|x| is_valid(x)));
    }

    #[test]
    fn repeated_insert_at_front_and_between() {
        let mut lo = between(None, None).unwrap();
        for _ in 0..200 {
            let next = between(None, Some(&lo)).unwrap();
            assert!(next < lo && is_valid(&next));
            lo = next;
        }
        let (mut a, b) = ("1".to_owned(), "2".to_owned());
        for _ in 0..200 {
            let m = between(Some(&a), Some(&b)).unwrap();
            assert!(a < m && m < b && is_valid(&m));
            a = m;
        }
    }

    #[test]
    fn long_and_invalid_ranks_are_refused_without_recursion() {
        let huge = format!("{}1", "z".repeat(100_000));
        assert!(!is_valid(&huge));
        assert_eq!(between(Some(&huge), None), None);
        assert_eq!(between(None, Some(&huge)), None);
        // The midpoint itself is iterative: a long input does not overflow.
        let m = midpoint(huge.as_bytes(), None);
        assert_eq!(m.len(), huge.len());
        let max = "z".repeat(MAX_RANK_LEN);
        assert!(is_valid(&max));
        assert!(!is_valid(&format!("{max}1")));
        assert_eq!(between(Some(&max), None), None, "the next rank would be too long");
        let p = place(&["1", &huge, &max], 3).unwrap();
        assert!(is_valid(&p.rank));
        assert_eq!(p.renumber.iter().map(|(i, _)| *i).collect::<Vec<_>>(), [1, 2]);
    }

    #[test]
    fn between_stays_valid_up_to_the_cap() {
        let mut a = "1".to_owned();
        let b = "2".to_owned();
        let mut steps = 0;
        while let Some(m) = between(Some(&a), Some(&b)) {
            assert!(a < m && m < b && is_valid(&m));
            a = m;
            steps += 1;
        }
        assert!(steps > 100, "{steps}");
        assert!(a.len() <= MAX_RANK_LEN);
    }

    #[test]
    fn spread_is_short_for_big_lists() {
        let r = spread(100_000);
        assert!(r.windows(2).all(|w| w[0] < w[1]));
        assert!(r.iter().all(|x| is_valid(x) && x.len() <= 5), "{:?}", r.iter().map(String::len).max());
        let inner = spread_between(Some("1"), Some("2"), 1000).unwrap();
        assert!(inner.windows(2).all(|w| w[0] < w[1]));
        assert!(inner.first().unwrap().as_str() > "1" && inner.last().unwrap().as_str() < "2");
        assert_eq!(spread_between(Some("2"), Some("1"), 1), None);
        assert_eq!(spread_between(Some("2"), Some("1"), 0), Some(Vec::new()));
    }

    #[test]
    fn place_renumbers_only_the_neighbours_that_need_it() {
        // Room: only the item.
        let p = place(&["1", "3"], 1).unwrap();
        assert!(p.renumber.is_empty() && "1" < p.rank.as_str() && p.rank.as_str() < "3");
        // Equal ranks in the middle of a long list: a small window.
        let mut ranks: Vec<String> = spread(1000);
        ranks[500] = ranks[501].clone();
        let refs: Vec<&str> = ranks.iter().map(String::as_str).collect();
        let p = place(&refs, 501).unwrap();
        assert!(!p.renumber.is_empty() && p.renumber.len() < 10, "{}", p.renumber.len());
        let mut after = ranks.clone();
        for (i, r) in &p.renumber {
            after[*i].clone_from(r);
        }
        after.insert(501, p.rank.clone());
        assert!(after.windows(2).all(|w| w[0] < w[1]));
        // Everything equal: the part up to the first neighbour that leaves
        // room below it (here an open start).
        let same = vec!["V"; 50];
        let p = place(&same, 10).unwrap();
        let mut after: Vec<String> = same.iter().map(|s| (*s).to_owned()).collect();
        for (i, r) in &p.renumber {
            after[*i].clone_from(r);
        }
        after.insert(10, p.rank.clone());
        let firsts = &after[..p.renumber.len() + 1];
        assert!(firsts.windows(2).all(|w| w[0] < w[1]) && firsts.last().unwrap().as_str() < "V");
        // Index past the end is clamped; empty list.
        assert_eq!(place(&[], 7).unwrap(), Placement { rank: "V".into(), renumber: vec![] });
    }

    proptest! {
        #[test]
        fn between_is_strictly_between(ops in proptest::collection::vec(any::<prop::sample::Index>(), 1..60)) {
            let mut ranks: Vec<String> = Vec::new();
            for ix in ops {
                let pos = ix.index(ranks.len() + 1);
                let before = pos.checked_sub(1).map(|i| ranks[i].as_str());
                let after = ranks.get(pos).map(String::as_str);
                let r = between(before, after).unwrap();
                prop_assert!(is_valid(&r));
                if let Some(b) = before { prop_assert!(b < r.as_str()); }
                if let Some(a) = after { prop_assert!(r.as_str() < a); }
                ranks.insert(pos, r);
            }
        }
    }
}
