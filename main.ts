// main.ts is mend, the CLI SPEC.md specifies, and this is the kit's starting point for it (MIT). It does sections 1 to 4, 9 and 10 of SPEC.md: the command line, the output and
// exit codes, safe paths, format detection, JSON edits and the all-or-nothing write. The other three formats are
// detected and then read as holding no edit, so they answer `error: parse 1`: reading unified diffs (section 6),
// SEARCH/REPLACE blocks (section 7) and V4A patches (section 8), and matching lines at three tiers (section 5), are
// yours to write. Node 22, the standard library alone; run it as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to runner.ts
// (the last lines below): keep that hand-over and runner.ts as they are, and write the CLI.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  /** [old, new] pairs of move edits that succeeded, for the `R` output lines. */
  readonly moves: [string, string][] = [];
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

/** Section 3: a file's lines, its line break and whether it ends with one. */
interface FileText {
  br: string;
  lines: string[];
  final: boolean;
}

function splitFile(text: string): FileText {
  if (text === '') return { br: '\n', lines: [], final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const final = text.endsWith(br);
  if (final) parts.pop();
  return { br, lines: parts, final };
}

function joinFile(f: FileText): string {
  if (f.lines.length === 0) return '';
  return f.lines.join(f.br) + (f.final ? f.br : '');
}

/** Section 5: the three matching tiers. */
const trimEndWs = (s: string): string => s.replace(/[ \t]+$/, '');
const trimBothWs = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
const leadWs = (s: string): string => (/^[ \t]*/.exec(s) ?? [''])[0]!;
const onlyWs = (s: string): boolean => s !== '' && /^[ \t]+$/.test(s);

function lineEq(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return trimEndWs(a) === trimEndWs(b);
  return trimBothWs(a) === trimBothWs(b);
}

function occurrences(O: string[], lines: string[], tier: number, from: number): number[] {
  const out: number[] = [];
  if (O.length === 0) return out;
  for (let i = from; i + O.length <= lines.length; i++) {
    let ok = true;
    for (let k = 0; k < O.length; k++) {
      if (!lineEq(O[k]!, lines[i + k]!, tier)) { ok = false; break; }
    }
    if (ok) out.push(i);
  }
  return out;
}

function firstTier(O: string[], lines: string[], strict: boolean, from: number): { tier: number; occ: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const occ = occurrences(O, lines, t, from);
    if (occ.length > 0) return { tier: t, occ };
  }
  return null;
}

/** One body line of a unified hunk or a V4A chunk: context, old, or new. */
interface BodyLine {
  kind: ' ' | '-' | '+';
  text: string;
}

/** What N writes in place of the matched O at `at`: a context line is the file's own matched line, and at tier 2 every other line is re-indented from O's first line to the file's first matched line. */
function replacement(body: BodyLine[], fileLines: string[], at: number, tier: number): string[] {
  const O = body.filter((b) => b.kind !== '+').map((b) => b.text);
  const F = leadWs(fileLines[at] ?? '');
  const P = leadWs(O[0] ?? '');
  const out: string[] = [];
  let o = 0;
  for (const b of body) {
    if (b.kind === ' ') { out.push(fileLines[at + o]!); o += 1; }
    else if (b.kind === '-') { o += 1; }
    else {
      let t = b.text;
      if (tier === 2 && t !== '' && !onlyWs(t) && t.startsWith(P)) t = F + t.slice(P.length);
      out.push(t);
    }
  }
  return out;
}

/** A new line of a SEARCH/REPLACE block, re-indented at tier 2 the way section 5 says. */
function reindent(t: string, tier: number, F: string, P: string): string {
  if (tier === 2 && t !== '' && !onlyWs(t) && t.startsWith(P)) return F + t.slice(P.length);
  return t;
}

/** Section 6: one hunk of a unified diff. */
interface Hunk {
  /** A from `@@ -A[,B] +C[,D] @@`, the 1-based old start. */
  a: number;
  body: BodyLine[];
  /** A `\` line follows the hunk's last context or `+` line. */
  noEol: boolean;
  /** A `\` line follows the hunk's last `+` line. */
  plusNoEol: boolean;
}

interface Section {
  dgOld: string | null;
  dgNew: string | null;
  pairOld: string | null | undefined;
  pairNew: string | null | undefined;
  renameFrom: string | null;
  renameTo: string | null;
  create: boolean;
  del: boolean;
  hunks: Hunk[];
}

