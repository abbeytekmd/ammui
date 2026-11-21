#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# AMMUI setup for Linux: a one-off bootstrap.
#
# It installs anything missing (Node.js, Git and the optional ffmpeg, yt-dlp and
# fpcalc helpers), fetches the latest AMMUI code from GitHub, installs its
# packages, adds menu entries and a system service that starts AMMUI with the computer, sets
# the browser to open when you log in, and starts the server.
#
# Usage:  bash ammui-setup.sh [install folder]   (default: ~/ammui)
#    or:  curl -fsSL https://raw.githubusercontent.com/abbeytekmd/ammui/main/installer/ammui-setup.sh | bash
#
# Environment switches: AMMUI_NO_EXTRAS=1 skips ffmpeg/yt-dlp/fpcalc,
# AMMUI_NO_RUN=1 sets everything up without starting the server,
# AMMUI_NO_STARTUP=1 adds no service or login entry (AMMUI then runs only when started).
#
# Run it as the user who will log in and use AMMUI, not as root: the service runs as that user,
# and the browser (if Settings > Startup sets one) opens when they log in to the desktop. It
# asks for your password (sudo) for system packages, the service and certificate trust.
# ---------------------------------------------------------------------------

set -u
USER="${USER:-$(id -un)}"

REPO_URL='https://github.com/abbeytekmd/ammui.git'
REPO_TGZ='https://codeload.github.com/abbeytekmd/ammui/tar.gz/refs/heads/main'
BRANCH='main'
MIN_NODE='22.13.0'   # node:sqlite without a flag
HTTP_PORT=80        # the ports wanted for plain HTTP (players) and HTTPS (browsers);
HTTPS_PORT=443      # choose_ports settles on free ones

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

# --- Starting with the computer, and the browser at login -------------------------
# The server runs as a system service, started at boot, as this user (so it keeps using this
# user's AMMUI folder, Node.js and certificates). It has no desktop, so an autostart entry opens
# the browser when this user logs in (scripts/startup-browser.js runs the Settings > Startup
# command). Without systemd or sudo, the autostart entry starts the server itself instead.

UNIT_FILE="/etc/systemd/system/$SERVICE_NAME.service"
AUTOSTART_FILE="${XDG_CONFIG_HOME:-$HOME/.config}/autostart/ammui.desktop"
LAUNCHER="$APP_DATA_DIR/ammui-server"
SERVER_LOG="$APP_DATA_DIR/server.log"
STARTUP_MODE=''   # service, login (the server starts at login) or none; set by install_startup

use_startup() { [ "${AMMUI_NO_STARTUP:-}" != 1 ]; }
have_systemd() { [ -d /run/systemd/system ] && have systemctl; }
service_installed() { [ -f "$UNIT_FILE" ]; }

# Earlier versions of this installer ran AMMUI as a systemd user service
remove_old_user_service() {
    local unit="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user/$SERVICE_NAME.service"
    if [ -f "$unit" ]; then
        systemctl --user disable --now "$SERVICE_NAME" >/dev/null 2>&1
        rm -f "$unit"
        systemctl --user daemon-reload >/dev/null 2>&1
        info 'Removed the AMMUI user service added by an older installer.'
    fi
    if [ -f "$APP_DATA_DIR/.linger-enabled" ]; then
        loginctl disable-linger "$USER" 2>/dev/null || as_root loginctl disable-linger "$USER" 2>/dev/null
        rm -f "$APP_DATA_DIR/.linger-enabled"
    fi
    return 0
}

remove_service() {
    service_installed || return 0
    as_root systemctl disable --now "$SERVICE_NAME" >/dev/null 2>&1
    as_root rm -f "$UNIT_FILE" && as_root systemctl daemon-reload
    info 'Removed the AMMUI service, so it no longer starts with the computer.'
}

