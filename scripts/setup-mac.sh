#!/usr/bin/env bash
#
# Aiper — one-shot setup for a Mac.
#
# Installs what is missing, clones Aiper to the Desktop, configures it, and starts it.
# Safe to run again: an existing clone is updated rather than replaced, and anything already
# installed is left alone.
#
# Run it with:
#
#     curl -fsSL https://raw.githubusercontent.com/DevDesai444/Aiper-plat/main/scripts/setup-mac.sh | bash
#
set -euo pipefail

# Public by design: the device flow has no client secret, and any client id ships inside the
# desktop app anyway, so this is not something that can be kept private.
CLIENT_ID="${AIPER_GITHUB_CLIENT_ID:-Ov23liGwgNrBrhj8UZP8}"
REPO_URL="${AIPER_REPO_URL:-https://github.com/DevDesai444/Aiper-plat.git}"
TARGET="${AIPER_TARGET:-$HOME/Desktop/Aiper}"

say()  { printf '  \033[36m%s\033[0m\n' "$1"; }
good() { printf '  \033[32m%s\033[0m\n' "$1"; }
warn() { printf '  \033[33m%s\033[0m\n' "$1"; }
die()  { printf '  \033[31m%s\033[0m\n' "$1" >&2; exit 1; }

printf '\n  \033[1mAiper setup\033[0m\n  ------------\n\n'

have() { command -v "$1" >/dev/null 2>&1; }

# ------------------------------------------------------------------------------ prerequisites
if ! have git; then
  # The Command Line Tools installer is a GUI dialog, so it cannot be waited on from here.
  say 'Git is missing — asking macOS to install the Command Line Tools.'
  xcode-select --install 2>/dev/null || true
  die 'Finish that installer, then run this again.'
fi
good "Git $(git --version | awk '{print $3}') is installed."

need_node=false
if have node; then
  major=$(node -v | sed 's/^v//' | cut -d. -f1)
  if [ "$major" -lt 20 ]; then
    warn "Node $(node -v) is too old; Aiper needs 20 or newer."
    need_node=true
  else
    good "Node $(node -v) is installed."
  fi
else
  need_node=true
fi

if [ "$need_node" = true ]; then
  if have brew; then
    say 'Installing Node.js with Homebrew...'
    brew install node
  else
    die 'Node 20+ is needed. Install it from https://nodejs.org (or install Homebrew first), then run this again.'
  fi
fi
have npm || die 'npm is missing even though Node is installed. Reinstall Node.js.'

# ------------------------------------------------------------------------------------- source
if [ -d "$TARGET/.git" ]; then
  say "Updating the existing copy at $TARGET..."
  # Local edits are the user's, not ours to discard.
  if [ -n "$(git -C "$TARGET" status --porcelain)" ]; then
    warn 'There are local changes here — leaving them alone and skipping the update.'
  else
    git -C "$TARGET" pull --ff-only >/dev/null
  fi
else
  say "Cloning Aiper to $TARGET..."
  git clone --depth 1 "$REPO_URL" "$TARGET" >/dev/null 2>&1
fi
good 'Source is ready.'

cd "$TARGET"

# ------------------------------------------------------------------------------------- config
# .env is gitignored, so it never arrives with a clone and has to be written here.
if [ -f .env ] && grep -q 'AIPER_GITHUB_CLIENT_ID=.\+' .env; then
  good 'A client id is already configured; leaving it as it is.'
else
  printf 'AIPER_GITHUB_CLIENT_ID=%s\n' "$CLIENT_ID" > .env
  good 'Wrote .env'
fi

# ------------------------------------------------------------------------------------ install
say 'Installing dependencies — this takes a few minutes the first time...'
npm install --no-fund --no-audit || die 'npm install failed. Scroll up for the reason.'
good 'Dependencies installed.'

printf '\n'
good "Starting Aiper. Click 'Sign in with GitHub' and approve the code it shows you."
printf '  \033[2mNext time, run:  cd "%s" && npm run dev\033[0m\n\n' "$TARGET"

npm run dev
