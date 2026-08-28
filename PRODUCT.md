# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Stack

Electron desktop shell with a React and TypeScript renderer built by Vite; shadcn/ui using Base UI primitives and Tailwind CSS; Apache ECharts through `echarts-for-react`; TanStack Query for asynchronous renderer state; Electron IPC for local communication; Node.js and SQLite for collection and persistence.

## Users

The primary user is a Windows PC user experiencing intermittent lag who needs evidence to distinguish a local network problem from an ISP, upstream, endpoint, or geographic routing problem.

## Product Purpose

Ping Spike Monitor continuously records latency, packet loss, and jitter across the local gateway, public anchors, and regional targets. It groups raw samples into evidence-backed incidents, preserves short spikes, and runs bandwidth tests only at low frequency or on demand.

Success means the user can quickly see whether the connection is currently degraded, identify the most likely affected network segment, inspect the supporting samples and route snapshot, and export useful evidence.

## Positioning

The product correlates simultaneous measurements across the local gateway, public internet, and multiple fixed regional endpoints. It does not collapse network quality into an opaque score or treat one failed endpoint as proof that an entire region is down.

## Operating Context

The application runs locally on a Windows computer, normally remains active in the system tray, and stores its database outside the synced repository. The renderer may be closed without stopping collection. Machine sleep and shutdown create explicit collection gaps.

## Capabilities and Constraints

- The local gateway and critical public anchors are sampled every two seconds by default.
- Regional groups contain at least two fixed unicast endpoints and are sampled every ten seconds by default.
- DNS and HTTPS probes run less frequently; traceroute is event-triggered and rate-limited.
- Internet speed tests are manual or low-frequency; LAN and regional throughput require configured `iperf3` peers.
- Regional conclusions require multiple agreeing endpoints. Anycast targets cannot represent a named geography.
- Raw data remains local in SQLite. The first release has no cloud account, cloud database, remote multi-user access, or microservices.
- The desktop shell uses secure preload APIs with Node integration disabled in the renderer.

## Evidence on Hand

The project has an original product mark generated for this application. No production measurements, verified regional endpoint catalog, ISP records, benchmarks, or testimonials are bundled with the repository. Demonstration data must be labeled synthetic until the collector has recorded real samples.

## Product Principles

1. Preserve raw evidence before interpreting it.
2. Correlate network layers before assigning a likely cause.
3. Distinguish unavailable data from a healthy connection.
4. Keep collection reliable when the interface is closed or reloaded.
5. Prefer direct, inspectable measurements over opaque health scores.

## Accessibility & Inclusion

The interface must support keyboard operation, visible focus, sufficient contrast, reduced motion, non-color status cues, ECharts ARIA descriptions, and a tabular or CSV alternative for chart data. English, Simplified Chinese, and French are first-class locales; dates, durations, numbers, chart copy, and operational states must switch together without changing the underlying measurements.