function headerPath(s: string): string | null {
  const t = s.slice(4).split('\t')[0]!.trim();
  if (t === '/dev/null') return null;
  return t.startsWith('a/') || t.startsWith('b/') ? t.slice(2) : t;
}

function diffGitPaths(l: string): [string, string] | null {
  if (!l.startsWith('diff --git ')) return null;
  const rest = l.slice('diff --git '.length).trimEnd();
  if (!rest.startsWith('a/')) return null;
  const i = rest.indexOf(' b/');
  if (i < 0) return null;
  const x = rest.slice(2, i);
  const y = rest.slice(i + 3);
  if (x === '' || y === '') return null;
  return [x, y];
}

function hunkHead(l: string): number | null {
  const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(l);
  return m === null ? null : Number(m[1]);
}

/** Parse one hunk starting at lines[i] (a line starting with `@@`); return the hunk and the index after its body. */
function parseHunk(lines: string[], i: number): { hunk: Hunk; next: number } {
  const a = hunkHead(lines[i]!);
  if (a === null) throw new Exit2(`error: parse ${i + 1}`);
  // Body lines, keeping `\` lines so the final-break rules can see them.
  const raw: (BodyLine | '\\')[] = [];
  let j = i + 1;
  while (j < lines.length) {
    const b = lines[j]!;
    if (b.startsWith('diff --git ')) break;
    if (b.startsWith('--- ') && (lines[j + 1] ?? '').startsWith('+++ ')) break;
    if (b === '') raw.push({ kind: ' ', text: '' });
    else if (b.startsWith(' ')) raw.push({ kind: ' ', text: b.slice(1) });
    else if (b.startsWith('-')) raw.push({ kind: '-', text: b.slice(1) });
    else if (b.startsWith('+')) raw.push({ kind: '+', text: b.slice(1) });
    else if (b.startsWith('\\')) raw.push('\\');
    else break;
    j += 1;
  }
  // Empty lines at the end of a body are not part of it.
  while (raw.length > 0) {
    const last = raw[raw.length - 1]!;
    if (last !== '\\' && last.kind === ' ' && last.text === '') raw.pop();
    else break;
  }
  // A `\` line follows the hunk's last context or `+` line, and whether one follows its last `+` line.
  let noEol = false;
  let plusNoEol = false;
  for (let k = raw.length - 1; k >= 0; k--) {
    const e = raw[k]!;
    if (e === '\\' || e.kind === '-') continue;
    noEol = raw[k + 1] === '\\';
    break;
  }
  for (let k = raw.length - 1; k >= 0; k--) {
    const e = raw[k]!;
    if (e === '\\' || e.kind !== '+') continue;
    plusNoEol = raw[k + 1] === '\\';
    break;
  }
  const body = raw.filter((e): e is BodyLine => e !== '\\');
  return { hunk: { a, body, noEol, plusNoEol }, next: j };
}

/** Apply a section's hunks in order to a file's lines. */
function applyHunks(hunks: Hunk[], f: FileText, strict: boolean, path: string): void {
  let d = 0;
  for (const h of hunks) {
    const O = h.body.filter((b) => b.kind !== '+').map((b) => b.text);
    if (O.length === 0) {
      const ins = h.body.filter((b) => b.kind === '+').map((b) => b.text);
      const pos = Math.min(h.a + d, f.lines.length);
      const atEnd = pos === f.lines.length;
      f.lines.splice(pos, 0, ...ins);
      if (atEnd) f.final = !h.noEol;
      d += ins.length;
      continue;
    }
    const found = firstTier(O, f.lines, strict, 0);
    if (found === null) throw new Fail('no-match', path);
    const target = h.a - 1 + d;
    let at = found.occ[0]!;
    let best = Math.abs(at - target);
    for (const p of found.occ) {
      const dist = Math.abs(p - target);
      if (dist < best) { at = p; best = dist; }
    }
    const runsToEnd = at + O.length === f.lines.length;
    const rep = replacement(h.body, f.lines, at, found.tier);
    f.lines.splice(at, O.length, ...rep);
    if (runsToEnd) f.final = !h.noEol;
    d += rep.length - O.length;
  }
}

