// Stage 4A: the deterministic rules. Each script command (the scanner's
// display-safe text, at most 500 characters) is split by a small, bounded
// lexer into commands, pipeline stages and words, and the rules look for
// structure (a downloader stage piped into an interpreter stage), not just
// words appearing somewhere. Quoted text is data unless it is the script of
// an interpreter (sh -c "...", cmd /c "...", powershell -Command ...) or a
// command substitution ($(...), `...`, <(...)); those are parsed as nested
// commands. Nothing is ever evaluated, executed, decoded or resolved on disk,
// and no pattern is built from repository text.
import type { SafetyRuleId } from "./types";

/** Text longer than this isn't examined further (the scanner already caps commands at 500). */
export const MAX_COMMAND_TEXT = 2000;
/** Nesting depth for substitutions and interpreter scripts. */
export const MAX_NESTING = 3;
/** Words, stages and nested commands examined per script, at most. */
const MAX_WORDS = 400;

/**
 * A substitution inside a word. "command" ($(...) or `...`) is replaced by the
 * inner command's output text; "process" (<(...)) by a file path whose
 * contents are that output.
 */
interface Substitution {
  text: string;
  start: number;
  kind: "command" | "process";
}

interface Word {
  /** Text with quotes and escapes removed, as the shell would see it (substitutions left as written). */
  value: string;
  /** Offset in the script text where the word starts. */
  start: number;
  /** Inner text of command substitutions in the word: $(...), `...`, <(...). */
  subs: Substitution[];
  /** Some part was quoted or escaped: then it is never a redirection. */
  quoted: boolean;
}
/** A pipeline stage's words, without its redirections. */
type Stage = Word[] & {
  /** Its standard input comes from a redirection (<file, <<EOF, <<<text, <&3), not from the pipe. */
  stdinRedirected?: boolean;
};
/** One command list: segments separated by ; && || &, each a pipeline of stages. */
type Command = Stage[][];

const SEPARATORS = new Set(["&&", "||", ";", "&"]);
/**
 * A backslash escapes only these (POSIX shells); before anything else it is
 * kept, so Windows paths (C:\Windows\Temp, %USERPROFILE%\.aws) stay intact,
 * as cmd.exe, which runs npm scripts on Windows, treats them.
 */
const ESCAPABLE = new Set(['"', "'", "\\", "$", "`", " ", "|", "&", ";", "(", ")", "<", ">"]);

/** Index just after the ")" closing the "(" before `from`, skipping quoted text. */
function closingParen(text: string, from: number): number {
  let depth = 1;
  for (let i = from; i < text.length; i++) {
    const c = text[i];
    if (c === "'" || c === '"') {
      const end = text.indexOf(c, i + 1);
      if (end < 0) return text.length;
      i = end;
    } else if (c === "(") depth++;
    else if (c === ")" && --depth === 0) return i + 1;
  }
  return text.length;
}

/** Splits `text` into words and separators. Linear in the text length. */
function lex(text: string, offset: number): Array<Word | { op: string }> {
  const out: Array<Word | { op: string }> = [];
  let word: Word | null = null;
  const begin = (at: number) => (word ??= { value: "", start: offset + at, subs: [], quoted: false });
  const end = () => {
    if (word) out.push(word);
    word = null;
  };
  const substitution = (open: number, innerStart: number, close: number) => {
    const w = begin(open);
    w.subs.push({ text: text.slice(innerStart, close), start: offset + innerStart, kind: text[open] === "<" ? "process" : "command" });
  };
  for (let i = 0; i < text.length && out.length < MAX_WORDS; i++) {
    const c = text[i];
    const current = word as Word | null;
    if (c === " " || c === "\t") {
      end();
    } else if ((c === "&" || c === "|") && current && !current.quoted && /^(?:\d*|&)(?:<|>)$/.test(current.value)) {
      current.value += c; // 2>&1, <&3, >|file
    } else if (c === "&" && current === null && text[i + 1] === ">") {
      begin(i).value += c; // &>file, &>>file
    } else if (c === "|" || c === "&" || c === ";") {
      end();
      const two = text.slice(i, i + 2);
      if (two === "||" || two === "&&") {
        out.push({ op: two });
        i++;
      } else out.push({ op: c });
    } else if (c === "'") {
      const close = text.indexOf("'", i + 1);
      const stop = close < 0 ? text.length : close;
      const w = begin(i);
      w.quoted = true;
      w.value += text.slice(i + 1, stop);
      i = stop;
    } else if (c === '"') {
      const w = begin(i);
      w.quoted = true;
      let j = i + 1;
      for (; j < text.length && text[j] !== '"'; j++) {
        if (text[j] === "\\" && j + 1 < text.length && ESCAPABLE.has(text[j + 1])) {
          w.value += text[++j];
        } else if (text[j] === "$" && text[j + 1] === "(") {
          const close = closingParen(text, j + 2);
          substitution(j, j + 2, Math.max(j + 2, close - 1));
          w.value += text.slice(j, close);
          j = close - 1;
        } else if (text[j] === "`") {
          const close = text.indexOf("`", j + 1);
          const stop = close < 0 ? text.length : close;
          substitution(j, j + 1, stop);
          w.value += text.slice(j, stop + 1);
          j = stop;
        } else w.value += text[j];
      }
      i = j;
    } else if (c === "\\" && i + 1 < text.length && ESCAPABLE.has(text[i + 1])) {
      const w = begin(i);
      w.quoted = true;
      w.value += text[++i];
    } else if ((c === "$" || c === "<") && text[i + 1] === "(") {
      const close = closingParen(text, i + 2);
      substitution(i, i + 2, Math.max(i + 2, close - 1));
      begin(i).value += text.slice(i, close);
      i = close - 1;
    } else if (c === "`") {
      const close = text.indexOf("`", i + 1);
      const stop = close < 0 ? text.length : close;
      substitution(i, i + 1, stop);
      begin(i).value += text.slice(i, stop + 1);
      i = stop;
    } else {
      begin(i).value += c;
    }
  }
  end();
  return out;
}

