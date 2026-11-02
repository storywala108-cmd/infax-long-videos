#!/usr/bin/env bash
# Commit state/ from a GitHub run and push it, surviving pushes that landed meanwhile.
# "-X theirs" during a rebase keeps THIS run's version of a conflicting state file (first run hit a conflict).
rm -f .env
git config user.name "storywala108-cmd"
git config user.email "storywala108@gmail.com"
node scripts/index.js || true
git add state
git diff --cached --quiet && exit 0
git commit -q -m "$1"
for i in 1 2 3; do
  if git pull -q --rebase -X theirs origin main && git push -q; then exit 0; fi
  git rebase --abort 2>/dev/null || true
  sleep $((i * 5))
done
echo "state push failed after 3 tries"; exit 1
