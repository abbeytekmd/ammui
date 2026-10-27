#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# AMMUI setup for Linux: a one-off bootstrap.
#
# It installs anything missing (Node.js, Git and the optional ffmpeg, yt-dlp and
# fpcalc helpers), fetches the latest AMMUI code from GitHub, installs its
# packages, adds menu entries and a background service, and starts the server.
#
# Usage:  bash ammui-setup.sh [install folder]   (default: ~/ammui)
#    or:  curl -fsSL https://raw.githubusercontent.com/abbeytekmd/ammui/main/installer/ammui-setup.sh | bash
#
# Environment switches: AMMUI_NO_EXTRAS=1 skips ffmpeg/yt-dlp/fpcalc,
# AMMUI_NO_RUN=1 sets everything up without starting the server,
# AMMUI_NO_STARTUP=1 does not run AMMUI as a service that starts with the computer.
#
# Run it as your normal user: it asks for your password (sudo) only for system
# packages and certificate trust. Run as root, it installs a system-wide service.
# ---------------------------------------------------------------------------

set -u
USER="${USER:-$(id -un)}"

REPO_URL='https://github.com/abbeytekmd/ammui.git'
REPO_TGZ='https://codeload.github.com/abbeytekmd/ammui/tar.gz/refs/heads/main'
BRANCH='main'
MIN_NODE='22.13.0'   # node:sqlite without a flag
HTTP_PORT=3000
HTTPS_PORT=3443