# Writes and enables the service; fails (leaving nothing behind) when it can't
install_service() {
    { have_systemd && can_be_root; } || return 1
    local node_dir; node_dir="$(dirname "$(command -v node)")"
    info 'Adding the AMMUI service, which starts AMMUI with the computer (you may be asked for your password).'
    # The log is the server's output: the one before the last restart is kept as server.log.old
    as_root tee "$UNIT_FILE" >/dev/null <<EOF || return 1
# Written by ammui-setup.sh
[Unit]
Description=AMMUI Media Hub
After=network-online.target
Wants=network-online.target

[Service]
User=$USER
WorkingDirectory=$INSTALL_DIR
ExecStart=/bin/sh -c 'mv -f "$SERVER_LOG" "$SERVER_LOG.old" 2>/dev/null; exec node server.js >"$SERVER_LOG" 2>&1'
Environment="HOME=$HOME"
Environment="PATH=$node_dir:$INSTALL_DIR:$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin:/snap/bin"
Environment=AMMUI_SUPERVISED=1
Environment=AMMUI_BROWSER_AT_LOGIN=1
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF
    if as_root systemctl daemon-reload && as_root systemctl enable "$SERVICE_NAME" >/dev/null 2>&1; then return 0; fi
    as_root rm -f "$UNIT_FILE"; as_root systemctl daemon-reload
    return 1
}

write_autostart() {   # write_autostart NAME COMMENT
    mkdir -p "$(dirname "$AUTOSTART_FILE")"
    cat > "$AUTOSTART_FILE" <<EOF
[Desktop Entry]
Type=Application
Name=$1
Comment=$2 Written by ammui-setup.sh.
Exec="$LAUNCHER" --login
Icon=$APP_ICON
Terminal=false
NoDisplay=true
X-GNOME-Autostart-enabled=true
EOF
}

# Offers to open AMMUI in a browser at login when Settings > Startup has nothing set yet,
# choosing the browser installed here (Firefox first)
offer_login_browser() {
    { [ -n "$(desktop_dir)" ] || [ -n "${DISPLAY:-}" ] || [ -n "${WAYLAND_DISPLAY:-}" ]; } || return 0   # no desktop
    local current chosen
    current="$(cd "$INSTALL_DIR" && node scripts/startup-browser.js --show 2>/dev/null)"
    if [ -n "$current" ]; then info "When $USER logs in, AMMUI runs: $current (change it in Settings > Startup)."; return 0; fi
    ask_yes "Open AMMUI in a browser whenever $USER logs in?" Y || {
        info 'No browser will open at login. To have one open, use Settings > Startup.'; return 0; }
    chosen="$(cd "$INSTALL_DIR" && node scripts/startup-browser.js --default 2>/dev/null)"
    if [ -n "$chosen" ]; then info "AMMUI will open in $chosen when $USER logs in. Change it in Settings > Startup."
    else warn 'No browser was found (Firefox, Chrome, Chromium or Edge). Choose one later in Settings > Startup.'; fi
}

