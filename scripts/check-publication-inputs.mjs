import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = process.argv[2] ?? fileURLToPath(new URL("..", import.meta.url));
const names = execFileSync("git", ["ls-files", "--cached", "-z"], { cwd: root, encoding: "utf8" }).split("\0").filter(Boolean);
const forbidden = /(^|\/)(?:\.env(?:\.[^/]*)?|\.npmrc|\.netrc|auth\.json|credentials\.json|user-secrets\.json|box-secrets\.json|anthropic-token|id_rsa[^/]*|id_ed25519[^/]*|Cookies|Login Data|Web Data)(?:$|\/)|(^|\/)(?:\.ssh|\.claude|\.codex|chrome-profile|browser-profile)(?:$|\/)|\.(?:pem|key|p12|pfx)$/i;
const rejected = names.filter(name => forbidden.test(name));
if (rejected.length) {
  // 只输出路径，绝不读取或输出文件内容。
  console.error(`Runtime credential/session paths cannot be published:\n${rejected.join("\n")}`);
  process.exitCode = 1;
} else console.log(`Publication path policy passed for ${names.length} tracked files.`);