INSTALL_DIR="${1:-${AMMUI_INSTALL_DIR:-$HOME/ammui}}"
case "$INSTALL_DIR" in /*) ;; *) INSTALL_DIR="$PWD/$INSTALL_DIR" ;; esac
INSTALL_DIR="${INSTALL_DIR%/}"

# Files kept outside the code folder: Node.js (when installed here), the icon, the launchers,
# the uninstaller and the kiosk browser profile.
DATA_HOME="${XDG_DATA_HOME:-$HOME/.local/share}"
APP_DATA_DIR="$DATA_HOME/ammui"
APP_ICON="$APP_DATA_DIR/ammui.png"
NODE_HOME="$APP_DATA_DIR/node"            # symlink to the unpacked Node.js release
APPS_DIR="$DATA_HOME/applications"
SERVICE_NAME='ammui'

if [ -t 1 ]; then C_CYAN=$'\e[36m'; C_YELLOW=$'\e[33m'; C_RED=$'\e[31m'; C_GREEN=$'\e[32m'; C_OFF=$'\e[0m'
else C_CYAN=''; C_YELLOW=''; C_RED=''; C_GREEN=''; C_OFF=''; fi

step() { printf '\n%s==> %s%s\n' "$C_CYAN" "$1" "$C_OFF"; }
info() { printf '    %s\n' "$1"; }
warn() { printf '    %sWARNING: %s%s\n' "$C_YELLOW" "$1" "$C_OFF"; }
fail() { printf '\n%sERROR: %s%s\n' "$C_RED" "$1" "$C_OFF" >&2; exit 1; }
green() { printf '    %s%s%s\n' "$C_GREEN" "$1" "$C_OFF"; }

have() { command -v "$1" >/dev/null 2>&1; }

# Questions are read from the terminal, so they work when the script itself arrives on stdin
# (curl ... | bash). With no terminal the default answer is taken.
ask_yes() {   # ask_yes "question" Y|N
    local default="$2" reply=''
    if [ -r /dev/tty ] && { : </dev/tty; } 2>/dev/null; then
        printf '    %s [%s] ' "$1" "$([ "$default" = Y ] && echo 'Y/n' || echo 'y/N')" >/dev/tty
        read -r reply </dev/tty || reply=''
    fi
    reply="${reply:-$default}"
    case "$reply" in [Yy]*) return 0 ;; *) return 1 ;; esac
}

# --- Root access ---------------------------------------------------------------

IS_ROOT=0; [ "$(id -u)" -eq 0 ] && IS_ROOT=1

as_root() {
    if [ "$IS_ROOT" -eq 1 ]; then "$@"
    elif have sudo; then sudo "$@"
    else return 1; fi
}

can_be_root() { [ "$IS_ROOT" -eq 1 ] || have sudo; }

# --- Downloads -------------------------------------------------------------------

fetch() {   # fetch URL DEST
    info "Downloading $1"
    if have curl; then curl -fsSL --retry 2 -A ammui-setup -o "$2" "$1"
    elif have wget; then wget -q -U ammui-setup -O "$2" "$1"
    else return 1; fi
}

fetch_text() {   # fetch_text URL (to stdout)
    if have curl; then curl -fsSL --retry 2 -A ammui-setup "$1"
    elif have wget; then wget -q -U ammui-setup -O - "$1"
    else return 1; fi
}

new_temp_dir() { mktemp -d "${TMPDIR:-/tmp}/ammui-setup-XXXXXX"; }

# --- Package manager ---------------------------------------------------------------

PKG=''
if have apt-get; then PKG=apt
elif have dnf; then PKG=dnf
elif have yum; then PKG=yum
elif have pacman; then PKG=pacman
elif have zypper; then PKG=zypper
fi
APT_UPDATED=0

pkg_install() {   # pkg_install package... (tries each name in turn until one installs)
    [ -n "$PKG" ] && can_be_root || return 1
    local p
    for p in "$@"; do
        info "Installing $p (you may be asked for your password)..."
        case "$PKG" in
            apt)
                if [ "$APT_UPDATED" -eq 0 ]; then as_root apt-get update -qq >/dev/null 2>&1; APT_UPDATED=1; fi
                as_root env DEBIAN_FRONTEND=noninteractive apt-get install -y -qq "$p" >/dev/null && return 0 ;;
            dnf|yum) as_root "$PKG" install -y -q "$p" >/dev/null && return 0 ;;
            pacman)  as_root pacman -S --needed --noconfirm "$p" >/dev/null && return 0 ;;
            zypper)  as_root zypper --non-interactive --quiet install "$p" >/dev/null && return 0 ;;
        esac
    done
    return 1
}

# Package names for each tool, per package manager
pkg_names() {   # pkg_names tool
    case "$1:$PKG" in
        git:*)              echo git ;;
        curl:*)             echo curl ;;
        ffmpeg:dnf|ffmpeg:yum) echo ffmpeg ffmpeg-free ;;
        ffmpeg:*)           echo ffmpeg ;;
        fpcalc:apt)         echo libchromaprint-tools ;;
        fpcalc:dnf|fpcalc:yum) echo chromaprint-tools ;;
        fpcalc:pacman)      echo chromaprint ;;
        fpcalc:zypper)      echo chromaprint-fpcalc ;;
        certutil:apt)       echo libnss3-tools ;;
        certutil:dnf|certutil:yum) echo nss-tools ;;
        certutil:pacman)    echo nss ;;
        certutil:zypper)    echo mozilla-nss-tools ;;
    esac
}

# --- Node.js -------------------------------------------------------------------

version_ge() { [ "$(printf '%s\n%s\n' "$2" "$1" | sort -V | head -n1)" = "$2" ]; }

node_version() { have node && node --version 2>/dev/null | sed 's/^v//'; }

node_arch() {
    case "$(uname -m)" in
        x86_64|amd64) echo x64 ;;
        aarch64|arm64) echo arm64 ;;
        armv7l|armv7*) echo armv7l ;;
        ppc64le) echo ppc64le ;;
        s390x) echo s390x ;;
        *) echo '' ;;
    esac
}

install_node_tarball() {
    # The official Linux build, unpacked into this user's AMMUI data folder: no root needed,
    # and it works the same on every distribution (their own packages are often too old).
    local arch; arch="$(node_arch)"
    [ -n "$arch" ] || fail "There is no Node.js build for this processor ($(uname -m)). Install Node.js $MIN_NODE or newer yourself and run the installer again."
    local index version
    index="$(fetch_text 'https://nodejs.org/dist/index.tab')" || fail 'Could not reach nodejs.org. Check your internet connection and try again.'
    # Columns: version date files npm v8 uv zlib openssl modules lts security. Newest first.
    version="$(printf '%s\n' "$index" | awk -F'\t' -v want="linux-$arch" 'NR > 1 && $10 != "-" && index("," $3 ",", "," want ",") { print $1; exit }')"
    [ -n "$version" ] || fail 'Could not find a Node.js LTS release on nodejs.org.'

    local name="node-$version-linux-$arch" tmp
    tmp="$(new_temp_dir)"
    fetch "https://nodejs.org/dist/$version/$name.tar.gz" "$tmp/node.tar.gz" || { rm -rf "$tmp"; fail 'Downloading Node.js failed.'; }
    mkdir -p "$APP_DATA_DIR"
    rm -rf "${APP_DATA_DIR:?}/$name"
    tar -xzf "$tmp/node.tar.gz" -C "$APP_DATA_DIR" || { rm -rf "$tmp"; fail 'Unpacking Node.js failed.'; }
    rm -rf "$tmp"
    ln -sfn "$name" "$NODE_HOME"
    # Older releases unpacked by earlier runs
    find "$APP_DATA_DIR" -maxdepth 1 -type d -name 'node-v*' ! -name "$name" -exec rm -rf {} + 2>/dev/null
    export PATH="$NODE_HOME/bin:$PATH"
    hash -r
    info "Node.js $version installed in $APP_DATA_DIR."
}

install_node() {
    step 'Checking Node.js'
    # A copy installed by an earlier run of this setup
    [ -x "$NODE_HOME/bin/node" ] && export PATH="$NODE_HOME/bin:$PATH"
    local v; v="$(node_version)"
    if [ -n "$v" ] && version_ge "$v" "$MIN_NODE"; then info "Node.js $v found."; return; fi
    if [ -n "$v" ]; then info "Node.js $v is too old (AMMUI needs $MIN_NODE or newer)."; else info 'Node.js is not installed.'; fi

    install_node_tarball

    v="$(node_version)"
    [ -n "$v" ] || fail "Node.js was installed but does not run on this system (it needs glibc 2.28 or newer). Install Node.js $MIN_NODE or newer yourself and run the installer again."
    version_ge "$v" "$MIN_NODE" || fail "Node.js $v at $(command -v node) is still older than $MIN_NODE."
    info "Node.js $v ready."
}

# --- Git -----------------------------------------------------------------------

install_git() {
    step 'Checking Git'
    if have git; then info "$(git --version) found."; return 0; fi
    # shellcheck disable=SC2046
    pkg_install $(pkg_names git)
    hash -r
    if have git; then info "$(git --version) ready."; return 0; fi
    warn 'Git could not be installed; the code will be downloaded as a tar file instead.'
    return 1
}

# --- AMMUI code --------------------------------------------------------------

get_code_as_tarball() {
    step "Downloading the latest AMMUI code to $INSTALL_DIR"
    local tmp; tmp="$(new_temp_dir)"
    fetch "$REPO_TGZ" "$tmp/ammui.tar.gz" || { rm -rf "$tmp"; fail 'Downloading AMMUI failed. Check your internet connection and try again.'; }
    mkdir -p "$tmp/src" "$INSTALL_DIR"
    tar -xzf "$tmp/ammui.tar.gz" -C "$tmp/src" --strip-components=1 || { rm -rf "$tmp"; fail 'Unpacking AMMUI failed.'; }
    cp -a "$tmp/src/." "$INSTALL_DIR/"
    rm -rf "$tmp"
}

get_code_with_git() {
    if [ -d "$INSTALL_DIR/.git" ]; then
        step "Updating AMMUI in $INSTALL_DIR"
        git -C "$INSTALL_DIR" pull --ff-only || warn 'Could not update the code (files in the folder have been changed locally?). Starting the existing version.'
    elif [ ! -d "$INSTALL_DIR" ] || [ -z "$(ls -A "$INSTALL_DIR" 2>/dev/null)" ]; then
        step "Downloading AMMUI to $INSTALL_DIR"
        git clone --branch "$BRANCH" "$REPO_URL" "$INSTALL_DIR" || fail 'git clone failed. Check your internet connection and try again.'
    elif [ -f "$INSTALL_DIR/server.js" ]; then
        # An existing copy that was not cloned (e.g. unpacked from a tar file): turn it into a clone,
        # keeping the database, settings and other files that are not part of the code.
        step "Converting the existing AMMUI folder $INSTALL_DIR to a Git copy"
        git -C "$INSTALL_DIR" init -q
        git -C "$INSTALL_DIR" remote add origin "$REPO_URL"
        git -C "$INSTALL_DIR" fetch origin "$BRANCH" || fail 'git fetch failed. Check your internet connection and try again.'
        git -C "$INSTALL_DIR" checkout -f -B "$BRANCH" "origin/$BRANCH"
        git -C "$INSTALL_DIR" branch -u "origin/$BRANCH" >/dev/null
    else
        fail "$INSTALL_DIR already exists and does not look like AMMUI. Choose another folder: bash ammui-setup.sh /path/to/ammui"
    fi
}

install_packages() {
    step 'Installing AMMUI packages'
    # npm ci only when the lock file changed: it starts from scratch each time and, unlike
    # npm install, never rewrites package-lock.json (which would block the next git pull).
    local stamp="$INSTALL_DIR/node_modules/.ammui-lock-hash" hash
    hash="$(sha256sum "$INSTALL_DIR/package-lock.json" | cut -d' ' -f1)"
    if [ -f "$stamp" ] && [ "$(cat "$stamp")" = "$hash" ]; then info 'Packages are up to date.'; return; fi
    (cd "$INSTALL_DIR" && npm ci --omit=dev --no-audit --no-fund) || fail 'npm could not install the packages. See the messages above.'
    printf '%s\n' "$hash" > "$stamp"
}

# --- Optional helper programs ---------------------------------------------------
# From the package manager where possible; otherwise dropped in the app folder, which AMMUI
# adds to its PATH.

have_helper() { [ -x "$INSTALL_DIR/$1" ] || have "$1"; }

install_helpers() {
    [ "${AMMUI_NO_EXTRAS:-}" = 1 ] && return
    step 'Checking optional helpers (ffmpeg, yt-dlp, fpcalc)'
    local arch; arch="$(uname -m)"

    if have_helper ffmpeg && have_helper ffprobe; then info 'ffmpeg found.'
    else
        # shellcheck disable=SC2046
        pkg_install $(pkg_names ffmpeg); hash -r
        if ! have_helper ffmpeg && have xz; then
            # Static build, for systems without a package manager or root access
            local build=''
            case "$arch" in x86_64) build=amd64 ;; aarch64) build=arm64 ;; armv7l) build=armhf ;; esac
            if [ -n "$build" ]; then
                local tmp; tmp="$(new_temp_dir)"
                if fetch "https://johnvansickle.com/ffmpeg/releases/ffmpeg-release-$build-static.tar.xz" "$tmp/ffmpeg.tar.xz" &&
                   tar -xJf "$tmp/ffmpeg.tar.xz" -C "$tmp"; then
                    find "$tmp" -type f \( -name ffmpeg -o -name ffprobe \) -exec cp {} "$INSTALL_DIR/" \;
                fi
                rm -rf "$tmp"
            fi
        fi
        if have_helper ffmpeg; then info 'ffmpeg installed.'
        else warn 'ffmpeg could not be installed. AirPlay, thumbnails and local video playback need it.'; fi
    fi

    local ytdlp="$INSTALL_DIR/yt-dlp"
    if [ -x "$ytdlp" ]; then
        # YouTube changes often; an out of date yt-dlp stops working.
        info "yt-dlp: $("$ytdlp" -U 2>&1 | tail -n1)"
    elif have yt-dlp; then info 'yt-dlp found.'
    else
        local asset=''
        case "$arch" in x86_64) asset=yt-dlp_linux ;; aarch64) asset=yt-dlp_linux_aarch64 ;; armv7l) asset=yt-dlp_linux_armv7l ;; *) have python3 && asset=yt-dlp ;; esac
        if [ -n "$asset" ] && fetch "https://github.com/yt-dlp/yt-dlp/releases/latest/download/$asset" "$ytdlp"; then
            chmod +x "$ytdlp"; info 'yt-dlp installed.'
        else
            rm -f "$ytdlp"
            warn 'yt-dlp could not be installed. Videos with embedding disabled will open on youtube.com.'
        fi
    fi

    if have_helper fpcalc; then info 'fpcalc found.'
    else
        # shellcheck disable=SC2046
        pkg_install $(pkg_names fpcalc); hash -r
        if ! have_helper fpcalc && [ "$arch" = x86_64 ]; then
            local url tmp
            url="$(fetch_text 'https://api.github.com/repos/acoustid/chromaprint/releases/latest' 2>/dev/null |
                   grep -o '"browser_download_url": *"[^"]*fpcalc[^"]*linux-x86_64\.tar\.gz"' | head -n1 | sed 's/.*"\(http[^"]*\)"$/\1/')"
            if [ -n "$url" ]; then
                tmp="$(new_temp_dir)"
                fetch "$url" "$tmp/fpcalc.tar.gz" && tar -xzf "$tmp/fpcalc.tar.gz" -C "$tmp" &&
                    find "$tmp" -type f -name fpcalc -exec cp {} "$INSTALL_DIR/" \;
                rm -rf "$tmp"
            fi
        fi
        if have_helper fpcalc; then info 'fpcalc installed.'
        else warn "fpcalc could not be installed. 'Identify with AcoustID' will be unavailable."; fi
    fi
}

# --- Service (start with the computer) ---------------------------------------
# A systemd user service (or a system one when run as root). It is told AMMUI_SUPERVISED=1, so
# Update & Restart in the app just exits and systemd starts the new version.

SYSTEMCTL=''
UNIT_FILE=''
JOURNAL_CMD=''
if have systemctl; then
    if [ "$IS_ROOT" -eq 1 ]; then
        if systemctl show-environment >/dev/null 2>&1; then
            SYSTEMCTL='systemctl'; UNIT_FILE="/etc/systemd/system/$SERVICE_NAME.service"; JOURNAL_CMD="journalctl -u $SERVICE_NAME -f"
        fi
    elif systemctl --user show-environment >/dev/null 2>&1; then
        SYSTEMCTL='systemctl --user'; UNIT_FILE="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user/$SERVICE_NAME.service"; JOURNAL_CMD="journalctl --user -u $SERVICE_NAME -f"
    fi
fi

use_service() { [ -n "$SYSTEMCTL" ] && [ "${AMMUI_NO_STARTUP:-}" != 1 ]; }

install_service() {
    if [ -z "$SYSTEMCTL" ]; then
        warn 'systemd is not available here, so AMMUI will not start with the computer. Start it from the AMMUI Server menu entry.'
        return
    fi
    if [ "${AMMUI_NO_STARTUP:-}" = 1 ]; then
        if [ -f "$UNIT_FILE" ]; then
            $SYSTEMCTL disable --now "$SERVICE_NAME" >/dev/null 2>&1
            rm -f "$UNIT_FILE"; $SYSTEMCTL daemon-reload
            info 'Removed the AMMUI service, so it no longer starts with the computer.'
        fi
        return
    fi
    local node_dir wanted
    node_dir="$(dirname "$(command -v node)")"
    if [ "$IS_ROOT" -eq 1 ]; then wanted=multi-user.target; else wanted=default.target; fi
    mkdir -p "$(dirname "$UNIT_FILE")"
    cat > "$UNIT_FILE" <<EOF
# Written by ammui-setup.sh
[Unit]
Description=AMMUI Media Hub
After=network-online.target
Wants=network-online.target

[Service]
WorkingDirectory=$INSTALL_DIR
ExecStart=$node_dir/node server.js
Environment="PATH=$node_dir:$INSTALL_DIR:$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin"
Environment=AMMUI_SUPERVISED=1
Restart=always
RestartSec=3

[Install]
WantedBy=$wanted
EOF
    $SYSTEMCTL daemon-reload
    $SYSTEMCTL enable "$SERVICE_NAME" >/dev/null 2>&1 || { warn 'Could not enable the AMMUI service.'; return; }
    info "Added the '$SERVICE_NAME' service, which runs AMMUI in the background."
    if [ "$IS_ROOT" -eq 0 ]; then
        # Without lingering a user service only runs while that user is logged in.
        if [ "$(loginctl show-user "$USER" -p Linger --value 2>/dev/null)" = yes ]; then
            info 'AMMUI will start when the computer starts.'
        elif loginctl enable-linger "$USER" 2>/dev/null || as_root loginctl enable-linger "$USER" 2>/dev/null; then
            touch "$APP_DATA_DIR/.linger-enabled"   # so the uninstaller turns it off again
            info 'AMMUI will start when the computer starts, before anyone logs in.'
        else
            info 'AMMUI will start when you log in.'
        fi
    else
        info 'AMMUI will start when the computer starts.'
    fi
}

# --- Icon, menu entries and uninstaller ------------------------------------------

desktop_dir() {
    local d=''
    have xdg-user-dir && d="$(xdg-user-dir DESKTOP 2>/dev/null)"
    [ -n "$d" ] && [ "$d" != "$HOME" ] && [ -d "$d" ] && { echo "$d"; return; }
    [ -d "$HOME/Desktop" ] && echo "$HOME/Desktop"
}

# A desktop entry on the desktop only opens once it is executable and, in GNOME, marked trusted.
trust_desktop_file() {
    chmod +x "$1"
    have gio && gio set "$1" metadata::trusted true 2>/dev/null
    return 0
}

write_launcher() {
    # The 'AMMUI Server' menu entry runs this: it starts the service and shows its log, or,
    # without the service, runs the server in the terminal window (close it to stop AMMUI).
    local node_dir; node_dir="$(dirname "$(command -v node)")"
    {
        printf '#!/bin/sh\n# Starts the AMMUI server. Written by ammui-setup.sh.\n'
        printf 'cd %s || exit 1\n' "'$INSTALL_DIR'"
        if [ -n "$SYSTEMCTL" ]; then cat <<EOF
if [ -f '$UNIT_FILE' ] && $SYSTEMCTL is-enabled --quiet $SERVICE_NAME 2>/dev/null; then
    $SYSTEMCTL start $SERVICE_NAME
    echo 'AMMUI is running in the background: https://localhost:$HTTPS_PORT/'
    echo 'Showing its log. Closing this window does not stop AMMUI; to stop it run: $SYSTEMCTL stop $SERVICE_NAME'
    exec $JOURNAL_CMD
fi
EOF
        fi
        cat <<EOF
printf '\033]0;AMMUI server - close this window to stop\007'
PATH='$node_dir':"\$PATH" exec node server.js
EOF
    } > "$APP_DATA_DIR/ammui-server"
    chmod +x "$APP_DATA_DIR/ammui-server"
}

new_menu_entries() {
    mkdir -p "$APP_DATA_DIR" "$APPS_DIR"
    [ -f "$INSTALL_DIR/public/amm-icon.png" ] && cp "$INSTALL_DIR/public/amm-icon.png" "$APP_ICON"
    write_launcher
    cat > "$APPS_DIR/ammui-server.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=AMMUI Server
Comment=Start the AMMUI server
Exec="$APP_DATA_DIR/ammui-server"
Icon=$APP_ICON
Terminal=true
Categories=AudioVideo;Network;
EOF
    cat > "$APPS_DIR/ammui-uninstall.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=Uninstall AMMUI
Comment=Remove AMMUI from this computer
Exec=bash "$APP_DATA_DIR/uninstall.sh"
Icon=$APP_ICON
Terminal=true
Categories=Settings;
EOF
    local desk; desk="$(desktop_dir)"
    if [ -n "$desk" ]; then
        cp "$APPS_DIR/ammui-server.desktop" "$desk/ammui-server.desktop"
        trust_desktop_file "$desk/ammui-server.desktop"
        info "Added 'AMMUI Server' to the applications menu and the desktop."
    else
        info "Added 'AMMUI Server' to the applications menu."
    fi
    have update-desktop-database && update-desktop-database "$APPS_DIR" 2>/dev/null
    return 0
}

new_kiosk_entry() {
    # Full-screen browser showing the local server, e.g. for a wall display. It uses its own
    # browser profile: kiosk mode is ignored when the window joins an already running browser.
    local browser='' b
    for b in google-chrome google-chrome-stable chromium chromium-browser microsoft-edge microsoft-edge-stable; do
        have "$b" && { browser="$(command -v "$b")"; break; }
    done
    if [ -z "$browser" ]; then
        [ -z "$(desktop_dir)" ] && return   # no desktop, so probably headless: nothing to say
        warn 'Chrome or Chromium was not found, so no kiosk entry was created.'
        return
    fi
    local entry="$APPS_DIR/ammui-kiosk.desktop" desk
    cat > "$entry" <<EOF
[Desktop Entry]
Type=Application
Name=AMMUI Kiosk
Comment=AMMUI full screen (Alt+F4 to close). The AMMUI server must be running.
Exec="$browser" --kiosk --user-data-dir="$APP_DATA_DIR/kiosk-browser" --no-first-run --no-default-browser-check --autoplay-policy=no-user-gesture-required https://localhost:$HTTPS_PORT/
Icon=$APP_ICON
Terminal=false
Categories=AudioVideo;
EOF
    desk="$(desktop_dir)"
    if [ -n "$desk" ]; then cp "$entry" "$desk/ammui-kiosk.desktop"; trust_desktop_file "$desk/ammui-kiosk.desktop"; fi
    info "Added an 'AMMUI Kiosk' entry ($(basename "$browser"), full screen; Alt+F4 closes it)."
}

# The uninstaller, written next to the icon with the install folder filled in. It is run from
# the menu (or by hand) after this setup file is long gone, so it has to stand alone.
write_uninstaller() {
    local script="$APP_DATA_DIR/uninstall.sh"
    mkdir -p "$APP_DATA_DIR"
    {
        printf '#!/usr/bin/env bash\n'
        printf '# AMMUI uninstaller, written by ammui-setup.sh. Run it from the menu, or with:\n'
        printf '#   bash %q\n' "$script"
        printf 'INSTALL_DIR=%q\n' "$INSTALL_DIR"
        printf 'APP_DATA_DIR=%q\n' "$APP_DATA_DIR"
        printf 'APPS_DIR=%q\n' "$APPS_DIR"
        printf 'UNIT_FILE=%q\n' "$UNIT_FILE"
        printf 'SYSTEMCTL=%q\n' "$SYSTEMCTL"
        cat <<'EOF'

ask_yes() {
    local reply=''
    printf '%s [%s] ' "$1" "$([ "$2" = Y ] && echo 'Y/n' || echo 'y/N')"
    read -r reply </dev/tty || reply=''
    case "${reply:-$2}" in [Yy]*) return 0 ;; *) return 1 ;; esac
}
info() { printf '    %s\n' "$1"; }
as_root() { if [ "$(id -u)" -eq 0 ]; then "$@"; else sudo "$@"; fi; }
finish() { echo; echo "$1"; read -r -p 'Press Enter to close ' _ </dev/tty; exit 0; }

echo 'Uninstall AMMUI'
echo
ask_yes 'Remove AMMUI from this computer? This stops the AMMUI server and removes its service and menu entries.' Y || exit 0
delete_folder=0
if [ -d "$INSTALL_DIR" ]; then
    echo
    echo "Also delete the AMMUI folder?  $INSTALL_DIR"
    echo "It holds your AMMUI database and settings, and the local library: the music, photos and videos"
    echo "added to AMMUI's own server. Back it up first if you want to keep any of it."
    echo 'Music and photo folders elsewhere on this computer are not touched.'
    ask_yes 'Delete the folder and everything in it?' N && delete_folder=1
fi

echo
echo 'Uninstalling AMMUI'

# Stop the server and the kiosk browser, which hold files in the folders being removed.
if [ -n "$SYSTEMCTL" ] && [ -f "$UNIT_FILE" ]; then
    info 'Stopping and removing the AMMUI service.'
    $SYSTEMCTL disable --now ammui >/dev/null 2>&1
    rm -f "$UNIT_FILE"
    $SYSTEMCTL daemon-reload
fi
for port in 3000 3443; do
    pid="$(ss -ltnpH "sport = :$port" 2>/dev/null | sed -n 's/.*"node",pid=\([0-9]*\).*/\1/p' | head -n1)"
    [ -n "$pid" ] && { info 'Stopping the AMMUI server.'; kill "$pid" 2>/dev/null; }
