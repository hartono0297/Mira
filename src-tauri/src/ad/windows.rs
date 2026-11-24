//! Windows directory reads: computer and user names from the OS, then
//! LDAP through wldap32, signed and sealed, bound with the logged-in
//! user's own credentials (Negotiate).
//!
//! Every blocking call runs on `spawn_blocking` under `tokio::time::timeout`.
//! A thread that outlives its timeout finishes on its own; the caller has
//! already moved on with what was read so far.

use std::ptr;
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Duration;

use windows_sys::Win32::Foundation::{ERROR_MORE_DATA, GetLastError};
use windows_sys::Win32::Networking::Ldap::{
    LDAP, LDAP_OPT_ENCRYPT, LDAP_OPT_PROTOCOL_VERSION, LDAP_OPT_REFERRALS, LDAP_OPT_SIGN,
    LDAP_OPT_SIZELIMIT, LDAP_OPT_TIMELIMIT, LDAP_PORT, LDAP_SCOPE_BASE, LDAP_SCOPE_SUBTREE,
    LDAP_SIZELIMIT_EXCEEDED, LDAP_SUCCESS, LDAP_TIMEVAL, LDAP_VERSION3, LDAPMessage,
    ldap_bind_sW, ldap_connect, ldap_first_entry, ldap_get_dnW, ldap_get_valuesW, ldap_initW,
    ldap_memfreeW, ldap_msgfree, ldap_search_ext_sW, ldap_set_option, ldap_unbind,
    ldap_value_freeW,
};
use windows_sys::Win32::Security::Authentication::Identity::{
    EXTENDED_NAME_FORMAT, GetUserNameExW, NameFullyQualifiedDN, NameSamCompatible,
};
use windows_sys::Win32::System::SystemInformation::{
    COMPUTER_NAME_FORMAT, ComputerNameDnsDomain, ComputerNameNetBIOS, GetComputerNameExW,
};
use windows_sys::core::PCWSTR;

use super::{DirectoryUser, LocalAd, LookupError, base_dn, tidy_domain};

/// `LDAP_AUTH_OTHERKIND | 0x0400` (winldap.h); not exported by windows-sys.
const LDAP_AUTH_NEGOTIATE: u32 = 0x0486;
/// `userAccountControl` ACCOUNTDISABLE.
const UF_ACCOUNTDISABLE: u32 = 0x2;

pub(super) fn machine_domain() -> Option<String> {
    computer_name(ComputerNameDnsDomain).and_then(|d| tidy_domain(&d))
}

pub(super) async fn read_local(timeout: Duration) -> Option<LocalAd> {
    let shared = Arc::new(Mutex::new(None::<LocalAd>));
    let worker = Arc::clone(&shared);
    let task = tokio::task::spawn_blocking(move || read_local_blocking(&worker, timeout));
    let finished = matches!(tokio::time::timeout(timeout, task).await, Ok(Ok(())));
    let mut read = lock(&shared).clone()?;
    if !finished {
        read.complete = false;
    }
    Some(read)
}

pub(super) async fn lookup_user(
    domain: String,
    user: String,
    timeout: Duration,
) -> Result<DirectoryUser, LookupError> {
    let task = tokio::task::spawn_blocking(move || lookup_blocking(&domain, &user, timeout));
    match tokio::time::timeout(timeout, task).await {
        Ok(Ok(found)) => found,
        _ => Err(LookupError::Unreachable),
    }
}

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// Fills `out` step by step, so a timeout still finds the parts read so
/// far. `complete` turns true only after the directory answered.
fn read_local_blocking(out: &Mutex<Option<LocalAd>>, timeout: Duration) {
    let Some(mut domain) = machine_domain() else {
        return;
    };
    let Some(sam) = user_name(NameSamCompatible) else {
        return;
    };
    let Some((prefix, user)) = sam.split_once('\\') else {
        return;
    };
    // `PCNAME\user` is a local account, even on a domain computer.
    let local_account = computer_name(ComputerNameNetBIOS)
        .is_none_or(|pc| pc.eq_ignore_ascii_case(prefix));
    if local_account || user.is_empty() {
        return;
    }
    *lock(out) = Some(LocalAd {
        domain: domain.clone(),
        user: Some(user.to_owned()),
        ..LocalAd::default()
    });

    // Needs a domain controller; can fail or take long.
    let Some(dn) = user_name(NameFullyQualifiedDN) else {
        return;
    };
    // The account may live in another domain of the forest.
    if let Some(user_domain) = domain_of_dn(&dn) {
        domain = user_domain;
    }
    if let Some(read) = lock(out).as_mut() {
        read.domain = domain.clone();
        read.dn = Some(dn.clone());
    }

    let Some(conn) = Conn::connect(&domain, timeout) else {
        return;
    };
    let attrs = ["sAMAccountName", "displayName", "department"];
    let Ok(res) = conn.search(&dn, LDAP_SCOPE_BASE, "(objectClass=*)", &attrs, timeout, 1) else {
        return;
    };
    let Some(entry) = res.first_entry(&conn) else {
        return;
    };
    let sam_name = conn.value(entry, "sAMAccountName");
    let display_name = conn.value(entry, "displayName");
    let department = conn.value(entry, "department");
    if let Some(read) = lock(out).as_mut() {
        if sam_name.is_some() {
            read.user = sam_name;
        }
        read.display_name = display_name;
        read.department = department;
        read.complete = true;
    }
}

