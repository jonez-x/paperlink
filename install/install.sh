#!/bin/sh
# Installs Paperlink for this user on macOS and Linux: its own Node.js in
# ~/.paperlink/node (no admin rights, any existing Node stays untouched), the
# app in ~/.paperlink/app and a `paper` command, then runs `paper setup`.
# Running it again updates Paperlink. Usage: sh install.sh [paperlink.tgz]
set -eu

NODE_LINE=22
HOME_DIR="${PAPERLINK_HOME:-$HOME/.paperlink}"
HERE="$(cd "$(dirname "$0")" && pwd)"
PACKAGE="${1:-$HERE/paperlink.tgz}"

say() { printf '  %s\n' "$*"; }
fail() { printf '  ✗ %s\n' "$*" >&2; exit 1; }

[ -f "$PACKAGE" ] || fail "paperlink.tgz not found next to this script."

case "$(uname -s)" in
  Darwin) os=darwin ;;
  Linux) os=linux ;;
  *) fail "Unsupported system $(uname -s). On Windows, run Install Paperlink.cmd." ;;
esac
case "$(uname -m)" in
  arm64|aarch64) arch=arm64 ;;
  x86_64|amd64) arch=x64 ;;
  *) fail "Unsupported processor $(uname -m)." ;;
esac
if command -v shasum >/dev/null 2>&1; then sha256() { shasum -a 256 "$1" | cut -d' ' -f1; }
else sha256() { sha256sum "$1" | cut -d' ' -f1; }; fi

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
mkdir -p "$HOME_DIR"

# Node.js: the latest release of the supported line, checked against nodejs.org's checksums.
base="https://nodejs.org/dist/latest-v$NODE_LINE.x"
curl -fsSL "$base/SHASUMS256.txt" -o "$work/SHASUMS256.txt" || fail "Cannot reach nodejs.org. Check the internet connection."
archive="$(grep -o "node-v[0-9.]*-$os-$arch\.tar\.gz" "$work/SHASUMS256.txt" | head -n 1)"
[ -n "$archive" ] || fail "No Node.js download for $os-$arch."
version="${archive%-$os-$arch.tar.gz}"; version="${version#node-}"
if [ "$(cat "$HOME_DIR/node/VERSION" 2>/dev/null || true)" = "$version" ]; then
  say "✓ Node.js $version is already here"
else
  say "Downloading Node.js $version …"
  curl -fL --progress-bar "$base/$archive" -o "$work/$archive"
  expected="$(grep " $archive\$" "$work/SHASUMS256.txt" | cut -d' ' -f1)"
  [ "$(sha256 "$work/$archive")" = "$expected" ] || fail "The Node.js download is damaged (checksum mismatch). Try again."
  tar -xzf "$work/$archive" -C "$work"
  rm -rf "$HOME_DIR/node"
  mv "$work/${archive%.tar.gz}" "$HOME_DIR/node"
  echo "$version" > "$HOME_DIR/node/VERSION"
  say "✓ Node.js $version"
fi
node="$HOME_DIR/node/bin/node"

# Paperlink itself. A running server is stopped first and restarted by setup.
[ -x "$HOME_DIR/bin/paper" ] && "$HOME_DIR/bin/paper" stop >/dev/null 2>&1 || true
tar -xzf "$PACKAGE" -C "$work"
rm -rf "$HOME_DIR/app"
mv "$work/package" "$HOME_DIR/app"
mkdir -p "$HOME_DIR/bin"
cat > "$HOME_DIR/bin/paper" <<EOF
#!/bin/sh
exec "$node" "$HOME_DIR/app/bin/paper.js" "\$@"
EOF
chmod +x "$HOME_DIR/bin/paper"
say "✓ Paperlink $("$node" -p "require(process.argv[1]).version" "$HOME_DIR/app/package.json")"

# `paper` in new terminals.
line="export PATH=\"$HOME_DIR/bin:\$PATH\""
for rc in "$HOME/.zprofile" "$HOME/.bashrc"; do
  if [ "$rc" = "$HOME/.zprofile" ] && [ "$os" != darwin ] && [ ! -f "$rc" ]; then continue; fi
  grep -qsF "$HOME_DIR/bin" "$rc" || printf '\n# Paperlink\n%s\n' "$line" >> "$rc"
done
say "✓ \`paper\` works in new terminal windows"
echo

# Setup asks questions, so it reads the keyboard even when this script was piped into sh.
if [ -t 1 ] && [ -r /dev/tty ]; then "$HOME_DIR/bin/paper" setup < /dev/tty
else say "Run \`paper setup\` to finish."; fi
