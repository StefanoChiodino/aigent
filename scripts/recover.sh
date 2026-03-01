#!/usr/bin/env bash
# recover.sh — Walk back through git history until `make check` passes.
# Saves the current (broken) state to a branch for inspection.
#
# Usage: ./scripts/recover.sh [max_commits_to_try]
#   Default: tries up to 20 commits back.

set -euo pipefail

MAX="${1:-20}"
BROKEN_BRANCH="broken/$(date +%Y%m%d-%H%M%S)"
ORIG_BRANCH="$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo "detached")"
ORIG_COMMIT="$(git rev-parse HEAD)"

echo "🔍 Current commit: $(git log --oneline -1)"
echo "📌 Saving broken state to branch: $BROKEN_BRANCH"

# Stash any uncommitted changes
STASHED=false
if ! git diff --quiet || ! git diff --cached --quiet; then
  git stash push -m "recover.sh: uncommitted changes from $ORIG_COMMIT"
  STASHED=true
  echo "📦 Stashed uncommitted changes"
fi

# Create branch pointing at the current (broken) commit
git branch "$BROKEN_BRANCH" HEAD
echo "✅ Branch '$BROKEN_BRANCH' created at $(git rev-parse --short HEAD)"

# Walk back through commits
echo ""
echo "🔄 Testing up to $MAX commits back..."
echo ""

FOUND=""
for i in $(seq 1 "$MAX"); do
  COMMIT="HEAD~$i"
  SHORT="$(git rev-parse --short "$COMMIT" 2>/dev/null || break)"
  DESC="$(git log --oneline -1 "$COMMIT" 2>/dev/null || break)"

  echo "--- [$i/$MAX] Testing: $DESC ---"

  git checkout --quiet "$COMMIT"

  # Install deps if package-lock changed
  if ! git diff --quiet HEAD "HEAD^" -- package-lock.json 2>/dev/null; then
    echo "  📦 package-lock changed, running npm ci..."
    npm ci --silent 2>/dev/null || npm install --silent 2>/dev/null || true
  fi

  # Run the check
  if make check 2>&1 | tail -3; then
    echo ""
    echo "✅ FOUND WORKING COMMIT: $DESC"
    FOUND="$SHORT"
    break
  else
    echo "  ❌ Failed"
  fi
done

if [ -z "$FOUND" ]; then
  echo ""
  echo "❌ No working commit found in the last $MAX commits."
  echo "   Returning to original state."
  git checkout --quiet "$ORIG_BRANCH" 2>/dev/null || git checkout --quiet "$ORIG_COMMIT"
  if [ "$STASHED" = true ]; then
    git stash pop --quiet 2>/dev/null || true
  fi
  exit 1
fi

echo ""
echo "🔧 Resetting '$ORIG_BRANCH' to working commit $FOUND"

if [ "$ORIG_BRANCH" = "detached" ]; then
  echo "⚠️  Was in detached HEAD — staying at $FOUND"
  echo "   Run: git checkout -b <branch-name> to create a branch"
else
  git checkout --quiet "$ORIG_BRANCH"
  git reset --hard "$FOUND"
  echo "✅ '$ORIG_BRANCH' now at: $(git log --oneline -1)"
fi

if [ "$STASHED" = true ]; then
  echo "⚠️  You had stashed changes. Run 'git stash pop' if you want them back."
fi

echo ""
echo "📋 Summary:"
echo "   Broken code: git checkout $BROKEN_BRANCH"
echo "   Working code: $(git log --oneline -1)"
echo "   Diff:         git diff $FOUND..$BROKEN_BRANCH"