install_startup() {
    remove_old_user_service
    if ! use_startup; then
        STARTUP_MODE=none
        remove_service
        if [ -f "$AUTOSTART_FILE" ]; then rm -f "$AUTOSTART_FILE"; info 'AMMUI no longer starts when you log in.'; fi
        return
    fi
    if install_service; then
        STARTUP_MODE=service
        write_autostart 'AMMUI Browser' 'Opens AMMUI in the browser set in Settings > Startup.'
        info "AMMUI will start with the computer, and open in a browser when $USER logs in if Settings > Startup says to."
    else
        STARTUP_MODE=login
        if have_systemd; then warn 'Could not add the AMMUI service (sudo is needed), so AMMUI will start when you log in instead.'
        else warn 'systemd is not available here, so AMMUI will start when you log in instead of with the computer.'; fi
        write_autostart 'AMMUI Server' 'Starts the AMMUI server in the background.'
        info "AMMUI will start in the background whenever $USER logs in (and open a browser then, if Settings > Startup says to)."
    fi
    offer_login_browser
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
    # Run by the login autostart (--login), the 'AMMUI Server' menu entry (no argument) and the
    # uninstaller (--stop). With the service it opens the browser at login, and the menu entry
    # starts the service if need be and shows the log. Without it, --login starts the server in
    # the background (the pid file holds its supervisor's process id), and the menu entry shows
    # the log of one already running or else runs the server in the terminal window.
    local node_dir service=0; node_dir="$(dirname "$(command -v node)")"
    [ "$STARTUP_MODE" = service ] && service=1
    cat > "$LAUNCHER" <<EOF
#!/bin/sh
# Starts AMMUI. Written by ammui-setup.sh.
#   ammui-server          show the log of the server running in the background, or start it
#   ammui-server --login  run at login: opens the browser set in Settings > Startup$([ "$service" = 0 ] && printf ',\n#                         starting the server in the background first')
#   ammui-server --stop   stop the server
SERVICE=$service
PIDFILE='$APP_DATA_DIR/server.pid'
LOG='$SERVER_LOG'
PATH='$node_dir':'$INSTALL_DIR':"\$HOME/.local/bin:\$PATH"
export PATH

running() {
    pid="\$(cat "\$PIDFILE" 2>/dev/null)"
    [ -n "\$pid" ] && kill -0 "\$pid" 2>/dev/null && grep -q server.js "/proc/\$pid/cmdline" 2>/dev/null
}

stop() {
    running || return 0
    # Stop the server; its supervisor then exits by itself
    pkill -TERM -P "\$pid" 2>/dev/null
    i=0
    while kill -0 "\$pid" 2>/dev/null && [ \$i -lt 20 ]; do sleep 0.5; i=\$((i + 1)); done
    kill "\$pid" 2>/dev/null
    rm -f "\$PIDFILE"
}

show_log() {
    echo 'AMMUI is running in the background: $(https_url localhost)'
    echo "Showing its log. Closing this window leaves it running; to stop it run: \$0 --stop"
    exec tail -n 50 -F "\$LOG"
}

cd '$INSTALL_DIR' || exit 1

if [ "\$SERVICE" = 1 ]; then
    case "\${1:-}" in
        --login) exec node scripts/startup-browser.js >'$APP_DATA_DIR/startup-browser.log' 2>&1 ;;
        --stop) sudo systemctl stop $SERVICE_NAME ;;
        *)
            systemctl is-active --quiet $SERVICE_NAME || sudo systemctl start $SERVICE_NAME || exit 1
            show_log ;;
    esac
    exit
fi

case "\${1:-}" in
    --stop)
        stop ;;
    --login|--background)
        # A server left running from an earlier login has that session's desktop, now gone,
        # so start afresh: it then opens the startup browser on this one.
        stop
        echo \$\$ > "\$PIDFILE"
        rm -f "\$LOG"
        exec node server.js </dev/null >"\$LOG" 2>&1 ;;
    *)
        running && show_log
        printf '\033]0;AMMUI server - close this window to stop\007'
        echo \$\$ > "\$PIDFILE"
        exec node server.js ;;
esac
EOF
    chmod +x "$LAUNCHER"
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
Exec="$browser" --kiosk --user-data-dir="$APP_DATA_DIR/kiosk-browser" --no-first-run --no-default-browser-check --autoplay-policy=no-user-gesture-required $(https_url localhost)
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
        printf 'AUTOSTART_FILE=%q\n' "$AUTOSTART_FILE"
        printf 'LAUNCHER=%q\n' "$LAUNCHER"
        printf 'UNIT_FILE=%q\n' "$UNIT_FILE"
        printf 'HTTP_PORT=%q\n' "$HTTP_PORT"
        printf 'HTTPS_PORT=%q\n' "$HTTPS_PORT"
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
ask_yes 'Remove AMMUI from this computer? This stops the AMMUI server and removes its service, login entry and menu entries.' Y || exit 0
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
if [ -f "$UNIT_FILE" ]; then
    info 'Stopping and removing the AMMUI service (you may be asked for your password).'
    as_root systemctl disable --now ammui >/dev/null 2>&1
    as_root rm -f "$UNIT_FILE"
    as_root systemctl daemon-reload
