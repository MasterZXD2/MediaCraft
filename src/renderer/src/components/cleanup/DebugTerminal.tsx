import { memo, useEffect, useRef } from 'react'
import { Terminal } from 'lucide-react'
import { useMediaStore } from '@/store/mediaStore'

export const DebugTerminal = memo(function DebugTerminal(): JSX.Element | null {
  const logs = useMediaStore((state) => state.duplicateDebugLogs)
  const isFindingDuplicates = useMediaStore((state) => state.isFindingDuplicates)
  const bottomRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: 'nearest' })
  }, [logs.length])

  if (!isFindingDuplicates && logs.length === 0) return null

  return (
    <section className="mt-4 overflow-hidden rounded-md border border-emerald-500/25 bg-gray-950 shadow-inner">
      <div className="flex items-center gap-2 border-b border-emerald-500/20 px-3 py-2 text-[10px] font-semibold uppercase tracking-[0.16em] text-emerald-300">
        <Terminal className="size-3.5" />
        Duplicate Debug Terminal
        <span className="ml-auto font-mono text-[9px] font-normal tracking-normal text-emerald-500/70">
          {logs.length}/500
        </span>
      </div>
      <div
        className="max-h-56 overflow-y-auto overscroll-contain px-3 py-2 font-mono text-[9px] leading-relaxed text-emerald-300/90"
        role="log"
        aria-live="polite"
        aria-label="Duplicate detection debug log"
      >
        {logs.map((log, index) => (
          <p key={`${index}-${log}`} className="whitespace-pre-wrap break-words">
            <span className="mr-1 text-emerald-500/60">$</span>{log}
          </p>
        ))}
        <div ref={bottomRef} aria-hidden="true" />
      </div>
    </section>
  )
})
