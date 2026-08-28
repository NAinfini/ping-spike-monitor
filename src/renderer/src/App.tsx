import { useEffect, useMemo, useRef, useState } from 'react'
import { Button as BaseButton } from '@base-ui/react/button'
import { Dialog } from '@base-ui/react/dialog'
import { Select } from '@base-ui/react/select'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import {
  Activity,
  AlertTriangle,
  Check,
  ChevronDown,
  Clock3,
  Copy,
  Database,
  Globe2,
  Laptop,
  Languages,
  MapPinned,
  Menu,
  Minus,
  Moon,
  Network,
  RadioTower,
  RefreshCw,
  Router,
  Settings2,
  SlidersHorizontal,
  Square,
  Sun,
  UploadCloud,
  X
} from 'lucide-react'

import type {
  HealthStatus,
  Incident,
  MonitorApi,
  MonitorTarget,
  OverviewSnapshot,
  ProbeSample,
  SeriesPoint,
  TargetHealth,
  TargetKind
} from '@shared/types'
import { LatencyChart } from './components/LatencyChart'
import appLogo from '../../../resources/app-logo.png'
import {
  confidenceLabel,
  formatAge,
  formatDateTime,
  formatDuration,
  formatLatency,
  formatPercent,
  formatSignedLatency,
  healthLabel,
  incidentScopeLabel,
  probeSampleToPoint,
  targetKindLabel
} from './lib/format'
import { localeOptions, useI18n, type Locale } from './lib/i18n'

type ViewId = 'overview' | 'incidents' | 'regions' | 'speed' | 'settings'
type Theme = 'dark' | 'light'
type RangeKey = '15m' | '1h' | '6h' | '24h' | '7d' | '30d' | 'custom'

interface TimeWindow {
  from: number
  key: RangeKey
  to: number
}

const timeRangeOptions: ReadonlyArray<{ key: RangeKey; durationMs?: number }> = [
  { key: '15m', durationMs: 15 * 60_000 },
  { key: '1h', durationMs: 60 * 60_000 },
  { key: '6h', durationMs: 6 * 60 * 60_000 },
  { key: '24h', durationMs: 24 * 60 * 60_000 },
  { key: '7d', durationMs: 7 * 24 * 60 * 60_000 },
  { key: '30d', durationMs: 30 * 24 * 60 * 60_000 },
  { key: 'custom' }
]

const navItems: Array<{ id: ViewId; labelKey: string; icon: typeof Activity }> = [
  { id: 'overview', labelKey: 'nav.overview', icon: Activity },
  { id: 'incidents', labelKey: 'nav.incidents', icon: AlertTriangle },
  { id: 'regions', labelKey: 'nav.regions', icon: MapPinned },
  { id: 'speed', labelKey: 'nav.speed', icon: UploadCloud },
  { id: 'settings', labelKey: 'nav.settings', icon: Settings2 }
]

const statusPriority: Record<HealthStatus, number> = {
  unknown: 0,
  healthy: 1,
  warming: 2,
  degraded: 3,
  down: 4
}

function monitorApi(locale: Locale = 'en'): MonitorApi {
  if (!window.monitor) {
    throw new Error(locale === 'zh-CN'
      ? '安全监控 API 不可用。请重启桌面应用以重新连接采集器。'
      : locale === 'fr'
        ? 'L’API sécurisée du moniteur est indisponible. Redémarrez l’application pour reconnecter le collecteur.'
        : 'The secure monitor API is unavailable. Restart the desktop app to reconnect to the collector.')
  }
  return window.monitor
}

function createPresetWindow(key: Exclude<RangeKey, 'custom'>, to = Date.now()): TimeWindow {
  const option = timeRangeOptions.find((candidate) => candidate.key === key)
  const durationMs = option?.durationMs ?? 60 * 60_000
  return { key, from: to - durationMs, to }
}

function statusFromGroup(health: TargetHealth[]): HealthStatus {
  if (health.length === 0) return 'unknown'
  return health.reduce<HealthStatus>(
    (leading, item) => (statusPriority[item.status] > statusPriority[leading] ? item.status : leading),
    'unknown'
  )
}

function average(values: number[]): number | null {
  if (values.length === 0) return null
  return values.reduce((total, value) => total + value, 0) / values.length
}

function healthSummary(health: TargetHealth[]) {
  return {
    status: statusFromGroup(health),
    latency: average(health.flatMap((item) => (item.latestRttMs == null ? [] : [item.latestRttMs]))),
    baseline: average(health.flatMap((item) => (item.baselineMs == null ? [] : [item.baselineMs]))),
    loss: average(health.map((item) => item.packetLossPct)),
    count: health.length
  }
}