/**
 * Reads an unquoted word as a redirection: an optional fd number (or &),
 * an operator, and the target, attached or (when missing) the next word.
 * Supported: < > >> >| <> <& >& &> &>> << <<- <<<, e.g. 2>/dev/null, >out,
 * 2>&1, <in, 0<in, <<EOF, <<<text, &>log, 2> /dev/null. <(...) is a process
 * substitution, not a redirection. `input`: it replaces standard input
 * (fd 0, the default for < forms).
 */
const REDIRECTION = /^(\d*)(<<<|<<-|<<|<>|<&|<|>>|>&|>\||>|&>>|&>)(.*)$/;
function redirection(word: Word): { input: boolean; attached: boolean } | null {
  if (word.quoted) return null;
  const m = REDIRECTION.exec(word.value);
  if (!m) return null;
  const [, fd, op, target] = m;
  if (op === "<" && target.startsWith("(")) return null; // <(...)
  const input = op.startsWith("<") ? fd === "" || fd === "0" : fd === "0";
  return { input, attached: target !== "" };
}

function parse(text: string, offset: number): Command {
  const segments: Command = [];
  let stages: Stage[] = [];
  let stage: Stage = [];
  let targetPending = false;
  for (const token of lex(text, offset)) {
    if (!("op" in token)) {
      if (targetPending) {
        targetPending = false; // the target of the redirection before it
        continue;
      }
      const r = redirection(token);
      if (r) {
        if (r.input) stage.stdinRedirected = true;
        targetPending = !r.attached;
        continue;
      }
      stage.push(token);
      continue;
    }
    targetPending = false;
    if (token.op === "|") {
      stages.push(stage);
      stage = [];
    } else if (SEPARATORS.has(token.op)) {
      stages.push(stage);
      segments.push(stages.filter((s) => s.length > 0));
      stages = [];
      stage = [];
    }
  }
  stages.push(stage);
  segments.push(stages.filter((s) => s.length > 0));
  return segments.filter((s) => s.length > 0);
}

/** "/usr/bin/Curl.exe" -> "curl"; leading "(" "{" and trailing ")" "}" are dropped. */
function commandName(value: string): string {
  let v = value.toLowerCase();
  while (v.startsWith("(") || v.startsWith("{")) v = v.slice(1);
  while (v.endsWith(")") || v.endsWith("}") || v.endsWith(";")) v = v.slice(0, -1);
  const slash = Math.max(v.lastIndexOf("/"), v.lastIndexOf("\\"));
  if (slash >= 0) v = v.slice(slash + 1);
  return v.endsWith(".exe") ? v.slice(0, -4) : v;
}

const WRAPPERS = new Set(["sudo", "env", "command", "exec", "nohup", "time"]);
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

/** The stage's program (after sudo, env, assignments) and the words after it. */
function head(stage: Stage): { name: string; index: number } | null {
  for (let i = 0; i < stage.length && i < 8; i++) {
    const name = commandName(stage[i].value);
    if (ASSIGNMENT.test(stage[i].value) || WRAPPERS.has(name)) continue;
    return { name, index: i };
  }
  return null;
}