fi
[ -f "$AUTOSTART_FILE" ] && { rm -f "$AUTOSTART_FILE"; info 'Removed the AMMUI login entry.'; }
[ -x "$LAUNCHER" ] && ! [ -f "$UNIT_FILE" ] && "$LAUNCHER" --stop
# A systemd user service added by an older installer
unit="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user/ammui.service"
if [ -f "$unit" ]; then
    info 'Stopping and removing the old AMMUI service.'
    systemctl --user disable --now ammui >/dev/null 2>&1
    rm -f "$unit"
    systemctl --user daemon-reload >/dev/null 2>&1
fi
for port in "$HTTP_PORT" "$HTTPS_PORT"; do
    pid="$(ss -ltnpH "sport = :$port" 2>/dev/null | sed -n 's/.*"node",pid=\([0-9]*\).*/\1/p' | head -n1)"
    [ -n "$pid" ] && { info 'Stopping the AMMUI server.'; kill "$pid" 2>/dev/null; }
done
pkill -f -- "--user-data-dir=$APP_DATA_DIR/kiosk-browser" 2>/dev/null
sleep 2

# Take away Node.js's right to use ports below 1024, if setup gave it
if [ -f "$APP_DATA_DIR/.node-port-capability" ]; then
    node_bin="$(cat "$APP_DATA_DIR/.node-port-capability")"
    [ -f "$node_bin" ] && as_root setcap -r "$node_bin" 2>/dev/null