function useMonitorSubscriptions(
  seriesQueryKey: readonly unknown[],
  targetIds: string[],
  timeWindow: TimeWindow,
  isLive: boolean
) {
  const queryClient = useQueryClient()
  const targetIdsRef = useRef(targetIds)
  const timeWindowRef = useRef(timeWindow)
  const liveRef = useRef(isLive)

  targetIdsRef.current = targetIds
  timeWindowRef.current = timeWindow
  liveRef.current = isLive

  useEffect(() => {
    let scheduled: number | undefined
    const pending: ProbeSample[] = []
    let unsubscribeSample: (() => void) | undefined
    let unsubscribeOverview: (() => void) | undefined

    try {
      const api = monitorApi()
      unsubscribeOverview = api.onOverview((overview) => {
        queryClient.setQueryData<OverviewSnapshot>(['overview'], overview)
      })
      unsubscribeSample = api.onSample((sample) => {
        if (!liveRef.current || !targetIdsRef.current.includes(sample.targetId)) return
        pending.push(sample)
        if (scheduled != null) return

        scheduled = window.setTimeout(() => {
          const samples = pending.splice(0)
          scheduled = undefined
          const activeWindow = timeWindowRef.current
          queryClient.setQueryData<SeriesPoint[]>(seriesQueryKey, (existing) => {
            if (!existing) return existing
            const keyed = new Map(existing.map((point) => [`${point.targetId}:${point.timestamp}`, point]))
            for (const sample of samples) {
              if (sample.completedAt < activeWindow.from || sample.completedAt > activeWindow.to + 30_000) continue
              const point = probeSampleToPoint(sample)
              keyed.set(`${point.targetId}:${point.timestamp}`, point)
            }
            return [...keyed.values()]
              .filter((point) => point.timestamp >= activeWindow.from)
              .sort((left, right) => left.timestamp - right.timestamp)
          })
        }, 700)
      })
    } catch {
      // Query error surfaces own a recovery message. A preload API may not yet be ready during a renderer reload.
    }

    return () => {
      if (scheduled != null) window.clearTimeout(scheduled)
      unsubscribeSample?.()
      unsubscribeOverview?.()
    }
  }, [queryClient, seriesQueryKey])
}

function WindowTitlebar() {
  const { t } = useI18n()
  const [isMaximized, setIsMaximized] = useState(false)

  useEffect(() => window.windowControls.onMaximizedChange(setIsMaximized), [])

  const toggleMaximize = () => window.windowControls.toggleMaximize()

  return (
    <header
      aria-label={t('window.titlebar')}
      className="window-titlebar"
      onDoubleClick={(event) => {
        if ((event.target as HTMLElement).closest('.window-controls')) return
        toggleMaximize()
      }}
    >
      <div className="window-titlebar-brand">
        <img alt="" className="window-titlebar-logo" draggable={false} src={appLogo} />
        <span>Ping Spike Monitor</span>
      </div>
      <div className="window-controls">
        <button
          aria-label={t('window.minimize')}
          className="window-control"
          onClick={() => window.windowControls.minimize()}
          type="button"
        >
          <Minus aria-hidden="true" size={15} />
        </button>
        <button
          aria-label={isMaximized ? t('window.restore') : t('window.maximize')}
          className="window-control window-control-maximize"
          onClick={toggleMaximize}
          type="button"
        >
          {isMaximized
            ? <Copy aria-hidden="true" size={12} />
            : <Square aria-hidden="true" size={12} />}
        </button>
        <button
          aria-label={t('window.close')}
          className="window-control window-control-close"
          onClick={() => window.windowControls.close()}
          type="button"
        >
          <X aria-hidden="true" size={15} />
        </button>
      </div>
    </header>
  )
}