const DOWNLOADERS = new Set(["curl", "wget", "iwr", "invoke-webrequest", "irm", "invoke-restmethod"]);
/** Programs that run what they're given: piped input, or a script argument. */
const INTERPRETERS = new Set(["sh", "bash", "zsh", "dash", "ksh", "node", "python", "python3", "perl", "ruby", "pwsh", "powershell", "iex", "invoke-expression", "source", "."]);
const SHELLS_WITH_SCRIPT_ARG = new Set(["sh", "bash", "zsh", "dash", "ksh", "cmd", "pwsh", "powershell"]);

const STDOUT_TARGETS = new Set(["-", "/dev/stdout"]);

/**
 * wget saves to a file unless its output document is stdout: -O -, -O-,
 * -qO-, -qO -, --output-document=-, --output-document -, or /dev/stdout in
 * place of "-". The last -O wins, as in wget. (-o / --output-file is wget's
 * own log, never the download, so "-o -" doesn't count.)
 */
function wgetToStdout(words: Word[]): boolean {
  let stdout = false;
  for (let i = 0; i < words.length; i++) {
    const v = words[i].value;
    const next = words[i + 1]?.value ?? "";
    if (v === "--output-document" || /^-[a-zA-Z]*O$/.test(v)) stdout = STDOUT_TARGETS.has(next);
    else if (v.startsWith("--output-document=")) stdout = STDOUT_TARGETS.has(v.slice("--output-document=".length));
    else {
      const attached = /^-[a-zA-Z]*O(.+)$/.exec(v);
      if (attached) stdout = STDOUT_TARGETS.has(attached[1]);
    }
  }
  return stdout;
}

/** curl short options that take no value (they may be followed by more options in the same word). */
const CURL_FLAGS = new Set([..."012346aBfgGhiIjJklLMnNpqRsSvVZ#"]);
/** curl short options that take a value: the rest of the word, or the next word. */
const CURL_VALUE_OPTIONS = new Set([..."AbcCdDeEFHKmoPQrtTuUwxXyYz"]);

/**
 * curl writes the download to stdout unless told otherwise. It saves to a
 * file with -o FILE / -oFILE / --output FILE / --output=FILE (FILE not "-" or
 * /dev/stdout), or with -O / --remote-name(-all). Short options are read as
 * curl reads them: value-less flags may share a word (-fsSL); "o" takes the
 * rest of the word (-fsSLoout.sh) or else the next word (-fsSLo out.sh); any
 * other value-taking option ends the word (-H, -d: the rest is their value,
 * not an output). An unknown letter makes the word ambiguous: then a file is
 * assumed, so no download-and-execute claim is made.
 */
function curlWritesToFile(words: Word[]): boolean {
  let file = false;
  const target = (value: string | undefined) => (file = value === undefined ? true : !STDOUT_TARGETS.has(value));
  for (let i = 0; i < words.length; i++) {
    const v = words[i].value;
    if (v === "--output") target(words[++i]?.value);
    else if (v.startsWith("--output=")) target(v.slice("--output=".length));
    else if (v === "--remote-name" || v === "--remote-name-all") file = true;
    else if (/^-[^-]/.test(v)) {
      for (let k = 1; k < v.length; k++) {
        const c = v[k];
        if (c === "O") file = true;
        else if (c === "o") {
          target(k + 1 < v.length ? v.slice(k + 1) : words[++i]?.value);
          break;
        } else if (CURL_VALUE_OPTIONS.has(c)) {
          if (k + 1 >= v.length) i++; // its value is the next word
          break;
        } else if (!CURL_FLAGS.has(c)) {
          file = true; // unknown option letter: can't tell where the output goes
          break;
        }
      }
    }
  }
  return file;
}

/** curl/wget writing to a file (not stdout): a plain download, not direct execution. */
function writesToFile(name: string, words: Word[]): boolean {
  if (name === "wget") return !wgetToStdout(words);
  if (name === "curl") return curlWritesToFile(words);
  for (let i = 0; i < words.length; i++) {
    const v = words[i].value;
    if ((name === "iwr" || name === "invoke-webrequest" || name === "irm" || name === "invoke-restmethod") && /^-outf(i(le?)?)?$/i.test(v)) return true;
  }
  return false;
}

/** The stage itself downloads to its output: a downloader, or PowerShell's DownloadString. */
function stageDownloadsDirectly(stage: Stage): boolean {
  const h = head(stage);
  if (!h) return false;
  if (DOWNLOADERS.has(h.name)) return !writesToFile(h.name, stage.slice(h.index + 1));
  // PowerShell: (New-Object Net.WebClient).DownloadString(...)
  return stage.some((w) => w.value.toLowerCase().includes(".downloadstring("));
}