function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  const sections: Section[] = [];
  const start = (dgOld: string | null, dgNew: string | null, pairOld: string | null | undefined, pairNew: string | null | undefined): Section => {
    const s: Section = { dgOld, dgNew, pairOld, pairNew, renameFrom: null, renameTo: null, create: false, del: false, hunks: [] };
    sections.push(s);
    return s;
  };
  let cur: Section | null = null;
  let inHeader = false;
  let i = 0;
  while (i < lines.length) {
    const l = lines[i]!;
    if (l.startsWith('diff --git ')) {
      const dg = diffGitPaths(l);
      if (dg === null) throw new Exit2(`error: parse ${i + 1}`);
      cur = start(dg[0], dg[1], undefined, undefined);
      inHeader = true;
      i += 1;
      continue;
    }
    if (cur === null) {
      if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
        cur = start(null, null, headerPath(l), headerPath(lines[i + 1]!));
        inHeader = true;
        i += 2;
        continue;
      }
      if (l.startsWith('@@')) throw new Exit2(`error: parse ${i + 1}`);
      i += 1;
      continue;
    }
    if (inHeader) {
      if (l.startsWith('--- ')) {
        if ((lines[i + 1] ?? '').startsWith('+++ ')) {
          if (cur.pairOld === undefined) {
            cur.pairOld = headerPath(l);
            cur.pairNew = headerPath(lines[i + 1]!);
            i += 2;
            continue;
          }
          cur = start(null, null, headerPath(l), headerPath(lines[i + 1]!));
          inHeader = true;
          i += 2;
          continue;
        }
        throw new Exit2(`error: parse ${i + 2}`);
      }
      if (l.startsWith('@@')) {
        const r = parseHunk(lines, i);
        cur.hunks.push(r.hunk);
        i = r.next;
        inHeader = false;
        continue;
      }
      if (l.startsWith('rename from ')) { cur.renameFrom = l.slice('rename from '.length).trim(); i += 1; continue; }
      if (l.startsWith('rename to ')) { cur.renameTo = l.slice('rename to '.length).trim(); i += 1; continue; }
      if (l.startsWith('new file mode')) { cur.create = true; i += 1; continue; }
      if (l.startsWith('deleted file mode')) { cur.del = true; i += 1; continue; }
      i += 1;
      continue;
    }
    if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      cur = start(null, null, headerPath(l), headerPath(lines[i + 1]!));
      inHeader = true;
      i += 2;
      continue;
    }
    if (l.startsWith('@@')) {
      const r = parseHunk(lines, i);
      cur.hunks.push(r.hunk);
      i = r.next;
      continue;
    }
    i += 1;
  }
  if (sections.length === 0) throw new Exit2('error: parse 1');
  return sections.map((s) => {
    const oldP = s.pairOld !== undefined ? s.pairOld : (s.renameFrom ?? s.dgOld);
    const newP = s.pairNew !== undefined ? s.pairNew : (s.renameTo ?? s.dgNew);
    const kind = s.create || oldP === null ? 'create' : s.del || newP === null ? 'delete' : oldP !== newP ? 'move' : 'change';
    return (tree: Tree) => {
      if (oldP !== null && !safe(oldP)) throw new Fail('unsafe', oldP);
      if (newP !== null && !safe(newP)) throw new Fail('unsafe', newP);
      if (kind === 'create') {
        if (newP === null) return;
        if (tree.get(newP) !== null) throw new Fail('exists', newP);
        const made: string[] = [];
        for (const h of s.hunks) for (const b of h.body) if (b.kind === '+') made.push(b.text);
        let final = true;
        for (let hi = s.hunks.length - 1; hi >= 0; hi--) {
          const h = s.hunks[hi]!;
          if (h.body.some((b) => b.kind === '+')) { final = !h.plusNoEol; break; }
        }
        tree.now.set(newP, joinFile({ br: '\n', lines: made, final }));
        return;
      }
      if (kind === 'delete') {
        if (oldP === null) return;
        if (tree.get(oldP) === null) throw new Fail('missing', oldP);
        tree.now.set(oldP, null);
        return;
      }
      const before = tree.get(oldP!);
      if (before === null) throw new Fail('missing', oldP!);
      if (kind === 'move' && tree.get(newP!) !== null) throw new Fail('exists', newP!);
      const f = splitFile(before);
      applyHunks(s.hunks, f, strict, oldP!);
      const out = joinFile(f);
      if (kind === 'move') {
        tree.now.set(oldP!, null);
        tree.now.set(newP!, out);
        tree.moves.push([oldP!, newP!]);
      } else {
        tree.now.set(oldP!, out);
      }
    };
  });
}