fn lookup_blocking(
    domain: &str,
    user: &str,
    timeout: Duration,
) -> Result<DirectoryUser, LookupError> {
    if user.is_empty() {
        return Err(LookupError::NotFound);
    }
    let conn = Conn::connect(domain, timeout).ok_or(LookupError::Unreachable)?;
    let filter = format!(
        "(&(objectCategory=person)(objectClass=user)(sAMAccountName={}))",
        escape_filter(user)
    );
    let attrs = [
        "sAMAccountName",
        "distinguishedName",
        "displayName",
        "department",
        "userAccountControl",
    ];
    let res = conn
        .search(&base_dn(domain), LDAP_SCOPE_SUBTREE, &filter, &attrs, timeout, 2)
        .map_err(|_| LookupError::Unreachable)?;
    let entry = res.first_entry(&conn).ok_or(LookupError::NotFound)?;
    let dn = conn
        .value(entry, "distinguishedName")
        .or_else(|| conn.dn(entry))
        .ok_or(LookupError::NotFound)?;
    let uac = conn
        .value(entry, "userAccountControl")
        .and_then(|v| v.trim().parse::<i64>().ok())
        .unwrap_or(0);
    Ok(DirectoryUser {
        user: conn
            .value(entry, "sAMAccountName")
            .unwrap_or_else(|| user.to_owned()),
        dn,
        display_name: conn.value(entry, "displayName"),
        department: conn.value(entry, "department"),
        disabled: uac & i64::from(UF_ACCOUNTDISABLE) != 0,
    })
}

/// RFC 4515 escaping for a filter assertion value.
fn escape_filter(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for c in value.chars() {
        match c {
            '*' => out.push_str("\\2a"),
            '(' => out.push_str("\\28"),
            ')' => out.push_str("\\29"),
            '\\' => out.push_str("\\5c"),
            '\0' => out.push_str("\\00"),
            c => out.push(c),
        }
    }
    out
}

/// Trailing `DC=` parts of a DN as a DNS domain, `None` when there are none.
fn domain_of_dn(dn: &str) -> Option<String> {
    let labels: Vec<&str> = dn
        .rsplit(',')
        .map(str::trim)
        .map_while(|rdn| {
            let (attr, value) = rdn.split_once('=')?;
            attr.trim().eq_ignore_ascii_case("DC").then(|| value.trim())
        })
        .collect();
    if labels.is_empty() || labels.iter().any(|l| l.is_empty()) {
        return None;
    }
    let joined: Vec<&str> = labels.into_iter().rev().collect();
    tidy_domain(&joined.join("."))
}

fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

/// Reads a NUL-terminated UTF-16 string.
///
/// # Safety
/// `p` must be non-null and point to a NUL-terminated UTF-16 string.
unsafe fn from_wide_ptr(p: *const u16) -> String {
    let mut len = 0;
    // SAFETY: the caller guarantees a terminator, so every read up to and
    // including it stays inside the string.
    unsafe {
        while *p.add(len) != 0 {
            len += 1;
        }
        String::from_utf16_lossy(std::slice::from_raw_parts(p, len))
    }
}

