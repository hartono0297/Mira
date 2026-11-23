#!/bin/bash
# Mira installer for macOS.
#
# Install or update (Terminal, no admin needed):
#   curl -fsSL https://raw.githubusercontent.com/hartono0297/Mira/main/install.sh | bash
#
# What it does:
#   1. Finds the newest Mira release on GitHub (prereleases included).
#   2. Picks the macOS build for this Mac: Mira_<version>_aarch64.dmg or
#      Mira_<version>_x64.dmg, else Mira_<version>_universal.dmg, else a
#      Mira_*universal.app.tar.gz. Checks its SHA-256 against the digest
#      GitHub publishes for the asset (or a .sha256 asset).
#   3. Quits a running Mira, copies Mira.app to /Applications (or to
#      ~/Applications when /Applications is not writable; never sudo),
#      removes the quarantine attribute, then opens Mira.
#
# The app is ad-hoc signed and not notarized (no Apple Developer account),
# so Gatekeeper would block a quarantined copy. Removing the attribute is
# the accepted trade-off for this internal tool; the SHA-256 check above is
# what ties the copy to the published release.
#
# Optional environment variables:
#   MIRA_GITHUB_TOKEN       token with read access, needed if the repository
#                           is private again.
#   MIRA_INSTALL_DRY_RUN=1  download and verify only, install nothing.
#
# Your data (~/Library/Application Support/id.mira.desktop and the laptop key
# in the macOS Keychain) is not touched by an update.
#
# The whole script is wrapped in main(), which runs on the last line, so a
# download cut short by the network runs nothing. Sourcing the file (for
# tests) defines the functions without running main.

MIRA_REPO='hartono0297/Mira'
MIRA_API="https://api.github.com/repos/$MIRA_REPO"
MIRA_BUNDLE_ID='id.mira.desktop'
MIRA_PS1_LINE='irm https://raw.githubusercontent.com/hartono0297/Mira/main/install.ps1 | iex'

say() { printf '  %s\n' "$*"; }

die() {
    printf '\n  %s\n\n' "$*" >&2
    exit 1
}

# ---------------------------------------------------------------------------
# Release JSON -> listing.
#
# Every parser prints the newest non-draft release as tab-separated lines:
#   tag    <tag_name>
#   asset  <name>  <digest>  <size>  <browser_download_url>  <api url>
# Empty or missing fields become "-" so `read` never collapses two tabs.
# Order of preference: JXA (always on macOS), python3, then awk.
# ---------------------------------------------------------------------------

mira_js_core() {
    cat <<'EOF'
function miraClean(v) {
  if (v === null || v === undefined || v === '') return '-';
  return String(v).replace(/[\t\r\n]/g, ' ');
}
function miraListing(text) {
  var releases = JSON.parse(text);
  if (!Array.isArray(releases)) return '';
  for (var i = 0; i < releases.length; i++) {
    var r = releases[i];
    if (!r || typeof r !== 'object' || r.draft) continue;
    var out = ['tag\t' + miraClean(r.tag_name)];
    var assets = Array.isArray(r.assets) ? r.assets : [];
    for (var j = 0; j < assets.length; j++) {
      var a = assets[j] || {};
      out.push(['asset', miraClean(a.name), miraClean(a.digest), miraClean(a.size),
                miraClean(a.browser_download_url), miraClean(a.url)].join('\t'));
    }
    return out.join('\n');
  }
  return '';
}
EOF
}

mira_python_core() {
    cat <<'EOF'
import json, sys

def clean(v):
    if v is None or v == "":
        return "-"
    if isinstance(v, bool):
        return "true" if v else "false"
    return str(v).replace("\t", " ").replace("\r", " ").replace("\n", " ")

with open(sys.argv[1], encoding="utf-8") as f:
    data = json.load(f)
for r in data if isinstance(data, list) else []:
    if not isinstance(r, dict) or r.get("draft"):
        continue
    print("tag\t" + clean(r.get("tag_name")))
    for a in r.get("assets") or []:
        a = a if isinstance(a, dict) else {}
        print("\t".join(["asset", clean(a.get("name")), clean(a.get("digest")),
                         clean(a.get("size")), clean(a.get("browser_download_url")),
                         clean(a.get("url"))]))
    break
EOF
}

