import { useMemo, useRef } from 'react'
import { Dialog } from '@base-ui/react/dialog'
import { Button as BaseButton } from '@base-ui/react/button'
import { BarChart, LineChart } from 'echarts/charts'
import {
  AriaComponent,
  DataZoomComponent,
  GridComponent,
  LegendComponent,
  MarkAreaComponent,
  MarkLineComponent,
  TooltipComponent
} from 'echarts/components'
import * as echarts from 'echarts/core'
import { CanvasRenderer } from 'echarts/renderers'
import ReactEChartsCore from 'echarts-for-react/lib/core'
import type { EChartsOption } from 'echarts'
import { Database, RotateCcw, X } from 'lucide-react'

import type { Incident, MonitorTarget, SeriesPoint, TargetHealth } from '@shared/types'
import { formatDateTime, formatLatency, formatPercent } from '../lib/format'
import { useI18n, type Locale } from '../lib/i18n'

echarts.use([
  AriaComponent,
  BarChart,
  CanvasRenderer,
  DataZoomComponent,
  GridComponent,
  LegendComponent,
  LineChart,
  MarkAreaComponent,
  MarkLineComponent,
  TooltipComponent
])

interface LatencyChartProps {
  from: number
  to: number
  incidents: Incident[]
  isError: boolean
  isLoading: boolean
  series: SeriesPoint[]
  targetHealth: TargetHealth[]
  targets: MonitorTarget[]
  theme: 'dark' | 'light'
}

function pointsWithGaps(points: SeriesPoint[], gapMs: number): Array<[number, number | null]> {
  const sorted = [...points].sort((left, right) => left.timestamp - right.timestamp)
  const data: Array<[number, number | null]> = []

  for (const point of sorted) {
    const previous = data.at(-1)
    if (previous && point.timestamp - previous[0] > gapMs) {
      data.push([previous[0] + 1, null])
    }
    data.push([point.timestamp, point.maxMs ?? point.avgMs])
  }

  return data
}

function lossPoints(points: SeriesPoint[]): Array<[number, number]> {
  return points
    .filter((point) => point.packetLossPct > 0)
    .map((point) => [point.timestamp, point.packetLossPct])
}

function seriesCoverage(points: SeriesPoint[]): { from: number; to: number } | null {
  const timestamps = points.map((point) => point.timestamp).filter(Number.isFinite)
  if (timestamps.length === 0) return null
  const from = Math.min(...timestamps)
  const to = Math.max(...timestamps)
  const minimumSpan = 60_000
  if (to - from < minimumSpan) return { from: to - minimumSpan, to }
  return { from, to }
}

function chartTime(value: number, locale: Locale, spanMs: number): string {
  return new Intl.DateTimeFormat(locale, {
    hour: '2-digit',
    minute: '2-digit',
    second: spanMs <= 5 * 60_000 ? '2-digit' : undefined
  }).format(value)
}

function ChartEmptyState({ children }: { children: React.ReactNode }) {
  return <div className="chart-state">{children}</div>
}