/** Section 7: SEARCH/REPLACE blocks. */
function searchReplaceEdits(lines: string[], strict: boolean): Edit[] {
  interface Block { path: string; oldLines: string[]; newLines: string[]; }
  const blocks: Block[] = [];
  let prevEnd = 0;
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') { i += 1; continue; }
    const searchIdx = i;
    let path: string | null = null;
    for (let j = searchIdx - 1; j >= prevEnd; j--) {
      const l = lines[j]!;
      if (blank(l)) continue;
      const t = l.trim();
      if (t.startsWith('```')) continue;
      path = t;
      break;
    }
    if (path === null) {
      if (prevPath === null) throw new Exit2(`error: parse ${searchIdx + 1}`);
      path = prevPath;
    }
    let eq = -1;
    for (let j = searchIdx + 1; j < lines.length; j++) {
      const t = lines[j]!.trimEnd();
      if (t === '=======') { eq = j; break; }
      if (t === '>>>>>>> REPLACE') break;
    }
    if (eq < 0) throw new Exit2(`error: parse ${searchIdx + 1}`);
    let rp = -1;
    for (let j = eq + 1; j < lines.length; j++) {
      if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') { rp = j; break; }
    }
    blocks.push({
      path,
      oldLines: lines.slice(searchIdx + 1, eq),
      newLines: rp < 0 ? lines.slice(eq + 1) : lines.slice(eq + 1, rp),
    });
    prevPath = path;
    prevEnd = rp < 0 ? lines.length : rp + 1;
    i = prevEnd;
  }
  if (blocks.length === 0) throw new Exit2('error: parse 1');
  return blocks.map((b) => (tree: Tree) => {
    if (!safe(b.path)) throw new Fail('unsafe', b.path);
    if (b.oldLines.length === 0) {
      if (tree.get(b.path) !== null) throw new Fail('exists', b.path);
      tree.now.set(b.path, joinFile({ br: '\n', lines: [...b.newLines], final: true }));
      return;
    }
    const before = tree.get(b.path);
    if (before === null) throw new Fail('missing', b.path);
    const f = splitFile(before);
    const found = firstTier(b.oldLines, f.lines, strict, 0);
    if (found === null) throw new Fail('no-match', b.path);
    if (found.occ.length > 1) throw new Fail('ambiguous', b.path);
    const at = found.occ[0]!;
    const F = leadWs(f.lines[at] ?? '');
    const P = leadWs(b.oldLines[0] ?? '');
    const rep = b.newLines.map((t) => reindent(t, found.tier, F, P));
    f.lines.splice(at, b.oldLines.length, ...rep);
    tree.now.set(b.path, joinFile(f));
  });
}

