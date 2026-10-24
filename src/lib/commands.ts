// Link parsing, file classification and Colab command generation.
// Pure functions only — the UI in src/routes/index.tsx feeds them state.

export type Kind = 'zip' | 'movie' | 'series' | 'other'
export type CopyMode = 'all' | 'group' | 'single'
// Command type chooser: "auto" detects per link, the rest force every link into one type.
export type ForceKind = 'auto' | 'wget' | 'zip' | 'rar' | 'split' | 'plain'

export interface LinkItem {
  id: string
  url: string
  name: string
  hasQuery: boolean
  failed: boolean
  type: Kind
  disp: string
  sk?: string
  bk?: string
  loose?: boolean
}

export interface Settings {
  commands: boolean
  comments: boolean
  names: boolean
  moviesAlone: boolean
  parallel: boolean
  looseSeriesPlain: boolean
  dedupe: boolean
  mode: CopyMode
  kind: ForceKind
  workers: number
}

export const DEFAULT_SETTINGS: Settings = {
  commands: true,
  comments: false,
  names: false,
  moviesAlone: true,
  parallel: true,
  looseSeriesPlain: true,
  dedupe: true,
  mode: 'all',
  kind: 'auto',
  workers: 15,
}

export interface Group {
  type: Kind
  label: string
  members: LinkItem[]
}

export interface Cell {
  label: string
  text: string
  kind: string
  ids: string[]
}

export const TAG: Record<Kind, string> = {
  zip: 'ZIP',
  movie: 'MOV',
  series: 'SER',
  other: 'OTH',
}
const ORDER: Kind[] = ['zip', 'movie', 'series', 'other']
const MIN_EPS = 3 // a season needs MORE than this many episodes to get its own group
export const collator = new Intl.Collator(undefined, {
  numeric: true,
  sensitivity: 'base',
})

// ---------- parsing ----------

// A URL runs until whitespace/double-quote/bracket OR the start of another URL glued on
// with no space ("…a.mkvhttps://…"). "=https://" inside a query string is not a split.
// NOTE: the apostrophe is deliberately NOT a terminator — file names such as
// "Doug's Dog's Date" or "Cookin'" live in the #fragment and must stay intact.
const URL_RE = /https?:\/\/[^\s"<>]+?(?=(?<!=)https?:\/\/|[\s"<>]|$)/gi
const HAS_EXT = /\.[A-Za-z0-9]{2,5}$/

const cleanName = (s: string) =>
  String(s || '')
    // eslint-disable-next-line no-control-regex -- control characters are invalid in file names
    .replace(/[\\/\0-\x1f]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()

const safeDecode = (s: string) => {
  try {
    return decodeURIComponent(s)
  } catch {
    return s
  }
}

// A label line before a link, e.g. "3. Movie.2024.mkv" or "# Movie.2024.mkv"
const labelFrom = (s: string) => {
  const t = s.trim()
  if (!t || t.startsWith('!') || t.startsWith('<--')) return ''
  return t
    .replace(/^#+\s*/, '')
    .replace(/^\d+[.)]\s+/, '')
    .replace(/^[-*•]\s+/, '')
    .trim()
}

const queryFileName = (u: URL) => {
  for (const k of ['filename', 'file', 'fn', 'name', 'title']) {
    const v = u.searchParams.get(k)
    if (v && HAS_EXT.test(v)) return v
  }
  const cd = u.searchParams.get('response-content-disposition')
  if (cd) {
    const m = cd.match(/filename\*?=(?:UTF-8'')?"?([^";]+)/i)
    if (m) return safeDecode(m[1])
  }
  return ''
}