fi

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
    for db in "$HOME"/.mozilla/firefox/*/ "$HOME"/snap/firefox/common/.mozilla/firefox/*/ \
              "$HOME"/.var/app/org.mozilla.firefox/.mozilla/firefox/*/; do
        [ -f "$db/cert9.db" ] && certutil -d "sql:$db" -D -n 'AMMUI' 2>/dev/null && info "Removed the AMMUI certificate from $db"
    done
fi
# The Firefox policy that installs it: take AMMUI's entry out, and the file if nothing else is left
node_bin="$(command -v node || echo "$APP_DATA_DIR/node/bin/node")"
for dir in /etc/firefox/policies /etc/firefox-esr/policies; do
    [ -f "$dir/ammui-ca.crt" ] || continue
    info "Removing the AMMUI certificate from Firefox's policy in $dir (you may be asked for your password)."
    if [ -f "$dir/policies.json" ] && [ -x "$node_bin" ]; then
        left="$(CERT="$dir/ammui-ca.crt" "$node_bin" -e '
            const doc = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
            const c = doc.policies?.Certificates;
            if (c?.Install) { c.Install = c.Install.filter(f => f !== process.env.CERT); if (!c.Install.length) delete c.Install; }
            if (c && !Object.keys(c).length) delete doc.policies.Certificates;
            if (doc.policies && !Object.keys(doc.policies).length) delete doc.policies;
            process.stdout.write(Object.keys(doc).length ? JSON.stringify(doc, null, 2) + "\n" : "");
        ' "$dir/policies.json" 2>/dev/null)" && {
            if [ -n "$left" ]; then printf '%s' "$left" | as_root tee "$dir/policies.json" >/dev/null
            else as_root rm -f "$dir/policies.json"; fi
        }
    fi
    as_root rm -f "$dir/ammui-ca.crt"
done
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
    local already=0 firefox_done=0
    if [ -f /usr/local/share/ca-certificates/ammui-ca.crt ] && cmp -s "$ca" /usr/local/share/ca-certificates/ammui-ca.crt; then already=1
    elif [ -f "$APP_DATA_DIR/ca-trusted.crt" ] && cmp -s "$ca" "$APP_DATA_DIR/ca-trusted.crt"; then already=1; fi
    if ! firefox_installed || { [ -f "$APP_DATA_DIR/firefox-trusted.crt" ] && cmp -s "$ca" "$APP_DATA_DIR/firefox-trusted.crt"; }; then firefox_done=1; fi
    [ "$already" = 1 ] && [ "$firefox_done" = 1 ] && return 0
    ask_yes 'Trust the AMMUI certificate on this computer, so browsers do not show a warning?' Y || {
        info 'Certificate not trusted: browsers will show a warning.'; return 0; }

    if ! have certutil; then
        # shellcheck disable=SC2046
        pkg_install $(pkg_names certutil); hash -r
    fi
    [ "$firefox_done" = 1 ] || trust_in_firefox "$ca"
    [ "$already" = 1 ] && { info 'Certificate trusted. Restart Firefox if it was already open.'; return 0; }
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
    info 'Certificate trusted. Restart any browser windows that were already open.'
}

firefox_installed() {
    have firefox || have firefox-esr || [ -d "$HOME/.mozilla/firefox" ] || [ -d "$HOME/snap/firefox" ] \
        || [ -d "$HOME/.var/app/org.mozilla.firefox" ]
}

# Firefox keeps its own list of trusted certificates rather than the system's. The certificate goes
# into the Firefox profiles there are already (certutil), and into a Firefox policy that installs it
# in every profile, including ones made later (needs sudo). The policy is read from
# /etc/<firefox name>/policies, by the snap too, so the certificate file is put beside it.
trust_in_firefox() {   # trust_in_firefox CA-FILE
    local ca="$1" db added=0 ok=0
    if have certutil; then
        for db in "$HOME"/.mozilla/firefox/*/ "$HOME"/snap/firefox/common/.mozilla/firefox/*/ \
                  "$HOME"/.var/app/org.mozilla.firefox/.mozilla/firefox/*/; do
            [ -f "$db/cert9.db" ] || continue
            certutil -d "sql:$db" -D -n 'AMMUI' 2>/dev/null   # an older AMMUI certificate
            certutil -d "sql:$db" -A -t 'C,,' -n 'AMMUI' -i "$ca" && added=$((added + 1))
        done
    fi
    [ "$added" -gt 0 ] && { info "Added the certificate to $added Firefox profile(s)."; ok=1; }

    if can_be_root; then
        local dir names='firefox' tmp
        have firefox-esr && names="$names firefox-esr"
        tmp="$(mktemp)"
        for dir in $names; do
            dir="/etc/$dir/policies"
            as_root mkdir -p "$dir" && as_root install -m 644 "$ca" "$dir/ammui-ca.crt" || continue
            # Add it to the policies already there, if any
            CERT="$dir/ammui-ca.crt" node -e '
                const fs = require("fs");
                let doc = {};
                try { doc = JSON.parse(fs.readFileSync(process.argv[1], "utf8")); } catch { }
                const p = doc.policies = doc.policies || {};
                const c = p.Certificates = p.Certificates || {};
                c.Install = [...new Set([...(c.Install || []), process.env.CERT])];
                process.stdout.write(JSON.stringify(doc, null, 2) + "\n");
            ' "$dir/policies.json" > "$tmp" && as_root install -m 644 "$tmp" "$dir/policies.json" && ok=1
        done
        rm -f "$tmp"
        [ "$ok" = 1 ] && info 'Added a Firefox policy that trusts the certificate (Firefox then says it is "managed by your organization").'
    fi
    if [ "$ok" = 1 ]; then cp "$ca" "$APP_DATA_DIR/firefox-trusted.crt"
    else warn "Could not add the certificate to Firefox. Import $ca in Firefox's settings (Privacy & Security > Certificates)."; fi
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
    remove_old_user_service
    if service_installed && systemctl is-active --quiet "$SERVICE_NAME" 2>/dev/null; then
        info 'Stopping the AMMUI service (you may be asked for your password).'
        as_root systemctl stop "$SERVICE_NAME"
    fi
    # One started by the launcher (at login, or by an earlier run of this installer). Stopping the
    # server lets its supervisor exit by itself.
    local spid
    spid="$(cat "$APP_DATA_DIR/server.pid" 2>/dev/null)"
    if [ -n "$spid" ] && kill -0 "$spid" 2>/dev/null && grep -q server.js "/proc/$spid/cmdline" 2>/dev/null; then
        info 'Stopping the AMMUI server that is already running.'
        pkill -TERM -P "$spid" 2>/dev/null
        local i
        for ((i = 0; i < 20; i++)); do kill -0 "$spid" 2>/dev/null || break; sleep 0.5; done
        kill "$spid" 2>/dev/null
        rm -f "$APP_DATA_DIR/server.pid"
    fi
    # The ports it was using (the saved ones). Another program on one isn't a problem:
    # choose_ports picks free ones later.
    local port pid name saved=''
    [ -f "$INSTALL_DIR/scripts/ports.js" ] && saved="$(cd "$INSTALL_DIR" && node scripts/ports.js 2>/dev/null)"
    for port in $saved; do
        read -r pid name <<<"$(listening_pid "$port")"
        [ "${name:-}" = node ] || continue
        info "Stopping the AMMUI server that is already running (process $pid)."
        kill "$pid"; sleep 1
    done
}

