---
version: 1
slug: "src-renderer-index-html"
primary_target: "src/renderer/index.html"
related_targets: []
---

Scope: the Electron renderer's primary monitoring surface; mode Operate.

Audience and job: a Windows user investigating intermittent lag must determine within seconds whether the current problem begins locally, upstream, or in one geographic region, then inspect the measurements supporting that conclusion.

Task and content: show collector freshness, the local-to-regional link chain, one dominant latency timeline, packet-loss gaps, active/recent incident evidence, regional configuration state, and low-frequency speed-test status. Real measurements lead; synthetic data is labeled and empty states never imply health.

Direction: a network packet-trace analysis workbench. The health chain, waveform, and evidence rows share one measured graphite plane rather than a grid of detached cards. The memorable moment is selecting an incident band in the dominant trace and seeing the affected chain segments and evidence rows resolve together.

Constraints: shadcn/ui with Base UI primitives, React, Tailwind, TanStack Query, echarts-for-react/ECharts Canvas, keyboard operation, visible focus, non-color status cues, reduced motion, ECharts ARIA, responsive down to the minimum Electron window, no decorative map, no gauge charts, no smoothed or connected data gaps.

Unresolved: verified regional endpoints, real speed-test history, and long-term notification behavior remain unavailable and must not be fabricated.