// The real file name. The query string never leaks into it.
export const fileNameFor = (url: string, given: string, n: number) => {
  let path = ''
  let fromQuery = ''
  let fromHash = ''
  try {
    const u = new URL(url)
    path = cleanName(safeDecode(u.pathname.split('/').pop() || ''))
    fromQuery = cleanName(queryFileName(u))
    // some hosts put the real name after '#': .../download/abc123#My.File_part01.zip
    const h = cleanName(safeDecode(u.hash.replace(/^#/, '')))
    if (HAS_EXT.test(h)) fromHash = h
  } catch {
    /* not a parseable URL: fall back to the given name or download_N */
  }
  const g = cleanName(given)
  const pick =
    g && HAS_EXT.test(g)
      ? g
      : fromQuery || fromHash || (HAS_EXT.test(path) ? path : g || path)
  return pick || `download_${n}`
}

export const parseLinks = (input: string): LinkItem[] => {
  const out: LinkItem[] = []
  let pending = ''
  input.split(/\r?\n/).forEach((line) => {
    const hits = [...line.matchAll(URL_RE)]
    if (!hits.length) {
      const l = labelFrom(line)
      if (l) pending = l
      return
    }
    const before = labelFrom(line.slice(0, hits[0].index))
    if (before && !/[|`$]/.test(before)) pending = before
    const tail = line.slice((hits.at(-1)!.index ?? 0) + hits.at(-1)![0].length)
    const failed = /<--/.test(tail)
    hits.forEach((h, k) => {
      // strip trailing punctuation, incl. a closing single quote from '…' wrapped URLs
      const url = h[0].replace(/[),;\]']+$/, '')
      let hasQuery: boolean
      try {
        hasQuery = new URL(url).search.length > 1
      } catch {
        return
      }
      const name = fileNameFor(url, k === 0 ? pending : '', out.length + 1)
      out.push({
        id: `${out.length}:${url}`,
        url,
        name,
        hasQuery,
        failed: failed && k === hits.length - 1,
        ...classify(name),
      })
    })
    pending = ''
  })
  return out
}

// ---------- classification ----------

const VID =
  /\.(mkv|mp4|avi|mov|m4v|wmv|ts|m2ts|mpg|mpeg|webm|flv|divx|vob)(?=$|\s)/i
const NONVID =
  /\.(nfo|srt|sub|idx|ass|txt|jpg|jpeg|png|gif|pdf|epub|mp3|flac|iso)$/i
const SERIES_RE = /^(.*?)[ ._-]+(S\d{1,2})[ ._-]?E\d{1,3}/i
const SERIES_ALT = /^(.*?)[ ._-]+(\d{1,2})x\d{2,3}(?![\dp])/i
const norm = (s: string) => s.replace(/[._]+/g, ' ').replace(/\s+/g, ' ').trim()
const seasonKey = (show: string, s: string) =>
  `${norm(show)} S${String(parseInt(s, 10)).padStart(2, '0')}`.trim()

export const classify = (
  name: string,
): Pick<LinkItem, 'type' | 'disp' | 'sk' | 'bk'> => {
  const n = name.trim()
  let m: RegExpMatchArray | null
  if ((m = n.match(/^(.*?)[ ._-]*part[ ._-]?0*\d+\.(zip|rar|7z)$/i)))
    return { type: 'zip', disp: norm(m[1]), bk: norm(m[1]) }
  if ((m = n.match(/^(.*)\.(zip|rar|7z|tar|gz)\.\d{2,3}$/i)))
    return { type: 'zip', disp: norm(m[1]), bk: norm(m[1]) }
  if ((m = n.match(/^(.*)\.(zip|rar|7z|tar|gz)$/i)))
    return { type: 'zip', disp: norm(m[1]), bk: norm(m[1]) }
  if ((m = n.match(/^(.*)\.(r\d{2}|z\d{2}|\d{3})$/i)))
    return { type: 'zip', disp: norm(m[1]), bk: norm(m[1]) }

  const isVid = VID.test(n)
  if (!NONVID.test(n)) {
    if ((m = n.match(SERIES_RE)))
      return {
        type: 'series',
        disp: 'Loose series',
        sk: seasonKey(m[1], m[2].slice(1)),
      }
    if (isVid && (m = n.match(SERIES_ALT)))
      return { type: 'series', disp: 'Loose series', sk: seasonKey(m[1], m[2]) }
  }
  if (isVid) return { type: 'movie', disp: 'Loose movies' }

  const base = norm(
    n
      .replace(/\.[A-Za-z0-9]{1,5}$/, '')
      .replace(/[ ._-]*(?:part|pt|cd|disc|vol)?[ ._-]*0*\d{1,3}$/i, ''),
  )
  return { type: 'other', disp: 'Other files', bk: base }
}

export const dedupeItems = (items: LinkItem[]) => {
  const seen = new Set<string>()
  let dupes = 0
  const kept = items.filter((f) => {
    const k = f.name.toLowerCase()
    if (seen.has(k)) {
      dupes++
      return false
    }
    seen.add(k)
    return true
  })
  return { kept, dupes }
}

// Groups for display and for "group by group" copying. Mutates item.loose.
export const buildGroups = (items: LinkItem[]): Group[] => {
  const sCount = new Map<string, number>()
  const bCount = new Map<string, number>()
  items.forEach((f) => {
    if (f.sk)
      sCount.set(f.sk.toLowerCase(), (sCount.get(f.sk.toLowerCase()) || 0) + 1)
    if (f.bk)
      bCount.set(f.bk.toLowerCase(), (bCount.get(f.bk.toLowerCase()) || 0) + 1)
  })
  const map = new Map<string, Group>()
  items.forEach((f) => {
    let label = f.disp
    if (f.sk && (sCount.get(f.sk.toLowerCase()) || 0) > MIN_EPS) label = f.sk
    else if (
      f.bk &&
      f.bk.length > 2 &&
      (bCount.get(f.bk.toLowerCase()) || 0) > 1
    )
      label = f.bk
    f.loose = f.type === 'series' && label === f.disp
    const key = f.type + '|' + label.toLowerCase()
    if (!map.has(key)) map.set(key, { type: f.type, label, members: [] })
    map.get(key)!.members.push(f)
  })
  return [...map.values()].sort(
    (a, b) => ORDER.indexOf(a.type) - ORDER.indexOf(b.type),
  )
}

// ---------- command templates ----------

// shell double-quote
export const dq = (s: string) =>
  '"' + String(s).replace(/(["\\$`])/g, '\\$1') + '"'

// One file. No query string -> let the server name it. Query string -> force the real name.
export const wgetOne = (
  f: Pick<LinkItem, 'url' | 'hasQuery'>,
  fileName: string,
) =>
  f.hasQuery
    ? `! wget -O ${dq(fileName)} ${dq(f.url)}`
    : `! wget --content-disposition ${dq(f.url)}`

const uniqueName = (n: string, used: Set<string>) => {
  if (!used.has(n.toLowerCase())) {
    used.add(n.toLowerCase())
    return n
  }
  const dot = n.lastIndexOf('.')
  const base = dot > 0 ? n.slice(0, dot) : n
  const ext = dot > 0 ? n.slice(dot) : ''
  let k = 2
  let c: string
  while (used.has((c = `${base} (${k})${ext}`).toLowerCase())) k++
  used.add(c.toLowerCase())
  return c
}

const pyZip = (u: string) => `import requests
import zipfile
import tempfile
import os

zip_url = ${JSON.stringify(u)}

with tempfile.NamedTemporaryFile(delete=False, suffix='.zip') as tmp_file:
    temp_zip_path = tmp_file.name
    print(f"Downloading ZIP to temporary file: {temp_zip_path}")
    with requests.get(zip_url, stream=True) as r:
        r.raise_for_status()
        for chunk in r.iter_content(chunk_size=8192):
            if chunk:
                tmp_file.write(chunk)

with zipfile.ZipFile(temp_zip_path, 'r') as zip_ref:
    extract_path = 'extracted_files'
    os.makedirs(extract_path, exist_ok=True)
    zip_ref.extractall(extract_path)
    print(f"Extracted files to: {extract_path}")

os.remove(temp_zip_path)
print("Temporary ZIP file removed.")`

const pyRar = (u: string) => `! pip install rarfile
import requests
import rarfile
import tempfile
import os

rar_url = ${JSON.stringify(u)}

with tempfile.NamedTemporaryFile(delete=False, suffix='.rar') as tmp_file:
    temp_rar_path = tmp_file.name
    print(f"Downloading RAR to temporary file: {temp_rar_path}")
    with requests.get(rar_url, stream=True) as r:
        r.raise_for_status()
        for chunk in r.iter_content(chunk_size=8192):
            if chunk:
                tmp_file.write(chunk)

extract_path = "extracted_files"
os.makedirs(extract_path, exist_ok=True)

with rarfile.RarFile(temp_rar_path) as rf:
    rf.extractall(extract_path)
    print(f"Extracted files to: {extract_path}")

os.remove(temp_rar_path)
print("Temporary RAR file removed.")`

const pyMany = (
  urls: string[],
  kind: 'zip' | 'rar',
  workers: number,
) => `${kind === 'rar' ? '! pip install rarfile\n' : ''}import os
import tempfile
import requests
${kind === 'rar' ? 'import rarfile' : 'import zipfile'}
from concurrent.futures import ThreadPoolExecutor

urls = [
${urls.map((u) => '    ' + JSON.stringify(u) + ',').join('\n')}
]

MAX_WORKERS = ${workers}
extract_path = "extracted_files"
os.makedirs(extract_path, exist_ok=True)


def download(job):
    i, url, path = job
    print(f"Downloading {i}/{len(urls)}: {url}")
    with requests.get(url, stream=True) as r:
        r.raise_for_status()
        with open(path, "wb") as f:
            for chunk in r.iter_content(chunk_size=8192):
                if chunk:
                    f.write(chunk)
    return path


with tempfile.TemporaryDirectory() as tmpdir:
    jobs = [(i, u, os.path.join(tmpdir, f"file_{i}.${kind}")) for i, u in enumerate(urls, start=1)]
    with ThreadPoolExecutor(max_workers=MAX_WORKERS) as ex:
        paths = list(ex.map(download, jobs))

    for p in paths:
        ${kind === 'rar' ? 'with rarfile.RarFile(p) as rf:\n            rf.extractall(extract_path)' : "with zipfile.ZipFile(p, 'r') as zf:\n            zf.extractall(extract_path)"}
        print(f"Extracted {os.path.basename(p)}")

print(f"Extraction complete to: {extract_path}")`

const pyMulti = (sets: string[][], workers: number) => `import os
import shutil
import subprocess
import tempfile
import requests
from concurrent.futures import ThreadPoolExecutor

# each inner list = parts of one archive, in order
zip_sets = [
${sets.map((urls) => '    [\n' + urls.map((u) => '        ' + JSON.stringify(u) + ',').join('\n') + '\n    ],').join('\n')}
]

MAX_WORKERS = ${workers}
extract_path = "extracted_files"
os.makedirs(extract_path, exist_ok=True)


def download(job):
    s, i, url, path = job
    print(f"Downloading set {s} part {i}: {url}")
    with requests.get(url, stream=True) as r:
        r.raise_for_status()
        with open(path, "wb") as f:
            for chunk in r.iter_content(chunk_size=8192):
                if chunk:
                    f.write(chunk)
    return path


with tempfile.TemporaryDirectory() as tmpdir:
    part_file = lambda s, i: os.path.join(tmpdir, f"set{s}.zip.{i:03d}")

    jobs = [
        (s, i, url, part_file(s, i))
        for s, urls in enumerate(zip_sets, start=1)
        for i, url in enumerate(urls, start=1)
    ]
    with ThreadPoolExecutor(max_workers=MAX_WORKERS) as ex:
        list(ex.map(download, jobs))

    for s, urls in enumerate(zip_sets, start=1):
        combined_zip_path = os.path.join(tmpdir, f"set{s}.zip")
        print(f"Combining {len(urls)} parts of set {s}")
        with open(combined_zip_path, "wb") as out_f:
            for i in range(1, len(urls) + 1):
                with open(part_file(s, i), "rb") as in_f:
                    shutil.copyfileobj(in_f, out_f)

        result = subprocess.run(
            ["7z", "x", combined_zip_path, f"-o{extract_path}", "-y"],
            capture_output=True,
            text=True,
        )
        if result.stdout:
            print(result.stdout)
        if result.stderr:
            print(result.stderr)

        if result.returncode == 0:
            print(f"Set {s}: extraction complete to {extract_path}")
        else:
            print(f"Set {s}: 7z extraction failed with return code {result.returncode}")`

export const cmdKind = (f: LinkItem) =>
  /\.(zip|rar|7z|tar|gz)\.\d{2,3}$/i.test(f.name)
    ? 'multi'
    : /\.zip$/i.test(f.name)
      ? 'zip'
      : /\.rar$/i.test(f.name)
        ? 'rar'
        : 'wget'

// ---------- cells ----------

// Turn a set of links into one or more Colab cells.
export const fmt = (
  members: LinkItem[],
  s: Settings,
  pos: Map<string, number>,
): Cell[] => {
  const line = (f: LinkItem) =>
    s.names ? `${pos.get(f.id) ?? ''}. ${f.name}\n${f.url}\n` : f.url
  const cm = (ns: string[]) =>
    s.comments
      ? ns.map((n) => '# ' + n.replace(/\s+/g, ' ').trim()).join('\n') + '\n'
      : ''

  if (!s.commands || s.kind === 'plain') {
    return [
      {
        label: `${members.length} link(s)`,
        text: members.map(line).join('\n'),
        kind: 'plain',
        ids: members.map((f) => f.id),
      },
    ]
  }

  const cells: Cell[] = []
  const plain: LinkItem[] = []
  const wg: { f: LinkItem; fn: string }[] = []
  const movies: { f: LinkItem; fn: string }[] = []
  const zips: LinkItem[] = []
  const rars: LinkItem[] = []
  const multi = new Map<string, { base: string; parts: LinkItem[] }>()
  const used = new Set<string>()
  const forced = s.kind !== 'auto'

  members.forEach((f) => {
    // When a command type is forced, every link goes into that type.
    if (!forced && (f.failed || (s.looseSeriesPlain && f.loose)))
      return void plain.push(f)
    const k = forced ? (s.kind === 'split' ? 'multi' : s.kind) : cmdKind(f)
    if (k === 'multi') {
      // forced split: all selected links form ONE archive set, in order
      const base = (forced ? members[0] : f).name.replace(/\.\d{2,3}$/, '')
      const b = forced ? '__all__' : base.toLowerCase()
      if (!multi.has(b)) multi.set(b, { base, parts: [] })
      multi.get(b)!.parts.push(f)
    } else if (k === 'zip') zips.push(f)
    else if (k === 'rar') rars.push(f)
    else {
      const entry = { f, fn: uniqueName(f.name, used) }
      if (s.moviesAlone && f.type === 'movie') movies.push(entry)
      else wg.push(entry)
    }
  })

  if (multi.size) {
    const sets = [...multi.entries()]
      .sort((a, b) => collator.compare(a[0], b[0]))
      .map(([, v]) => v)
    // forced split keeps the pasted/sorted order; auto sorts parts by name
    if (!forced)
      sets.forEach((v) =>
        v.parts.sort((a, b) => collator.compare(a.name, b.name)),
      )
    cells.push({
      label: `${sets.length} split archive set(s)`,
      kind: 'split',
      text:
        cm(sets.map((v) => v.base)) +
        pyMulti(
          sets.map((v) => v.parts.map((p) => p.url)),
          s.workers,
        ),
      ids: sets.flatMap((v) => v.parts.map((p) => p.id)),
    })
  }
  if (zips.length === 1)
    cells.push({
      label: zips[0].name,
      kind: 'zip',
      text: cm([zips[0].name]) + pyZip(zips[0].url),
      ids: [zips[0].id],
    })
  else if (zips.length > 1)
    cells.push({
      label: `${zips.length} zips`,
      kind: 'zip',
      text:
        cm(zips.map((x) => x.name)) +
        pyMany(
          zips.map((x) => x.url),
          'zip',
          s.workers,
        ),
      ids: zips.map((x) => x.id),
    })
  if (rars.length === 1)
    cells.push({
      label: rars[0].name,
      kind: 'rar',
      text: cm([rars[0].name]) + pyRar(rars[0].url),
      ids: [rars[0].id],
    })
  else if (rars.length > 1)
    cells.push({
      label: `${rars.length} rars`,
      kind: 'rar',
      text:
        cm(rars.map((x) => x.name)) +
        pyMany(
          rars.map((x) => x.url),
          'rar',
          s.workers,
        ),
      ids: rars.map((x) => x.id),
    })

  // movies: each one in a cell by itself
  movies.forEach(({ f, fn }) =>
    cells.push({
      label: f.name,
      kind: 'movie',
      text: cm([f.name]) + wgetOne(f, fn),
      ids: [f.id],
    }),
  )

  if (wg.length === 1) {
    const { f, fn } = wg[0]
    cells.push({
      label: f.name,
      kind: 'wget',
      text: cm([f.name]) + wgetOne(f, fn),
      ids: [f.id],
    })
  } else if (wg.length > 1) {
    let text: string
    if (s.parallel) {
      const q = wg.filter((x) => x.f.hasQuery)
      const nq = wg.filter((x) => !x.f.hasQuery)
      const lines: string[] = []
      if (nq.length)
        lines.push(
          `! printf '%s\\0' ${nq.map((x) => dq(x.f.url)).join(' ')} | xargs -0 -n 1 -P ${s.workers} wget --content-disposition`,
        )
      if (q.length)
        lines.push(
          `! printf '%s\\0' ${q.map((x) => dq(x.fn) + ' ' + dq(x.f.url)).join(' ')} | xargs -0 -n 2 -P ${s.workers} sh -c 'wget -O "$0" "$1"'`,
        )
      text = lines.join('\n')
    } else {
      text = wg.map(({ f, fn }) => wgetOne(f, fn)).join('\n')
    }
    cells.push({
      label: `${wg.length} files`,
      kind: 'wget',
      text: cm(wg.map((x) => x.f.name)) + text,
      ids: wg.map((x) => x.f.id),
    })
  }

  if (plain.length)
    cells.push({
      label: `${plain.length} plain link(s)`,
      kind: 'plain',
      text: plain.map(line).join('\n'),
      ids: plain.map((f) => f.id),
    })
  return cells
}

// All cells for the current selection, by copy mode.
export const buildCells = (
  view: LinkItem[],
  groups: Group[],
  s: Settings,
): Cell[] => {
  const pos = new Map(view.map((f, i) => [f.id, i + 1]))
  const inView = new Set(view.map((f) => f.id))
  if (s.mode === 'single') return view.flatMap((f) => fmt([f], s, pos))
  if (s.mode === 'group') {
    return groups.flatMap((g) => {
      const sel = g.members.filter((f) => inView.has(f.id))
      if (!sel.length) return []
      if (g.type === 'movie') return sel.flatMap((f) => fmt([f], s, pos))
      return fmt(sel, s, pos).map((c) =>
        c.ids.length > 1 ? { ...c, label: `${g.label} · ${c.label}` } : c,
      )
    })
  }
  return fmt(view, s, pos)
}

// Blank, fill-it-yourself cells (the original templates)
export const blankCells = (workers: number): Cell[] => [
  {
    label: 'Split ZIP (blank)',
    kind: 'split',
    text: pyMulti([['', '', '', '', '']], workers),
    ids: [],
  },
  { label: 'RAR (blank)', kind: 'rar', text: pyRar(''), ids: [] },
  { label: 'ZIP (blank)', kind: 'zip', text: pyZip(''), ids: [] },
]