# Ports below 1024 (such as 80) are only for root, unless the system allows them for everyone or
# Node.js has been given the right to use them. Gives Node.js that right if need be (asking for
# the password); fails when it can't.
allow_low_port() {   # allow_low_port PORT
    { [ "$1" -ge 1024 ] || [ "$IS_ROOT" -eq 1 ]; } && return 0
    [ "$(sysctl -n net.ipv4.ip_unprivileged_port_start 2>/dev/null || echo 1024)" -le "$1" ] && return 0
    local node_bin; node_bin="$(readlink -f "$(command -v node)")"
    have getcap && getcap "$node_bin" 2>/dev/null | grep -q cap_net_bind_service && return 0
    have setcap || { pkg_install libcap2-bin libcap-progs libcap >/dev/null 2>&1; hash -r; }
    { have setcap && can_be_root; } || return 1
    info "Letting Node.js use port $1 (you may be asked for your password)..."
    as_root setcap cap_net_bind_service=+ep "$node_bin" || return 1
    printf '%s\n' "$node_bin" > "$APP_DATA_DIR/.node-port-capability"   # so the uninstaller takes it away again
}

# The first of the given ports that is free and allowed, skipping SKIP; warns when it isn't the first
pick_port() {   # pick_port LABEL SKIP PORT... -> prints the port, or nothing
    local label="$1" skip="$2" wanted="$3" port reason=''
    shift 2
    for port in "$@"; do
        [ "$port" = "$skip" ] && { [ "$port" = "$wanted" ] && reason='it is the other port'; continue; }
        if [ -n "$(listening_pid "$port")" ]; then
            [ "$port" = "$wanted" ] && reason='it is in use by another program'
        elif ! allow_low_port "$port" >&2; then
            [ "$port" = "$wanted" ] && reason='this computer only lets root use it'
        else
            [ "$port" = "$wanted" ] || warn "Port $wanted is not available for $label ($reason), so AMMUI will use port $port. Change it in Settings > Secure Access." >&2
            echo "$port"
            return
        fi
    done
}

# Settles the ports: the saved ones (80 and 443 at first) if they're free and allowed, or else the
# first of a few others that are, and saves them. They can be changed later in Settings > Secure Access.
choose_ports() {
    local saved
    saved="$(cd "$INSTALL_DIR" && node scripts/ports.js 2>/dev/null)" || saved=''
    [ -n "$saved" ] && read -r HTTP_PORT HTTPS_PORT <<<"$saved"
    HTTP_PORT="$(pick_port HTTP '' "$HTTP_PORT" 80 8080 8000 3000 8081 8888)"
    [ -n "$HTTP_PORT" ] || fail 'No free port was found for HTTP. Close the program using port 80 and run the installer again.'
    HTTPS_PORT="$(pick_port HTTPS "$HTTP_PORT" "$HTTPS_PORT" 443 3443 8443 4443 9443)"
    [ -n "$HTTPS_PORT" ] || fail 'No free port was found for HTTPS. Close the program using port 443 and run the installer again.'
    (cd "$INSTALL_DIR" && node scripts/ports.js "$HTTP_PORT" "$HTTPS_PORT" 2>/dev/null) || fail 'Could not save the ports.'
    info "AMMUI will use port $HTTP_PORT for HTTP (players and other devices) and $HTTPS_PORT for HTTPS (browsers)."
}