/// Calls a Win32 "fill this buffer" function, growing the buffer once when
/// it reports `ERROR_MORE_DATA`. Starts large enough that the usual case is
/// a single call (the DN lookup contacts a domain controller).
fn read_wide(mut call: impl FnMut(*mut u16, &mut u32) -> bool) -> Option<String> {
    let mut buf = vec![0u16; 512];
    for _ in 0..2 {
        let mut len = u32::try_from(buf.len()).ok()?;
        if call(buf.as_mut_ptr(), &mut len) {
            buf.truncate((len as usize).min(buf.len()));
            let s = String::from_utf16_lossy(&buf);
            let s = s.trim_end_matches('\0').trim();
            return (!s.is_empty()).then(|| s.to_owned());
        }
        // SAFETY: no preconditions; reads this thread's last error.
        if unsafe { GetLastError() } != ERROR_MORE_DATA || len as usize <= buf.len() {
            return None;
        }
        buf = vec![0u16; len as usize];
    }
    None
}

fn computer_name(format: COMPUTER_NAME_FORMAT) -> Option<String> {
    // SAFETY: `buf` points to `len` writable u16s; the function writes at
    // most that many and updates `len`.
    read_wide(|buf, len| unsafe { GetComputerNameExW(format, buf, len) } != 0)
}

fn user_name(format: EXTENDED_NAME_FORMAT) -> Option<String> {
    // SAFETY: as in `computer_name`.
    read_wide(|buf, len| unsafe { GetUserNameExW(format, buf, len) })
}

fn whole_seconds(d: Duration) -> u32 {
    u32::try_from(d.as_secs()).unwrap_or(u32::MAX).clamp(1, 3600)
}

/// An LDAP session, unbound (and freed) on drop.
struct Conn(*mut LDAP);

impl Drop for Conn {
    fn drop(&mut self) {
        // SAFETY: `self.0` came from `ldap_initW` and is freed only here.
        unsafe { ldap_unbind(self.0) };
    }
}

/// A search result, freed on drop.
struct Results(*mut LDAPMessage);

impl Drop for Results {
    fn drop(&mut self) {
        if !self.0.is_null() {
            // SAFETY: `self.0` came from `ldap_search_ext_sW` and is freed
            // only here.
            unsafe { ldap_msgfree(self.0) };
        }
    }
}

impl Results {
    fn first_entry(&self, conn: &Conn) -> Option<*mut LDAPMessage> {
        if self.0.is_null() {
            return None;
        }
        // SAFETY: both handles are live; the entry belongs to `self`.
        let entry = unsafe { ldap_first_entry(conn.0, self.0) };
        (!entry.is_null()).then_some(entry)
    }
}

impl Conn {
    /// Session to `host` (a DNS domain lets wldap32 locate a controller)
    /// with LDAP v3, signing, sealing and time limits set. No network yet.
    fn open(host: &str, timeout: Duration) -> Option<Conn> {
        let host = wide(host);
        // SAFETY: `host` is NUL-terminated and outlives the call.
        let ld = unsafe { ldap_initW(host.as_ptr(), LDAP_PORT) };
        if ld.is_null() {
            return None;
        }
        let conn = Conn(ld);
        conn.set(LDAP_OPT_PROTOCOL_VERSION, LDAP_VERSION3)?;
        conn.set(LDAP_OPT_SIGN, 1)?;
        conn.set(LDAP_OPT_ENCRYPT, 1)?;
        conn.set(LDAP_OPT_TIMELIMIT, whole_seconds(timeout))?;
        // Chasing referrals would bind again elsewhere and wait longer.
        let _ = conn.set(LDAP_OPT_REFERRALS, 0);
        Some(conn)
    }

    /// `open`, then connect and bind as the logged-in user.
    fn connect(host: &str, timeout: Duration) -> Option<Conn> {
        let conn = Conn::open(host, timeout)?;
        let secs = i32::try_from(whole_seconds(timeout)).unwrap_or(i32::MAX);
        let mut tv = LDAP_TIMEVAL {
            tv_sec: secs,
            tv_usec: 0,
        };
        // SAFETY: live session; `tv` outlives the call.
        if unsafe { ldap_connect(conn.0, &mut tv) } != LDAP_SUCCESS as u32 {
            return None;
        }
        // SAFETY: live session; null DN and credentials mean "the current
        // logon" for Negotiate.
        let rc = unsafe { ldap_bind_sW(conn.0, ptr::null(), ptr::null(), LDAP_AUTH_NEGOTIATE) };
        (rc == LDAP_SUCCESS as u32).then_some(conn)
    }

    /// Sets a ULONG option.
    fn set(&self, option: u32, value: u32) -> Option<()> {
        let option = i32::try_from(option).ok()?;
        // SAFETY: live session; these options read a ULONG through the
        // pointer, which stays valid for the call.
        let rc = unsafe { ldap_set_option(self.0, option, (&raw const value).cast()) };
        (rc == LDAP_SUCCESS as u32).then_some(())
    }

