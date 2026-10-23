import { useEffect, useMemo, useState, type CSSProperties } from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { toast } from 'sonner'
import {
  Check,
  ClipboardCopy,
  Search,
  Sparkles,
  Trash2,
  Wand2,
  X,
} from 'lucide-react'

import { Switch } from '@/components/ui/switch'
import {
  DEFAULT_SETTINGS,
  TAG,
  blankCells,
  buildCells,
  buildGroups,
  dedupeItems,
  parseLinks,
  type Cell,
  type CopyMode,
  type Kind,
  type Settings,
} from '@/lib/commands'
import { cn } from '@/lib/utils'

export const Route = createFileRoute('/')({
  component: Home,
})

const SAMPLE = `1. Dune.Part.Two.2024.1080p.WEB.mkv
https://srv3.example-cdn.com/d/8hQk2/Dune.Part.Two.2024.1080p.WEB.mkv
https://srv1.example-cdn.com/d/ab12/Oppenheimer.2023.2160p.mkv?token=Xy91kP&expires=1761200000https://srv1.example-cdn.com/d/cd34/Arrival.2016.720p.mp4
https://srv2.example-cdn.com/f/Severance.S02E01.1080p.mkv https://srv2.example-cdn.com/f/Severance.S02E02.1080p.mkv https://srv2.example-cdn.com/f/Severance.S02E03.1080p.mkv https://srv2.example-cdn.com/f/Severance.S02E04.1080p.mkv
https://srv4.example-cdn.com/dl/Photos.Backup.zip?sig=a1b2c3
https://srv4.example-cdn.com/dl/Project.Files.part1.rarhttps://srv4.example-cdn.com/dl/Soundtrack.rar
https://srv5.example-cdn.com/dl/BigArchive.zip.001
https://srv5.example-cdn.com/dl/BigArchive.zip.002
https://srv6.example-cdn.com/get?id=77&filename=Notes.pdf`

const KIND_STYLE: Record<Kind, string> = {
  movie: 'bg-fuchsia-100 text-fuchsia-700 border-fuchsia-300',
  series: 'bg-violet-100 text-violet-700 border-violet-300',
  zip: 'bg-amber-100 text-amber-700 border-amber-300',
  other: 'bg-sky-100 text-sky-700 border-sky-300',
}
const CELL_EMOJI: Record<string, string> = {
  movie: '🎬',
  wget: '📦',
  zip: '🗜️',
  rar: '🗜️',
  split: '🧩',
  plain: '🔗',
}
const MODES: [CopyMode, string, string][] = [
  [
    'all',
    'Together',
    'Everything in as few cells as possible (movies still alone)',
  ],
  ['group', 'By group', 'One cell per group — each movie on its own'],
  ['single', 'One by one', 'A separate cell for every single link'],
]

const LS = {
  input: 'lp_input',
  settings: 'lp_settings',
  off: 'lp_off',
  extra: 'lp_extra',
}
const NO_COPIES: ReadonlySet<number> = new Set()

// Space-separated words must all match (AND); comma-separated groups are alternatives (OR).
const searchMatcher = (search: string) => {
  const terms = search
    .toLowerCase()
    .split(',')
    .map((q) => q.trim().split(/\s+/).filter(Boolean))
    .filter((a) => a.length)
  return (name: string) =>
    !terms.length ||
    terms.some((ws) => ws.every((w) => name.toLowerCase().includes(w)))
}