export function App() {
  const { locale, setLocale, t } = useI18n()
  const queryClient = useQueryClient()
  const [activeView, setActiveView] = useState<ViewId>('overview')
  const [isLive, setIsLive] = useState(true)
  const [timeWindow, setTimeWindow] = useState<TimeWindow>(() => createPresetWindow('1h'))
  const [theme, setTheme] = useState<Theme>(() => (window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark'))
  const [now, setNow] = useState(Date.now())
  const mainRef = useRef<HTMLElement>(null)
  const previousViewRef = useRef<ViewId>('overview')

  const overviewQuery = useQuery({
    queryKey: ['overview'],
    queryFn: () => monitorApi(locale).getOverview(),
    refetchInterval: 8_000
  })
  const targetsQuery = useQuery({
    queryKey: ['targets'],
    queryFn: () => monitorApi(locale).getTargets(),
    refetchInterval: 30_000
  })
  const incidentsQuery = useQuery({
    queryKey: ['incidents'],
    queryFn: () => monitorApi(locale).getIncidents(),
    refetchInterval: 20_000
  })

  const targetHealth = overviewQuery.data?.targetHealth ?? []
  const targets = targetsQuery.data ?? targetHealth.map((health) => health.target)
  const visibleTargetIds = useMemo(() => {
    const preferred = targetHealth
      .filter((health) => health.target.kind === 'gateway' || health.target.kind === 'public')
      .map((health) => health.target.id)
    const fallback = targets.map((target) => target.id)
    return (preferred.length > 0 ? preferred : fallback).slice(0, 4)
  }, [targetHealth, targets])
  const visibleTargets = useMemo(
    () => targets.filter((target) => visibleTargetIds.includes(target.id)),
    [targets, visibleTargetIds]
  )
  const visibleTargetHealth = useMemo(
    () => targetHealth.filter((health) => visibleTargetIds.includes(health.target.id)),
    [targetHealth, visibleTargetIds]
  )
  const visibleTargetIdKey = [...visibleTargetIds].sort().join(':')
  const seriesQueryKey = useMemo(
    () => ['series', timeWindow.from, timeWindow.to, visibleTargetIdKey] as const,
    [timeWindow.from, timeWindow.to, visibleTargetIdKey]
  )
  const seriesQuery = useQuery({
    queryKey: seriesQueryKey,
    queryFn: () => monitorApi(locale).getSeries({ from: timeWindow.from, to: timeWindow.to, targetIds: visibleTargetIds, maxPoints: 1_500 }),
    enabled: visibleTargetIds.length > 0,
    staleTime: 8_000
  })

  useMonitorSubscriptions(seriesQueryKey, visibleTargetIds, timeWindow, isLive)

  useEffect(() => {
    document.documentElement.dataset.theme = theme
  }, [theme])

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 10_000)
    return () => window.clearInterval(timer)
  }, [])

  useEffect(() => {
    if (!isLive) return
    const timer = window.setInterval(() => setTimeWindow(createPresetWindow('1h')), 30_000)
    return () => window.clearInterval(timer)
  }, [isLive])

  useEffect(() => {
    if (previousViewRef.current !== activeView) window.scrollTo({ top: 0 })
    previousViewRef.current = activeView
    mainRef.current?.focus({ preventScroll: true })
  }, [activeView])

  const allIncidents = incidentsQuery.data ?? overviewQuery.data?.recentIncidents ?? []
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ['overview'] })
    void queryClient.invalidateQueries({ queryKey: ['targets'] })
    void queryClient.invalidateQueries({ queryKey: ['incidents'] })
    void queryClient.invalidateQueries({ queryKey: seriesQueryKey })
  }
  const selectPreset = (key: RangeKey) => {
    if (key === 'custom') return
    setTimeWindow(createPresetWindow(key))
    setIsLive(false)
  }
  const returnToLive = () => {
    setTimeWindow(createPresetWindow('1h'))
    setIsLive(true)
  }
  const applyCustomRange = (from: number, to: number) => {
    setTimeWindow({ key: 'custom', from, to })
    setIsLive(false)
  }

  return (
    <div className="window-shell">
      <WindowTitlebar />
      <div className="app-frame">
        <a className="skip-link" href="#main-content">{t('app.skipContent')}</a>
        <aside className="side-rail" aria-label={t('nav.primary')}>
        <div className="brand-lockup">
          <span className="brand-mark" aria-hidden="true"><img alt="" draggable={false} src={appLogo} /></span>
          <span className="brand-name">Ping Spike<br />Monitor</span>
        </div>
        <nav className="nav-list" aria-label={t('nav.views')}>
          {navItems.map((item) => {
            const Icon = item.icon
            const current = activeView === item.id
            return (
              <BaseButton
                aria-current={current ? 'page' : undefined}
                className="nav-item"
                data-current={current ? 'true' : undefined}
                key={item.id}
                onClick={() => setActiveView(item.id)}
                type="button"
              >
                <Icon aria-hidden="true" size={17} />
                <span>{t(item.labelKey)}</span>
              </BaseButton>
            )
          })}
        </nav>
        <div className="rail-footnote">
          <StatusPill status={overviewQuery.data?.status ?? (overviewQuery.isError ? 'unknown' : 'warming')} />
          <span>{overviewQuery.data ? t('state.updated', { age: formatAge(overviewQuery.data.lastUpdatedAt, now, locale) }) : t('state.connecting')}</span>
        </div>
        </aside>

        <div className="workspace">
        <header className="topbar">
          <div className="topbar-context">
            <Menu aria-hidden="true" className="compact-menu" size={19} />
            <div>
              <p className="topbar-title">{t(navItems.find((item) => item.id === activeView)?.labelKey ?? 'nav.overview')}</p>
              <p className="topbar-subtitle">{overviewQuery.data ? t('state.lastSignal', { age: formatAge(overviewQuery.data.lastUpdatedAt, now, locale) }) : t('state.collectorPending')}</p>
            </div>
          </div>
          <div className="topbar-actions">
            <TimeRangeSelect onSelect={selectPreset} selected={timeWindow.key} />
            <CustomRangeDialog onApply={applyCustomRange} timeWindow={timeWindow} />
            {!isLive && (
              <BaseButton className="secondary-button" onClick={returnToLive} type="button">
                <RadioTower aria-hidden="true" size={15} />
                {t('action.returnLive')}
              </BaseButton>
            )}
            <LanguageSelect locale={locale} onChange={setLocale} />
            <BaseButton aria-label={t('action.refresh')} className="icon-button" onClick={refresh} type="button">
              <RefreshCw aria-hidden="true" size={16} />
            </BaseButton>
            <BaseButton
              aria-label={theme === 'dark' ? t('action.themeLight') : t('action.themeDark')}
              className="icon-button theme-button"
              onClick={() => setTheme((current) => (current === 'dark' ? 'light' : 'dark'))}
              type="button"
            >
              {theme === 'dark' ? <Sun aria-hidden="true" size={16} /> : <Moon aria-hidden="true" size={16} />}
            </BaseButton>
          </div>
        </header>

        <main className="app-main" id="main-content" ref={mainRef} tabIndex={-1}>
          {overviewQuery.isError && (
            <div className="collector-alert" role="status">
              <AlertTriangle aria-hidden="true" size={17} />
              <span>{t('app.collectorUnavailable')}</span>
              <BaseButton className="inline-action" onClick={refresh} type="button">{t('action.retry')}</BaseButton>
            </div>
          )}
          {activeView === 'overview' && (
            <OverviewView
              incidents={allIncidents}
              now={now}
              onNavigate={setActiveView}
              overview={overviewQuery.data}
              series={seriesQuery.data ?? []}
              seriesQuery={seriesQuery}
              targetHealth={targetHealth}
              targets={targets}
              theme={theme}
              timeWindow={timeWindow}
              visibleTargetHealth={visibleTargetHealth}
              visibleTargets={visibleTargets}
            />
          )}
          {activeView === 'incidents' && <IncidentsView incidents={allIncidents} now={now} targetHealth={targetHealth} />}
          {activeView === 'regions' && <RegionsView targetHealth={targetHealth} />}
          {activeView === 'speed' && <SpeedTestsView />}
          {activeView === 'settings' && <SettingsView isLoading={targetsQuery.isPending} targets={targets} />}
        </main>
        </div>
      </div>
    </div>
  )
}

