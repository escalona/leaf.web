import { useEffect, useMemo, useRef, useState } from "react";
import type { SyncHealth } from "../../core/state/sync-health";

type DevToolbarProps = {
  syncHealth: SyncHealth;
  peerCount: number;
  networkIssue: string | null;
};

type FrameSample = {
  elapsedMs: number;
  expectedFrames: number;
  fps: number;
  jank: number;
  renderedFrames: number;
};

const FRAME_HISTORY_SIZE = 8;
const DEFAULT_FRAME_BUDGET_MS = 1000 / 60;
const MIN_FRAME_BUDGET_MS = 1000 / 240;
const MAX_FRAME_BUDGET_MS = 1000 / 30;
const FRAME_DELTA_SAMPLE_LIMIT = 240;

type ToolbarIssueTone = "warning" | "danger";

type ToolbarIssue = {
  detail: string;
  title: string;
  tone: ToolbarIssueTone;
};

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

export function estimateFrameBudgetMs(frameDeltas: number[]) {
  const validDeltas = frameDeltas.filter(
    (delta) =>
      Number.isFinite(delta) && delta >= MIN_FRAME_BUDGET_MS && delta <= MAX_FRAME_BUDGET_MS,
  );
  if (validDeltas.length < 6) return DEFAULT_FRAME_BUDGET_MS;

  const sortedDeltas = [...validDeltas].sort((left, right) => left - right);
  const medianIndex = Math.floor(sortedDeltas.length / 2);
  const medianBudget =
    sortedDeltas.length % 2 === 0
      ? (sortedDeltas[medianIndex - 1] + sortedDeltas[medianIndex]) / 2
      : sortedDeltas[medianIndex];
  return clamp(medianBudget, MIN_FRAME_BUDGET_MS, MAX_FRAME_BUDGET_MS);
}

export function summarizeFrameWindow(
  renderedFrames: number,
  expectedFrames: number,
  elapsedMs: number,
): FrameSample {
  const effectiveElapsedMs = Math.max(elapsedMs, 1);
  const effectiveExpectedFrames = Math.max(expectedFrames, renderedFrames, 1);
  const droppedFrames = Math.max(0, effectiveExpectedFrames - renderedFrames);
  const fps = (renderedFrames * 1000) / effectiveElapsedMs;
  const jank = (droppedFrames / effectiveExpectedFrames) * 100;
  return {
    elapsedMs: effectiveElapsedMs,
    expectedFrames: effectiveExpectedFrames,
    fps,
    jank,
    renderedFrames,
  };
}

export function summarizeFrameHistory(frameHistory: FrameSample[]) {
  if (frameHistory.length === 0) return null;

  const totals = frameHistory.reduce(
    (summary, sample) => {
      summary.elapsedMs += sample.elapsedMs;
      summary.expectedFrames += sample.expectedFrames;
      summary.renderedFrames += sample.renderedFrames;
      return summary;
    },
    { elapsedMs: 0, expectedFrames: 0, renderedFrames: 0 },
  );

  return summarizeFrameWindow(totals.renderedFrames, totals.expectedFrames, totals.elapsedMs);
}

export function collectToolbarIssues({
  syncHealth,
  networkIssue,
}: Pick<DevToolbarProps, "networkIssue" | "syncHealth">): ToolbarIssue[] {
  const issues: ToolbarIssue[] = [];

  if (syncHealth.tone === "warning" || syncHealth.tone === "danger") {
    issues.push({
      detail: syncHealth.detail,
      title: syncHealth.title,
      tone: syncHealth.tone,
    });
  }

  if (networkIssue) {
    issues.push({
      detail: networkIssue,
      title: "Network issue",
      tone: "danger",
    });
  }

  return issues;
}

const MONO_FONT = '"SF Mono", "Cascadia Code", "Fira Code", ui-monospace, monospace';

