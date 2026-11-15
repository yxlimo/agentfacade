#!/bin/sh
# Worktree setup for this repository, run by pi-subagents before a subagent starts.
# The manifest is at the repository root, so no cd is needed.
#
# The exit code decides whether the worktree counts as ready. pnpm 12 exits
# non-zero after a *successful* install when a dependency ships a build script
# it was not allowed to run (`ERR_PNPM_IGNORED_BUILDS`); that is a policy note,
# not an install failure, and treating it as one sends every subagent down the
# "dependencies are missing" road. So verify the tree instead of trusting the
# exit code: if the packages are there, the worktree is ready.
set -eu

if pnpm install --prefer-offline; then
	exit 0
fi

# The install command failed. Only accept that if the tree is usable anyway.
if [ -d node_modules/typescript ] && [ -d node_modules/.bin ]; then
	echo "pnpm exited non-zero (ignored build scripts?); the tree is installed, continuing" >&2
	exit 0
fi

echo "pnpm install failed and node_modules is incomplete" >&2
exit 1