/** The stage outputs downloaded content: directly, or through a substitution (echo "$(curl URL)"). */
function stageDownloads(stage: Stage): boolean {
  if (stageDownloadsDirectly(stage)) return true;
  return stage.some((w) => w.subs.some((sub) => parse(sub.text, sub.start).some((seg) => seg.length > 0 && stageDownloadsDirectly(seg[0]))));
}

const STDIN_OPERANDS = new Set(["-", "/dev/stdin"]);
const POSIX_SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh"]);

/**
 * For a POSIX shell's arguments: the index of the command string given with
 * -c, or -1. Any short-option word containing "c" (-c, -ec, -euc, -xc) makes
 * the next non-option word the command string, as in sh and bash. A word
 * that isn't an option, reached first, is a script name (no command string);
 * so is anything after "--".
 */
function shellCommandIndex(words: readonly Word[]): number {
  for (let i = 0; i < words.length; i++) {
    const v = words[i].value;
    if (v === "--" || v === "-") return -1;
    if (/^-[a-zA-Z]+$/.test(v)) {
      if (!v.includes("c")) continue;
      for (let j = i + 1; j < words.length; j++) if (!/^-[a-zA-Z]+$/.test(words[j].value)) return j;
      return -1;
    }
    if (v.startsWith("--")) continue; // --login, --norc, ...
    return -1;
  }
  return -1;
}
/** PowerShell options that take a value (so the value isn't a command). */
const PS_VALUE_OPTIONS = ["-executionpolicy", "-ep", "-windowstyle", "-inputformat", "-outputformat", "-configurationname", "-workingdirectory", "-settingsfile"];

/**
 * Whether a stage runs the content piped into it as code, by that program's
 * own rules. A named script file runs that file, with the piped content as
 * plain input; a program given on the command line (-c, -e, -m, -Command,
 * -File) runs that program. Only an explicit stdin operand ("-",
 * /dev/stdin), a stdin switch (sh -s), or no program at all means the input
 * itself is run. An option whose value can't be told from a script name
 * counts as a script name: no claim is made then. eval ignores stdin.
 */
function executesStdin(stage: Stage): boolean {
  if (stage.stdinRedirected) return false; // sh <file reads the file, not the pipe
  const h = head(stage);
  if (!h) return false;
  const args = stage.slice(h.index + 1).map((w) => w.value);
  const name = h.name;
  if (POSIX_SHELLS.has(name)) {
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if (a === "--") return i + 1 >= args.length || STDIN_OPERANDS.has(args[i + 1]);
      if (a === "-") return true;
      if (/^-[a-zA-Z]+$/.test(a)) {
        if (a.includes("c")) return false; // sh -c / -ec: runs the given string
        if (a.includes("s")) return true; // sh -s: reads commands from stdin
        continue;
      }
      if (a.startsWith("--")) continue; // --login, --noprofile, ...
      return STDIN_OPERANDS.has(a); // a script file (or /dev/stdin)
    }
    return true; // no script: reads stdin
  }
  if (name === "node" || name === "python" || name === "python3" || name === "perl" || name === "ruby") {
    const program = name === "node" ? ["-e", "--eval", "-p", "--print"] : name.startsWith("python") ? ["-c", "-m"] : ["-e", "-E"];
    for (const a of args) {
      if (program.includes(a) || (name === "node" && (a.startsWith("--eval=") || a.startsWith("--print=")))) return false;
      if (STDIN_OPERANDS.has(a)) return true;
      if (a.startsWith("-")) continue;
      return false; // a script file
    }
    return true;
  }
  if (name === "pwsh" || name === "powershell") {
    for (let i = 0; i < args.length; i++) {
      const a = args[i].toLowerCase();
      if (!a.startsWith("-") && !a.startsWith("/")) return false; // positional: a command
      const opt = a.replace(/^\//, "-");
      if (PS_VALUE_OPTIONS.some((o) => o.startsWith(opt) && opt.length >= 3) || opt === "-ex" || opt === "-w") {
        i++;
        continue;
      }
      if (opt === "-c" || (opt.length >= 3 && "-command".startsWith(opt)) || opt === "-f" || (opt.length >= 3 && "-file".startsWith(opt))) return args[i + 1] === "-";
      if (opt === "-ec" || (opt.length >= 4 && "-encodedcommand".startsWith(opt))) return false;
    }
    return true; // no command or file: reads stdin
  }
  if (name === "iex" || name === "invoke-expression") return args.length === 0; // with an argument it runs that instead
  if (name === "source" || name === ".") return args.length > 0 && STDIN_OPERANDS.has(args[0]);
  return false;
}