# A small JSON walker in POSIX awk. It tracks container depth and the key
# each container sits under, and only reads the fields it needs:
# depth 2 = a release object, depth 3 = its "assets" array, depth 4 = an asset.
mira_awk_core() {
    cat <<'EOF'
function clean(v) { return (v == "" || v == "null") ? "-" : v }
function value(v) {
    if (depth == 2 && type[1] == "a" && type[2] == "o") {
        if (key[2] == "draft") draft = v
        else if (key[2] == "tag_name") tag = clean(v)
    } else if (depth == 4 && ckey[3] == "assets" && type[3] == "a" && type[4] == "o") {
        if (key[4] == "name") an = clean(v)
        else if (key[4] == "digest") ad = clean(v)
        else if (key[4] == "size") as = clean(v)
        else if (key[4] == "browser_download_url") ab = clean(v)
        else if (key[4] == "url") au = clean(v)
    }
}
{ text = text $0 "\n" }
END {
    n = length(text); i = 1; depth = 0
    while (i <= n) {
        c = substr(text, i, 1)
        if (c == "\"") {
            s = ""; i++
            while (i <= n) {
                c = substr(text, i, 1)
                if (c == "\\") {
                    e = substr(text, i + 1, 1)
                    if (e == "u") { s = s "?"; i += 6; continue }
                    if (e == "n" || e == "t" || e == "r" || e == "b" || e == "f") s = s " "
                    else s = s e
                    i += 2; continue
                }
                if (c == "\"") break
                if (c == "\t") c = " "
                s = s c; i++
            }
            i++
            if (type[depth] == "o" && want_key[depth]) { key[depth] = s; want_key[depth] = 0 }
            else value(s)
            continue
        }
        if (c == "{" || c == "[") {
            pk = (depth > 0 && type[depth] == "o") ? key[depth] : ""
            depth++
            type[depth] = (c == "{") ? "o" : "a"
            ckey[depth] = pk
            want_key[depth] = (c == "{") ? 1 : 0
            key[depth] = ""
            if (depth == 2) { tag = "-"; draft = ""; buf = "" }
            if (depth == 4) { an = "-"; ad = "-"; as = "-"; ab = "-"; au = "-" }
            i++; continue
        }
        if (c == "}" || c == "]") {
            if (c == "}" && depth == 4 && ckey[3] == "assets" && type[3] == "a")
                buf = buf "asset\t" an "\t" ad "\t" as "\t" ab "\t" au "\n"
            if (c == "}" && depth == 2 && type[1] == "a" && draft != "true") {
                printf "tag\t%s\n%s", tag, buf
                exit 0
            }
            depth--; i++; continue
        }
        if (c == ",") { if (type[depth] == "o") want_key[depth] = 1; i++; continue }
        if (c == ":" || c == " " || c == "\t" || c == "\n" || c == "\r") { i++; continue }
        s = ""
        while (i <= n) {
            c = substr(text, i, 1)
            if (index(",]}: \t\r\n", c)) break
            s = s c; i++
        }
        value(s)
    }
}
EOF
}

parse_with_jxa() {
    command -v osascript >/dev/null 2>&1 || return 1
    local js
    js="$(mktemp "${TMPDIR:-/tmp}/mira-parse.XXXXXX")" || return 1
    {
        mira_js_core
        cat <<'EOF'
function run(argv) {
  ObjC.import('Foundation');
  var s = $.NSString.stringWithContentsOfFileEncodingError(argv[0], $.NSUTF8StringEncoding, null);
  if (s.isNil()) throw new Error('cannot read ' + argv[0]);
  return miraListing(s.js);
}
EOF
    } > "$js"
    local rc=0
    osascript -l JavaScript "$js" "$1" || rc=$?
    rm -f "$js"
    return "$rc"
}

parse_with_python() {
    command -v python3 >/dev/null 2>&1 || return 1
    # On a Mac without the Command Line Tools, /usr/bin/python3 is a stub
    # that opens an install dialog. Only use it when the tools are present.
    if [ "$(command -v python3)" = /usr/bin/python3 ] && [ "$(uname -s)" = Darwin ]; then
        xcode-select -p >/dev/null 2>&1 || return 1
    fi
    python3 -I -c "$(mira_python_core)" "$1"
}

parse_with_awk() {
    LC_ALL=C awk "$(mira_awk_core)" "$1"
}

# Prints the listing for the newest non-draft release (empty if none).
parse_releases() {
    parse_with_jxa "$1" 2>/dev/null && return 0
    parse_with_python "$1" 2>/dev/null && return 0
    parse_with_awk "$1"
}