function Home() {
  const [input, setInput] = useState('')
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS)
  const [off, setOff] = useState<Set<string>>(new Set())
  const [search, setSearch] = useState('')
  const [forceCD, setForceCD] = useState(false)
  const [parts, setParts] = useState(1)
  const [copiedState, setCopiedState] = useState<{
    key: string
    idx: Set<number>
  }>({
    key: '',
    idx: new Set(),
  })
  const [ready, setReady] = useState(false)

  // Restore from this browser after hydration; localStorage doesn't exist during SSR.
  useEffect(() => {
    try {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- one-time sync from external storage
      setInput(localStorage.getItem(LS.input) ?? '')
      const s = localStorage.getItem(LS.settings)
      if (s) setSettings({ ...DEFAULT_SETTINGS, ...JSON.parse(s) })
      const o = localStorage.getItem(LS.off)
      if (o) setOff(new Set(JSON.parse(o)))
      const x = localStorage.getItem(LS.extra)
      if (x) {
        const j = JSON.parse(x)
        setForceCD(!!j.forceCD)
        setParts(Math.max(1, parseInt(j.parts, 10) || 1))
      }
    } catch {
      /* ignore broken storage */
    }
    setReady(true)
  }, [])
  useEffect(() => {
    if (!ready) return
    localStorage.setItem(LS.input, input)
    localStorage.setItem(LS.settings, JSON.stringify(settings))
    localStorage.setItem(LS.off, JSON.stringify([...off]))
    localStorage.setItem(LS.extra, JSON.stringify({ forceCD, parts }))
  }, [ready, input, settings, off, forceCD, parts])

  const parsed = useMemo(() => parseLinks(input), [input])
  const { items, dupes } = useMemo(() => {
    const d = settings.dedupe
      ? dedupeItems(parsed)
      : { kept: parsed, dupes: 0 }
    // Force content-disposition: treat every link as "clean" so -O is never used.
    // Done here (not later) so groups and "By group" mode see it too.
    const kept = forceCD
      ? d.kept.map((f) => ({ ...f, hasQuery: false }))
      : d.kept
    return { items: kept, dupes: d.dupes }
  }, [parsed, settings.dedupe, forceCD])
  const groups = useMemo(() => buildGroups(items), [items])

  const matches = useMemo(() => searchMatcher(search), [search])
  const shown = useMemo(
    () => items.filter((f) => matches(f.name)),
    [items, matches],
  )
  const view = useMemo(() => shown.filter((f) => !off.has(f.url)), [shown, off])

  // Split the selected links evenly, in order, into `parts` commands (50 / 2 = 25 + 25).
  const cells = useMemo(() => {
    const n = Math.min(Math.max(1, parts), Math.max(view.length, 1))
    if (n === 1) return buildCells(view, groups, settings)
    const out: Cell[] = []
    for (let p = 0; p < n; p++) {
      const chunk = view.slice(
        Math.round((p * view.length) / n),
        Math.round(((p + 1) * view.length) / n),
      )
      if (!chunk.length) continue
      const built = buildCells(chunk, groups, settings)
      out.push(
        ...built.map((c) => ({
          ...c,
          label: `Part ${p + 1}/${n} · ${c.label}`,
        })),
      )
    }
    return out
  }, [view, groups, settings, parts])

  // "Copied" marks belong to one exact output; any change to the cells' text resets them.
  const cellsKey = useMemo(() => cells.map((c) => c.text).join('\0'), [cells])
  const copied = copiedState.key === cellsKey ? copiedState.idx : NO_COPIES
  const markCopied = (i: number) =>
    setCopiedState((s) => ({
      key: cellsKey,
      idx: new Set(s.key === cellsKey ? s.idx : []).add(i),
    }))

  const set = <K extends keyof Settings>(k: K, v: Settings[K]) =>
    setSettings((s) => ({ ...s, [k]: v }))
  const toggleOff = (urls: string[], turnOff: boolean) =>
    setOff((o) => {
      const n = new Set(o)
      urls.forEach((u) => (turnOff ? n.add(u) : n.delete(u)))
      return n
    })

  const copy = async (text: string, what: string) => {
    try {
      await navigator.clipboard.writeText(
        text.endsWith('\n') ? text : text + '\n',
      )
      toast.success(`Copied ${what}`)
      return true
    } catch {
      toast.error('Clipboard blocked — select the text and copy manually')
      return false
    }
  }
  const copyCell = async (i: number) => {
    if (await copy(cells[i].text, cells[i].label)) markCopied(i)
  }
  const blanks = useMemo(() => blankCells(settings.workers), [settings.workers])
  const [copiedB, setCopiedB] = useState<Set<number>>(new Set())
  const copyBlank = async (i: number) => {
    if (await copy(blanks[i].text, blanks[i].label))
      setCopiedB((c) => new Set(c).add(i))
  }
  const nextIdx = cells.findIndex((_, i) => !copied.has(i))
  const queryCount = items.filter((f) => f.hasQuery).length

  return (
    <div className="lp-bg relative min-h-dvh overflow-x-hidden text-foreground">
      <Stickers />
      <header className="relative mx-auto max-w-content px-4 pt-10 pb-6 sm:pt-14">
        <div className="flex flex-wrap items-end gap-x-6 gap-y-3">
          <h1 className="font-display text-5xl font-bold tracking-tight sm:text-6xl">
            <span className="bg-gradient-to-br from-fuchsia-500 via-purple-600 to-violet-700 bg-clip-text text-transparent">
              LinkPop
            </span>
            <span
              className="sticker ml-2 align-top text-4xl"
              style={{ transform: 'rotate(14deg)' }}
            >
              💜
            </span>
          </h1>
          <p className="max-w-xl pb-2 text-lg text-muted-foreground">
            Paste download links — even glued together with no spaces — and get
            ready-to-run Colab cells. Movies come out alone as{' '}
            <code className="lp-code rounded bg-purple-100 px-1.5 text-purple-800">
              ! wget --content-disposition
            </code>
            .
          </p>
        </div>
      </header>

      <main className="relative mx-auto grid max-w-content grid-cols-[minmax(0,1fr)] gap-6 px-4 pb-28 lg:pb-16 lg:grid-cols-[minmax(0,5fr)_minmax(0,6fr)]">
        {/* ---------- left: input + options + links ---------- */}
        <div className="flex min-w-0 flex-col gap-6">
          <section className="lp-card p-5">
            <Corner emoji="🔮" />
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
              <h2 className="font-display text-xl font-semibold">
                1 · Paste links
              </h2>
              <div className="flex flex-wrap gap-2">
                <button
                  className="rounded-full border border-border bg-white px-3 py-2 text-sm font-semibold hover:bg-purple-50 sm:py-1"
                  onClick={() => {
                    setInput(SAMPLE)
                    setOff(new Set())
                  }}
                >
                  <Wand2 className="mr-1 inline size-3.5" />
                  Try sample
                </button>
                <button
                  className="rounded-full border border-border bg-white px-3 py-2 text-sm font-semibold hover:bg-purple-50 sm:py-1 disabled:opacity-40"
                  disabled={!input}
                  onClick={() => {
                    setInput('')
                    setOff(new Set())
                  }}
                >
                  <Trash2 className="mr-1 inline size-3.5" />
                  Clear
                </button>
              </div>
            </div>
            <textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              aria-label="Download links"
              spellCheck={false}
              placeholder={
                'https://…/Movie.2024.mkvhttps://…/Show.S01E01.mkv?token=…\n\nOptional: put a file name on the line above a link.'
              }
              className="lp-code lp-scroll h-48 w-full resize-y rounded-2xl border-[1.5px] border-border bg-white/90 p-3 text-base leading-relaxed sm:text-[12.5px] outline-none placeholder:text-purple-300 focus:border-primary focus:ring-4 focus:ring-primary/15"
            />
            <div className="mt-3 flex flex-wrap gap-2 text-sm">
              <Stat n={items.length} label="links" />
              <Stat n={queryCount} label="with ?query → -O name" />
              <Stat
                n={items.length - queryCount}
                label="clean → content-disposition"
              />
              {dupes > 0 && <Stat n={dupes} label="dupes skipped" />}
            </div>
          </section>

          <section className="lp-card p-5">
            <Corner emoji="🎀" />
            <h2 className="mb-3 font-display text-xl font-semibold">
              2 · Options
            </h2>
            <div className="mb-4">
              <div className="mb-1.5 text-xs font-extrabold tracking-widest text-muted-foreground uppercase">
                Output cells
              </div>
              <div className="grid w-full grid-cols-3 overflow-hidden rounded-full border-[1.5px] border-border bg-white sm:inline-grid sm:w-auto">
                {MODES.map(([k, label, tip]) => (
                  <button
                    key={k}
                    title={tip}
                    onClick={() => set('mode', k)}
                    className={cn(
                      'px-2 py-2 text-sm font-semibold transition-colors not-first:border-l border-border sm:px-4 sm:py-1.5',
                      settings.mode === k ? 'lp-btn-pri' : 'hover:bg-purple-50',
                    )}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>
            <div className="grid gap-x-6 gap-y-3 sm:grid-cols-2">
              <Toggle
                label="Commands"
                hint="Wrap links in wget / extract cells"
                checked={settings.commands}
                onChange={(v) => set('commands', v)}
              />
              <Toggle
                label="Movies alone"
                hint="Each movie gets its own wget cell"
                checked={settings.moviesAlone}
                disabled={!settings.commands}
                onChange={(v) => set('moviesAlone', v)}
              />
              <Toggle
                label="Parallel wget"
                hint="Other files download together via xargs"
                checked={settings.parallel}
                disabled={!settings.commands}
                onChange={(v) => set('parallel', v)}
              />
              <Toggle
                label="Loose series plain"
                hint="Stray episodes stay as bare links"
                checked={settings.looseSeriesPlain}
                disabled={!settings.commands}
                onChange={(v) => set('looseSeriesPlain', v)}
              />
              <Toggle
                label="# Comments"
                hint="File names on top of each command"
                checked={settings.comments}
                disabled={!settings.commands}
                onChange={(v) => set('comments', v)}
              />
              <Toggle
                label="Names"
                hint="Number + name above plain links"
                checked={settings.names}
                onChange={(v) => set('names', v)}
              />
              <Toggle
                label="Dedupe"
                hint="Skip repeated file names"
                checked={settings.dedupe}
                onChange={(v) => set('dedupe', v)}
              />
              <Toggle
                label="Force content-disposition"
                hint="Ignore ?query and never use -O"
                checked={forceCD}
                disabled={!settings.commands}
                onChange={setForceCD}
              />
              <label className="flex items-center justify-between gap-3">
                <span className="min-w-0">
                  <span className="block font-bold">Workers</span>
                  <span className="block text-xs text-muted-foreground">
                    Concurrent downloads
                  </span>
                </span>
                <input
                  type="number"
                  min={1}
                  max={64}
                  value={settings.workers}
                  onChange={(e) =>
                    set(
                      'workers',
                      Math.max(
                        1,
                        Math.min(64, parseInt(e.target.value, 10) || 1),
                      ),
                    )
                  }
                  className="w-16 shrink-0 rounded-full border-[1.5px] border-border bg-white px-3 py-1 text-center text-base outline-none sm:text-sm focus:border-primary"
                />
              </label>
              <label className="flex items-center justify-between gap-3">
                <span className="min-w-0">
                  <span className="block font-bold">Split into</span>
                  <span className="block text-xs text-muted-foreground">
                    Number of parts (1 = no split)
                  </span>
                </span>
                <input
                  type="number"
                  min={1}
                  max={999}
                  value={parts}
                  onChange={(e) =>
                    setParts(Math.max(1, parseInt(e.target.value, 10) || 1))
                  }
                  className="w-16 shrink-0 rounded-full border-[1.5px] border-border bg-white px-3 py-1 text-center text-base outline-none sm:text-sm focus:border-primary"
                />
              </label>
            </div>
          </section>

          <section className="lp-card p-5">
            <Corner emoji="🍇" />
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
              <h2 className="font-display text-xl font-semibold">
                3 · Pick links
              </h2>
              <div className="flex gap-2 text-sm">
                <button
                  className="rounded-full border border-border bg-white px-3 py-2 font-semibold hover:bg-purple-50 sm:py-1"
                  onClick={() =>
                    toggleOff(
                      shown.map((f) => f.url),
                      false,
                    )
                  }
                >
                  All
                </button>
                <button
                  className="rounded-full border border-border bg-white px-3 py-2 font-semibold hover:bg-purple-50 sm:py-1"
                  onClick={() =>
                    toggleOff(
                      shown.map((f) => f.url),
                      true,
                    )
                  }
                >
                  None
                </button>
              </div>
            </div>
            <div className="relative mb-3">
              <Search className="absolute top-1/2 left-3 size-4 -translate-y-1/2 text-purple-400" />
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                aria-label="Search links"
                placeholder="Search… (space = AND, comma = OR)"
                className="w-full rounded-full border-[1.5px] border-border bg-white py-2 pr-9 pl-9 text-base outline-none sm:text-sm focus:border-primary focus:ring-4 focus:ring-primary/15"
              />
              {search && (
                <button
                  aria-label="Clear search"
                  className="absolute top-1/2 right-3 -translate-y-1/2"
                  onClick={() => setSearch('')}
                >
                  <X className="size-4 text-purple-400" />
                </button>
              )}
            </div>
            <div className="lp-scroll max-h-[420px] overflow-auto rounded-2xl border border-border bg-white/80 p-1.5">
              {!items.length ? (
                <p className="p-6 text-center text-sm text-muted-foreground">
                  <span className="sticker mb-2 block text-3xl">🫧</span>
                  No links yet — paste some above.
                </p>
              ) : !shown.length ? (
                <p className="p-6 text-center text-sm text-muted-foreground">
                  No matches
                </p>
              ) : (
                groups.map((g) => {
                  const ms = g.members.filter((f) => matches(f.name))
                  if (!ms.length) return null
                  const on = ms.filter((f) => !off.has(f.url)).length
                  return (
                    <div key={g.type + g.label} className="mb-1">
                      <label className="flex cursor-pointer items-center gap-2 rounded-xl bg-gradient-to-r from-purple-100 to-fuchsia-100 px-3 py-1.5 text-sm font-bold">
                        <input
                          type="checkbox"
                          className="accent-purple-600"
                          checked={on === ms.length}
                          ref={(el) => {
                            if (el) el.indeterminate = on > 0 && on < ms.length
                          }}
                          onChange={(e) =>
                            toggleOff(
                              ms.map((f) => f.url),
                              !e.target.checked,
                            )
                          }
                        />
                        <span
                          className={cn(
                            'rounded-full border px-1.5 text-[10px]',
                            KIND_STYLE[g.type],
                          )}
                        >
                          {TAG[g.type]}
                        </span>
                        <span className="flex-1 truncate">{g.label}</span>
                        <span className="text-xs text-muted-foreground">
                          {ms.length}
                        </span>
                      </label>
                      {ms.map((f) => (
                        <label
                          key={f.id}
                          title={f.url}
                          className="flex cursor-pointer items-start gap-2 rounded-lg px-3 py-1.5 pl-6 text-[13px] hover:bg-purple-50"
                        >
                          <input
                            type="checkbox"
                            className="mt-0.5 accent-purple-600"
                            checked={!off.has(f.url)}
                            onChange={(e) =>
                              toggleOff([f.url], !e.target.checked)
                            }
                          />
                          <span
                            className={cn(
                              'min-w-0 flex-1 break-all',
                              off.has(f.url) && 'opacity-45',
                            )}
                          >
                            {f.name}
                            {f.failed && (
                              <span className="ml-1 text-xs font-bold text-rose-600">
                                · failed
                              </span>
                            )}
                          </span>
                          <span
                            className={cn(
                              'shrink-0 rounded-full px-1.5 text-[10px] font-bold',
                              f.hasQuery
                                ? 'bg-amber-100 text-amber-700'
                                : 'bg-emerald-100 text-emerald-700',
                            )}
                            title={
                              f.hasQuery
                                ? 'Has query parameters — saved with -O and the real file name'
                                : 'No query parameters — uses --content-disposition'
                            }
                          >
                            {f.hasQuery ? '?query' : 'clean'}
                          </span>
                        </label>
                      ))}
                    </div>
                  )
                })
              )}
            </div>
          </section>
        </div>

        {/* ---------- right: output ---------- */}
        <section className="lp-card min-w-0 self-start p-5 lg:sticky lg:top-4">
          <Corner emoji="✨" />
          <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
            <h2 className="font-display text-xl font-semibold">
              4 · Commands
              <span className="ml-2 text-sm font-normal text-muted-foreground">
                {cells.length} cell{cells.length === 1 ? '' : 's'} ·{' '}
                {view.length} link
                {view.length === 1 ? '' : 's'}
              </span>
            </h2>
            <div className="flex w-full gap-2 sm:w-auto">
              <button
                disabled={nextIdx < 0}
                onClick={() => copyCell(nextIdx)}
                className="lp-btn-pri flex-1 rounded-full px-4 py-2 text-sm font-bold transition-transform sm:flex-none sm:py-1.5 hover:-translate-y-0.5 disabled:opacity-40"
              >
                <Sparkles className="mr-1 inline size-4" />
                {nextIdx < 0
                  ? 'All copied'
                  : `Copy next ${nextIdx + 1}/${cells.length}`}
              </button>
              <button
                disabled={!cells.length}
                onClick={() =>
                  copy(cells.map((c) => c.text).join('\n\n'), 'everything')
                }
                className="flex-1 rounded-full border-[1.5px] border-border bg-white px-4 py-2 text-sm font-bold hover:bg-purple-50 disabled:opacity-40 sm:flex-none sm:py-1.5"
              >
                Copy all
              </button>
            </div>
          </div>
          <div className="lp-scroll flex lg:max-h-[calc(100dvh-9rem)] flex-col gap-3 overflow-auto pr-1">
            {!cells.length ? (
              <div className="rounded-2xl border-2 border-dashed border-border p-10 text-center text-muted-foreground">
                <span
                  className="sticker sticker-float mb-3 block text-5xl"
                  style={{ '--r': '-8deg' } as CSSProperties}
                >
                  🦄
                </span>
                Your Colab cells appear here.
              </div>
            ) : (
              cells.map((c, i) => (
                <CellCard
                  key={i}
                  cell={c}
                  n={i + 1}
                  copied={copied.has(i)}
                  onCopy={() => copyCell(i)}
                />
              ))
            )}
          </div>
          <details className="mt-4 min-w-0 rounded-2xl border border-border bg-white/70 p-3">
            <summary className="cursor-pointer py-1 font-semibold">
              Blank templates
            </summary>
            <div className="mt-3 flex flex-col gap-3">
              {blanks.map((c, i) => (
                <CellCard
                  key={i}
                  cell={c}
                  n={i + 1}
                  copied={copiedB.has(i)}
                  onCopy={() => copyBlank(i)}
                />
              ))}
            </div>
          </details>
        </section>
      </main>

      <footer className="relative pb-8 text-center text-sm text-muted-foreground">
        <span className="sticker mr-1">🧁</span> Everything runs in your browser
        — links never leave this page.
      </footer>

      <div className="fixed inset-x-0 bottom-0 z-30 border-t border-border bg-white/95 px-3 pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] backdrop-blur lg:hidden">
        <button
          disabled={nextIdx < 0}
          onClick={() => copyCell(nextIdx)}
          className="lp-btn-pri w-full rounded-full py-3 font-bold disabled:opacity-40"
        >
          <Sparkles className="mr-1 inline size-4" />
          {nextIdx < 0
            ? 'All copied'
            : `Copy next ${nextIdx + 1}/${cells.length}`}
        </button>
      </div>
    </div>
  )
}

function CellCard({
  cell,
  n,
  copied,
  onCopy,
}: {
  cell: Cell
  n: number
  copied: boolean
  onCopy: () => void
}) {
  return (
    <div
      className={cn(
        'overflow-hidden rounded-2xl border-[1.5px] transition-colors',
        copied
          ? 'border-emerald-300 bg-emerald-50/60'
          : 'border-border bg-white',
      )}
    >
      <div className="flex items-center gap-2 border-b border-border/70 bg-gradient-to-r from-purple-50 to-fuchsia-50 px-3 py-1.5">
        <span className="sticker text-base">
          {CELL_EMOJI[cell.kind] ?? '📄'}
        </span>
        <span className="text-xs font-extrabold text-purple-500">#{n}</span>
        <span
          className="min-w-0 flex-1 truncate text-sm font-semibold"
          title={cell.label}
        >
          {cell.label}
        </span>
        <button
          onClick={onCopy}
          className={cn(
            'flex items-center gap-1 rounded-full px-3 py-0.5 text-xs font-bold',
            copied ? 'bg-emerald-500 text-white' : 'lp-btn-pri',
          )}
        >
          {copied ? (
            <Check className="size-3.5" />
          ) : (
            <ClipboardCopy className="size-3.5" />
          )}
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      <pre className="lp-code lp-scroll max-h-72 max-w-full overflow-auto p-3 text-[12px] leading-relaxed break-all whitespace-pre-wrap text-purple-950">
        {cell.text}
      </pre>
    </div>
  )
}

function Toggle({
  label,
  hint,
  checked,
  disabled,
  onChange,
}: {
  label: string
  hint: string
  checked: boolean
  disabled?: boolean
  onChange: (v: boolean) => void
}) {
  return (
    <label
      className={cn(
        'flex cursor-pointer items-center justify-between gap-3',
        disabled && 'opacity-45',
      )}
    >
      <span className="min-w-0">
        <span className="block font-bold">{label}</span>
        <span className="block text-xs text-muted-foreground">{hint}</span>
      </span>
      <Switch
        className="shrink-0"
        checked={checked}
        disabled={disabled}
        onCheckedChange={onChange}
      />
    </label>
  )
}

function Stat({ n, label }: { n: number; label: string }) {
  return (
    <span className="rounded-full border border-border bg-white/90 px-3 py-0.5">
      <b className="text-purple-700">{n}</b>{' '}
      <span className="text-muted-foreground">{label}</span>
    </span>
  )
}

function Corner({ emoji }: { emoji: string }) {
  return (
    <span
      className="sticker absolute -top-4 -right-2 z-10 text-3xl"
      style={{ transform: 'rotate(12deg)' }}
    >
      {emoji}
    </span>
  )
}

const FLOATERS: [string, string, string, string][] = [
  ['🌸', '6%', '18%', '-12deg'],
  ['⭐', '92%', '12%', '10deg'],
  ['🍬', '3%', '62%', '8deg'],
  ['🌙', '95%', '55%', '-14deg'],
  ['💫', '48%', '4%', '6deg'],
  ['🪻', '90%', '88%', '12deg'],
]

function Stickers() {
  return (
    <div
      aria-hidden
      className="pointer-events-none absolute inset-0 hidden overflow-hidden md:block"
    >
      {FLOATERS.map(([e, left, top, r], i) => (
        <span
          key={i}
          className="sticker sticker-float absolute text-4xl opacity-90"
          style={
            {
              left,
              top,
              '--r': r,
              animationDelay: `${i * 0.7}s`,
            } as CSSProperties
          }
        >
          {e}
        </span>
      ))}
    </div>
  )
}