function TimeRangeSelect({ onSelect, selected }: { onSelect: (key: RangeKey) => void; selected: RangeKey }) {
  const { t } = useI18n()
  const selectedOption = timeRangeOptions.find((option) => option.key === selected)
  return (
    <Select.Root
      items={timeRangeOptions.map((option) => ({ label: t(`range.${option.key}`), value: option.key }))}
      onValueChange={(value) => {
        if (value) onSelect(value)
      }}
      value={selected}
    >
      <Select.Trigger aria-label={t('action.selectRange')} className="range-trigger">
        <Clock3 aria-hidden="true" size={15} />
        <Select.Value>{selectedOption ? t(`range.${selectedOption.key}`) : t('range.1h')}</Select.Value>
        <Select.Icon><ChevronDown aria-hidden="true" size={15} /></Select.Icon>
      </Select.Trigger>
      <Select.Portal>
        <Select.Positioner align="end" className="select-positioner" sideOffset={8}>
          <Select.Popup className="select-popup">
            <Select.List>
              {timeRangeOptions.filter((option) => option.key !== 'custom').map((option) => (
                <Select.Item className="select-item" key={option.key} value={option.key}>
                  <Select.ItemText>{t(`range.${option.key}`)}</Select.ItemText>
                  <Select.ItemIndicator><Check aria-hidden="true" size={15} /></Select.ItemIndicator>
                </Select.Item>
              ))}
            </Select.List>
          </Select.Popup>
        </Select.Positioner>
      </Select.Portal>
    </Select.Root>
  )
}

function LanguageSelect({ locale, onChange }: { locale: Locale; onChange: (locale: Locale) => void }) {
  const { t } = useI18n()
  const selected = localeOptions.find((option) => option.value === locale)
  return (
    <Select.Root
      items={localeOptions}
      onValueChange={(value) => {
        if (value === 'en' || value === 'zh-CN' || value === 'fr') onChange(value)
      }}
      value={locale}
    >
      <Select.Trigger aria-label={t('action.language')} className="range-trigger language-trigger">
        <Languages aria-hidden="true" size={15} />
        <Select.Value>{selected?.label}</Select.Value>
        <Select.Icon><ChevronDown aria-hidden="true" size={15} /></Select.Icon>
      </Select.Trigger>
      <Select.Portal>
        <Select.Positioner align="end" className="select-positioner" sideOffset={8}>
          <Select.Popup className="select-popup">
            <Select.List>
              {localeOptions.map((option) => (
                <Select.Item className="select-item" key={option.value} value={option.value}>
                  <Select.ItemText>{option.label}</Select.ItemText>
                  <Select.ItemIndicator><Check aria-hidden="true" size={15} /></Select.ItemIndicator>
                </Select.Item>
              ))}
            </Select.List>
          </Select.Popup>
        </Select.Positioner>
      </Select.Portal>
    </Select.Root>
  )
}

