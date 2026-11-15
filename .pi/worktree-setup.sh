#!/bin/sh
# Worktree setup for this repository, run by pi-subagents before a subagent starts.
# The manifest is at the repository root, so no cd is needed.
#
# The worktree arrives with `node_modules` as a symlink into the main checkout.
# pnpm follows that link and installs into the main tree, so the worktree keeps
# pointing at packages it does not own: anything added to the manifest after the
# link was made (undici, for one) resolves in the main checkout and not here,
# and a subagent then sees `Cannot find package` for a dependency that is right
# there in package.json. Replace the link with a real directory before installing.
set -eu

if [ -L node_modules ]; then
	rm -f node_modules
fi

if pnpm install --prefer-offline; then
	exit 0
fi

# The install command failed. pnpm 12 exits non-zero after a *successful* install
# when a dependency ships a build script it was not allowed to run
# (`ERR_PNPM_IGNORED_BUILDS`), so verify the tree instead of trusting the code.
if [ -d node_modules/typescript ] && [ -d node_modules/.bin ]; then
	echo "pnpm exited non-zero (ignored build scripts?); the tree is installed, continuing" >&2
	exit 0
fi

echo "pnpm install failed and node_modules is incomplete" >&2
exit 1