/**
 * The substitutions in a stage whose content the program runs as code, by
 * that program's own syntax:
 *  - eval and iex: their arguments are the program ($(...) / `...`);
 *  - sh/bash/zsh/dash/ksh: the -c string ($(...) / `...`), or a <(...) in the
 *    script position (the script file is the substitution's output);
 *  - source / .: a <(...) as the file;
 *  - node -e/--eval/-p/--print, python -c, perl/ruby -e/-E: their program
 *    argument ($(...) / `...`); a <(...) in the script position;
 *  - powershell/pwsh -Command: the command text ($(...) / `...`); -File <(...).
 * Anything after a named script, option values, and $(...) where a file name
 * goes (bash "$(curl URL)" names a file) are arguments, not code. When a
 * word's role can't be told, it isn't counted.
 */
function programSubstitutions(stage: Stage): Substitution[] {
  const h = head(stage);
  if (!h) return [];
  const words = stage.slice(h.index + 1);
  const name = h.name;
  const asCode = (w: Word | undefined) => (w ? w.subs.filter((sub) => sub.kind === "command") : []);
  const asScript = (w: Word | undefined) => (w ? w.subs.filter((sub) => sub.kind === "process") : []);
  if (name === "eval" || name === "iex" || name === "invoke-expression") return words.flatMap(asCode);
  if (POSIX_SHELLS.has(name) || name === "source" || name === ".") {
    if (POSIX_SHELLS.has(name)) {
      const command = shellCommandIndex(words);
      if (command >= 0) return asCode(words[command]);
    }
    for (let i = 0; i < words.length; i++) {
      const v = words[i].value;
      if (POSIX_SHELLS.has(name) && /^-[a-zA-Z]+$/.test(v) && v.includes("c")) return [];
      if (POSIX_SHELLS.has(name) && (/^-[a-zA-Z]+$/.test(v) || v.startsWith("--"))) continue;
      return asScript(words[i]); // the script position; later words are its arguments
    }
    return [];
  }
  if (name === "node" || name === "python" || name === "python3" || name === "perl" || name === "ruby") {
    const program = name === "node" ? ["-e", "--eval", "-p", "--print"] : name.startsWith("python") ? ["-c"] : ["-e", "-E"];
    for (let i = 0; i < words.length; i++) {
      const v = words[i].value;
      if (program.includes(v)) return asCode(words[i + 1]);
      if (name === "node" && (v.startsWith("--eval=") || v.startsWith("--print="))) return asCode(words[i]);
      if (v.startsWith("-")) continue;
      return asScript(words[i]);
    }
    return [];
  }
  if (name === "pwsh" || name === "powershell") {
    for (let i = 0; i < words.length; i++) {
      const opt = words[i].value.toLowerCase().replace(/^\//, "-");
      if (opt === "-c" || (opt.length >= 3 && "-command".startsWith(opt))) return words.slice(i + 1).flatMap(asCode);
      if (opt === "-f" || (opt.length >= 3 && "-file".startsWith(opt))) return asScript(words[i + 1]);
    }
    return [];
  }
  return [];
}

/**
 * The program text node (-e, --eval, --eval=, -p, --print, --print=) or
 * python (-c) is given on its command line, or null. Options are read only
 * up to the first script name (node tools/check.js -e '...': the -e belongs
 * to the script) or python -m MODULE.
 */
function evaluatedProgram(name: string, args: readonly Word[]): string | null {
  const flags = name === "node" ? ["-e", "--eval", "-p", "--print"] : ["-c"];
  for (let k = 0; k < args.length; k++) {
    const v = args[k].value;
    if (flags.includes(v)) return args[k + 1]?.value ?? null;
    if (name === "node" && (v.startsWith("--eval=") || v.startsWith("--print="))) return v.slice(v.indexOf("=") + 1);
    if (name !== "node" && v === "-m") return null;
    if (v.startsWith("-") && v !== "-") continue;
    return null; // a script (or stdin): the rest are its arguments
  }
  return null;
}

function isBase64Decode(stage: Stage): boolean {
  const h = head(stage);
  if (!h) return false;
  const args = stage.slice(h.index + 1).map((w) => w.value);
  if (h.name === "base64") return args.some((a) => a === "-d" || a === "-D" || a === "--decode");
  if (h.name === "openssl") return args.some((a) => a === "base64" || a === "-base64") && args.some((a) => a === "-d");
  return false;
}

/** The nested commands a stage hands to another program: substitutions and interpreter scripts. */
function nestedTexts(stage: Stage): { text: string; start: number }[] {
  const out: { text: string; start: number }[] = stage.flatMap((w) => w.subs);
  const h = head(stage);
  if (h && POSIX_SHELLS.has(h.name)) {
    const words = stage.slice(h.index + 1);
    const command = shellCommandIndex(words);
    if (command >= 0) out.push({ text: words[command].value, start: words[command].start });
  } else if (h && SHELLS_WITH_SCRIPT_ARG.has(h.name)) {
    const words = stage.slice(h.index + 1);
    for (let i = 0; i < words.length; i++) {
      const v = words[i].value.toLowerCase();
      const scriptFlag = h.name === "cmd" ? v === "/c" || v === "/k" : v === "-c" || (v.length >= 3 && "-command".startsWith(v));
      if (!scriptFlag || i + 1 >= words.length) continue;
      // PowerShell -Command and cmd /c take the rest of the line.
      const rest = words.slice(i + 1);
      out.push({ text: rest.map((w) => w.value).join(" "), start: rest[0].start });
      break;
    }
  }
  return out;
}

interface ParsedScript {
  commands: { command: Command; depth: number }[];
}

/** The script's command and every nested command in it, up to MAX_NESTING deep. */
export function parseScript(text: string): ParsedScript {
  const commands: ParsedScript["commands"] = [];
  const queue: { text: string; start: number; depth: number }[] = [{ text: text.slice(0, MAX_COMMAND_TEXT), start: 0, depth: 0 }];
  while (queue.length > 0 && commands.length < 64) {
    const item = queue.shift()!;
    const command = parse(item.text, item.start);
    commands.push({ command, depth: item.depth });
    if (item.depth >= MAX_NESTING) continue;
    for (const segment of command) for (const stage of segment) for (const nested of nestedTexts(stage)) queue.push({ ...nested, depth: item.depth + 1 });
  }
  return { commands };
}

// ---------------------------------------------------------------------------
// Rules. Each returns the offset of its first match in the script text, or -1.

/**
 * R2. Detected forms:
 *  - a downloader stage piped into a stage that runs its input as code (see
 *    executesStdin): curl URL | sh, curl URL | node -, wget -qO- URL | bash,
 *    irm URL | iex, (New-Object Net.WebClient).DownloadString(URL) | iex;
 *    not curl URL | node script.js (the script runs; the download is its
 *    input), not plain wget URL | sh (wget saves to a file by default);
 *  - an interpreter given a download as its program (see programSubstitutions):
 *    bash <(curl URL), sh -c "$(curl URL)", node -e "$(curl URL)",
 *    source <(wget -qO- URL), eval "$(curl URL)"; not a download passed as an
 *    argument to a named script (node check.js "$(curl URL)");
 *  - PowerShell iex / Invoke-Expression applied to a download: iex (iwr URL), iex(irm URL),
 *    Invoke-Expression (New-Object Net.WebClient).DownloadString(URL).
 * Any of these inside sh -c / cmd /c / powershell -Command scripts or substitutions.
 * Not detected: downloading to a file and running it later (curl -o x && sh x),
 * downloads in files the script runs, and downloads through other tools.
 */
export function downloadExecute(parsed: ParsedScript): number {
  for (const { command } of parsed.commands) {
    for (const segment of command) {
      for (let i = 0; i < segment.length; i++) {
        const stage = segment[i];
        if (stageDownloads(stage) && segment.slice(i + 1).some(executesStdin)) return stage[0].start;
        const h = head(stage);
        if (!h) continue;
        for (const sub of programSubstitutions(stage)) {
          const nested = parse(sub.text, sub.start);
          if (nested.some((seg) => seg.length > 0 && stageDownloadsDirectly(seg[0]))) return stage[0].start;
        }
        if (h.name === "iex" || h.name === "invoke-expression" || h.name.startsWith("iex(") || h.name.startsWith("invoke-expression(")) {
          const rest = stage.slice(h.index).map((w) => w.value.toLowerCase());
          const tail = rest.join(" ").replace(/^(iex|invoke-expression)/, "");
          const words = tail.split(/[\s()]+/).filter(Boolean);
          if (words.some((w) => DOWNLOADERS.has(commandName(w))) || tail.includes(".downloadstring(")) return stage[0].start;
        }
      }
    }
  }
  return -1;
}

const BASE64ISH = /^[A-Za-z0-9+/=]{20,}$/;

/**
 * R3. Detected forms:
 *  - powershell / pwsh with an encoded command: -EncodedCommand or its prefixes
 *    down to -enc, -ec, and -e / -en followed by a base64-looking argument;
 *  - base64 decoding (base64 -d, base64 --decode, openssl base64 -d) piped into
 *    a stage that runs its input as code (not into a named script, not into
 *    eval), or used as an interpreter's script ($(... | base64 -d));
 *  - eval of a command substitution: eval "$(...)", eval `...`;
 *  - node -e / python -c scripts that decode base64 and evaluate it
 *    (node: "base64" with eval(; python: b64decode with exec( or eval().
 * The payload is never decoded. Not detected: other encodings, obfuscation in
 * files the script runs, and long encoded strings without an execution link.
 */
export function encodedExecution(parsed: ParsedScript): number {
  for (const { command } of parsed.commands) {
    for (const segment of command) {
      for (let i = 0; i < segment.length; i++) {
        const stage = segment[i];
        const h = head(stage);
        if (!h) continue;
        const args = stage.slice(h.index + 1);
        if (h.name === "powershell" || h.name === "pwsh") {
          for (let k = 0; k < args.length; k++) {
            const v = args[k].value.toLowerCase();
            if (v.length < 2 || (v[0] !== "-" && v[0] !== "/")) continue;
            const opt = v.slice(1);
            if (opt === "ec" || (opt.length >= 3 && "encodedcommand".startsWith(opt))) return stage[0].start;
            if ((opt === "e" || opt === "en") && BASE64ISH.test(args[k + 1]?.value ?? "")) return stage[0].start;
          }
        }
        if (isBase64Decode(stage) && segment.slice(i + 1).some(executesStdin)) return stage[0].start;
        if (h.name === "eval" && args.some((w) => w.subs.length > 0)) return stage[0].start;
        for (const sub of programSubstitutions(stage)) {
          const nested = parse(sub.text, sub.start);
          if (nested.some((seg) => seg.some(isBase64Decode))) return stage[0].start;
        }
        if (h.name === "node" || h.name === "python" || h.name === "python3") {
          // Only the interpreter's own options, before a script or module: what follows belongs to that program.
          const program = evaluatedProgram(h.name, args);
          const text = program?.toLowerCase() ?? "";
          if (h.name === "node" && text.includes("base64") && text.includes("eval(")) return stage[0].start;
          if (h.name !== "node" && text.includes("b64decode") && (text.includes("exec(") || text.includes("eval("))) return stage[0].start;
        }
      }
    }
  }
  return -1;
}

const ROOT_TARGETS = new Set(["/", "/*", "/.", "\\", "\\*"]);
const DRIVE_ROOT = /^[a-z]:[\\/]?\*?$/;
const HOME_PREFIXES = ["~", "$home", "${home}", "%userprofile%", "%homepath%", "%homedrive%%homepath%", "$env:userprofile", "$env:home", "%appdata%", "%localappdata%", "$env:appdata", "$env:localappdata"];
const SYSTEM_PREFIXES = ["/etc", "/usr", "/bin", "/sbin", "/boot", "/lib", "/lib64", "/var", "/opt", "/home", "/users", "/root", "/system", "/library", "/private"];
const WINDOWS_SYSTEM = /^[a-z]:\/(windows|program files|program files \(x86\)|programdata|users)(\/|$)/;

function hasPrefix(path: string, prefix: string): boolean {
  return path === prefix || path.startsWith(`${prefix}/`) || path.startsWith(`${prefix}\\`);
}

/** Where a delete target points, if that is clear from its text alone. */
export function externalTarget(raw: string, packageDepth: number, cwdUnknown: boolean): "root" | "home" | "system" | "outside-repository" | null {
  const v = raw.toLowerCase();
  if (ROOT_TARGETS.has(v) || DRIVE_ROOT.test(v)) return "root";
  if (HOME_PREFIXES.some((p) => hasPrefix(v, p))) return "home";
  const slashed = v.replace(/\\/g, "/");
  if (SYSTEM_PREFIXES.some((p) => hasPrefix(slashed, p)) || WINDOWS_SYSTEM.test(slashed)) return "system";
  if (cwdUnknown) return null;
  // Relative to the package folder: escapes the repository only with more "../" than the package is deep.
  let ups = 0;
  for (const part of slashed.split("/")) {
    if (part === "..") ups++;
    else if (part !== "." && part !== "") break;
  }
  return ups > packageDepth ? "outside-repository" : null;
}

function recursiveFlag(option: string): boolean {
  const v = option.toLowerCase();
  if (v === "--recursive") return true;
  if (/^-[a-z]{1,3}$/.test(v) && v.includes("r")) return true; // -r, -rf, -fr, -Rf
  return v.length >= 4 && v.startsWith("-rec") && "-recurse".startsWith(v);
}

const CHANGES_DIRECTORY = new Set(["cd", "pushd", "set-location", "sl", "chdir"]);

/**
 * R4. Detected: a recursive delete whose target is a filesystem or drive root,
 * a home or user-profile folder (~, $HOME, %USERPROFILE%, %APPDATA%, $env:...),
 * a system folder (/etc, /usr, /home, C:\Windows, C:\Users, ...), or a
 * relative path with more "../" than the package is deep inside the repository
 * (only when nothing earlier in the command changes directory). Commands:
 * rm -r/-rf/--recursive, rimraf, del or erase /s, rd or rmdir /s,
 * Remove-Item / ri -Recurse. Not detected: targets given by variables, other
 * absolute paths (/tmp/..., D:\data), deletes through other tools or files.
 */
export function destructiveOutsideProject(parsed: ParsedScript, packageDepth: number): number {
  for (const { command, depth } of parsed.commands) {
    let cwdUnknown = depth > 0; // a nested script may run anywhere
    for (const segment of command) {
      for (const stage of segment) {
        const h = head(stage);
        if (!h) continue;
        if (CHANGES_DIRECTORY.has(h.name)) cwdUnknown = true;
        const args = stage.slice(h.index + 1).map((w) => w.value);
        let recursive = false;
        let targets: string[] = [];
        if (h.name === "rm" || h.name === "remove-item" || h.name === "ri") {
          const end = args.indexOf("--");
          const opts = end < 0 ? args : args.slice(0, end);
          recursive = opts.some((a) => a.startsWith("-") && recursiveFlag(a));
          targets = [...opts.filter((a) => !a.startsWith("-")), ...(end < 0 ? [] : args.slice(end + 1))];
        } else if (h.name === "rimraf") {
          recursive = true;
          targets = args.filter((a) => !a.startsWith("-"));
        } else if (h.name === "del" || h.name === "erase" || h.name === "rd" || h.name === "rmdir") {
          recursive = args.some((a) => a.toLowerCase() === "/s");
          targets = args.filter((a) => !/^\/[a-z]$/i.test(a));
        }
        if (recursive && targets.some((t) => externalTarget(t, packageDepth, cwdUnknown) !== null)) return stage[0].start;
      }
    }
  }
  return -1;
}

/**
 * R5. Literal references (case-insensitive, either slash) to: an .ssh folder
 * under a home or user profile, SSH private keys (id_rsa, id_ed25519,
 * id_ecdsa, id_dsa; not .pub), .aws/credentials under a home, .git-credentials,
 * a user-level .npmrc (under a home, never a bare project .npmrc),
 * .config/gcloud or %APPDATA%\gcloud, and browser profile stores (Chrome or
 * Edge "User Data" / "Login Data", .config/google-chrome, Firefox profiles).
 * The whole command text is searched, quoted or not: a reference is reported
 * as a reference, never as proof that anything is read or sent.
 */
const CREDENTIAL_PATTERNS: readonly RegExp[] = [
  // An .ssh folder under a home or user profile.
  /(?:~|\$home|\$\{home\}|%userprofile%|%homepath%|\$env:userprofile|\$env:home|\/home\/[^/\s"']+|\/users\/[^/\s"']+|\/root|[a-z]:\/users\/[^/\s"']+)\/\.ssh(?:\/|\b)/,
  // SSH private keys (not the .pub public keys).
  /(?:^|[/\s"'=])id_(?:rsa|ed25519|ecdsa|dsa)(?![\w.-]*\.pub)(?![\w-])/,
  // AWS credentials under a home.
  /(?:~|\$home|\$\{home\}|%userprofile%|%homepath%|\$env:userprofile|\$env:home|\/home\/[^/\s"']+|\/users\/[^/\s"']+|\/root|[a-z]:\/users\/[^/\s"']+)\/\.aws\/credentials\b/,
  /\.git-credentials\b/,
  // A user-level .npmrc (a bare .npmrc is the project's own).
  /(?:~|\$home|\$\{home\}|%userprofile%|%homepath%|\$env:userprofile|\$env:home|\/home\/[^/\s"']+|\/users\/[^/\s"']+|\/root|[a-z]:\/users\/[^/\s"']+)\/\.npmrc\b/,
  /\.config\/gcloud\b|%appdata%\/gcloud\b|\$env:appdata\/gcloud\b/,
  /(?:google\/chrome|microsoft\/edge|brave-browser|bravesoftware\/brave-browser)\/user data\b|\/login data\b|\.config\/(?:google-chrome|chromium)\b|mozilla\/firefox\/profiles\b|\.mozilla\/firefox\b|library\/application support\/(?:google\/chrome|firefox)\b/,
];

export function credentialPath(text: string): number {
  const normalized = text.slice(0, MAX_COMMAND_TEXT).toLowerCase().replace(/\\/g, "/");
  let first = -1;
  for (const pattern of CREDENTIAL_PATTERNS) {
    const m = pattern.exec(normalized);
    if (m && (first < 0 || m.index < first)) first = m.index;
  }
  return first;
}

export const RULE_ORDER: readonly SafetyRuleId[] = ["install-script", "download-execute", "encoded-execution", "destructive-outside-project", "credential-path"];