done
pkill -f -- "--user-data-dir=$APP_DATA_DIR/kiosk-browser" 2>/dev/null
sleep 2

if [ -f "$APP_DATA_DIR/.linger-enabled" ]; then
    loginctl disable-linger "$USER" 2>/dev/null || as_root loginctl disable-linger "$USER" 2>/dev/null
fi

desk=''
command -v xdg-user-dir >/dev/null 2>&1 && desk="$(xdg-user-dir DESKTOP 2>/dev/null)"
[ -d "$desk" ] || desk="$HOME/Desktop"
for f in "$APPS_DIR/ammui-server.desktop" "$APPS_DIR/ammui-kiosk.desktop" "$APPS_DIR/ammui-uninstall.desktop" \
         "$desk/ammui-server.desktop" "$desk/ammui-kiosk.desktop"; do
    [ -f "$f" ] && { rm -f "$f"; info "Removed $f"; }
done

# Stop trusting AMMUI's certificate.
if command -v certutil >/dev/null 2>&1; then
    for db in "$HOME/.pki/nssdb" "$HOME/snap/chromium/current/.pki/nssdb"; do
        [ -d "$db" ] && certutil -d "sql:$db" -D -n 'AMMUI' 2>/dev/null && info "Removed the AMMUI certificate from $db"
    done