export function DevToolbar({ syncHealth, peerCount, networkIssue }: DevToolbarProps) {
  const [frameHistory, setFrameHistory] = useState<FrameSample[]>([]);
  const [memoryLabel, setMemoryLabel] = useState("--");
  const frameAccumulator = useRef({
    expected: 0,
    frameBudgetMs: DEFAULT_FRAME_BUDGET_MS,
    lastObservedFrameAt: 0,
    lastSampleFrameAt: 0,
    recentFrameDeltas: [] as number[],
    rendered: 0,
    startedAt: 0,
  });

  useEffect(() => {
    const startedAt = performance.now();
    frameAccumulator.current = {
      expected: 0,
      frameBudgetMs: DEFAULT_FRAME_BUDGET_MS,
      lastObservedFrameAt: 0,
      lastSampleFrameAt: startedAt,
      recentFrameDeltas: [],
      rendered: 0,
      startedAt,
    };

    let rafId = 0;
    const updateMemoryLabel = () => {
      const performanceWithMemory = performance as Performance & {
        memory?: { usedJSHeapSize: number };
      };
      const usedBytes = performanceWithMemory.memory?.usedJSHeapSize;
      if (typeof usedBytes === "number") {
        const mb = usedBytes / (1024 * 1024);
        setMemoryLabel(mb >= 1024 ? `${(mb / 1024).toFixed(1)}G` : `${Math.round(mb)}M`);
      } else {
        setMemoryLabel("--");
      }
    };

    const sampleFrame = (now: number) => {
      const accumulator = frameAccumulator.current;

      if (accumulator.lastObservedFrameAt !== 0) {
        const observedDelta = now - accumulator.lastObservedFrameAt;
        accumulator.recentFrameDeltas = [
          ...accumulator.recentFrameDeltas.slice(-(FRAME_DELTA_SAMPLE_LIMIT - 1)),
          observedDelta,
        ];
        accumulator.frameBudgetMs = Math.min(
          accumulator.frameBudgetMs,
          estimateFrameBudgetMs(accumulator.recentFrameDeltas),
        );
      }

      const sampleDelta = now - accumulator.lastSampleFrameAt;
      accumulator.rendered += 1;
      accumulator.expected += sampleDelta / accumulator.frameBudgetMs;
      accumulator.lastObservedFrameAt = now;
      accumulator.lastSampleFrameAt = now;

      rafId = window.requestAnimationFrame(sampleFrame);
    };

    rafId = window.requestAnimationFrame(sampleFrame);

    const intervalId = window.setInterval(() => {
      const accumulator = frameAccumulator.current;
      const now = performance.now();
      const elapsedMs = now - accumulator.startedAt;
      const trailingExpectedFrames =
        accumulator.lastSampleFrameAt === 0
          ? 0
          : (now - accumulator.lastSampleFrameAt) / accumulator.frameBudgetMs;
      const summary = summarizeFrameWindow(
        accumulator.rendered,
        accumulator.expected + trailingExpectedFrames,
        elapsedMs,
      );

      setFrameHistory((previous) => [...previous.slice(-(FRAME_HISTORY_SIZE - 1)), summary]);
      frameAccumulator.current = {
        ...accumulator,
        expected: 0,
        lastSampleFrameAt: now,
        rendered: 0,
        startedAt: now,
      };

      updateMemoryLabel();
    }, 1000);

    return () => {
      window.cancelAnimationFrame(rafId);
      window.clearInterval(intervalId);
    };
  }, []);

  const latestFrameSample = frameHistory.at(-1) ?? null;
  const rollingFrameSummary = useMemo(() => summarizeFrameHistory(frameHistory), [frameHistory]);
  const averageFps = rollingFrameSummary?.fps ?? null;
  const activeIssues = useMemo(
    () =>
      collectToolbarIssues({
        networkIssue,
        syncHealth,
      }),
    [networkIssue, syncHealth],
  );
  const issueCount = activeIssues.length;
  const hasDangerIssue = activeIssues.some((issue) => issue.tone === "danger");

  const statusColor = hasDangerIssue ? "#ef4444" : issueCount > 0 ? "#f97316" : "#22c55e";

  const fpsColor = latestFrameSample && latestFrameSample.fps < 45 ? "#ef4444" : "#71717a";
  const jankColor =
    rollingFrameSummary && rollingFrameSummary.jank >= 20
      ? "#ef4444"
      : rollingFrameSummary && rollingFrameSummary.jank >= 8
        ? "#eab308"
        : "#71717a";
  const issueTitle =
    issueCount === 0
      ? "No warnings"
      : activeIssues.map((issue) => `${issue.title}: ${issue.detail}`).join("\n");
  const syncValue = syncHealth.title.startsWith("Sync ")
    ? syncHealth.title.slice("Sync ".length)
    : syncHealth.title;
  const syncSuffix = ` (${peerCount} peer${peerCount !== 1 ? "s" : ""})`;

  return (
    <div
      style={{
        position: "fixed",
        left: 0,
        right: 0,
        bottom: 0,
        zIndex: 40,
        pointerEvents: "none",
      }}
    >
      <div
        style={{
          pointerEvents: "auto",
          display: "flex",
          alignItems: "center",
          height: 28,
          borderTop: "1px solid rgba(0,0,0,0.06)",
          background: "rgba(250,250,250,0.92)",
          backdropFilter: "blur(12px)",
          WebkitBackdropFilter: "blur(12px)",
          color: "#71717a",
          fontFamily: MONO_FONT,
          fontSize: 11,
          padding: "0 12px",
          gap: 0,
          fontVariantNumeric: "tabular-nums",
        }}
      >
        {/* Status dot + brand */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 6,
            paddingRight: 10,
            marginRight: 2,
          }}
        >
          <div
            style={{
              width: 7,
              height: 7,
              borderRadius: 999,
              backgroundColor: statusColor,
              boxShadow: `0 0 0 2px ${statusColor}22`,
              flexShrink: 0,
            }}
          />
          <span
            style={{
              fontSize: 10,
              fontWeight: 600,
              letterSpacing: "0.04em",
              textTransform: "uppercase",
              color: "#a1a1aa",
            }}
          >
            Dev
          </span>
        </div>

        <Separator />

        {/* Heap */}
        <Metric
          label="Heap"
          value={memoryLabel}
          title="JavaScript heap usage from performance.memory"
        />
        <Dot />

        {/* FPS */}
        <Metric
          label="FPS"
          value={latestFrameSample ? `${Math.round(latestFrameSample.fps)}` : "--"}
          valueColor={fpsColor}
          suffix={
            averageFps === null ? undefined : (
              <span style={{ color: "#a1a1aa", fontSize: 10 }}>
                {" "}
                ({Math.round(averageFps)} avg)
              </span>
            )
          }
        />
        <Dot />

        {/* Jank */}
        <Metric
          label="Jank"
          value={rollingFrameSummary ? `${Math.round(rollingFrameSummary.jank)}%` : "--"}
          valueColor={jankColor}
        />

        <Separator />

        {/* Sync */}
        <Metric
          label="Sync"
          value={syncValue}
          valueColor={
            syncHealth.tone === "danger"
              ? "#ef4444"
              : syncHealth.tone === "warning"
                ? "#eab308"
                : "#71717a"
          }
          title={`${syncHealth.title}: ${syncHealth.detail}`}
          suffix={<span style={{ color: "#a1a1aa", fontSize: 10 }}>{syncSuffix}</span>}
        />

        {/* Right-aligned issue count */}
        <div
          style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 5 }}
          title={issueTitle}
        >
          {issueCount > 0 && (
            <div
              style={{
                width: 5,
                height: 5,
                borderRadius: 999,
                backgroundColor: hasDangerIssue ? "#ef4444" : "#f97316",
                flexShrink: 0,
              }}
            />
          )}
          <span
            style={{ color: issueCount > 0 ? (hasDangerIssue ? "#ef4444" : "#f97316") : "#a1a1aa" }}
          >
            {issueCount} issue{issueCount !== 1 ? "s" : ""}
          </span>
        </div>
      </div>
    </div>
  );
}

function Metric({
  label,
  value,
  valueColor,
  title,
  suffix,
}: {
  label: string;
  value: string;
  valueColor?: string;
  title?: string;
  suffix?: React.ReactNode;
}) {
  return (
    <span
      title={title}
      style={{ display: "inline-flex", alignItems: "center", gap: 4, whiteSpace: "nowrap" }}
    >
      <span style={{ color: "#a1a1aa" }}>{label}</span>
      <span style={{ color: valueColor ?? "#71717a" }}>{value}</span>
      {suffix}
    </span>
  );
}

function Separator() {
  return (
    <div
      style={{
        width: 1,
        height: 12,
        backgroundColor: "rgba(0,0,0,0.08)",
        margin: "0 8px",
        flexShrink: 0,
      }}
    />
  );
}

function Dot() {
  return (
    <span
      style={{
        color: "#d4d4d8",
        margin: "0 6px",
        fontSize: 8,
        lineHeight: 1,
        userSelect: "none",
      }}
    >
      ·
    </span>
  );
}