function OverviewView({
  incidents,
  now,
  onNavigate,
  overview,
  series,
  seriesQuery,
  targetHealth,
  targets,
  theme,
  timeWindow,
  visibleTargetHealth,
  visibleTargets
}: {
  incidents: Incident[]
  now: number
  onNavigate: (view: ViewId) => void
  overview: OverviewSnapshot | undefined
  series: SeriesPoint[]
  seriesQuery: { isError: boolean; isPending: boolean }
  targetHealth: TargetHealth[]
  targets: MonitorTarget[]
  theme: Theme
  timeWindow: TimeWindow
  visibleTargetHealth: TargetHealth[]
  visibleTargets: MonitorTarget[]
}) {
  const { locale, t } = useI18n()
  const activeIncident = overview?.activeIncident ?? incidents.find((incident) => incident.endedAt == null) ?? null
  const coverage = getSeriesCoverage(series)
  const requestedRange = formatWindow(timeWindow.from, timeWindow.to, locale)
  const actualCoverage = coverage ? formatWindow(coverage.from, coverage.to, locale) : t('trace.noCoverage')

  return (
    <>
      <section className="view-heading">
        <div>
          <h1>{t('overview.title')}</h1>
          <p>{t('overview.subtitle')}</p>
        </div>
        <div className="heading-status">
          <StatusPill status={overview?.status ?? 'warming'} />
          <span>{overview ? t('overview.collectorStarted', { time: formatDateTime(overview.collectorStartedAt, locale) }) : t('overview.waitingHandshake')}</span>
        </div>
      </section>

      <HealthPath overview={overview} targetHealth={targetHealth} />

      {overview?.status === 'warming' && (
        <section className="warming-note" aria-label={t('warm.aria')}>
          <Activity aria-hidden="true" size={18} />
          <div>
            <strong>{t('warm.title')}</strong>
            <p>{t('warm.body')}</p>
          </div>
        </section>
      )}

      <div className="overview-grid">
        <section className="trace-panel" aria-labelledby="latency-heading">
          <div className="section-heading">
            <div>
              <h2 id="latency-heading">{t('trace.title')}</h2>
              <p>{t('trace.selectedTargets', { range: t(`range.${timeWindow.key}`) })}</p>
            </div>
            <div className="trace-legend" aria-label={t('trace.description')}>
              <span><i className="line-swatch" aria-hidden="true" />{t('trace.maxRtt')}</span>
              <span><i className="bar-swatch" aria-hidden="true" />{t('trace.packetLoss')}</span>
              <span><i className="dash-swatch" aria-hidden="true" />{t('trace.baseline')}</span>
            </div>
          </div>
          <div className="trace-window-summary">
            <span>{t('trace.requestedWindow', { range: requestedRange })}</span>
            <span>{t('trace.actualCoverage', { range: actualCoverage })}</span>
          </div>
          <LatencyChart
            from={timeWindow.from}
            incidents={incidents}
            isError={seriesQuery.isError}
            isLoading={seriesQuery.isPending}
            series={series}
            targetHealth={visibleTargetHealth}
            targets={visibleTargets}
            theme={theme}
            to={timeWindow.to}
          />
        </section>
        <IncidentEvidence incident={activeIncident} now={now} onNavigate={onNavigate} />
      </div>

      <section className="region-section" aria-labelledby="region-heading">
        <div className="section-heading">
          <div>
            <h2 id="region-heading">{t('regions.title')}</h2>
            <p>{t('regions.subtitle')}</p>
          </div>
          <BaseButton className="quiet-action" onClick={() => onNavigate('regions')} type="button">{t('regions.open')}</BaseButton>
        </div>
        <RegionMatrix targetHealth={targetHealth} />
      </section>
    </>
  )
}

function HealthPath({ overview, targetHealth }: { overview: OverviewSnapshot | undefined; targetHealth: TargetHealth[] }) {
  const { locale, t } = useI18n()
  const groups: Array<{ kinds: TargetKind[]; labelKey: string; Icon: typeof Activity; noteKey: string }> = [
    { kinds: [], labelKey: 'path.device', Icon: Laptop, noteKey: 'path.measurementOrigin' },
    { kinds: ['gateway'], labelKey: 'path.gateway', Icon: Router, noteKey: 'path.localLink' },
    { kinds: ['isp'], labelKey: 'path.isp', Icon: RadioTower, noteKey: 'path.firstUpstream' },
    { kinds: ['public'], labelKey: 'path.public', Icon: Globe2, noteKey: 'path.independentReachability' },
    { kinds: ['region'], labelKey: 'path.regions', Icon: MapPinned, noteKey: 'path.twoRequired' }
  ]

  return (
    <section className="health-path" aria-label={t('path.aria')}>
      {groups.map((group, index) => {
        const groupHealth = group.kinds.length === 0 ? [] : targetHealth.filter((item) => group.kinds.includes(item.target.kind))
        const summary = group.kinds.length === 0
          ? { status: overview ? 'healthy' as const : 'unknown' as const, latency: null, baseline: null, loss: null, count: 0 }
          : healthSummary(groupHealth)
        const Icon = group.Icon
        const detail = group.kinds.length === 0
          ? overview ? t('path.collectorConnected') : t('path.awaitingCollector')
          : summary.count === 0
            ? t('path.notConfigured')
            : summary.status === 'warming'
              ? t('path.establishingBaseline')
              : summary.latency == null
                ? t('path.noRecentRtt')
                : `${formatLatency(summary.latency, locale)} · ${t('path.loss', { loss: formatPercent(summary.loss, locale) })}`
        return (
          <div className="path-fragment" key={group.labelKey}>
            {index > 0 && <span aria-hidden="true" className="path-connector" />}
            <div className="path-node" data-status={summary.status}>
              <Icon aria-hidden="true" size={17} />
              <div>
                <span className="path-label">{t(group.labelKey)}</span>
                <strong>{detail}</strong>
                <span className="path-note">{t(group.noteKey)}</span>
              </div>
            </div>
          </div>
        )
      })}
    </section>
  )
}