fi
if [ -f /usr/local/share/ca-certificates/ammui-ca.crt ]; then
    info 'Removing the AMMUI certificate from the system (you may be asked for your password).'
    as_root rm -f /usr/local/share/ca-certificates/ammui-ca.crt && as_root update-ca-certificates --fresh >/dev/null 2>&1
elif [ -f "$APP_DATA_DIR/ca-trusted.crt" ] && command -v trust >/dev/null 2>&1; then
    info 'Removing the AMMUI certificate from the system (you may be asked for your password).'
    as_root trust anchor --remove "$APP_DATA_DIR/ca-trusted.crt" 2>/dev/null
fi

kept=''
if [ "$delete_folder" = 1 ]; then
    info "Deleting $INSTALL_DIR"
    rm -rf -- "$INSTALL_DIR"
    [ -e "$INSTALL_DIR" ] && kept="Some files in $INSTALL_DIR could not be deleted. Delete the folder yourself."
elif [ -d "$INSTALL_DIR" ]; then
    kept="Your AMMUI folder was kept: $INSTALL_DIR"
fi

cd /
rm -rf -- "$APP_DATA_DIR"   # Node.js (if installed by setup), icon, kiosk profile and this script

msg='AMMUI has been removed. Git and any system packages (ffmpeg, Chromaprint) were left installed.'
[ -n "$kept" ] && msg="$msg
$kept"
finish "$msg"
EOF
    } > "$script"
    chmod +x "$script"
}

