# Contributing

This repository is intended for a small technical study group. Keep changes
reviewable and do not commit generated application payloads or local evidence.

Before sharing a change, run:

```sh
npm ci
npm run check
npm run frontend:build
```

## CI 与 main 合并

在功能分支开发，通过 PR 合并到 `main`。`check` 通过即可合并，无需其他人审批，
也不要求每次合并前重新更新分支。main 禁止强制推送和删除；管理员保留通过 PR
绕过检查的应急权限，正常合并应等待检查通过。功能分支不受这些规则限制。

CI 检查所有指向 main 的 PR 和 main 的新提交。相同 PR 的新提交取消旧运行；
尚未创建 PR 的分支可以从 Actions 页面手动运行 `repository checks`。
Actions 使用完整 commit SHA，Dependabot 每月集中提交更新。

源码检查使用 Node 26.5.0、`npm ci` 和仓库内临时目录。容器中复现时设置：

```sh
export TMPDIR="$PWD/.cache/ci-tmp"
mkdir -p "$TMPDIR"
export GIT_LFS_SKIP_SMUDGE=1
npm ci --no-audit --no-fund
npm run check
npm run frontend:build
npm run publication:check
```

源码测试需要在全新 checkout 中运行，使用已提交的输入；真实应用构件的打包验收
单独执行。源码 CI 校验 LFS pointer，不下载安装包。需要导入外部依赖的临时 ESM
构件应放在仓库 `.cache` 内，使 Node 能解析仓库安装的依赖。子进程关闭检查等待
实际退出事件；固定睡眠时长不能证明资源已经释放。

On macOS, after `npm run bootstrap`, package changes should also pass:

```sh
npm run package
npm run verify
```

Use focused commits. Explain whether a change affects reviewed runtime source,
the editable frontend, the checksum-pinned packaged renderer, or packaging only.
Do not weaken checksum, bundle identity, code-signing, or clean-export checks to
make a build pass.
