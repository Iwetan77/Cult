'use client';

import { useEffect, useRef, useState } from 'react';
import { CandlestickSeries, ColorType, createChart, type IChartApi, type ISeriesApi, type UTCTimestamp } from 'lightweight-charts';
import type { Candle, ChartMarker, Market } from '@/lib/contracts';
import { signedUsd, usd } from '@/lib/format';

type Props = { candles: Candle[]; markers: ChartMarker[]; market: Market; selectedId: string | null; onSelect: (marker: ChartMarker) => void };
type Hit = { id: string; x: number; y: number; width: number; height: number };

const markerColor = (origin: ChartMarker['origin']) => origin === 'auto_mirror' ? '#7aaaff' : origin === 'manual_stack' ? '#f6bf68' : '#68e7be';

export function SharedChart({ candles, markers, market, selectedId, onSelect }: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const lastMarketRef = useRef<string | null>(null);
  const seriesRef = useRef<ISeriesApi<'Candlestick'> | null>(null);
  const [hitRegions, setHitRegions] = useState<Hit[]>([]);
  const drawRef = useRef<() => void>(() => {});

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const chart = createChart(host, {
      autoSize: true,
      layout: { background: { type: ColorType.Solid, color: '#1e2029' }, textColor: '#838b9a', fontFamily: 'Arial, sans-serif', fontSize: 11 },
      grid: { vertLines: { color: '#292d37' }, horzLines: { color: '#292d37' } },
      crosshair: { vertLine: { color: '#657080' }, horzLine: { color: '#657080' } },
      rightPriceScale: { borderColor: '#303541', scaleMargins: { top: 0.12, bottom: 0.12 } },
      timeScale: { borderColor: '#303541', timeVisible: true, secondsVisible: false, rightOffset: 14 },
      handleScroll: true,
      handleScale: true,
    });
    const series = chart.addSeries(CandlestickSeries, {
      upColor: '#57cfa8', downColor: '#e4777d', borderVisible: false,
      wickUpColor: '#57cfa8', wickDownColor: '#e4777d', priceLineVisible: false,
    });
    chartRef.current = chart;
    seriesRef.current = series;
    const resize = new ResizeObserver(() => drawRef.current());
    resize.observe(host);
    const onRange = () => drawRef.current();
    chart.timeScale().subscribeVisibleLogicalRangeChange(onRange);
    return () => {
      chart.timeScale().unsubscribeVisibleLogicalRangeChange(onRange);
      resize.disconnect();
      chart.remove();
      chartRef.current = null;
      seriesRef.current = null;
    };
  }, []);

  useEffect(() => {
    const series = seriesRef.current;
    if (!series) return;
    series.setData(candles.map(c => ({ ...c, time: c.time as UTCTimestamp })));
    if (candles.length) {
      if (lastMarketRef.current !== market.id) chartRef.current?.timeScale().fitContent();
      lastMarketRef.current = market.id;
    }
    drawRef.current();
  }, [candles, market.id]);

  useEffect(() => {
    drawRef.current = () => {
      const canvas = canvasRef.current;
      const host = hostRef.current;
      const series = seriesRef.current;
      if (!canvas || !host || !series) return;
      const { width, height } = host.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      canvas.width = Math.max(1, Math.round(width * dpr));
      canvas.height = Math.max(1, Math.round(height * dpr));
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      ctx.scale(dpr, dpr);
      ctx.font = '12px Arial, sans-serif';
      ctx.textBaseline = 'middle';
      const hits: Hit[] = [];
      const visible = markers.filter(marker => marker.marketId === market.id && marker.venue === market.venue);
      visible.forEach((marker, index) => {
        const y = series.priceToCoordinate(marker.entryPrice ?? marker.markPrice);
        if (y == null || y < 12 || y > height - 24) return;
        const x = width < 480 ? 16 : Math.max(80, Math.min(width - 260, width * 0.58));
        const offset = visible.slice(0, index).filter(previous => {
          const previousY = series.priceToCoordinate(previous.entryPrice ?? previous.markPrice);
          return previousY != null && Math.abs(previousY - y) < 28;
        }).length;
        const markerY = Math.max(20, Math.min(height - 28, y + offset * 25));
        const color = markerColor(marker.origin);
        const selected = marker.id === selectedId;
        ctx.strokeStyle = color;
        ctx.lineWidth = selected ? 2 : 1;
        ctx.globalAlpha = selected ? 0.9 : 0.44;
        ctx.setLineDash([4, 5]);
        ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(width - 56, y); ctx.stroke();
        ctx.setLineDash([]); ctx.globalAlpha = 1;
        if (marker.venue === 'perpl') {
          for (const [price, label, lineColor] of [
            [marker.takeProfitPrice, 'TP', '#68e7be'], [marker.stopLossPrice, 'SL', '#e4777d'],
          ] as const) {
            if (price == null) continue;
            const guideY = series.priceToCoordinate(price);
            if (guideY == null) continue;
            ctx.strokeStyle = lineColor; ctx.globalAlpha = selected ? 0.65 : 0.22; ctx.setLineDash([3, 4]);
            ctx.beginPath(); ctx.moveTo(0, guideY); ctx.lineTo(width - 56, guideY); ctx.stroke();
            ctx.setLineDash([]); ctx.globalAlpha = 1; ctx.fillStyle = lineColor;
            if (selected) ctx.fillText(`${label} ${usd(price, price < 1 ? 5 : 2)}`, 12, guideY - 10);
          }
        }
        const badge = `${marker.memberName}  ${marker.venue === 'perpl' ? marker.pnlUsd == null ? 'PENDING' : signedUsd(marker.pnlUsd) : marker.valueUsd == null ? 'PENDING' : usd(marker.valueUsd)}`;
        const badgeWidth = Math.min(235, Math.max(80, width - x - 62), ctx.measureText(badge).width + 43);
        ctx.fillStyle = selected ? '#313945' : '#292e39';
        ctx.strokeStyle = color; ctx.lineWidth = selected ? 1.5 : 1;
        ctx.beginPath(); ctx.roundRect(x, markerY - 13, badgeWidth, 26, 4); ctx.fill(); ctx.stroke();
        const iconX = x + 14;
        ctx.strokeStyle = color; ctx.fillStyle = color; ctx.lineWidth = 2;
        if (marker.origin === 'auto_mirror') {
          ctx.beginPath(); ctx.arc(iconX, markerY, 5, 0, Math.PI * 2); ctx.stroke();
        } else if (marker.origin === 'manual_stack') {
          ctx.fillRect(iconX - 5, markerY - 5, 10, 10);
        } else {
          ctx.beginPath(); ctx.moveTo(iconX, markerY - 6); ctx.lineTo(iconX + 6, markerY + 5); ctx.lineTo(iconX - 6, markerY + 5); ctx.closePath(); ctx.fill();
        }
        ctx.fillStyle = '#ecf1f2'; ctx.fillText(badge, x + 29, markerY + 1, badgeWidth - 35);
        hits.push({ id: marker.id, x, y: markerY - 15, width: badgeWidth, height: 30 });
      });
      setHitRegions(hits);
    };
    drawRef.current();
  }, [markers, market, selectedId]);

  return <div className="chart-stage">
    <div ref={hostRef} className="chart-host" />
    <canvas ref={canvasRef} className="chart-overlay" aria-hidden="true" />
    <div className="chart-hit-layer">{hitRegions.map(hit => {
      const marker = markers.find(item => item.id === hit.id);
      return marker && <button key={hit.id} className="chart-hit" type="button" style={{ left: hit.x, top: hit.y, width: hit.width, height: hit.height }} title={`${marker.memberName}: ${marker.venue === 'perpl' ? marker.pnlUsd == null ? 'PENDING' : signedUsd(marker.pnlUsd) : marker.valueUsd == null ? 'PENDING' : usd(marker.valueUsd)}. Open trade details`} aria-label={`Open ${marker.memberName}'s ${market.symbol} trade details`} onClick={() => onSelect(marker)} />;
    })}</div>    {!candles.length && <div className="chart-empty">Waiting for live market data</div>}
  </div>;
}