export function LatencyChart({
  from,
  to,
  incidents,
  isError,
  isLoading,
  series,
  targetHealth,
  targets,
  theme
}: LatencyChartProps) {
  const { locale, t } = useI18n()
  const chartRef = useRef<ReactEChartsCore>(null)
  const healthByTarget = useMemo(
    () => new Map(targetHealth.map((health) => [health.target.id, health])),
    [targetHealth]
  )

  const option = useMemo<EChartsOption>(() => {
    const chartStyle = theme === 'light'
      ? {
          axis: 'rgba(48, 69, 87, 0.26)',
          baseline: 'rgba(71, 89, 103, 0.46)',
          grid: 'rgba(48, 69, 87, 0.13)',
          loss: '#9c5d16',
          lossSoft: 'rgba(156, 93, 22, 0.44)',
          pointer: 'rgba(48, 69, 87, 0.28)',
          text: '#526777',
          tooltipBackground: '#ffffff',
          tooltipBorder: '#d3dce2',
          tooltipText: '#17212b',
          traces: ['#087ca5', '#536b7c', '#9c5d16', '#237654']
        }
      : {
          axis: 'rgba(159, 171, 185, 0.18)',
          baseline: 'rgba(184, 196, 210, 0.36)',
          grid: 'rgba(159, 171, 185, 0.12)',
          loss: '#d7a462',
          lossSoft: 'rgba(215, 164, 98, 0.46)',
          pointer: 'rgba(210, 220, 230, 0.28)',
          text: '#768392',
          tooltipBackground: '#151a20',
          tooltipBorder: '#313a45',
          tooltipText: '#eef2f6',
          traces: ['#64b9d4', '#b8c4d2', '#d7a462', '#8ec7aa']
        }
    const coverage = seriesCoverage(series)
    const axisFrom = coverage?.from ?? from
    const axisTo = coverage?.to ?? to
    const axisSpan = axisTo - axisFrom
    const incidentAreas = incidents
      .filter((incident) => incident.startedAt <= axisTo && (incident.endedAt ?? axisTo) >= axisFrom)
      .map((incident) => [
        {
          xAxis: Math.max(axisFrom, incident.startedAt),
          itemStyle: {
            color: incident.severity === 'critical' ? 'rgba(217, 123, 109, 0.14)' : 'rgba(215, 164, 98, 0.11)'
          }
        },
        { xAxis: Math.min(axisTo, incident.endedAt ?? axisTo) }
      ])

    const latencySeries = targets.map((target, index) => {
      const health = healthByTarget.get(target.id)
      const targetPoints = series.filter((point) => point.targetId === target.id)
      const expectedGap = Math.max(target.intervalMs * 2.5, 9_000)

      return {
        name: target.name,
        type: 'line',
        xAxisIndex: 0,
        yAxisIndex: 0,
        data: pointsWithGaps(targetPoints, expectedGap),
        connectNulls: false,
        showSymbol: targetPoints.length === 1,
        symbolSize: 5,
        smooth: false,
        sampling: 'lttb',
        emphasis: { focus: 'series' },
        tooltip: { valueFormatter: (value: unknown) => formatLatency(Number(value), locale) },
        lineStyle: {
          width: index === 0 ? 2.3 : 1.55,
          type: health?.status === 'down' ? 'dashed' : 'solid'
        },
        itemStyle: { color: chartStyle.traces[index % chartStyle.traces.length] },
        markArea:
          index === 0 && incidentAreas.length > 0
            ? {
                silent: true,
                label: { show: false },
                data: incidentAreas
              }
            : undefined,
        markLine:
          health?.baselineMs != null
            ? {
                silent: true,
                symbol: 'none',
                label: { show: false },
                lineStyle: { color: chartStyle.baseline, type: 'dashed', width: 1 },
                data: [{ yAxis: health.baselineMs }]
              }
            : undefined
      }
    })

    const packetLossSeries = targets.map((target, index) => ({
      name: `${target.name} packet loss`,
      type: 'bar',
      xAxisIndex: 1,
      yAxisIndex: 1,
      data: lossPoints(series.filter((point) => point.targetId === target.id)),
      barMaxWidth: 8,
      barGap: '-100%',
      silent: true,
      tooltip: { valueFormatter: (value: unknown) => formatPercent(Number(value), locale) },
      emphasis: { disabled: true },
      itemStyle: {
        color: index === 0 ? chartStyle.loss : chartStyle.lossSoft
      }
    }))

    return {
      animation: false,
      aria: {
        enabled: true,
        description: t('trace.aria')
      },
      color: chartStyle.traces,
      grid: [
        { left: 68, right: 40, top: 68, bottom: 74 },
        { left: 68, right: 40, height: 30, bottom: 34 }
      ],
      legend: {
        data: targets.map((target) => target.name),
        type: 'scroll',
        top: 4,
        left: 68,
        right: 40,
        padding: [4, 0],
        textStyle: { color: chartStyle.text, fontSize: 11, lineHeight: 16, fontFamily: 'Inter, ui-sans-serif, system-ui, sans-serif' },
        itemWidth: 18,
        itemHeight: 2,
        itemGap: 17
      },
      tooltip: {
        trigger: 'axis',
        confine: true,
        axisPointer: { type: 'line', lineStyle: { color: chartStyle.pointer } },
        backgroundColor: chartStyle.tooltipBackground,
        borderColor: chartStyle.tooltipBorder,
        borderWidth: 1,
        textStyle: { color: chartStyle.tooltipText, fontSize: 12 },
      },
      dataZoom: [
        {
          id: 'latency-inside-zoom',
          type: 'inside',
          xAxisIndex: [0, 1],
          filterMode: 'none',
          zoomOnMouseWheel: true,
          moveOnMouseMove: true
        }
      ],
      xAxis: [
        {
          type: 'time',
          gridIndex: 0,
          min: axisFrom,
          max: axisTo,
          axisLabel: { show: false },
          axisLine: { show: false },
          axisTick: { show: false },
          splitLine: { show: false }
        },
        {
          type: 'time',
          gridIndex: 1,
          min: axisFrom,
          max: axisTo,
          axisLabel: {
            color: chartStyle.text,
            fontSize: 10,
            hideOverlap: true,
            alignMinLabel: 'left',
            alignMaxLabel: 'right',
            margin: 11,
            formatter: (value: number) => chartTime(value, locale, axisSpan)
          },
          axisLine: { lineStyle: { color: chartStyle.axis } },
          axisTick: { show: false },
          splitLine: { show: false }
        }
      ],
      yAxis: [
        {
          type: 'value',
          gridIndex: 0,
          name: t('trace.rttAxis'),
          nameTextStyle: { color: chartStyle.text, fontSize: 10, lineHeight: 14 },
          axisLabel: { color: chartStyle.text, fontSize: 10, formatter: '{value}' },
          axisLine: { show: false },
          axisTick: { show: false },
          splitLine: { lineStyle: { color: chartStyle.grid } },
          min: (value: { min: number }) => Math.max(0, Math.floor(value.min * 0.8))
        },
        {
          type: 'value',
          gridIndex: 1,
          min: 0,
          max: 100,
          axisLabel: { color: chartStyle.text, fontSize: 10, formatter: (value: number) => (value === 100 ? t('trace.lossAxis') : '') },
          axisLine: { show: false },
          axisTick: { show: false },
          splitLine: { show: false }
        }
      ],
      series: [...latencySeries, ...packetLossSeries]
    } as EChartsOption
  }, [from, healthByTarget, incidents, locale, series, t, targets, theme, to])

  if (isLoading) {
    return <ChartEmptyState><span className="loading-line" />{t('trace.loading')}</ChartEmptyState>
  }

  if (isError) {
    return <ChartEmptyState>{t('trace.error')}</ChartEmptyState>
  }

  if (series.length === 0) {
    return <ChartEmptyState>{t('trace.empty')}</ChartEmptyState>
  }

  return (
    <div className="chart-shell">
      <p className="sr-only" id="latency-chart-description">
        {t('trace.description')}
      </p>
      <ReactEChartsCore
        ref={chartRef}
        aria-describedby="latency-chart-description"
        className="latency-chart"
        echarts={echarts}
        lazyUpdate
        notMerge={false}
        option={option}
        opts={{ renderer: 'canvas' }}
        role="img"
        style={{ height: 390, width: '100%' }}
      />
      <div className="chart-actions">
        <BaseButton
          className="quiet-action"
          onClick={() => chartRef.current?.getEchartsInstance().dispatchAction({ type: 'dataZoom', start: 0, end: 100 })}
          type="button"
        >
          <RotateCcw aria-hidden="true" size={14} />
          {t('trace.resetZoom')}
        </BaseButton>
        <SampleTableDialog series={series} targets={targets} />
      </div>
    </div>
  )
}