# ---------------------------------------------------------------------------
# Asset choice.
# ---------------------------------------------------------------------------

# Maps `uname -m` to the arch name in Tauri's file names. A shell running
# under Rosetta reports x86_64 on Apple Silicon, so ask the kernel too.
mira_arch() {
    local m
    m="$(uname -m)"
    if [ "$m" = x86_64 ] && [ "$(sysctl -n sysctl.proc_translated 2>/dev/null)" = 1 ]; then
        m=arm64
    fi
    case "$m" in
        arm64|aarch64) echo aarch64 ;;
        x86_64) echo x64 ;;
        *) return 1 ;;
    esac
}

# pick_asset <listing file> <aarch64|x64>: prints the asset line to install.
pick_asset() {
    local listing="$1" arch="$2" pattern kind name rest
    for pattern in "Mira_*_${arch}.dmg" "Mira_*_universal.dmg" \
                   "Mira_*universal.app.tar.gz" "Mira_*${arch}.app.tar.gz"; do
        while IFS=$'\t' read -r kind name rest; do
            [ "$kind" = asset ] || continue
            # shellcheck disable=SC2254 # $pattern is a glob on purpose
            case "$name" in
                $pattern) printf '%s\t%s\t%s\n' "$kind" "$name" "$rest"; return 0 ;;
            esac
        done < "$listing"
    done
    return 1
}

# find_asset_by_name <listing file> <name>: prints that asset line, if any.
find_asset_by_name() {
    local kind name rest
    while IFS=$'\t' read -r kind name rest; do
        if [ "$kind" = asset ] && [ "$name" = "$2" ]; then
            printf '%s\t%s\t%s\n' "$kind" "$name" "$rest"
            return 0
        fi
    done < "$1"
    return 1
}

# ---------------------------------------------------------------------------
# Network.
# ---------------------------------------------------------------------------

# fetch_asset <browser url> <api url> <output file>
fetch_asset() {
    if [ -n "${MIRA_GITHUB_TOKEN:-}" ]; then
        curl -fsSL --proto '=https' -o "$3" \
            -H 'User-Agent: mira-installer' \
            -H 'Accept: application/octet-stream' \
            -H "Authorization: Bearer $MIRA_GITHUB_TOKEN" "$2"
    else
        curl -fsSL --proto '=https' -o "$3" -H 'User-Agent: mira-installer' "$1"
    fi
}

fetch_releases() {
    local out="$1" code
    local args=(-sS --proto '=https' -o "$out" -w '%{http_code}'
                -H 'User-Agent: mira-installer' -H 'Accept: application/vnd.github+json')
    if [ -n "${MIRA_GITHUB_TOKEN:-}" ]; then
        args+=(-H "Authorization: Bearer $MIRA_GITHUB_TOKEN")
    fi
    code="$(curl "${args[@]}" "$MIRA_API/releases?per_page=10")" \
        || die "Gagal menghubungi GitHub. Periksa sambungan internet, lalu coba lagi."
    case "$code" in
        200) ;;
        401|404) die "Repositori Mira tidak bisa dibaca dari komputer ini (mungkin private). Minta installer ke admin, atau isi MIRA_GITHUB_TOKEN." ;;
        403|429) die "GitHub menolak permintaan (kode $code), biasanya karena batas permintaan. Tunggu sekitar satu jam, atau isi MIRA_GITHUB_TOKEN." ;;
        *) die "GitHub menjawab dengan kode $code. Coba lagi nanti." ;;
    esac
}

# ---------------------------------------------------------------------------
# Install steps.
# ---------------------------------------------------------------------------

mira_running() {
    pgrep -f 'Mira\.app/Contents/MacOS/' >/dev/null 2>&1
}

quit_mira() {
    mira_running || return 0
    say 'Menutup Mira yang sedang jalan...'
    osascript -e "tell application id \"$MIRA_BUNDLE_ID\" to quit" >/dev/null 2>&1 || true
    local n=0
    while mira_running && [ "$n" -lt 20 ]; do
        sleep 0.5
        n=$((n + 1))
    done
    if mira_running; then
        pkill -TERM -f 'Mira\.app/Contents/MacOS/' 2>/dev/null || true
        sleep 2
        pkill -KILL -f 'Mira\.app/Contents/MacOS/' 2>/dev/null || true
        sleep 1
    fi
}

