import { useEffect, useMemo, useRef, useState } from 'react'
import ReactCrop, { type Crop, type PixelCrop } from 'react-image-crop'
import 'react-image-crop/dist/ReactCrop.css'
import {
  AlertTriangle,
  Camera,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  Crop as CropIcon,
  FileImage,
  Film,
  FlipHorizontal,
  FlipVertical,
  LoaderCircle,
  RotateCcw,
  RotateCw,
  Scissors,
  VolumeX,
  X
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Slider } from '@/components/ui/slider'
import { useViewerKeys } from '@/hooks/useViewerKeys'
import { createMediaUrl, selectActiveMediaIds, useMediaStore } from '@/store/mediaStore'

export function MediaViewer(): JSX.Element | null {
  const viewingId = useMediaStore((state) => state.viewingId)
  const file = useMediaStore((state) => viewingId ? state.byId[viewingId] : undefined)
  const activeIds = useMediaStore(selectActiveMediaIds)
  const closeViewer = useMediaStore((state) => state.closeViewer)
  const viewNext = useMediaStore((state) => state.viewNext)
  const viewPrevious = useMediaStore((state) => state.viewPrevious)
  const [mediaFailed, setMediaFailed] = useState(false)
  const [snapshotStatus, setSnapshotStatus] = useState<'idle' | 'saving' | 'queued' | 'error'>('idle')
  const [trimMode, setTrimMode] = useState(false)
  const [trimStatus, setTrimStatus] = useState<'idle' | 'saving' | 'queued' | 'error'>('idle')
  const [editingTrimStart, setEditingTrimStart] = useState(false)
  const [editingTrimEnd, setEditingTrimEnd] = useState(false)
  const [cropMode, setCropMode] = useState(false)
  const [cropStatus, setCropStatus] = useState<'idle' | 'saving' | 'queued' | 'error'>('idle')
  const [quickActionStatus, setQuickActionStatus] = useState<'idle' | 'saving' | 'queued' | 'error'>('idle')
  const [previewRotate, setPreviewRotate] = useState(0)
  const [previewFlipHorizontal, setPreviewFlipHorizontal] = useState(false)
  const [previewFlipVertical, setPreviewFlipVertical] = useState(false)
  const [crop, setCrop] = useState<Crop>()
  const [completedCrop, setCompletedCrop] = useState<PixelCrop>()
  const [videoDuration, setVideoDuration] = useState(0)
  const [trimRange, setTrimRange] = useState<[number, number]>([0, 1])
  const [thumbnails, setThumbnails] = useState<string[]>([])
  const [thumbnailsLoading, setThumbnailsLoading] = useState(false)
  const [currentTime, setCurrentTime] = useState(0)
  const [isDraggingTimeline, setIsDraggingTimeline] = useState(false)
  const [isDraggingHandle, setIsDraggingHandle] = useState<'start' | 'end' | null>(null)
  const dialogRef = useRef<HTMLDivElement>(null)
  const videoRef = useRef<HTMLVideoElement>(null)
  const imageRef = useRef<HTMLImageElement>(null)
  const timelineRef = useRef<HTMLDivElement>(null)
  const snapshotResetTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const trimResetTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const cropResetTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const quickActionResetTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const trimRangeRef = useRef<[number, number]>([0, 1])
  const sourceUrl = useMemo(() => file ? createMediaUrl(file.path) : '', [file?.path])
  const currentIndex = viewingId ? activeIds.indexOf(viewingId) : -1
  const canNavigate = activeIds.length > 1

  useViewerKeys(viewingId !== null)

  useEffect(() => {
    setMediaFailed(false)
    setSnapshotStatus('idle')
    setTrimMode(false)
    setTrimStatus('idle')
    setEditingTrimStart(false)
    setEditingTrimEnd(false)
    setCropMode(false)
    setCropStatus('idle')
    setQuickActionStatus('idle')
    setPreviewRotate(0)
    setPreviewFlipHorizontal(false)
    setPreviewFlipVertical(false)
    setCrop(undefined)
    setCompletedCrop(undefined)
    setVideoDuration(0)
    setThumbnails([])
    setThumbnailsLoading(false)
    setCurrentTime(0)
    setIsDraggingTimeline(false)
    setIsDraggingHandle(null)
    trimRangeRef.current = [0, 1]
    setTrimRange([0, 1])
    if (snapshotResetTimer.current) {
      clearTimeout(snapshotResetTimer.current)
      snapshotResetTimer.current = null
    }
    if (trimResetTimer.current) {
      clearTimeout(trimResetTimer.current)
      trimResetTimer.current = null
    }
    if (cropResetTimer.current) {
      clearTimeout(cropResetTimer.current)
      cropResetTimer.current = null
    }
    if (quickActionResetTimer.current) {
      clearTimeout(quickActionResetTimer.current)
      quickActionResetTimer.current = null
    }
  }, [viewingId])

  useEffect(() => () => {
    if (snapshotResetTimer.current) clearTimeout(snapshotResetTimer.current)
    if (trimResetTimer.current) clearTimeout(trimResetTimer.current)
    if (cropResetTimer.current) clearTimeout(cropResetTimer.current)
    if (quickActionResetTimer.current) clearTimeout(quickActionResetTimer.current)
  }, [])

  useEffect(() => {
    if (!viewingId) return
    const previouslyFocused = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null
    dialogRef.current?.focus()
    return () => previouslyFocused?.focus()
  }, [viewingId])

  useEffect(() => {
    if (viewingId && !file) closeViewer()
  }, [closeViewer, file, viewingId])

  useEffect(() => {
    if (!trimMode || !file || file.type !== 'video') return

    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement) return

      const key = event.key.toLowerCase()
      if (key === 'i') {
        event.preventDefault()
        if (videoRef.current && videoDuration > 0) {
          const currentTime = videoRef.current.currentTime
          const [, end] = trimRangeRef.current
          const newStart = Math.max(0, Math.min(currentTime, end - 0.1))
          const next: [number, number] = [newStart, end]
          trimRangeRef.current = next
          setTrimRange(next)
        }
      } else if (key === 'o') {
        event.preventDefault()
        if (videoRef.current && videoDuration > 0) {
          const currentTime = videoRef.current.currentTime
          const [start] = trimRangeRef.current
          const newEnd = Math.max(start + 0.1, Math.min(currentTime, videoDuration))
          const next: [number, number] = [start, newEnd]
          trimRangeRef.current = next
          setTrimRange(next)
        }
      } else if (key === ' ') {
        event.preventDefault()
        if (videoRef.current) {
          if (videoRef.current.paused) {
            void videoRef.current.play()
          } else {
            videoRef.current.pause()
          }
        }
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [trimMode, file, videoDuration])

  const takeSnapshot = async (): Promise<void> => {
    if (!file || file.type !== 'video' || snapshotStatus === 'saving') return

    const timestamp = Math.max(0, videoRef.current?.currentTime ?? 0)
    setSnapshotStatus('saving')
    try {
      const outputDirectory = await window.api.selectTransformOutputDirectory()
      if (!outputDirectory) {
        setSnapshotStatus('idle')
        return
      }

      await window.api.transformMedia({
        fileIds: [file.id],
        outputDirectory,
        options: {
          image: {
            mode: 'long_edge',
            longEdge: 2048,
            format: 'jpeg',
            quality: 92,
            skipUpscale: true
          },
          video: { mode: 'snapshot', timestamp }
        }
      })
      setSnapshotStatus('queued')
      snapshotResetTimer.current = setTimeout(() => {
        snapshotResetTimer.current = null
        setSnapshotStatus('idle')
      }, 3000)
    } catch {
      setSnapshotStatus('error')
      snapshotResetTimer.current = setTimeout(() => {
        snapshotResetTimer.current = null
        setSnapshotStatus('idle')
      }, 3000)
    }
  }

  const handleVideoMetadata = (event: React.SyntheticEvent<HTMLVideoElement>): void => {
    const duration = event.currentTarget.duration
    if (!Number.isFinite(duration) || duration <= 0) return
    setVideoDuration(duration)
    trimRangeRef.current = [0, duration]
    setTrimRange([0, duration])
  }

  const handleTrimRangeChange = (values: number[]): void => {
    if (values.length < 2 || videoDuration <= 0) return

    const previous = trimRangeRef.current
    const next: [number, number] = [
      Math.max(0, Math.min(values[0], videoDuration)),
      Math.max(0, Math.min(values[1], videoDuration))
    ]
    const movedThumb = Math.abs(next[0] - previous[0]) >= Math.abs(next[1] - previous[1]) ? 0 : 1
    trimRangeRef.current = next
    setTrimRange(next)
    if (videoRef.current) videoRef.current.currentTime = next[movedThumb]
  }

  const nudgeTrimStart = (delta: number): void => {
    if (videoDuration <= 0) return
    const [start, end] = trimRangeRef.current
    const newStart = Math.max(0, Math.min(start + delta, end - 0.1))
    const next: [number, number] = [newStart, end]
    trimRangeRef.current = next
    setTrimRange(next)
    if (videoRef.current) videoRef.current.currentTime = newStart
  }

  const nudgeTrimEnd = (delta: number): void => {
    if (videoDuration <= 0) return
    const [start, end] = trimRangeRef.current
    const newEnd = Math.max(start + 0.1, Math.min(end + delta, videoDuration))
    const next: [number, number] = [start, newEnd]
    trimRangeRef.current = next
    setTrimRange(next)
    if (videoRef.current) videoRef.current.currentTime = newEnd
  }

  const setTrimStartManual = (value: number): void => {
    if (videoDuration <= 0) return
    const [, end] = trimRangeRef.current
    const newStart = Math.max(0, Math.min(value, end - 0.1))
    const next: [number, number] = [newStart, end]
    trimRangeRef.current = next
    setTrimRange(next)
    if (videoRef.current) videoRef.current.currentTime = newStart
    setEditingTrimStart(false)
  }

  const setTrimEndManual = (value: number): void => {
    if (videoDuration <= 0) return
    const [start] = trimRangeRef.current
    const newEnd = Math.max(start + 0.1, Math.min(value, videoDuration))
    const next: [number, number] = [start, newEnd]
    trimRangeRef.current = next
    setTrimRange(next)
    if (videoRef.current) videoRef.current.currentTime = newEnd
    setEditingTrimEnd(false)
  }

  const handleVideoTimeUpdate = (): void => {
    if (!trimMode || !videoRef.current || videoDuration <= 0) return
    const time = videoRef.current.currentTime
    setCurrentTime(time)
    const [, end] = trimRangeRef.current
    if (time >= end) {
      videoRef.current.pause()
      videoRef.current.currentTime = end
    }
  }

  const handleTimelineClick = (event: React.MouseEvent<HTMLDivElement>): void => {
    if (!timelineRef.current || videoDuration <= 0 || isDraggingHandle) return
    const rect = timelineRef.current.getBoundingClientRect()
    const clickX = event.clientX - rect.left
    const percent = Math.max(0, Math.min(1, clickX / rect.width))
    const newTime = percent * videoDuration
    if (videoRef.current) {
      videoRef.current.currentTime = newTime
      setCurrentTime(newTime)
    }
  }

  const handleTimelineMouseDown = (event: React.MouseEvent<HTMLDivElement>): void => {
    if (!timelineRef.current || videoDuration <= 0) return
    const rect = timelineRef.current.getBoundingClientRect()
    const clickX = event.clientX - rect.left
    const percent = clickX / rect.width
    const clickTime = percent * videoDuration

    const handleWidth = 12
    const startPos = (trimRange[0] / videoDuration) * rect.width
    const endPos = (trimRange[1] / videoDuration) * rect.width

    if (Math.abs(clickX - startPos) <= handleWidth) {
      setIsDraggingHandle('start')
      event.stopPropagation()
    } else if (Math.abs(clickX - endPos) <= handleWidth) {
      setIsDraggingHandle('end')
      event.stopPropagation()
    } else {
      setIsDraggingTimeline(true)
      if (videoRef.current) {
        videoRef.current.currentTime = clickTime
        setCurrentTime(clickTime)
      }
    }
  }

  const handleTimelineMouseMove = (event: MouseEvent): void => {
    if (!timelineRef.current || videoDuration <= 0) return
    if (!isDraggingTimeline && !isDraggingHandle) return

    const rect = timelineRef.current.getBoundingClientRect()
    const moveX = event.clientX - rect.left
    const percent = Math.max(0, Math.min(1, moveX / rect.width))
    const newTime = percent * videoDuration

    if (isDraggingTimeline) {
      if (videoRef.current) {
        videoRef.current.currentTime = newTime
        setCurrentTime(newTime)
      }
    } else if (isDraggingHandle === 'start') {
      const [, end] = trimRangeRef.current
      const newStart = Math.max(0, Math.min(newTime, end - 0.1))
      const next: [number, number] = [newStart, end]
      trimRangeRef.current = next
      setTrimRange(next)
      if (videoRef.current) {
        videoRef.current.currentTime = newStart
        setCurrentTime(newStart)
      }
    } else if (isDraggingHandle === 'end') {
      const [start] = trimRangeRef.current
      const newEnd = Math.max(start + 0.1, Math.min(newTime, videoDuration))
      const next: [number, number] = [start, newEnd]
      trimRangeRef.current = next
      setTrimRange(next)
      if (videoRef.current) {
        videoRef.current.currentTime = newEnd
        setCurrentTime(newEnd)
      }
    }
  }

  const handleTimelineMouseUp = (): void => {
    setIsDraggingTimeline(false)
    setIsDraggingHandle(null)
  }

  useEffect(() => {
    if (isDraggingTimeline || isDraggingHandle) {
      window.addEventListener('mousemove', handleTimelineMouseMove)
      window.addEventListener('mouseup', handleTimelineMouseUp)
      return () => {
        window.removeEventListener('mousemove', handleTimelineMouseMove)
        window.removeEventListener('mouseup', handleTimelineMouseUp)
      }
    }
  }, [isDraggingTimeline, isDraggingHandle, videoDuration])

  const toggleTrimMode = (): void => {
    setTrimMode((enabled) => {
      const nextEnabled = !enabled
      if (nextEnabled && videoRef.current && videoDuration > 0) {
        videoRef.current.currentTime = trimRangeRef.current[0]
        if (file && thumbnails.length === 0 && !thumbnailsLoading) {
          setThumbnailsLoading(true)
          window.api.extractVideoThumbnails(file.path, 10)
            .then((thumbs) => {
              setThumbnails(thumbs)
              setThumbnailsLoading(false)
            })
            .catch(() => {
              setThumbnailsLoading(false)
            })
        }
      }
      return nextEnabled
    })
  }

  const toggleCropMode = (): void => {
    setCropMode((enabled) => !enabled)
    if (!cropMode) {
      setCrop(undefined)
      setCompletedCrop(undefined)
    }
  }

  const exportTrimmedVideo = async (): Promise<void> => {
    if (
      !file
      || file.type !== 'video'
      || videoDuration <= 0
      || trimStatus === 'saving'
    ) return

    const [trimStart, trimEnd] = trimRangeRef.current
    if (trimEnd <= trimStart) {
      setTrimStatus('error')
      return
    }

    setTrimStatus('saving')
    try {
      const outputDirectory = await window.api.selectTransformOutputDirectory()
      if (!outputDirectory) {
        setTrimStatus('idle')
        return
      }

      await window.api.transformMedia({
        fileIds: [file.id],
        outputDirectory,
        options: {
          image: {
            mode: 'long_edge',
            longEdge: 2048,
            format: 'jpeg',
            quality: 92,
            skipUpscale: true
          },
          video: { mode: 'trim', trimStart, trimEnd }
        }
      })
      setTrimStatus('queued')
      trimResetTimer.current = setTimeout(() => {
        trimResetTimer.current = null
        setTrimStatus('idle')
      }, 3000)
    } catch {
      setTrimStatus('error')
      trimResetTimer.current = setTimeout(() => {
        trimResetTimer.current = null
        setTrimStatus('idle')
      }, 3000)
    }
  }

  const exportCroppedImage = async (): Promise<void> => {
    if (
      !file
      || file.type !== 'image'
      || !completedCrop
      || !imageRef.current
      || cropStatus === 'saving'
    ) return

    const image = imageRef.current
    const scaleX = image.naturalWidth / image.width
    const scaleY = image.naturalHeight / image.height

    const cropRect = {
      x: completedCrop.x * scaleX,
      y: completedCrop.y * scaleY,
      width: completedCrop.width * scaleX,
      height: completedCrop.height * scaleY
    }

    if (cropRect.width < 1 || cropRect.height < 1) {
      setCropStatus('error')
      return
    }

    setCropStatus('saving')
    try {
      const outputDirectory = await window.api.selectTransformOutputDirectory()
      if (!outputDirectory) {
        setCropStatus('idle')
        return
      }

      await window.api.transformMedia({
        fileIds: [file.id],
        outputDirectory,
        options: {
          image: {
            mode: 'crop',
            cropRect,
            format: 'source',
            quality: 95
          },
          video: { mode: 'remux' }
        }
      })
      setCropStatus('queued')
      cropResetTimer.current = setTimeout(() => {
        cropResetTimer.current = null
        setCropStatus('idle')
      }, 3000)
    } catch {
      setCropStatus('error')
      cropResetTimer.current = setTimeout(() => {
        cropResetTimer.current = null
        setCropStatus('idle')
      }, 3000)
    }
  }

  const quickActionRotate = async (degrees: number): Promise<void> => {
    if (!file || file.type !== 'image' || quickActionStatus === 'saving') return

    setQuickActionStatus('saving')
    try {
      const outputDirectory = await window.api.selectTransformOutputDirectory()
      if (!outputDirectory) {
        setQuickActionStatus('idle')
        return
      }

      const normalizedRotate = previewRotate % 360
      const actualRotate = normalizedRotate === 0 ? degrees : normalizedRotate

      await window.api.transformMedia({
        fileIds: [file.id],
        outputDirectory,
        options: {
          image: {
            mode: 'adjust_image',
            ...(actualRotate !== 0 ? { rotate: actualRotate } : {}),
            ...(previewFlipHorizontal ? { flipHorizontal: true } : {}),
            format: 'source',
            quality: 95
          },
          video: { mode: 'remux' }
        }
      })
      setQuickActionStatus('queued')
      setPreviewRotate(0)
      setPreviewFlipHorizontal(false)
      quickActionResetTimer.current = setTimeout(() => {
        quickActionResetTimer.current = null
        setQuickActionStatus('idle')
      }, 3000)
    } catch {
      setQuickActionStatus('error')
      quickActionResetTimer.current = setTimeout(() => {
        quickActionResetTimer.current = null
        setQuickActionStatus('idle')
      }, 3000)
    }
  }

  const quickActionFlipHorizontal = async (): Promise<void> => {
    if (!file || file.type !== 'image' || quickActionStatus === 'saving') return

    setQuickActionStatus('saving')
    try {
      const outputDirectory = await window.api.selectTransformOutputDirectory()
      if (!outputDirectory) {
        setQuickActionStatus('idle')
        return
      }

      const normalizedRotate = previewRotate % 360

      await window.api.transformMedia({
        fileIds: [file.id],
        outputDirectory,
        options: {
          image: {
            mode: 'adjust_image',
            ...(normalizedRotate !== 0 ? { rotate: normalizedRotate } : {}),
            flipHorizontal: true,
            format: 'source',
            quality: 95
          },
          video: { mode: 'remux' }
        }
      })
      setQuickActionStatus('queued')
      setPreviewRotate(0)
      setPreviewFlipHorizontal(false)
      quickActionResetTimer.current = setTimeout(() => {
        quickActionResetTimer.current = null
        setQuickActionStatus('idle')
      }, 3000)
    } catch {
      setQuickActionStatus('error')
      quickActionResetTimer.current = setTimeout(() => {
        quickActionResetTimer.current = null
        setQuickActionStatus('idle')
      }, 3000)
    }
  }

  const quickActionMuteVideo = async (): Promise<void> => {
    if (!file || file.type !== 'video' || quickActionStatus === 'saving') return

    setQuickActionStatus('saving')
    try {
      const outputDirectory = await window.api.selectTransformOutputDirectory()
      if (!outputDirectory) {
        setQuickActionStatus('idle')
        return
      }

      await window.api.transformMedia({
        fileIds: [file.id],
        outputDirectory,
        options: {
          image: {
            mode: 'long_edge',
            longEdge: 2048,
            format: 'jpeg',
            quality: 92,
            skipUpscale: true
          },
          video: { mode: 'mute_video' }
        }
      })
      setQuickActionStatus('queued')
      quickActionResetTimer.current = setTimeout(() => {
        quickActionResetTimer.current = null
        setQuickActionStatus('idle')
      }, 3000)
    } catch {
      setQuickActionStatus('error')
      quickActionResetTimer.current = setTimeout(() => {
        quickActionResetTimer.current = null
        setQuickActionStatus('idle')
      }, 3000)
    }
  }

  const applyImageAdjustments = async (): Promise<void> => {
    if (!file || file.type !== 'image' || quickActionStatus === 'saving') return

    const normalizedRotate = previewRotate % 360
    if (normalizedRotate === 0 && !previewFlipHorizontal && !previewFlipVertical) return

    setQuickActionStatus('saving')
    try {
      const outputDirectory = await window.api.selectTransformOutputDirectory()
      if (!outputDirectory) {
        setQuickActionStatus('idle')
        return
      }

      await window.api.transformMedia({
        fileIds: [file.id],
        outputDirectory,
        options: {
          image: {
            mode: 'adjust_image',
            ...(normalizedRotate !== 0 ? { rotate: normalizedRotate } : {}),
            ...(previewFlipHorizontal ? { flipHorizontal: true } : {}),
            ...(previewFlipVertical ? { flipVertical: true } : {}),
            format: 'source',
            quality: 95
          },
          video: { mode: 'remux' }
        }
      })
      setQuickActionStatus('queued')
      setPreviewRotate(0)
      setPreviewFlipHorizontal(false)
      setPreviewFlipVertical(false)
      quickActionResetTimer.current = setTimeout(() => {
        quickActionResetTimer.current = null
        setQuickActionStatus('idle')
      }, 3000)
    } catch {
      setQuickActionStatus('error')
      quickActionResetTimer.current = setTimeout(() => {
        quickActionResetTimer.current = null
        setQuickActionStatus('idle')
      }, 3000)
    }
  }

  const discardImageAdjustments = (): void => {
    setPreviewRotate(0)
    setPreviewFlipHorizontal(false)
    setPreviewFlipVertical(false)
  }

  if (!viewingId || !file) return null

  const hasPendingImageChanges = previewRotate % 360 !== 0 || previewFlipHorizontal || previewFlipVertical

  return (
    <div
      ref={dialogRef}
      role="dialog"
      aria-modal="true"
      aria-label={`Viewing ${file.filename}`}
      tabIndex={-1}
      className="fixed inset-0 z-50 flex bg-black/95 outline-none"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) closeViewer()
      }}
    >
      <div className="pointer-events-none absolute inset-x-0 top-0 z-10 h-28 bg-gradient-to-b from-black/85 to-transparent" />

      <div className="pointer-events-none absolute left-4 top-4 z-20 max-w-[calc(100%-8rem)] sm:left-6 sm:top-5">
        <p className="truncate text-sm font-medium text-white" title={file.filename}>{file.filename}</p>
        <p className="mt-1 text-[10px] uppercase tracking-wider text-white/55">
          {file.type} {currentIndex >= 0 ? `- ${currentIndex + 1} of ${activeIds.length}` : ''}
        </p>
      </div>

      <Button
        type="button"
        variant="secondary"
        size="icon"
        className="absolute right-4 top-14 z-30 bg-black/65 text-white shadow-lg hover:bg-white hover:text-black"
        onClick={closeViewer}
        title="Close viewer"
        aria-label="Close viewer"
      >
        <X className="h-5 w-5" />
      </Button>

      <ViewerNavigationButton
        direction="previous"
        disabled={!canNavigate}
        onClick={viewPrevious}
      />
      <ViewerNavigationButton
        direction="next"
        disabled={!canNavigate}
        onClick={viewNext}
      />

      <div className={`flex min-h-0 min-w-0 flex-1 items-center justify-center px-16 pt-20 sm:px-24 ${trimMode && file?.type === 'video' ? 'pb-[280px]' : 'pb-24'}`}>
        {mediaFailed ? (
          <div className="text-center text-white/70">
            <AlertTriangle className="mx-auto h-9 w-9 text-amber-400" />
            <p className="mt-3 text-sm font-medium text-white">Unable to display this file</p>
            <p className="mt-1 text-xs text-white/50">The media may be corrupt or use an unsupported codec.</p>
          </div>
        ) : file.type === 'image' ? (
          cropMode ? (
            <ReactCrop
              crop={crop}
              onChange={(c) => setCrop(c)}
              onComplete={(c) => setCompletedCrop(c)}
              className="max-h-full max-w-full"
            >
              <img
                key={file.id}
                ref={imageRef}
                src={sourceUrl}
                alt={file.filename}
                decoding="async"
                className="max-h-full max-w-full object-contain"
                style={{
                  transform: `rotate(${previewRotate}deg) scaleX(${previewFlipHorizontal ? -1 : 1}) scaleY(${previewFlipVertical ? -1 : 1})`,
                  transition: 'transform 0.2s ease-in-out'
                }}
                onError={() => setMediaFailed(true)}
              />
            </ReactCrop>
          ) : (
            <img
              key={file.id}
              ref={imageRef}
              src={sourceUrl}
              alt={file.filename}
              decoding="async"
              className="max-h-full max-w-full object-contain"
              style={{
                transform: `rotate(${previewRotate}deg) scaleX(${previewFlipHorizontal ? -1 : 1}) scaleY(${previewFlipVertical ? -1 : 1})`,
                transition: 'transform 0.2s ease-in-out'
              }}
              onError={() => setMediaFailed(true)}
            />
          )
        ) : (
          <video
            key={file.id}
            ref={videoRef}
            src={sourceUrl}
            controls
            loop
            playsInline
            className="max-h-full max-w-full bg-black object-contain"
            onLoadedMetadata={handleVideoMetadata}
            onTimeUpdate={handleVideoTimeUpdate}
            onError={() => setMediaFailed(true)}
          />
        )}
      </div>

      {file.type === 'image' && !cropMode && (
        <ImageToolbar
          onCrop={toggleCropMode}
          onRotateLeft={() => setPreviewRotate((prev) => prev - 90)}
          onRotateRight={() => setPreviewRotate((prev) => prev + 90)}
          onFlipHorizontal={() => setPreviewFlipHorizontal((prev) => !prev)}
          onFlipVertical={() => setPreviewFlipVertical((prev) => !prev)}
          hasPendingChanges={hasPendingImageChanges}
          onApply={() => void applyImageAdjustments()}
          onDiscard={discardImageAdjustments}
          quickActionStatus={quickActionStatus}
        />
      )}

      {file.type === 'image' && cropMode && (
        <div className="pointer-events-auto absolute inset-x-4 bottom-4 z-30 mx-auto max-w-3xl rounded-xl border border-white/15 bg-black/85 p-4 shadow-2xl backdrop-blur-md sm:inset-x-8 sm:p-5">
          <div className="flex items-center justify-between gap-3">
            <div className="flex min-w-0 items-center gap-2 text-white">
              <CropIcon className="size-4 shrink-0 text-primary" />
              <span className="truncate text-xs font-medium">Crop image</span>
              {completedCrop && completedCrop.width > 0 && completedCrop.height > 0 && imageRef.current && (
                <span className="font-mono text-[10px] text-white/55">
                  {Math.round(completedCrop.width * (imageRef.current.naturalWidth / imageRef.current.width))} x{' '}
                  {Math.round(completedCrop.height * (imageRef.current.naturalHeight / imageRef.current.height))} px
                </span>
              )}
            </div>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-7 px-2 text-[10px] text-white/65 hover:bg-white/10 hover:text-white"
              onClick={toggleCropMode}
            >
              Close
            </Button>
          </div>

          <div className="mt-4 flex flex-wrap items-center justify-between gap-2">
            <p className="text-[10px] text-white/50">
              Drag to select the area you want to export.
            </p>
            <Button
              type="button"
              size="sm"
              className="gap-2"
              disabled={!completedCrop || completedCrop.width < 1 || completedCrop.height < 1 || cropStatus === 'saving'}
              onClick={() => void exportCroppedImage()}
            >
              {cropStatus === 'saving'
                ? <LoaderCircle className="size-3.5 animate-spin" />
                : cropStatus === 'queued'
                  ? <Check className="size-3.5" />
                  : <CropIcon className="size-3.5" />}
              {cropStatus === 'saving'
                ? 'Exporting...'
                : cropStatus === 'queued'
                  ? 'Crop queued'
                  : 'Export Cropped Image'}
            </Button>
          </div>
          {cropStatus === 'error' && (
            <p className="mt-2 text-right text-[10px] text-destructive-foreground" role="alert">
              Choose a valid crop area and try again.
            </p>
          )}
        </div>
      )}

      {file.type === 'video' && !trimMode && (
        <VideoToolbar
          snapshotStatus={snapshotStatus}
          onSnapshot={() => void takeSnapshot()}
          onTrim={toggleTrimMode}
          onMute={() => void quickActionMuteVideo()}
          quickActionStatus={quickActionStatus}
        />
      )}

      {file.type === 'video' && trimMode && (
        <div className="pointer-events-auto fixed inset-x-0 bottom-0 z-30 h-[240px] border-t border-white/15 bg-gray-950">
          <div className="flex h-full flex-col">
            <div className="flex items-center justify-between border-b border-white/10 px-4 py-2">
              <div className="flex items-center gap-2 text-white">
                <Scissors className="size-4 text-cyan-400" />
                <span className="text-xs font-medium">Pro Trim</span>
                <span className="ml-2 rounded border border-white/20 bg-white/10 px-1.5 py-0.5 font-mono text-[9px] text-white/70">I</span>
                <span className="text-[9px] text-white/50">Mark In</span>
                <span className="ml-3 rounded border border-white/20 bg-white/10 px-1.5 py-0.5 font-mono text-[9px] text-white/70">O</span>
                <span className="text-[9px] text-white/50">Mark Out</span>
                <span className="ml-3 rounded border border-white/20 bg-white/10 px-1.5 py-0.5 font-mono text-[9px] text-white/70">Space</span>
                <span className="text-[9px] text-white/50">Play/Pause</span>
              </div>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-7 px-2 text-[10px] text-white/65 hover:bg-white/10 hover:text-white"
                onClick={toggleTrimMode}
              >
                Close
              </Button>
            </div>

            <div className="relative flex-1 overflow-hidden bg-gradient-to-br from-gray-900 via-gray-950 to-black">
              <div className="absolute inset-0 flex items-center justify-center px-4">
                <div
                  ref={timelineRef}
                  className="relative h-20 w-full max-w-5xl cursor-pointer overflow-hidden"
                  style={{
                    boxShadow: 'inset 0 2px 8px rgba(0,0,0,0.3)'
                  }}
                  onMouseDown={handleTimelineMouseDown}
                  onClick={handleTimelineClick}
                >
                  {thumbnails.length > 0 ? (
                    <div className="absolute inset-0 flex">
                      {thumbnails.map((thumb, index) => (
                        <img
                          key={index}
                          src={thumb}
                          alt=""
                          className="h-full flex-1 object-cover"
                          style={{ width: `${100 / thumbnails.length}%` }}
                        />
                      ))}
                    </div>
                  ) : (
                    <div
                      className="absolute inset-0"
                      style={{
                        background: 'linear-gradient(90deg, #0f172a 0%, #1e293b 25%, #334155 50%, #1e293b 75%, #0f172a 100%)'
                      }}
                    />
                  )}

                  <div
                    className="pointer-events-none absolute inset-y-0 left-0 bg-black/60"
                    style={{
                      width: `${(trimRange[0] / (videoDuration || 1)) * 100}%`
                    }}
                  />
                  <div
                    className="pointer-events-none absolute inset-y-0 right-0 bg-black/60"
                    style={{
                      left: `${(trimRange[1] / (videoDuration || 1)) * 100}%`
                    }}
                  />

                  <div
                    className="pointer-events-none absolute inset-y-0 border-2 border-cyan-400"
                    style={{
                      left: `${(trimRange[0] / (videoDuration || 1)) * 100}%`,
                      width: `${((trimRange[1] - trimRange[0]) / (videoDuration || 1)) * 100}%`
                    }}
                  >
                    <div className="absolute left-0 top-0 h-full w-3 cursor-ew-resize bg-cyan-400" />
                    <div className="absolute right-0 top-0 h-full w-3 cursor-ew-resize bg-cyan-400" />
                  </div>

                  <div
                    className="pointer-events-none absolute inset-y-0 w-0.5 bg-white shadow-lg"
                    style={{
                      left: `${(currentTime / (videoDuration || 1)) * 100}%`
                    }}
                  >
                    <div className="absolute -top-1 left-1/2 h-3 w-3 -translate-x-1/2 rounded-full bg-white shadow-lg" />
                  </div>
                </div>
              </div>
            </div>

            <div className="border-t border-white/10 bg-gray-950/90 px-4 py-3">
              <div className="mx-auto flex max-w-5xl items-center justify-between gap-4">
                <div className="flex items-center gap-2">
                  <span className="text-[10px] font-medium text-white/60">In</span>
                  <div className="flex items-center gap-1">
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="h-6 w-6 text-white/50 hover:bg-white/10 hover:text-white"
                      onClick={() => nudgeTrimStart(-0.1)}
                      disabled={videoDuration <= 0}
                      title="Nudge -0.1s"
                    >
                      <ChevronLeft className="size-3" />
                    </Button>
                    {editingTrimStart ? (
                      <input
                        type="number"
                        step="0.1"
                        min="0"
                        max={trimRange[1] - 0.1}
                        value={trimRange[0].toFixed(1)}
                        onChange={(e) => setTrimStartManual(parseFloat(e.target.value) || 0)}
                        onBlur={() => setEditingTrimStart(false)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') setEditingTrimStart(false)
                          if (e.key === 'Escape') setEditingTrimStart(false)
                        }}
                        autoFocus
                        className="w-20 rounded bg-white/10 px-2 py-1 font-mono text-[11px] text-white outline-none ring-1 ring-cyan-400/40 focus:ring-cyan-400"
                      />
                    ) : (
                      <button
                        onClick={() => setEditingTrimStart(true)}
                        className="rounded px-2 py-1 font-mono text-[11px] text-cyan-400 hover:bg-white/10"
                        title="Click to edit"
                      >
                        {formatTimecode(trimRange[0])}
                      </button>
                    )}
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="h-6 w-6 text-white/50 hover:bg-white/10 hover:text-white"
                      onClick={() => nudgeTrimStart(0.1)}
                      disabled={videoDuration <= 0}
                      title="Nudge +0.1s"
                    >
                      <ChevronRight className="size-3" />
                    </Button>
                  </div>
                </div>

                <Button
                  type="button"
                  size="sm"
                  className="gap-2 bg-cyan-500 text-black hover:bg-cyan-400"
                  disabled={videoDuration <= 0 || trimStatus === 'saving'}
                  onClick={() => void exportTrimmedVideo()}
                >
                  {trimStatus === 'saving'
                    ? <LoaderCircle className="size-3.5 animate-spin" />
                    : trimStatus === 'queued'
                      ? <Check className="size-3.5" />
                      : <Scissors className="size-3.5" />}
                  {trimStatus === 'saving'
                    ? 'Exporting...'
                    : trimStatus === 'queued'
                      ? 'Queued'
                      : 'Export'}
                </Button>

                <div className="flex items-center gap-2">
                  <span className="text-[10px] font-medium text-white/60">Out</span>
                  <div className="flex items-center gap-1">
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="h-6 w-6 text-white/50 hover:bg-white/10 hover:text-white"
                      onClick={() => nudgeTrimEnd(-0.1)}
                      disabled={videoDuration <= 0}
                      title="Nudge -0.1s"
                    >
                      <ChevronLeft className="size-3" />
                    </Button>
                    {editingTrimEnd ? (
                      <input
                        type="number"
                        step="0.1"
                        min={trimRange[0] + 0.1}
                        max={videoDuration}
                        value={trimRange[1].toFixed(1)}
                        onChange={(e) => setTrimEndManual(parseFloat(e.target.value) || 0)}
                        onBlur={() => setEditingTrimEnd(false)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') setEditingTrimEnd(false)
                          if (e.key === 'Escape') setEditingTrimEnd(false)
                        }}
                        autoFocus
                        className="w-20 rounded bg-white/10 px-2 py-1 font-mono text-[11px] text-white outline-none ring-1 ring-cyan-400/40 focus:ring-cyan-400"
                      />
                    ) : (
                      <button
                        onClick={() => setEditingTrimEnd(true)}
                        className="rounded px-2 py-1 font-mono text-[11px] text-cyan-400 hover:bg-white/10"
                        title="Click to edit"
                      >
                        {formatTimecode(trimRange[1])}
                      </button>
                    )}
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="h-6 w-6 text-white/50 hover:bg-white/10 hover:text-white"
                      onClick={() => nudgeTrimEnd(0.1)}
                      disabled={videoDuration <= 0}
                      title="Nudge +0.1s"
                    >
                      <ChevronRight className="size-3" />
                    </Button>
                  </div>
                </div>
              </div>
              {trimStatus === 'error' && (
                <p className="mt-2 text-center text-[10px] text-destructive-foreground" role="alert">
                  Choose a valid video range and try again.
                </p>
              )}
            </div>
          </div>
        </div>
      )}

      {file.type === 'video' && !trimMode && snapshotStatus !== 'idle' && (
        <p
          className={`pointer-events-none absolute bottom-20 left-1/2 z-30 -translate-x-1/2 rounded-md border px-3 py-1.5 text-[10px] shadow-lg ${
            snapshotStatus === 'error'
              ? 'border-destructive/40 bg-destructive/15 text-destructive-foreground'
              : 'border-white/15 bg-black/80 text-white/80'
          }`}
          role="status"
          aria-live="polite"
        >
          {snapshotStatus === 'saving'
            ? 'Saving snapshot...'
            : snapshotStatus === 'queued'
              ? 'Snapshot queued'
              : 'Unable to save snapshot'}
        </p>
      )}

      {quickActionStatus !== 'idle' && (
        <p
          className={`pointer-events-none absolute bottom-4 left-1/2 z-30 -translate-x-1/2 rounded-md border px-3 py-1.5 text-[10px] shadow-lg ${
            quickActionStatus === 'error'
              ? 'border-destructive/40 bg-destructive/15 text-destructive-foreground'
              : 'border-white/15 bg-black/80 text-white/80'
          }`}
          role="status"
          aria-live="polite"
        >
          {quickActionStatus === 'saving'
            ? 'Processing...'
            : quickActionStatus === 'queued'
              ? 'Export queued'
              : 'Unable to process'}
        </p>
      )}

      <div className="pointer-events-none absolute inset-x-0 bottom-0 z-10 bg-gradient-to-t from-black via-black/80 to-transparent px-5 pb-5 pt-16 sm:px-8">
        <div className="mx-auto flex max-w-5xl items-end gap-4 text-white">
          <div className="grid h-9 w-9 shrink-0 place-items-center rounded-md bg-white/10">
            {file.type === 'image' ? <FileImage className="h-4 w-4" /> : <Film className="h-4 w-4" />}
          </div>
          <div className="min-w-0">
            <p className="truncate text-xs font-medium" title={file.filename}>{file.filename}</p>
            <p className="mt-1 font-mono text-[10px] text-white/55">
              {formatViewerMetadata(file)}
            </p>
            {file.tags.length > 0 && (
              <div className="mt-2 flex max-w-full flex-wrap gap-1.5">
                {file.tags.map((tag) => (
                  <span
                    key={tag}
                    className="max-w-40 truncate rounded-md border border-white/15 bg-white/10 px-2 py-1 text-[9px] text-white/75"
                    title={tag}
                  >
                    {tag}
                  </span>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

function ImageToolbar({
  onCrop,
  onRotateLeft,
  onRotateRight,
  onFlipHorizontal,
  onFlipVertical,
  hasPendingChanges,
  onApply,
  onDiscard,
  quickActionStatus
}: {
  onCrop: () => void
  onRotateLeft: () => void
  onRotateRight: () => void
  onFlipHorizontal: () => void
  onFlipVertical: () => void
  hasPendingChanges: boolean
  onApply: () => void
  onDiscard: () => void
  quickActionStatus: 'idle' | 'saving' | 'queued' | 'error'
}): JSX.Element {
  const isProcessing = quickActionStatus === 'saving'

  return (
    <div className="pointer-events-auto absolute bottom-20 left-1/2 z-30 flex -translate-x-1/2 items-center gap-2 rounded-xl border border-white/15 bg-black/75 p-2 shadow-xl backdrop-blur-md">
      <Button
        type="button"
        variant="secondary"
        size="sm"
        className="gap-2 bg-white/10 text-white hover:bg-white hover:text-black"
        onClick={onRotateLeft}
        disabled={isProcessing}
        title="Rotate left 90°"
      >
        <RotateCcw className="size-3.5" />
        Rotate Left
      </Button>
      <Button
        type="button"
        variant="secondary"
        size="sm"
        className="gap-2 bg-white/10 text-white hover:bg-white hover:text-black"
        onClick={onRotateRight}
        disabled={isProcessing}
        title="Rotate right 90°"
      >
        <RotateCw className="size-3.5" />
        Rotate Right
      </Button>
      <Button
        type="button"
        variant="secondary"
        size="sm"
        className="gap-2 bg-white/10 text-white hover:bg-white hover:text-black"
        onClick={onFlipHorizontal}
        disabled={isProcessing}
        title="Flip horizontally"
      >
        <FlipHorizontal className="size-3.5" />
        Flip H
      </Button>
      <Button
        type="button"
        variant="secondary"
        size="sm"
        className="gap-2 bg-white/10 text-white hover:bg-white hover:text-black"
        onClick={onFlipVertical}
        disabled={isProcessing}
        title="Flip vertically"
      >
        <FlipVertical className="size-3.5" />
        Flip V
      </Button>
      <div className="mx-1 h-6 w-px bg-white/15" />
      <Button
        type="button"
        variant="secondary"
        size="sm"
        className="gap-2 bg-primary/90 text-primary-foreground hover:bg-primary disabled:cursor-not-allowed disabled:opacity-50"
        onClick={onCrop}
        disabled={isProcessing || hasPendingChanges}
        title={hasPendingChanges ? "Apply or discard changes before cropping" : "Open visual crop editor"}
      >
        <CropIcon className="size-3.5" />
        Crop
      </Button>
      {hasPendingChanges && (
        <>
          <div className="mx-1 h-6 w-px bg-amber-500/50" />
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="gap-2 text-white/65 hover:bg-white/10 hover:text-white"
            onClick={onDiscard}
            disabled={isProcessing}
            title="Discard changes"
          >
            <X className="size-3.5" />
            Discard
          </Button>
          <Button
            type="button"
            size="sm"
            className="gap-2 bg-amber-500 text-black hover:bg-amber-400"
            onClick={onApply}
            disabled={isProcessing}
            title="Export adjusted image"
          >
            {isProcessing ? (
              <LoaderCircle className="size-3.5 animate-spin" />
            ) : (
              <Check className="size-3.5" />
            )}
            Apply & Export
          </Button>
        </>
      )}
    </div>
  )
}

function VideoToolbar({
  snapshotStatus,
  onSnapshot,
  onTrim,
  onMute,
  quickActionStatus
}: {
  snapshotStatus: 'idle' | 'saving' | 'queued' | 'error'
  onSnapshot: () => void
  onTrim: () => void
  onMute: () => void
  quickActionStatus: 'idle' | 'saving' | 'queued' | 'error'
}): JSX.Element {
  const isProcessing = quickActionStatus === 'saving'

  return (
    <div className="pointer-events-auto absolute bottom-20 left-1/2 z-30 flex -translate-x-1/2 items-center gap-2 rounded-xl border border-white/15 bg-black/75 p-2 shadow-xl backdrop-blur-md">
      <Button
        type="button"
        variant="secondary"
        size="sm"
        className="gap-2 bg-white/10 text-white hover:bg-white hover:text-black"
        onClick={onSnapshot}
        disabled={snapshotStatus === 'saving'}
        title="Take snapshot at current time"
      >
        {snapshotStatus === 'saving'
          ? <LoaderCircle className="size-3.5 animate-spin" />
          : snapshotStatus === 'queued'
            ? <Check className="size-3.5" />
            : <Camera className="size-3.5" />}
        {snapshotStatus === 'queued' ? 'Queued' : 'Snapshot'}
      </Button>
      <Button
        type="button"
        variant="secondary"
        size="sm"
        className="gap-2 bg-white/10 text-white hover:bg-white hover:text-black"
        onClick={onMute}
        disabled={isProcessing}
        title="Remove audio track"
      >
        <VolumeX className="size-3.5" />
        Mute
      </Button>
      <div className="mx-1 h-6 w-px bg-white/15" />
      <Button
        type="button"
        variant="secondary"
        size="sm"
        className="gap-2 bg-primary/90 text-primary-foreground hover:bg-primary"
        onClick={onTrim}
        disabled={isProcessing}
        title="Open visual trim editor"
      >
        <Scissors className="size-3.5" />
        Trim
      </Button>
    </div>
  )
}

function ViewerNavigationButton({
  direction,
  disabled,
  onClick
}: {
  direction: 'previous' | 'next'
  disabled: boolean
  onClick: () => void
}): JSX.Element {
  const isPrevious = direction === 'previous'
  const Icon = isPrevious ? ChevronLeft : ChevronRight
  const label = isPrevious ? 'Previous media' : 'Next media'

  return (
    <Button
      type="button"
      variant="secondary"
      size="icon"
      disabled={disabled}
      className={`absolute top-1/2 z-20 h-11 w-11 -translate-y-1/2 bg-black/65 text-white shadow-lg hover:bg-white hover:text-black ${
        isPrevious ? 'left-3 sm:left-6' : 'right-3 sm:right-6'
      }`}
      onClick={onClick}
      title={label}
      aria-label={label}
    >
      <Icon className="h-6 w-6" />
    </Button>
  )
}

function formatResolution(width: number | null, height: number | null): string {
  return width && height ? `${width} x ${height}` : 'Resolution unavailable'
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  const unitIndex = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1)
  const value = bytes / 1024 ** unitIndex
  return `${value.toFixed(unitIndex === 0 ? 0 : 1)} ${units[unitIndex]}`
}

function formatViewerMetadata(file: {
  type: 'image' | 'video'
  width: number | null
  height: number | null
  size: number
  duration: number | null
  fps: number | null
}): string {
  const parts = [formatResolution(file.width, file.height), formatBytes(file.size)]
  if (file.type === 'video') {
    parts.push(file.duration !== null ? formatDuration(file.duration) : 'Duration unavailable')
    parts.push(file.fps !== null ? `${formatFps(file.fps)} FPS` : 'FPS unavailable')
  }
  return parts.join(' - ')
}

function formatDuration(seconds: number): string {
  const wholeSeconds = Math.max(0, Math.round(seconds))
  const hours = Math.floor(wholeSeconds / 3600)
  const minutes = Math.floor((wholeSeconds % 3600) / 60)
  const remainder = wholeSeconds % 60
  return hours > 0
    ? `${hours}:${minutes.toString().padStart(2, '0')}:${remainder.toString().padStart(2, '0')}`
    : `${minutes}:${remainder.toString().padStart(2, '0')}`
}

function formatTimecode(seconds: number): string {
  const totalSeconds = Math.max(0, Math.floor(seconds))
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const remainder = totalSeconds % 60
  return `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${remainder.toString().padStart(2, '0')}`
}

function formatFps(fps: number): string {
  return Number.isInteger(fps) ? fps.toFixed(0) : fps.toFixed(2)
}