function SampleTableDialog({ series, targets }: { series: SeriesPoint[]; targets: MonitorTarget[] }) {
  const { locale, t } = useI18n()
  const targetById = useMemo(() => new Map(targets.map((target) => [target.id, target])), [targets])
  const recent = useMemo(
    () => [...series].sort((left, right) => right.timestamp - left.timestamp).slice(0, 80),
    [series]
  )

  return (
    <Dialog.Root>
      <Dialog.Trigger className="quiet-action" type="button">
        <Database aria-hidden="true" size={14} />
        {t('trace.dataTable')}
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Backdrop className="dialog-backdrop" />
        <Dialog.Viewport className="dialog-viewport">
          <Dialog.Popup className="dialog-popup">
            <div className="dialog-heading">
              <div>
                <Dialog.Title>{t('dialog.recentTitle')}</Dialog.Title>
                <Dialog.Description>{t('dialog.recentDescription')}</Dialog.Description>
              </div>
              <Dialog.Close aria-label={t('dialog.closeData')} className="icon-button" type="button">
                <X aria-hidden="true" size={17} />
              </Dialog.Close>
            </div>
            <div className="table-scroll">
              <table className="data-table">
                <thead>
                  <tr>
                    <th scope="col">{t('dialog.time')}</th>
                    <th scope="col">{t('dialog.target')}</th>
                    <th scope="col">{t('dialog.latency')}</th>
                    <th scope="col">{t('dialog.packetLoss')}</th>
                  </tr>
                </thead>
                <tbody>
                  {recent.map((point) => (
                    <tr key={`${point.targetId}-${point.timestamp}`}>
                      <td>{formatDateTime(point.timestamp, locale)}</td>
                      <td>{targetById.get(point.targetId)?.name ?? point.targetId}</td>
                      <td>{formatLatency(point.avgMs, locale)}</td>
                      <td>{formatPercent(point.packetLossPct, locale)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Dialog.Popup>
        </Dialog.Viewport>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