# This server's address over HTTPS on a host, leaving out the port when it's the usual 443
https_url() {   # https_url HOST
    if [ "$HTTPS_PORT" = 443 ]; then echo "https://$1/"; else echo "https://$1:$HTTPS_PORT/"; fi
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
    green "AMMUI is starting: $(https_url localhost)"
    info 'Open that address in a browser. To have a browser open whenever AMMUI starts, use Settings > Startup.'
    info "From other devices use $(https_url "$(hostname)")${ip:+ (or $(https_url "$ip"))}."
    if { have systemctl && { systemctl is-active --quiet ufw 2>/dev/null || systemctl is-active --quiet firewalld 2>/dev/null; }; }; then
        warn "A firewall is running. Allow TCP ports $HTTP_PORT and $HTTPS_PORT, and UPnP/mDNS discovery (UDP 1900 and 5353), so players and other devices can connect."
    fi
}

# A new server waits to be named before it starts its services, and nothing else opens the page
# on a new install: say so where it can be seen (the log has pushed the addresses out of sight),
# and open the page when there's a desktop to open it on.
open_if_unnamed() {
    local url name
    url="$(https_url localhost)"
    name="$(cd "$INSTALL_DIR" && node scripts/server-name.js 2>/dev/null)"
    printf '\n'
    green "AMMUI is running: $url"
    [ -n "$name" ] && return 0
    green 'Give this server a name there to finish setting it up.'
    local opened
    if opened="$(open_on_desktop "$url")"; then
        info "Opening it in $opened on the desktop."
    else
        warn 'No desktop session was found to open it on (or no browser), so open that address yourself:'
        info "on this computer once you have logged in to the desktop, or from another device at $(https_url "$(hostname)")."
    fi
}

# The desktop session's variables (NAME=value lines), so a window can be opened on it: none when
# this terminal is already on the desktop, else from this user's systemd manager, which the desktop
# fills in when it starts (so this works over SSH too). Fails when no one is logged in to a desktop.
desktop_env() {
    { [ -n "${DISPLAY:-}" ] || [ -n "${WAYLAND_DISPLAY:-}" ]; } && return 0
    have systemctl || return 1
    local vars
    vars="$(systemctl --user show-environment 2>/dev/null \
        | grep -E '^(DISPLAY|WAYLAND_DISPLAY|XAUTHORITY|DBUS_SESSION_BUS_ADDRESS|XDG_RUNTIME_DIR|XDG_SESSION_TYPE|XDG_CURRENT_DESKTOP|XDG_DATA_DIRS)=' \
        | sed "s/^\([A-Z_]*\)=\\\$\?'\(.*\)'\$/\1=\2/")"
    printf '%s\n' "$vars" | grep -qE '^(DISPLAY|WAYLAND_DISPLAY)=' || return 1
    printf '%s\n' "$vars"
}

# Opens URL in a browser on the desktop, in its own session so it stays open when this script and
# its terminal end. Prints what opened it; fails when there's no desktop or no browser.
open_on_desktop() {   # open_on_desktop URL
    local env_lines opener='' b line
    env_lines="$(desktop_env)" || return 1
    for b in xdg-open firefox chromium chromium-browser google-chrome google-chrome-stable microsoft-edge microsoft-edge-stable; do
        have "$b" && { opener="$b"; break; }
    done
    [ -n "$opener" ] || return 1
    local -a envs=()
    while IFS= read -r line; do [ -n "$line" ] && envs+=("$line"); done <<<"$env_lines"
    if have setsid; then env ${envs[@]+"${envs[@]}"} setsid "$opener" "$1" </dev/null >/dev/null 2>&1 &
    else env ${envs[@]+"${envs[@]}"} nohup "$opener" "$1" </dev/null >/dev/null 2>&1 &
    fi
    if [ "$opener" = xdg-open ]; then echo 'your browser'; else echo "$opener"; fi
}

