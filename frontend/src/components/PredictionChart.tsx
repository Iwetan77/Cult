'use client';

import { useEffect, useRef } from 'react';
import { AreaSeries, ColorType, LineSeries, createChart, type IChartApi, type ISeriesApi, type UTCTimestamp } from 'lightweight-charts';
import type { PricePoint } from '@/lib/polymarket';

// Odds over time: one area for a yes/no question, a line per option (up to
// four) for multi-outcome events. Values are 0..1, shown as percent.

export const LINE_COLORS = ['#63f0d6', '#8fb4ff', '#f6bf68', '#ff8fc7'];
export type ChartLine = { id: string; label: string; points: PricePoint[] };

const percent = (p: number) => `${Math.round(p * 100)}%`;

export function PredictionChart({ lines }: { lines: ChartLine[] }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<'Area' | 'Line'>[]>([]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const font = getComputedStyle(document.body).getPropertyValue('--font-aeonik').trim() || 'sans-serif';
    const chart = createChart(host, {
      autoSize: true,
      layout: { background: { type: ColorType.Solid, color: 'rgba(0,0,0,0)' }, textColor: '#7d8792', fontFamily: font, fontSize: 11, attributionLogo: false },
      grid: { vertLines: { visible: false }, horzLines: { color: 'rgba(255,255,255,0.05)' } },
      crosshair: { vertLine: { color: 'rgba(99,240,214,0.35)', labelBackgroundColor: '#1d2a28' }, horzLine: { color: 'rgba(99,240,214,0.35)', labelBackgroundColor: '#1d2a28' } },
      rightPriceScale: { borderColor: 'rgba(255,255,255,0.06)', scaleMargins: { top: 0.1, bottom: 0.08 } },
      timeScale: { borderColor: 'rgba(255,255,255,0.06)', timeVisible: true, secondsVisible: false },
      localization: { priceFormatter: percent },
      handleScroll: true, handleScale: true,
    });
    chartRef.current = chart;
    return () => { chart.remove(); chartRef.current = null; seriesRef.current = []; };
  }, []);

  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;
    for (const series of seriesRef.current) chart.removeSeries(series);
    const format = { type: 'custom' as const, formatter: percent, minMove: 0.001 };
    seriesRef.current = lines.map((line, i) => {
      const color = LINE_COLORS[i % LINE_COLORS.length]!;
      const series = lines.length === 1
        ? chart.addSeries(AreaSeries, { lineColor: color, topColor: 'rgba(99,240,214,0.28)', bottomColor: 'rgba(99,240,214,0)', lineWidth: 2, priceFormat: format, priceLineColor: 'rgba(99,240,214,0.5)', priceLineStyle: 2 })
        : chart.addSeries(LineSeries, { color, lineWidth: 2, priceFormat: format, priceLineVisible: false, lastValueVisible: true });
      // One point per second at most; the API can repeat timestamps.
      const seen = new Set<number>();
      series.setData(line.points.filter(p => !seen.has(p.time) && seen.add(p.time)).map(p => ({ time: p.time as UTCTimestamp, value: p.value })));
      return series;
    });
    chart.timeScale().fitContent();
  }, [lines]);

  return <div ref={hostRef} className="pm-chart" />;
}