# install_app <path to Mira.app> <destination folder>
install_app() {
    local src="$1" dir="$2" target new old
    target="$dir/Mira.app"
    new="$dir/.Mira.app.baru.$$"
    old="$dir/.Mira.app.lama.$$"
    rm -rf "$new" "$old"
    ditto "$src" "$new" || { rm -rf "$new"; die "Gagal menyalin Mira.app ke $dir."; }
    if [ -e "$target" ]; then
        if ! mv "$target" "$old" 2>/dev/null; then
            rm -rf "$new"
            die "Mira lama di $target tidak bisa diganti dari akun ini. Hapus dulu lewat Finder (mungkin perlu kata sandi admin), lalu jalankan perintah ini lagi."
        fi
    fi
    if ! mv "$new" "$target"; then
        [ -e "$old" ] && mv "$old" "$target"
        rm -rf "$new"
        die "Gagal memasang Mira di $dir."
    fi
    rm -rf "$old" 2>/dev/null || true
}

MIRA_WORK=''
MIRA_MOUNT=''
MIRA_KEEP_WORK=0

cleanup() {
    if [ -n "$MIRA_MOUNT" ]; then
        hdiutil detach "$MIRA_MOUNT" -quiet >/dev/null 2>&1 \
            || hdiutil detach "$MIRA_MOUNT" -force -quiet >/dev/null 2>&1 || true
        MIRA_MOUNT=''
    fi
    if [ -n "$MIRA_WORK" ] && [ "$MIRA_KEEP_WORK" != 1 ]; then
        rm -rf "$MIRA_WORK"
    fi
}