start_server() {
    step 'Starting AMMUI'
    if [ "$STARTUP_MODE" = service ]; then
        # This first start leaves opening the page to the installer, once the certificate is
        # trusted (see openToName in server.js). The service takes its environment as it starts.
        as_root systemctl set-environment AMMUI_INSTALLER=1 2>/dev/null
        as_root systemctl start "$SERVICE_NAME"; local started=$?
        as_root systemctl unset-environment AMMUI_INSTALLER 2>/dev/null
        [ "$started" -eq 0 ] || fail "The AMMUI service did not start. See: systemctl status $SERVICE_NAME, and $SERVER_LOG"
        print_addresses
        if wait_for_port ''; then grant_certificate_trust; open_if_unnamed
        else warn "AMMUI has not opened its port yet. See its log: $SERVER_LOG"; fi
        printf '\n'
        green 'AMMUI is running as a service and starts with the computer.'
        info "Log: $SERVER_LOG (or use AMMUI Server in the menu)"
        info "Stop: sudo systemctl stop $SERVICE_NAME    Start: sudo systemctl start $SERVICE_NAME"
        return
    fi
    if [ "$STARTUP_MODE" = login ]; then
        # Started in the background as the next login will start it, in its own session so it
        # carries on when this terminal closes. This first start leaves opening the page to the
        # installer, once the certificate is trusted (see openToName in server.js).
        if have setsid; then AMMUI_INSTALLER=1 setsid "$LAUNCHER" --login </dev/null >/dev/null 2>&1 &
        else AMMUI_INSTALLER=1 nohup "$LAUNCHER" --login </dev/null >/dev/null 2>&1 &
        fi
        print_addresses
        if wait_for_port ''; then grant_certificate_trust; open_if_unnamed
        else warn "AMMUI has not opened its port yet. See its log: $SERVER_LOG"; fi
        printf '\n'
        green "AMMUI is running in the background, and starts whenever $USER logs in."
        info "Log: $SERVER_LOG (or use AMMUI Server in the menu)"
        info "Stop: $LAUNCHER --stop    Start: $LAUNCHER --login"
        return
    fi

    print_addresses
    green 'Press Ctrl+C to stop AMMUI.'
    printf '\n'
    # The server shares this terminal for its log. Once it is listening (its certificate exists
    # by then), trust the certificate.
    cd "$INSTALL_DIR" || fail "Cannot open $INSTALL_DIR"
    # It leaves opening the page to the installer, once the certificate is trusted (see openToName in server.js)
    AMMUI_INSTALLER=1 node server.js </dev/null &
    local server=$! code
    # A background job ignores Ctrl+C in a script, so pass it on. wait returns when the trap
    # runs, so wait again until the server has really gone.
    trap 'kill "$server" 2>/dev/null' INT TERM
    wait_for_port "$server" && { grant_certificate_trust; open_if_unnamed; green 'Press Ctrl+C to stop AMMUI.'; printf '\n'; }
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
    [ "$IS_ROOT" -eq 1 ] && fail 'Run this as the user who will log in and use AMMUI, not as root or with sudo: the AMMUI service runs as that user, and the browser opens when they log in. To set it up for another user, run it as them (for example: sudo -iu USERNAME, then run the installer).'
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
    choose_ports
    install_helpers
    install_startup
    new_menu_entries
    new_kiosk_entry
    write_uninstaller
    info "To uninstall AMMUI later, use 'Uninstall AMMUI' in the menu, or run: bash $APP_DATA_DIR/uninstall.sh"

    if [ "${AMMUI_NO_RUN:-}" = 1 ]; then step "AMMUI is installed in $INSTALL_DIR"; else start_server; fi
}

main </dev/null