function IncidentEvidence({ incident, now, onNavigate }: { incident: Incident | null; now: number; onNavigate: (view: ViewId) => void }) {
  const { locale, t } = useI18n()
  return (
    <aside className="evidence-panel" aria-labelledby="evidence-heading">
      <div className="section-heading compact-heading">
        <div>
          <h2 id="evidence-heading">{t('evidence.title')}</h2>
          <p>{t('evidence.subtitle')}</p>
        </div>
      </div>
      {incident ? (
        <>
          <div className="incident-callout" data-severity={incident.severity}>
            <span>{incident.severity === 'critical' ? t('evidence.critical') : t('evidence.warning')}</span>
            <strong>{incident.summary}</strong>
            <p>{incidentScopeLabel(incident.scope, locale)} · {formatDuration(incident.startedAt, incident.endedAt, now, locale)} · {t('evidence.confidence', { confidence: confidenceLabel(incident.confidence, locale) })}</p>
          </div>
          <ol className="evidence-list">
            {incident.evidence.map((item) => <li key={item}>{item}</li>)}
          </ol>
          <BaseButton className="secondary-button full-button" onClick={() => onNavigate('incidents')} type="button">{t('evidence.inspect')}</BaseButton>
        </>
      ) : (
        <div className="quiet-empty">
          <Network aria-hidden="true" size={20} />
          <strong>{t('evidence.noneTitle')}</strong>
          <p>{t('evidence.noneBody')}</p>
        </div>
      )}
    </aside>
  )
}

function RegionMatrix({ targetHealth }: { targetHealth: TargetHealth[] }) {
  const { locale, t } = useI18n()
  const regions = useMemo(() => groupRegions(targetHealth, t('common.unassignedRegion')), [targetHealth, t])
  if (regions.length === 0) {
    return <EmptyState icon={MapPinned} title={t('regions.emptyTitle')} message={t('regions.emptyBody')} />
  }

  return (
    <div className="region-matrix" role="list" aria-label={t('regions.aria')}>
      {regions.map(({ name, health }) => {
        const summary = healthSummary(health)
        const hasQuorum = health.length >= 2
        const status = hasQuorum ? summary.status : 'unknown'
        return (
          <div className="region-row" key={name} role="listitem">
            <div className="region-name"><MapPinned aria-hidden="true" size={16} /><span>{name}</span></div>
            <div className="region-metric"><span>{t('regions.coverage')}</span><strong>{t(health.length === 1 ? 'regions.endpointOne' : 'regions.endpointOther', { count: health.length })}</strong></div>
            <div className="region-metric"><span>{t('regions.currentRtt')}</span><strong>{formatLatency(summary.latency, locale)}</strong></div>
            <div className="region-metric"><span>{t('regions.relativeBaseline')}</span><strong>{summary.baseline == null || summary.latency == null ? '—' : formatSignedLatency(summary.latency - summary.baseline, locale)}</strong></div>
            <StatusPill detail={hasQuorum ? undefined : t('regions.needTwo')} status={status} />
          </div>
        )
      })}
    </div>
  )
}

function IncidentsView({ incidents, now, targetHealth }: { incidents: Incident[]; now: number; targetHealth: TargetHealth[] }) {
  const { locale, t } = useI18n()
  const [selectedId, setSelectedId] = useState<string | null>(incidents.find((incident) => incident.endedAt == null)?.id ?? incidents[0]?.id ?? null)
  const selected = incidents.find((incident) => incident.id === selectedId) ?? null

  useEffect(() => {
    if (selectedId == null && incidents[0]) setSelectedId(incidents[0].id)
  }, [incidents, selectedId])

  return (
    <section className="full-view">
      <div className="view-heading">
        <div>
          <h1>{t('incidents.title')}</h1>
          <p>{t('incidents.subtitle')}</p>
        </div>
      </div>
      {incidents.length === 0 ? (
        <EmptyState icon={AlertTriangle} title={t('incidents.emptyTitle')} message={t('incidents.emptyBody')} />
      ) : (
        <div className="incident-workbench">
          <div className="incident-list" role="list" aria-label={t('incidents.aria')}>
            {incidents.map((incident) => (
              <BaseButton
                aria-pressed={incident.id === selected?.id}
                className="incident-row"
                data-selected={incident.id === selected?.id ? 'true' : undefined}
                key={incident.id}
                onClick={() => setSelectedId(incident.id)}
                type="button"
              >
                <span className="incident-marker" data-severity={incident.severity} aria-hidden="true" />
                <span className="incident-row-main"><strong>{incident.summary}</strong><span>{incidentScopeLabel(incident.scope, locale)} · {formatDateTime(incident.startedAt, locale)}</span></span>
                <span className="incident-row-duration">{formatDuration(incident.startedAt, incident.endedAt, now, locale)}</span>
              </BaseButton>
            ))}
          </div>
          <IncidentDetail incident={selected} now={now} targetHealth={targetHealth} />
        </div>
      )}
    </section>
  )
}

