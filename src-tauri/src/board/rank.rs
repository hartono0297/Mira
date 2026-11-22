//! Fractional indexing for card order within a column.
//!
//! A rank is a non-empty string of base-62 digits (`0-9A-Za-z`, which is also
//! their ASCII order) that never ends in `0`. Between any two valid ranks
//! `a < b` there is always another valid rank, so moving a card between two
//! neighbours rewrites only that card's rank. Ported from the "midpoint"
//! algorithm of David Greenspan's fractional-indexing (without integer part).

const DIGITS: &[u8; 62] = b"0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

fn digit(b: u8) -> Option<usize> {
    match b {
        b'0'..=b'9' => Some((b - b'0') as usize),
        b'A'..=b'Z' => Some((b - b'A') as usize + 10),
        b'a'..=b'z' => Some((b - b'a') as usize + 36),
        _ => None,
    }
}

/// Non-empty, only base-62 digits, no trailing `0`.
pub fn is_valid(rank: &str) -> bool {
    !rank.is_empty() && rank.bytes().all(|b| digit(b).is_some()) && !rank.ends_with('0')
}

/// A rank strictly between `before` and `after` (`None` = open end).
/// Returns `None` when the bounds are invalid or not in order; the caller
/// then renumbers the column with [`spread`].
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
    let out = midpoint(a.as_bytes(), after.map(str::as_bytes));
    String::from_utf8(out).ok()
}

fn midpoint(a: &[u8], b: Option<&[u8]>) -> Vec<u8> {
    if let Some(b) = b {
        // Strip the common prefix, padding `a` with zeros.
        let mut n = 0;
        while n < b.len() && a.get(n).copied().unwrap_or(b'0') == b[n] {
            n += 1;
        }
        if n > 0 {
            let mut out = b[..n].to_vec();
            out.extend(midpoint(a.get(n..).unwrap_or(&[]), Some(&b[n..])));
            return out;
        }
    }
    let digit_a = a.first().and_then(|&c| digit(c)).unwrap_or(0);
    let digit_b = b
        .and_then(|b| b.first())
        .and_then(|&c| digit(c))
        .unwrap_or(DIGITS.len());
    if digit_b - digit_a > 1 {
        let mid = (digit_a + digit_b).div_ceil(2);
        vec![DIGITS[mid]]
    } else if let Some(b) = b.filter(|b| b.len() > 1) {
        vec![b[0]]
    } else {
        let mut out = vec![DIGITS[digit_a]];
        out.extend(midpoint(a.get(1..).unwrap_or(&[]), None));
        out
    }
}

/// `n` evenly spread, increasing valid ranks (used to renumber a column).
pub fn spread(n: usize) -> Vec<String> {
    let mut out = Vec::with_capacity(n);
    let mut prev: Option<String> = None;
    for _ in 0..n {
        // between() with an open end always succeeds for a valid `prev`.
        let next = between(prev.as_deref(), None).unwrap_or_else(|| "V".to_owned());
        prev = Some(next.clone());
        out.push(next);
    }
    out
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