    /// Synchronous search; an answer cut at `size_limit` still counts.
    fn search(
        &self,
        base: &str,
        scope: u32,
        filter: &str,
        attrs: &[&str],
        timeout: Duration,
        size_limit: u32,
    ) -> Result<Results, u32> {
        let base = wide(base);
        let filter = wide(filter);
        let attr_bufs: Vec<Vec<u16>> = attrs.iter().map(|a| wide(a)).collect();
        let mut attr_ptrs: Vec<*const u16> = attr_bufs.iter().map(|a| a.as_ptr()).collect();
        attr_ptrs.push(ptr::null());
        let _ = self.set(LDAP_OPT_SIZELIMIT, size_limit);
        let secs = i32::try_from(whole_seconds(timeout)).unwrap_or(i32::MAX);
        let mut tv = LDAP_TIMEVAL {
            tv_sec: secs,
            tv_usec: 0,
        };
        let mut res: *mut LDAPMessage = ptr::null_mut();
        // SAFETY: live session; every string is NUL-terminated, `attr_ptrs`
        // is NULL-terminated, and all of them plus `tv` and `res` outlive
        // the call.
        let rc = unsafe {
            ldap_search_ext_sW(
                self.0,
                base.as_ptr(),
                scope,
                filter.as_ptr(),
                attr_ptrs.as_ptr(),
                0,
                ptr::null(),
                ptr::null(),
                &mut tv,
                size_limit,
                &mut res,
            )
        };
        // The result must be freed even when the call reports an error.
        let res = Results(res);
        if rc == LDAP_SUCCESS as u32 || rc == LDAP_SIZELIMIT_EXCEEDED as u32 {
            Ok(res)
        } else {
            Err(rc)
        }
    }

    /// First value of `attr`, `None` when absent or empty.
    fn value(&self, entry: *mut LDAPMessage, attr: &str) -> Option<String> {
        let name = wide(attr);
        // SAFETY: live session and entry; `name` is NUL-terminated.
        let vals = unsafe { ldap_get_valuesW(self.0, entry, name.as_ptr()) };
        if vals.is_null() {
            return None;
        }
        // SAFETY: `vals` is a NULL-terminated array of NUL-terminated
        // strings owned by wldap32; it is read before being freed once.
        let first = unsafe {
            let first = *vals;
            let s = (!first.is_null()).then(|| from_wide_ptr(first));
            ldap_value_freeW(vals as *const PCWSTR);
            s
        };
        first.map(|s| s.trim().to_owned()).filter(|s| !s.is_empty())
    }

    /// The entry's DN as the server reported it.
    fn dn(&self, entry: *mut LDAPMessage) -> Option<String> {
        // SAFETY: live session and entry.
        let p = unsafe { ldap_get_dnW(self.0, entry) };
        if p.is_null() {
            return None;
        }
        // SAFETY: `p` is a NUL-terminated string from wldap32, read before
        // being freed once.
        let dn = unsafe {
            let dn = from_wide_ptr(p);
            ldap_memfreeW(p);
            dn
        };
        (!dn.is_empty()).then_some(dn)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn filter_values_are_escaped() {
        assert_eq!(escape_filter("rina"), "rina");
        assert_eq!(escape_filter("a*b(c)d\\e\0"), "a\\2ab\\28c\\29d\\5ce\\00");
        assert_eq!(escape_filter("*)(cn=*"), "\\2a\\29\\28cn=\\2a");
    }

    #[test]
    fn domain_from_dn() {
        assert_eq!(
            domain_of_dn("CN=Rina,OU=Keuangan,DC=macf,DC=co,DC=id").as_deref(),
            Some("macf.co.id")
        );
        assert_eq!(
            domain_of_dn("CN=Wijaya\\, Rina,OU=IT,dc=MACF, dc=co,dc=id").as_deref(),
            Some("macf.co.id")
        );
        assert_eq!(domain_of_dn("CN=Rina,OU=IT"), None);
        assert_eq!(domain_of_dn("CN=Rina,DC=,DC=id"), None);
    }

    #[test]
    fn names_from_the_os_do_not_panic() {
        let _ = machine_domain();
        let _ = computer_name(ComputerNameNetBIOS);
        let _ = user_name(NameSamCompatible);
    }

    /// Exercises `ldap_initW` and the option calls on the real wldap32
    /// without touching the network.
    #[test]
    fn session_options_are_accepted() {
        assert!(Conn::open("mira-test.invalid", Duration::from_secs(2)).is_some());
    }
}