function IncidentDetail({ incident, now, targetHealth }: { incident: Incident | null; now: number; targetHealth: TargetHealth[] }) {
  const { locale, t } = useI18n()
  if (!incident) return null
  const affected = incident.scope === 'region' && incident.region
    ? targetHealth.filter((health) => health.target.region === incident.region)
    : targetHealth
  return (
    <article className="incident-detail" aria-live="polite">
      <div className="incident-detail-heading">
        <div>
          <StatusPill detail={incident.confidence} status={incident.severity === 'critical' ? 'down' : 'degraded'} />
          <h2>{incident.summary}</h2>
          <p>{incidentScopeLabel(incident.scope, locale)}{incident.region ? ` · ${incident.region}` : ''} · {t('incidents.started', { time: formatDateTime(incident.startedAt, locale) })} · {formatDuration(incident.startedAt, incident.endedAt, now, locale)}</p>
        </div>
      </div>
      <div className="detail-columns">
        <section>
          <h3>{t('incidents.evidenceUsed')}</h3>
          <ul className="evidence-list">{incident.evidence.map((item) => <li key={item}>{item}</li>)}</ul>
        </section>
        <section>
          <h3>{t('incidents.measuredTargets')}</h3>
          <ul className="target-summary-list">
            {affected.slice(0, 6).map((health) => <li key={health.target.id}><span>{health.target.name}</span><span>{formatLatency(health.latestRttMs, locale)} · {t('path.loss', { loss: formatPercent(health.packetLossPct, locale) })}</span></li>)}
          </ul>
        </section>
      </div>
      <div className="route-placeholder">
        <RadioTower aria-hidden="true" size={17} />
        <div><strong>{t('incidents.routeTitle')}</strong><p>{t('incidents.routeBody')}</p></div>
      </div>
    </article>
  )
}

function RegionsView({ targetHealth }: { targetHealth: TargetHealth[] }) {
  const { locale, t } = useI18n()
  const regions = useMemo(() => groupRegions(targetHealth, t('common.unassignedRegion')), [targetHealth, t])
  return (
    <section className="full-view">
      <div className="view-heading">
        <div>
          <h1>{t('regionDetail.title')}</h1>
          <p>{t('regionDetail.subtitle')}</p>
        </div>
      </div>
      {regions.length === 0 ? (
        <EmptyState icon={MapPinned} title={t('regionDetail.emptyTitle')} message={t('regionDetail.emptyBody')} />
      ) : (
        <div className="region-detail-list">
          {regions.map(({ name, health }) => {
            const summary = healthSummary(health)
            const hasQuorum = health.length >= 2
            return (
              <section className="region-detail" key={name}>
                <div className="region-detail-head"><div><h2>{name}</h2><p>{t(health.length === 1 ? 'regions.endpointOne' : 'regions.endpointOther', { count: health.length })} · {hasQuorum ? t('regionDetail.assessmentAvailable') : t('regionDetail.assessmentNeedsEndpoint')}</p></div><StatusPill detail={hasQuorum ? undefined : t('regions.needTwo')} status={hasQuorum ? summary.status : 'unknown'} /></div>
                <div className="endpoint-table">
                  {health.map((item) => <div className="endpoint-row" key={item.target.id}><div><strong>{item.target.name}</strong><span>{item.target.address} · {item.target.method.toUpperCase()} · {t('regionDetail.everySeconds', { seconds: formatDuration(0, item.target.intervalMs, item.target.intervalMs, locale) })}</span></div><div><span>{t('regionDetail.current')}</span><strong>{formatLatency(item.latestRttMs, locale)}</strong></div><div><span>{t('regionDetail.baseline')}</span><strong>{formatLatency(item.baselineMs, locale)}</strong></div><div><span>{t('regionDetail.loss')}</span><strong>{formatPercent(item.packetLossPct, locale)}</strong></div><StatusPill status={item.status} /></div>)}
                </div>
              </section>
            )
          })}
        </div>
      )}
    </section>
  )
}

function SpeedTestsView() {
  const { t } = useI18n()
  return (
    <section className="full-view">
      <div className="view-heading">
        <div>
          <h1>{t('speed.title')}</h1>
          <p>{t('speed.subtitle')}</p>
        </div>
      </div>
      <section className="speed-prerequisite">
        <UploadCloud aria-hidden="true" size={26} />
        <div>
          <h2>{t('speed.emptyTitle')}</h2>
          <p>{t('speed.emptyBody')}</p>
        </div>
      </section>
      <div className="speed-guide-grid">
        <section><h2>{t('speed.internetTitle')}</h2><p>{t('speed.internetBody')}</p></section>
        <section><h2>{t('speed.lanTitle')}</h2><p>{t('speed.lanBody')}</p></section>
        <section><h2>{t('speed.regionTitle')}</h2><p>{t('speed.regionBody')}</p></section>
      </div>
    </section>
  )
}

