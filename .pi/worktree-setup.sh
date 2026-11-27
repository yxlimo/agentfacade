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
#
# `web/` is a second pnpm project of its own (its own pnpm-workspace.yaml and
# lockfile), not a workspace member of the root. Installing only the root leaves
# `web/node_modules` missing, and the first `mise run web:*` inside the child's
# sandbox then tries to install it there — where the store is not writable and
# the network is cut, so it hangs instead of failing. Install both here, while
# it still has the real store and the network.
set -eu

install_one() {
	dir="$1"
	[ -f "$dir/pnpm-lock.yaml" ] || return 0
	if [ -L "$dir/node_modules" ]; then
		rm -f "$dir/node_modules"
	fi
	if ( cd "$dir" && pnpm install --prefer-offline --frozen-lockfile ); then
		return 0
	fi
	# The install command failed. pnpm 12 exits non-zero after a *successful*
	# install when a dependency ships a build script it was not allowed to run
	# (`ERR_PNPM_IGNORED_BUILDS`), so verify the tree instead of trusting the
	# exit code.
	if [ -d "$dir/node_modules/.bin" ]; then
		echo "pnpm exited non-zero in $dir (ignored build scripts?); the tree is installed, continuing" >&2
		return 0
	fi
	echo "pnpm install failed in $dir and node_modules is incomplete" >&2
	return 1
}

install_one .
install_one web

# 构建产物目录先建出来。子代理的沙箱只能授权**已经存在**的路径：写范围里写了
# `web/.gen` 而它不存在时，那条授权被跳过（Landlock 授权的是 inode），于是第一次
# 构建就死在 `EACCES: /…/web/.gen`。空目录先摆好，授权就落得下来。
mkdir -p web/.gen web/.tanstack web/dist .e2e/tmp .e2e/logs .e2e/results

# pnpm 的 verify-deps-before-run：依赖树与 lockfile 一旦对不上，任何 `mise run`
# 都会先自己 install 一次。沙箱里 store 不可写、网络被切，那一步不报错、只挂住
# （表现成「Verifying lockfile against supply-chain policies」停在那里），子代理
# 于是被一个跟它代码无关的命令耗到超时。依赖本来就在上面装齐了，这里把这个自动
# 修复关掉：真正缺依赖时宁可让命令当场报错。
#
# 只作用于这个工作树（文件写在工作树里），并且登记进该工作树的 exclude —— 否则
# 它会以一个未跟踪文件的样子混进子代理的补丁。
for project in . web; do
	printf 'verify-deps-before-run=false\n' > "$project/.npmrc"
done
exclude=$(git rev-parse --git-path info/exclude)
mkdir -p "$(dirname "$exclude")"
if ! grep -qx '/\*\*/.npmrc' "$exclude" 2>/dev/null; then
	printf '/**/.npmrc\n' >> "$exclude"
fi
