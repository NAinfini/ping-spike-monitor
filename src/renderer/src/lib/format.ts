import type { HealthStatus, IncidentScope, ProbeSample } from '@shared/types'
import type { Locale } from './i18n'

const unitLabels: Record<Locale, { hour: string; minute: string; second: string; justNow: string }> = {
  en: { hour: 'h', minute: 'm', second: 's', justNow: 'Just now' },
  'zh-CN': { hour: '小时', minute: '分', second: '秒', justNow: '刚刚' },
  fr: { hour: 'h', minute: 'min', second: 's', justNow: 'À l’instant' }
}

const healthLabels: Record<Locale, Record<HealthStatus, string>> = {
  en: {
    healthy: 'Healthy',
    degraded: 'Degraded',
    down: 'Unavailable',
    warming: 'Learning baseline',
    unknown: 'Awaiting data'
  },
  'zh-CN': {
    healthy: '健康',
    degraded: '已降级',
    down: '不可用',
    warming: '正在学习基线',
    unknown: '等待数据'
  },
  fr: {
    healthy: 'Sain',
    degraded: 'Dégradé',
    down: 'Indisponible',
    warming: 'Référence en apprentissage',
    unknown: 'En attente de données'
  }
}

const scopeLabels: Record<Locale, Record<IncidentScope, string>> = {
  en: {
    local: 'Local network',
    isp: 'ISP path',
    internet: 'Public internet',
    region: 'Regional path',
    endpoint: 'Endpoint'
  },
  'zh-CN': {
    local: '本地网络',
    isp: 'ISP 路径',
    internet: '公共互联网',
    region: '区域路径',
    endpoint: '端点'
  },
  fr: {
    local: 'Réseau local',
    isp: 'Chemin FAI',
    internet: 'Internet public',
    region: 'Chemin régional',
    endpoint: 'Point terminal'
  }
}

const confidenceLabels: Record<Locale, Record<'low' | 'medium' | 'high', string>> = {
  en: { low: 'low', medium: 'medium', high: 'high' },
  'zh-CN': { low: '低', medium: '中', high: '高' },
  fr: { low: 'faible', medium: 'moyenne', high: 'élevée' }
}

const targetKindLabels: Record<Locale, Record<string, string>> = {
  en: { gateway: 'Gateway', public: 'Public', isp: 'ISP', region: 'Region', dns: 'DNS', https: 'HTTPS' },
  'zh-CN': { gateway: '网关', public: '公共', isp: 'ISP', region: '区域', dns: 'DNS', https: 'HTTPS' },
  fr: { gateway: 'Passerelle', public: 'Public', isp: 'FAI', region: 'Région', dns: 'DNS', https: 'HTTPS' }
}

function numberFormatter(locale: Locale, maximumFractionDigits = 0): Intl.NumberFormat {
  return new Intl.NumberFormat(locale, { maximumFractionDigits })
}

export function formatLatency(value: number | null | undefined, locale: Locale = 'en'): string {
  if (value == null || !Number.isFinite(value)) return '—'
  return `${numberFormatter(locale).format(Math.round(value))} ms`
}

export function formatSignedLatency(value: number | null | undefined, locale: Locale = 'en'): string {
  if (value == null || !Number.isFinite(value)) return '—'
  const rounded = Math.round(value)
  const sign = rounded > 0 ? '+' : ''
  return `${sign}${formatLatency(rounded, locale)}`
}

export function formatPercent(value: number | null | undefined, locale: Locale = 'en'): string {
  if (value == null || !Number.isFinite(value)) return '—'
  return new Intl.NumberFormat(locale, {
    maximumFractionDigits: value < 1 ? 1 : 0,
    style: 'percent'
  }).format(value / 100)
}

export function formatTime(value: number | null | undefined, locale: Locale = 'en'): string {
  if (value == null) return '—'
  return new Intl.DateTimeFormat(locale, {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  }).format(value)
}

export function formatDateTime(
  value: number | null | undefined,
  locale: Locale = 'en',
  includeSeconds = false
): string {
  if (value == null) return '—'
  return new Intl.DateTimeFormat(locale, {
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: includeSeconds ? '2-digit' : undefined,
    month: 'short'
  }).format(value)
}

export function formatAge(value: number | null | undefined, now = Date.now(), locale: Locale = 'en'): string {
  if (value == null) return locale === 'zh-CN' ? '尚无样本' : locale === 'fr' ? 'Aucun échantillon' : 'No sample yet'
  const seconds = Math.max(0, Math.round((now - value) / 1000))
  if (seconds < 5) return unitLabels[locale].justNow
  const relative = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' })
  if (seconds < 60) return relative.format(-seconds, 'second')
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return relative.format(-minutes, 'minute')
  return relative.format(-Math.round(minutes / 60), 'hour')
}

export function formatDuration(startedAt: number, endedAt: number | null, now = Date.now(), locale: Locale = 'en'): string {
  const durationMs = Math.max(0, (endedAt ?? now) - startedAt)
  const seconds = Math.round(durationMs / 1000)
  const units = unitLabels[locale]
  if (seconds < 60) return `${numberFormatter(locale).format(seconds)} ${units.second}`
  const minutes = Math.floor(seconds / 60)
  const remainingSeconds = seconds % 60
  if (minutes < 60) {
    const wholeMinutes = `${numberFormatter(locale).format(minutes)} ${units.minute}`
    return remainingSeconds === 0 ? wholeMinutes : `${wholeMinutes} ${numberFormatter(locale).format(remainingSeconds)} ${units.second}`
  }
  return `${numberFormatter(locale).format(Math.floor(minutes / 60))} ${units.hour} ${numberFormatter(locale).format(minutes % 60)} ${units.minute}`
}

export function healthLabel(status: HealthStatus, locale: Locale = 'en'): string {
  return healthLabels[locale][status]
}

export function incidentScopeLabel(scope: IncidentScope, locale: Locale = 'en'): string {
  return scopeLabels[locale][scope]
}

export function confidenceLabel(confidence: 'low' | 'medium' | 'high', locale: Locale = 'en'): string {
  return confidenceLabels[locale][confidence]
}

export function targetKindLabel(kind: string, locale: Locale = 'en'): string {
  return targetKindLabels[locale][kind] ?? kind
}

export function probeSampleToPoint(sample: ProbeSample) {
  return {
    timestamp: sample.completedAt,
    targetId: sample.targetId,
    minMs: sample.rttMs,
    avgMs: sample.rttMs,
    maxMs: sample.rttMs,
    packetLossPct: sample.status === 'ok' ? 0 : 100
  }
}