# --- Certificate trust and running ---------------------------------------------

grant_certificate_trust() {
    # Trust AMMUI's own certificate authority, so the browser (and the kiosk window, which has
    # no easy way past the warning) opens the page without a warning. Chrome and Chromium read
    # this user's NSS database; curl and other programs read the system store.
    local ca="$INSTALL_DIR/certs/ca.crt"
    [ -f "$ca" ] || return 0
    local already=0
    if [ -f /usr/local/share/ca-certificates/ammui-ca.crt ] && cmp -s "$ca" /usr/local/share/ca-certificates/ammui-ca.crt; then already=1
    elif [ -f "$APP_DATA_DIR/ca-trusted.crt" ] && cmp -s "$ca" "$APP_DATA_DIR/ca-trusted.crt"; then already=1; fi
    [ "$already" = 1 ] && return 0
    ask_yes 'Trust the AMMUI certificate on this computer, so browsers do not show a warning?' Y || {
        info 'Certificate not trusted: browsers will show a warning.'; return 0; }

    if ! have certutil; then
        # shellcheck disable=SC2046
        pkg_install $(pkg_names certutil); hash -r
    fi
    if have certutil; then
        local db
        for db in "$HOME/.pki/nssdb" "$HOME/snap/chromium/current/.pki/nssdb"; do
            if [ "$db" = "$HOME/.pki/nssdb" ] && [ ! -d "$db" ]; then mkdir -p "$db" && certutil -d "sql:$db" -N --empty-password 2>/dev/null; fi
            [ -d "$db" ] || continue
            certutil -d "sql:$db" -D -n 'AMMUI' 2>/dev/null   # an older AMMUI certificate
            certutil -d "sql:$db" -A -t 'C,,' -n 'AMMUI' -i "$ca" || warn "Could not add the certificate to $db."
        done
    else
        warn 'certutil is not available, so Chrome and Chromium will still show a certificate warning.'
    fi

    if can_be_root; then
        info 'Adding the certificate to the system (you may be asked for your password).'
        if [ -d /usr/local/share/ca-certificates ] && have update-ca-certificates; then
            as_root cp "$ca" /usr/local/share/ca-certificates/ammui-ca.crt && as_root update-ca-certificates >/dev/null 2>&1
        elif have trust; then
            [ -f "$APP_DATA_DIR/ca-trusted.crt" ] && as_root trust anchor --remove "$APP_DATA_DIR/ca-trusted.crt" 2>/dev/null
            as_root trust anchor --store "$ca" && cp "$ca" "$APP_DATA_DIR/ca-trusted.crt"
        fi || warn 'Could not add the certificate to the system store.'
    fi
    info 'Certificate trusted. Restart any browser windows that were already open. Firefox keeps its own list: see the README.'
}