function SettingsView({ isLoading, targets }: { isLoading: boolean; targets: MonitorTarget[] }) {
  const { locale, t } = useI18n()
  return (
    <section className="full-view">
      <div className="view-heading">
        <div>
          <h1>{t('settings.title')}</h1>
          <p>{t('settings.subtitle')}</p>
        </div>
      </div>
      {isLoading ? <div className="table-loading"><span className="loading-line" />{t('settings.loading')}</div> : targets.length === 0 ? (
        <EmptyState icon={SlidersHorizontal} title={t('settings.emptyTitle')} message={t('settings.emptyBody')} />
      ) : (
        <div className="settings-table" role="table" aria-label={t('settings.aria')}>
          <div className="settings-table-head" role="row"><span role="columnheader">{t('settings.target')}</span><span role="columnheader">{t('settings.layer')}</span><span role="columnheader">{t('settings.method')}</span><span role="columnheader">{t('settings.interval')}</span><span role="columnheader">{t('settings.status')}</span></div>
          {targets.map((target) => <div className="settings-table-row" key={target.id} role="row"><span role="cell"><strong>{target.name}</strong><small>{target.address}{target.region ? ` · ${target.region}` : ''}</small></span><span role="cell">{targetKindLabel(target.kind, locale)}</span><span role="cell">{target.method.toUpperCase()}</span><span role="cell">{formatDuration(0, target.intervalMs, target.intervalMs, locale)}</span><span role="cell">{target.enabled ? t('settings.enabled') : t('settings.paused')}</span></div>)}
        </div>
      )}
      <div className="settings-notice"><Database aria-hidden="true" size={17} /><p>{t('settings.notice')}</p></div>
    </section>
  )
}

function StatusPill({ detail, status }: { detail?: string | undefined; status: HealthStatus }) {
  const { locale } = useI18n()
  return <span className="status-pill" data-status={status}><span aria-hidden="true" className="status-dot" />{detail ?? healthLabel(status, locale)}</span>
}

function EmptyState({ icon: Icon, message, title }: { icon: typeof Activity; message: string; title: string }) {
  return <div className="empty-state"><Icon aria-hidden="true" size={23} /><strong>{title}</strong><p>{message}</p></div>
}

function groupRegions(targetHealth: TargetHealth[], unassignedRegion: string): Array<{ name: string; health: TargetHealth[] }> {
  const grouped = new Map<string, TargetHealth[]>()
  for (const item of targetHealth) {
    if (item.target.kind !== 'region') continue
    const name = item.target.region ?? unassignedRegion
    const current = grouped.get(name) ?? []
    current.push(item)
    grouped.set(name, current)
  }
  return [...grouped.entries()]
    .map(([name, health]) => ({ name, health: [...health].sort((left, right) => left.target.name.localeCompare(right.target.name)) }))
    .sort((left, right) => left.name.localeCompare(right.name))
}

function CustomRangeDialog({ onApply, timeWindow }: { onApply: (from: number, to: number) => void; timeWindow: TimeWindow }) {
  const { t } = useI18n()
  const [open, setOpen] = useState(false)
  const [fromValue, setFromValue] = useState(() => inputDateValue(timeWindow.from))
  const [toValue, setToValue] = useState(() => inputDateValue(timeWindow.to))
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!open) {
      setFromValue(inputDateValue(timeWindow.from))
      setToValue(inputDateValue(timeWindow.to))
      setError(null)
    }
  }, [open, timeWindow.from, timeWindow.to])

  const submit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const from = Date.parse(fromValue)
    const to = Date.parse(toValue)
    if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) {
      setError(t('dialog.invalidRange'))
      return
    }
    onApply(from, to)
    setOpen(false)
  }

  return (
    <Dialog.Root onOpenChange={setOpen} open={open}>
      <Dialog.Trigger className="icon-button range-custom" aria-label={t('action.chooseRange')} type="button"><Clock3 aria-hidden="true" size={16} /></Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Backdrop className="dialog-backdrop" />
        <Dialog.Viewport className="dialog-viewport">
          <Dialog.Popup className="dialog-popup compact-dialog">
            <div className="dialog-heading"><div><Dialog.Title>{t('dialog.customTitle')}</Dialog.Title><Dialog.Description>{t('dialog.customDescription')}</Dialog.Description></div><Dialog.Close aria-label={t('dialog.closeRange')} className="icon-button" type="button"><X aria-hidden="true" size={17} /></Dialog.Close></div>
            <form className="range-form" onSubmit={submit}>
              <label>{t('dialog.from')}<input onChange={(event) => setFromValue(event.target.value)} type="datetime-local" value={fromValue} /></label>
              <label>{t('dialog.to')}<input onChange={(event) => setToValue(event.target.value)} type="datetime-local" value={toValue} /></label>
              {error && <p className="form-error" role="alert">{error}</p>}
              <div className="dialog-actions"><Dialog.Close className="secondary-button" type="button">{t('dialog.cancel')}</Dialog.Close><BaseButton className="primary-button" type="submit">{t('dialog.apply')}</BaseButton></div>
            </form>
          </Dialog.Popup>
        </Dialog.Viewport>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

function inputDateValue(timestamp: number): string {
  const date = new Date(timestamp)
  const timezoneOffsetMs = date.getTimezoneOffset() * 60_000
  return new Date(timestamp - timezoneOffsetMs).toISOString().slice(0, 16)
}

function getSeriesCoverage(series: SeriesPoint[]): { from: number; to: number } | null {
  if (series.length === 0) return null
  const timestamps = series.map((point) => point.timestamp).filter(Number.isFinite)
  if (timestamps.length === 0) return null
  return { from: Math.min(...timestamps), to: Math.max(...timestamps) }
}

function formatWindow(from: number, to: number, locale: Locale): string {
  const includeSeconds = to - from <= 5 * 60_000
  return `${formatDateTime(from, locale, includeSeconds)}–${formatDateTime(to, locale, includeSeconds)}`
}