main() {
    set -euo pipefail

    printf '\nMira - pasang atau perbarui\n'

    if [ "$(uname -s)" != Darwin ]; then
        die "Skrip ini untuk macOS. Di Windows, buka PowerShell lalu jalankan: $MIRA_PS1_LINE"
    fi
    local osv major
    osv="$(sw_vers -productVersion 2>/dev/null || echo 0)"
    major="${osv%%.*}"
    case "$major" in ''|*[!0-9]*) major=0 ;; esac
    if [ "$major" -lt 11 ]; then
        die "Mira butuh macOS 11 atau yang lebih baru. Mac ini memakai macOS $osv."
    fi
    local arch
    arch="$(mira_arch)" || die "Jenis prosesor Mac ini ($(uname -m)) tidak dikenali."

    MIRA_WORK="$(mktemp -d "${TMPDIR:-/tmp}/mira-install.XXXXXX")"
    trap cleanup EXIT
    trap 'exit 130' INT TERM

    # 1. Newest release. /releases/latest skips prereleases, so list instead.
    say 'Mencari versi terbaru di GitHub...'
    local json="$MIRA_WORK/releases.json" listing="$MIRA_WORK/releases.tsv"
    fetch_releases "$json"
    parse_releases "$json" > "$listing" || die "Daftar rilis dari GitHub tidak bisa dibaca."

    local tag
    tag="$(awk -F '\t' '$1 == "tag" { print $2; exit }' "$listing")"
    [ -n "$tag" ] || die 'Belum ada rilis Mira di GitHub.'

    local line
    line="$(pick_asset "$listing" "$arch")" \
        || die "Rilis $tag belum punya installer Mira untuk macOS."
    local kind name digest size url api_url
    IFS=$'\t' read -r kind name digest size url api_url <<< "$line"

    # 2. Expected checksum: GitHub's asset digest, or a .sha256 asset.
    local expected=''
    case "$digest" in
        sha256:*) expected="${digest#sha256:}" ;;
    esac
    if [ -z "$expected" ]; then
        local sha_line
        if sha_line="$(find_asset_by_name "$listing" "$name.sha256")"; then
            local s_kind s_name s_digest s_size s_url s_api
            IFS=$'\t' read -r s_kind s_name s_digest s_size s_url s_api <<< "$sha_line"
            fetch_asset "$s_url" "$s_api" "$MIRA_WORK/asset.sha256" \
                || die "Gagal mengunduh $s_name."
            expected="$(awk 'NR == 1 { print $1 }' "$MIRA_WORK/asset.sha256")"
        fi
    fi
    expected="$(printf '%s' "$expected" | tr 'A-F' 'a-f')"
    case "$expected" in
        ''|*[!0-9a-f]*) die "Rilis $tag tidak punya checksum installer. Pemasangan dibatalkan." ;;
    esac
    [ "${#expected}" -eq 64 ] || die "Checksum rilis $tag tidak dikenali. Pemasangan dibatalkan."

    local size_mb='?'
    case "$size" in
        ''|*[!0-9]*) ;;
        *) size_mb="$(awk -v b="$size" 'BEGIN { printf "%.1f", b / 1048576 }' | tr . ,)" ;;
    esac
    say "Mengunduh Mira $tag ($size_mb MB)..."
    local file="$MIRA_WORK/$name"
    fetch_asset "$url" "$api_url" "$file" || die "Gagal mengunduh $name dari GitHub."

    local actual
    actual="$(shasum -a 256 "$file" | awk '{ print $1 }' | tr 'A-F' 'a-f')"
    if [ "$actual" != "$expected" ]; then
        die 'Checksum file yang diunduh tidak cocok. Pemasangan dibatalkan.'
    fi
    say 'Checksum cocok.'

    if [ "${MIRA_INSTALL_DRY_RUN:-}" = 1 ]; then
        MIRA_KEEP_WORK=1
        say "Uji coba saja (MIRA_INSTALL_DRY_RUN=1): Mira tidak dipasang. File: $file"
        return 0
    fi

    # 3. Close a running Mira so its files can be replaced.
    quit_mira

    # 4. Get Mira.app out of the DMG (or archive).
    local app=''
    case "$name" in
        *.dmg)
            MIRA_MOUNT="$MIRA_WORK/mnt"
            mkdir -p "$MIRA_MOUNT"
            if ! hdiutil attach -nobrowse -readonly -noautoopen \
                    -mountpoint "$MIRA_MOUNT" "$file" >/dev/null; then
                MIRA_MOUNT=''
                die "File $name tidak bisa dibuka. Pemasangan dibatalkan."
            fi
            app="$MIRA_MOUNT/Mira.app"
            ;;
        *.tar.gz)
            mkdir -p "$MIRA_WORK/unpack"
            tar -xzf "$file" -C "$MIRA_WORK/unpack" \
                || die "File $name tidak bisa dibuka. Pemasangan dibatalkan."
            app="$MIRA_WORK/unpack/Mira.app"
            ;;
    esac
    [ -d "$app" ] || die "Mira.app tidak ditemukan di dalam $name."

    # 5. /Applications when this account can write there, else ~/Applications.
    local dest='/Applications'
    if [ ! -w /Applications ]; then
        dest="$HOME/Applications"
        mkdir -p "$dest"
    fi
    say "Memasang Mira di $dest..."
    install_app "$app" "$dest"

    if [ -n "$MIRA_MOUNT" ]; then
        hdiutil detach "$MIRA_MOUNT" -quiet >/dev/null 2>&1 \
            || hdiutil detach "$MIRA_MOUNT" -force -quiet >/dev/null 2>&1 || true
        MIRA_MOUNT=''
    fi

    # 6. Ad-hoc signed, not notarized: drop the quarantine flag so Gatekeeper
    # does not block the first launch. The checksum above was already verified.
    xattr -dr com.apple.quarantine "$dest/Mira.app" 2>/dev/null || true

    if [ "$dest" != /Applications ] && [ -d /Applications/Mira.app ]; then
        say 'Catatan: masih ada Mira versi lama di /Applications. Hapus lewat Finder supaya tidak terbuka yang lama.'
    fi

    say "Terpasang di $dest/Mira.app"
    say 'Membuka Mira. Saat pertama dibuka, macOS meminta izin Mira memakai jaringan lokal:'
    say 'klik Izinkan (Allow). Kalau firewall macOS menyala, macOS juga bisa bertanya apakah'
    say 'Mira boleh menerima sambungan masuk: klik Izinkan juga. Tanpa dua izin ini, Mira'
    say 'tidak bisa menemukan laptop rekan di jaringan kantor.'
    open "$dest/Mira.app" || say 'Mira belum terbuka. Buka Mira dari folder Applications.'
    printf '\nSelesai. Mira %s siap dipakai.\n\n' "$tag"
}

# Run main unless this file is being sourced (tests source it).
if [ -z "${BASH_SOURCE[0]:-}" ] || [ "${BASH_SOURCE[0]}" = "$0" ]; then
    main "$@"
fi