listening_pid() {   # listening_pid PORT -> "pid name", or "? ?" when the owner is unknown, or nothing
    local line
    if have ss; then
        line="$(ss -ltnpH "sport = :$1" 2>/dev/null | head -n1)"
        [ -n "$line" ] || return 0
        printf '%s\n' "$line" | sed -n 's/.*(("\([^"]*\)",pid=\([0-9]*\).*/\2 \1/p' | grep . || echo '? ?'
    elif have lsof; then
        line="$(lsof -nP -iTCP:"$1" -sTCP:LISTEN -Fpc 2>/dev/null | tr '\n' ' ')"
        [ -n "$line" ] && printf '%s\n' "$line" | sed -n 's/^p\([0-9]*\) c\([^ ]*\).*/\1 \2/p'
    fi
}

stop_running_server() {
    # The server has to be stopped to update it, and a second copy could not open the ports.
    if [ -n "$SYSTEMCTL" ] && $SYSTEMCTL is-active --quiet "$SERVICE_NAME" 2>/dev/null; then
        info 'Stopping the AMMUI service that is already running.'
        $SYSTEMCTL stop "$SERVICE_NAME"
    fi
    local port pid name
    for port in "$HTTP_PORT" "$HTTPS_PORT"; do
        read -r pid name <<<"$(listening_pid "$port")"
        [ -n "${pid:-}" ] || continue
        if [ "$name" = node ]; then
            info "Stopping the AMMUI server that is already running (process $pid)."
            kill "$pid"; sleep 1
        else
            [ "$name" = '?' ] && name='another program'
            fail "Port $port is in use by $name, so AMMUI cannot start. Close it and run the installer again."
        fi
    done
}