/** Section 8: V4A patches. */
function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = lines.length - 1;
  while (last >= 0 && blank(lines[last]!)) last -= 1;
  if (last < 0 || lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const isSectionStart = (l: string): boolean => l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ');
  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    if (blank(lines[i]!)) { i += 1; continue; }
    const l = lines[i]!;
    if (!isSectionStart(l)) throw new Exit2(`error: parse ${i + 1}`);
    const isAdd = l.startsWith('*** Add File: ');
    const isDel = l.startsWith('*** Delete File: ');
    const path = l.slice((isAdd ? '*** Add File: ' : isDel ? '*** Delete File: ' : '*** Update File: ').length).trim();
    const start = i + 1;
    let j = start;
    while (j < last && !isSectionStart(lines[j]!)) j += 1;
    let end = j;
    while (end > start && blank(lines[end - 1]!)) end -= 1;
    const secLines = lines.slice(start, end);
    if (isAdd) {
      for (let k = 0; k < secLines.length; k++) {
        const sl = secLines[k]!;
        if (!(sl.startsWith('+') || sl === '')) throw new Exit2(`error: parse ${start + k + 1}`);
      }
      const made = secLines.map((sl) => (sl === '' ? '' : sl.slice(1)));
      edits.push((tree) => {
        if (!safe(path)) throw new Fail('unsafe', path);
        if (tree.get(path) !== null) throw new Fail('exists', path);
        tree.now.set(path, joinFile({ br: '\n', lines: made, final: true }));
      });
    } else if (isDel) {
      for (let k = 0; k < secLines.length; k++) {
        if (!blank(secLines[k]!)) throw new Exit2(`error: parse ${start + k + 1}`);
      }
      edits.push((tree) => {
        if (!safe(path)) throw new Fail('unsafe', path);
        if (tree.get(path) === null) throw new Fail('missing', path);
        tree.now.set(path, null);
      });
    } else {
      let k = 0;
      let moveTo: string | null = null;
      if (secLines.length > 0 && secLines[0]!.startsWith('*** Move to: ')) {
        moveTo = secLines[0]!.slice('*** Move to: '.length).trim();
        k = 1;
      }
      interface Chunk { anchor: string | null; body: BodyLine[]; eof: boolean; }
      const chunks: Chunk[] = [];
      let cur: Chunk | null = null;
      const close = (): void => { if (cur !== null) { chunks.push(cur); cur = null; } };
      while (k < secLines.length) {
        const sl = secLines[k]!;
        if (sl.startsWith('@@')) {
          close();
          const anchor = sl.slice(2).trim();
          cur = { anchor: anchor === '' ? null : anchor, body: [], eof: false };
          k += 1;
          continue;
        }
        if (sl.trimEnd() === '*** End of File') {
          if (cur === null) cur = { anchor: null, body: [], eof: true };
          else cur.eof = true;
          close();
          k += 1;
          continue;
        }
        if (sl === '' || sl.startsWith(' ') || sl.startsWith('-') || sl.startsWith('+')) {
          if (cur === null) cur = { anchor: null, body: [], eof: false };
          cur.body.push(sl === '' ? { kind: ' ', text: '' } : sl.startsWith(' ') ? { kind: ' ', text: sl.slice(1) } : sl.startsWith('-') ? { kind: '-', text: sl.slice(1) } : { kind: '+', text: sl.slice(1) });
          k += 1;
          continue;
        }
        throw new Exit2(`error: parse ${start + k + 1}`);
      }
      close();
      if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${i + 1}`);
      edits.push((tree) => {
        if (!safe(path)) throw new Fail('unsafe', path);
        if (moveTo !== null && !safe(moveTo)) throw new Fail('unsafe', moveTo);
        const before = tree.get(path);
        if (before === null) throw new Fail('missing', path);
        if (moveTo !== null && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
        const f = splitFile(before);
        let cursor = 0;
        for (const ch of chunks) {
          if (ch.anchor !== null) {
            const af = firstTier([ch.anchor], f.lines, strict, cursor);
            if (af === null) throw new Fail('no-match', path);
            cursor = af.occ[0]! + 1;
          }
          const O = ch.body.filter((b) => b.kind !== '+').map((b) => b.text);
          if (O.length === 0) {
            const ins = ch.body.filter((b) => b.kind === '+').map((b) => b.text);
            const pos = ch.eof ? f.lines.length : cursor;
            f.lines.splice(pos, 0, ...ins);
            cursor = pos + ins.length;
            continue;
          }
          const found = firstTier(O, f.lines, strict, cursor);
          if (found === null) throw new Fail('no-match', path);
          let occ = found.occ;
          if (ch.eof) occ = occ.filter((p) => p + O.length === f.lines.length);
          if (occ.length === 0) throw new Fail('no-match', path);
          const at = occ[0]!;
          const rep = replacement(ch.body, f.lines, at, found.tier);
          f.lines.splice(at, O.length, ...rep);
          cursor = at + rep.length;
        }
        const out = joinFile(f);
        if (moveTo !== null) {
          tree.now.set(path, null);
          tree.now.set(moveTo, out);
          tree.moves.push([path, moveTo]);
        } else {
          tree.now.set(path, out);
        }
      });
    }
    i = j;
  }
  if (edits.length === 0) throw new Exit2('error: parse 1');
  return edits;
}

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    edits =
      kind === 'json' ? jsonEdits(text, lines)
      : kind === 'unified' ? unifiedEdits(lines, strict)
      : kind === 'search-replace' ? searchReplaceEdits(lines, strict)
      : v4aEdits(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const outRows: { key: string; line: string }[] = [];
  const covered = new Set<string>();
  for (const [oldP, newP] of tree.moves) {
    if (tree.original(oldP) !== null && tree.get(oldP) === null && tree.original(newP) === null && tree.get(newP) !== null) {
      outRows.push({ key: newP, line: `R ${oldP} -> ${newP}` });
      covered.add(oldP);
      covered.add(newP);
    }
  }
  for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
    if (covered.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    outRows.push({ key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  if (!check) {
    for (const p of [...tree.now.keys()]) {
      const was = tree.original(p);
      const now = tree.now.get(p)!;
      if (was === now) continue;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  outRows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  const rows = outRows.map((r) => r.line);
  return { code: 0, out: [...rows, `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
}


const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