wait_for_port() {   # wait_for_port PID-or-empty
    local i
    for ((i = 0; i < 120; i++)); do
        [ -n "$1" ] && ! kill -0 "$1" 2>/dev/null && return 1
        (exec 3<>"/dev/tcp/127.0.0.1/$HTTPS_PORT") 2>/dev/null && return 0
        sleep 0.5
    done
    return 1
}

print_addresses() {
    local ip; ip="$(hostname -I 2>/dev/null | awk '{print $1}')"
    printf '\n'
    green "AMMUI is starting: https://localhost:$HTTPS_PORT/"
    info 'Open that address in a browser. To have a browser open whenever AMMUI starts, use Settings > Startup.'
    info "From other devices use https://$(hostname):$HTTPS_PORT/${ip:+ (or https://$ip:$HTTPS_PORT/)}."
    if { have systemctl && { systemctl is-active --quiet ufw 2>/dev/null || systemctl is-active --quiet firewalld 2>/dev/null; }; }; then
        warn "A firewall is running. Allow TCP ports $HTTP_PORT and $HTTPS_PORT, and UPnP/mDNS discovery (UDP 1900 and 5353), so players and other devices can connect."
    fi
}

start_server() {
    step 'Starting AMMUI'
    if use_service; then
        $SYSTEMCTL start "$SERVICE_NAME" || fail "The AMMUI service did not start. See: $JOURNAL_CMD"
        print_addresses
        if wait_for_port ''; then grant_certificate_trust
        else warn "AMMUI has not opened its port yet. See its log: $JOURNAL_CMD"; fi
        printf '\n'
        green 'AMMUI is running in the background and starts with the computer.'
        info "Log: $JOURNAL_CMD"
        info "Stop: $SYSTEMCTL stop $SERVICE_NAME    Start: $SYSTEMCTL start $SERVICE_NAME"
        return
    fi

    print_addresses
    green 'Press Ctrl+C to stop AMMUI.'
    printf '\n'
    # The server shares this terminal for its log. Once it is listening (its certificate exists
    # by then), trust the certificate.
    cd "$INSTALL_DIR" || fail "Cannot open $INSTALL_DIR"
    node server.js </dev/null &
    local server=$! code
    # A background job ignores Ctrl+C in a script, so pass it on. wait returns when the trap
    # runs, so wait again until the server has really gone.
    trap 'kill "$server" 2>/dev/null' INT TERM
    wait_for_port "$server" && grant_certificate_trust
    while kill -0 "$server" 2>/dev/null; do wait "$server"; code=$?; done
    trap - INT TERM
    printf '\n'
    warn "The AMMUI server stopped (exit code ${code:-?})."
}

# --- Main --------------------------------------------------------------------

# All in a function, so that with 'curl ... | bash' the whole script has been read before
# anything runs: otherwise a command that reads stdin (npm, apt) could swallow the rest of it.
main() {
    printf '%sAMMUI setup%s\n' "$C_GREEN" "$C_OFF"
    info "Install folder: $INSTALL_DIR"
    [ "$(uname -s)" = Linux ] || fail 'This installer is for Linux. On Windows use ammui-setup.cmd.'
    [ "$IS_ROOT" -eq 1 ] && warn 'Running as root: AMMUI will be installed for root, with a system service.'
    can_be_root || warn 'sudo is not available, so system packages cannot be installed.'

    if ! have curl && ! have wget; then
        # shellcheck disable=SC2046
        pkg_install $(pkg_names curl); hash -r
        have curl || fail 'curl or wget is needed to download AMMUI. Install one of them and run the installer again.'
    fi

    mkdir -p "$APP_DATA_DIR"
    install_node
    local have_git=0
    install_git && have_git=1
    stop_running_server
    if [ "$have_git" = 1 ]; then get_code_with_git; else get_code_as_tarball; fi
    [ -f "$INSTALL_DIR/server.js" ] || fail "The AMMUI code was not found in $INSTALL_DIR."
    install_packages
    install_helpers
    install_service
    new_menu_entries
    new_kiosk_entry
    write_uninstaller
    info "To uninstall AMMUI later, use 'Uninstall AMMUI' in the menu, or run: bash $APP_DATA_DIR/uninstall.sh"

    if [ "${AMMUI_NO_RUN:-}" = 1 ]; then step "AMMUI is installed in $INSTALL_DIR"; else start_server; fi
}

main </dev/null
