'use client';

import { useEffect, useRef, useState, type PointerEvent } from 'react';
import { CandlestickSeries, ColorType, createChart, type IChartApi, type ISeriesApi, type UTCTimestamp } from 'lightweight-charts';
import type { Candle, ChartMarker, Market } from '@/lib/contracts';
import { dollars, signedDollars } from '@/lib/format';

type GuideKind = 'takeProfit' | 'stopLoss';
type Props = {
  candles: Candle[]; markers: ChartMarker[]; market: Market; selectedId: string | null;
  onSelect: (marker: ChartMarker) => void;
  onGuideDrop: (marker: ChartMarker, kind: GuideKind, price: number) => void;
  guidesDisabled?: boolean;
};
type Hit = { id: string; x: number; y: number; width: number; height: number };
type GuideHit = { markerId: string; kind: GuideKind; x: number; y: number };
type Drag = { markerId: string; kind: GuideKind; price: number; startY: number; moved: boolean };

const markerColor = (origin: ChartMarker['origin']) => origin === 'auto_mirror' ? '#7aaaff' : origin === 'manual_stack' ? '#f6bf68' : '#68e7be';
const guideColor = (kind: GuideKind) => kind === 'takeProfit' ? '#68e7be' : '#e4777d';
const guideLabel = (kind: GuideKind) => kind === 'takeProfit' ? 'TP' : 'SL';

export function SharedChart({ candles, markers, market, selectedId, onSelect, onGuideDrop, guidesDisabled = false }: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const lastMarketRef = useRef<string | null>(null);
  const seriesRef = useRef<ISeriesApi<'Candlestick'> | null>(null);
  const drawRef = useRef<() => void>(() => {});
  const dragRef = useRef<Drag | null>(null);
  const [drag, setDrag] = useState<Drag | null>(null);
  const [hitRegions, setHitRegions] = useState<Hit[]>([]);
  const [guideHits, setGuideHits] = useState<GuideHit[]>([]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const monoFont = getComputedStyle(document.body).getPropertyValue('--font-mono').trim() || 'monospace';
    const chart = createChart(host, {
      autoSize: true,
      layout: { background: { type: ColorType.Solid, color: '#1e2029' }, textColor: '#838b9a', fontFamily: monoFont, fontSize: 11 },
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
      ctx.font = `12px ${getComputedStyle(document.body).getPropertyValue('--font-mono').trim() || 'monospace'}`;
      ctx.textBaseline = 'middle';
      const hits: Hit[] = [];
      const guides: GuideHit[] = [];
      const visible = markers.filter(marker => marker.marketId === market.id && marker.venue === market.venue);
      visible.forEach((marker, index) => {
        const anchor = marker.entryPrice ?? marker.markPrice;
        const y = series.priceToCoordinate(anchor);
        const selected = marker.id === selectedId;
        if (marker.venue === 'perpl' && marker.entryPrice != null) {
          for (const kind of ['takeProfit', 'stopLoss'] as const) {
            const actual = kind === 'takeProfit' ? marker.takeProfitPrice : marker.stopLossPrice;
            const preview = drag?.markerId === marker.id && drag.kind === kind ? drag.price : null;
            const price = preview ?? actual;
            const guideY = price == null ? null : series.priceToCoordinate(price);
            if (price != null && guideY != null && guideY >= 0 && guideY <= height) {
              ctx.strokeStyle = preview != null ? '#f6bf68' : guideColor(kind);
              ctx.globalAlpha = selected ? 0.8 : 0.24;
              ctx.lineWidth = selected ? 1.5 : 1;
              ctx.setLineDash(preview != null ? [5, 4] : [3, 4]);
              ctx.beginPath(); ctx.moveTo(0, guideY); ctx.lineTo(width - 56, guideY); ctx.stroke();
              ctx.setLineDash([]); ctx.globalAlpha = 1;
              if (selected) {
                ctx.fillStyle = preview != null ? '#f6bf68' : guideColor(kind);
                ctx.fillText(`${guideLabel(kind)} ${dollars(price, price < 1 ? 6 : 2)}${preview != null ? ' DRAFT' : ''}`, 12, Math.max(10, guideY - 10));
              }
            }
            if (selected) {
              const sideOffset = (kind === 'takeProfit') === (marker.side === 'long') ? -35 : 35;
              const handleY = guideY ?? (y == null ? null : y + sideOffset);
              if (handleY != null) guides.push({ markerId: marker.id, kind, x: width - (kind === 'takeProfit' ? 154 : 104), y: Math.max(17, Math.min(height - 17, handleY)) });
            }
          }
        }
        if (y == null || y < 12 || y > height - 24) return;
        const x = width < 480 ? 16 : Math.max(80, Math.min(width - 260, width * 0.58));
        const offset = visible.slice(0, index).filter(previous => {
          const previousY = series.priceToCoordinate(previous.entryPrice ?? previous.markPrice);
          return previousY != null && Math.abs(previousY - y) < 28;
        }).length;
        const markerY = Math.max(20, Math.min(height - 28, y + offset * 25));
        const color = markerColor(marker.origin);
        ctx.strokeStyle = color;
        ctx.lineWidth = selected ? 2 : 1;
        ctx.globalAlpha = selected ? 0.9 : 0.44;
        ctx.setLineDash([4, 5]);
        ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(width - 56, y); ctx.stroke();
        ctx.setLineDash([]); ctx.globalAlpha = 1;
        const badge = `${marker.memberName}  ${marker.venue === 'perpl' ? marker.pnlUsd == null ? 'PENDING' : signedDollars(marker.pnlUsd) : marker.valueUsd == null ? 'PENDING' : dollars(marker.valueUsd)}`;
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
        ctx.fillStyle = '#ecf1f2'; ctx.fillText(badge, x + 29, markerY + 1, badgeWidth - (marker.pendingAdd ? 68 : 35));
        if (marker.pendingAdd) { ctx.fillStyle = '#f6bf68'; ctx.font = `10px ${getComputedStyle(document.body).getPropertyValue('--font-mono').trim() || 'monospace'}`; ctx.fillText('ADD', x + badgeWidth - 34, markerY + 1); ctx.font = `12px ${getComputedStyle(document.body).getPropertyValue('--font-mono').trim() || 'monospace'}`; }
        hits.push({ id: marker.id, x, y: markerY - 15, width: badgeWidth, height: 30 });
      });
      setHitRegions(hits);
      setGuideHits(guides);
    };
    drawRef.current();
  }, [markers, market, selectedId, drag]);

  const startGuideDrag = (event: PointerEvent<HTMLButtonElement>, marker: ChartMarker, kind: GuideKind) => {
    if (guidesDisabled) return;
const actual = kind === 'takeProfit' ? marker.takeProfitPrice : marker.stopLossPrice;
    const rect = hostRef.current?.getBoundingClientRect();
    const pointerPrice = rect ? seriesRef.current?.coordinateToPrice(event.clientY - rect.top) : null;
    const price = actual ?? (pointerPrice != null && pointerPrice > 0 ? pointerPrice : marker.entryPrice ?? marker.markPrice);
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    const next = { markerId: marker.id, kind, price, startY: event.clientY, moved: false };
    dragRef.current = next;
    setDrag(next);
  };
  const moveGuideDrag = (event: PointerEvent<HTMLButtonElement>) => {
    const current = dragRef.current;
    const rect = hostRef.current?.getBoundingClientRect();
    const series = seriesRef.current;
    if (!current || !rect || !series) return;
    const price = series.coordinateToPrice(Math.max(2, Math.min(rect.height - 2, event.clientY - rect.top)));
    if (price == null || !Number.isFinite(price) || price <= 0) return;
    const next = { ...current, price, moved: current.moved || Math.abs(event.clientY - current.startY) > 3 };
    dragRef.current = next;
    setDrag(next);
  };
  const finishGuideDrag = (event: PointerEvent<HTMLButtonElement>) => {
    const current = dragRef.current;
    dragRef.current = null;
    setDrag(null);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    if (!current?.moved) return;
    const marker = markers.find(item => item.id === current.markerId);
    if (marker) onGuideDrop(marker, current.kind, current.price);
  };

  return <div className="chart-stage">
    <div ref={hostRef} className="chart-host" />
    <canvas ref={canvasRef} className="chart-overlay" aria-hidden="true" />
    <div className="chart-hit-layer">
      {hitRegions.map(hit => {
        const marker = markers.find(item => item.id === hit.id);
        return marker && <button key={hit.id} className="chart-hit" type="button" style={{ left: hit.x, top: hit.y, width: hit.width, height: hit.height }} title={`${marker.memberName}: ${marker.venue === 'perpl' ? marker.pnlUsd == null ? 'PENDING' : signedDollars(marker.pnlUsd) : marker.valueUsd == null ? 'PENDING' : dollars(marker.valueUsd)}. Open trade details`} aria-label={`Open ${marker.memberName}'s ${market.symbol} trade details`} onClick={() => onSelect(marker)} />;
      })}
      {guideHits.map(hit => {
        const marker = markers.find(item => item.id === hit.markerId);
        return marker && <button key={`${hit.markerId}:${hit.kind}`} className={`chart-guide ${hit.kind}`} type="button" style={{ left: hit.x, top: hit.y - 12 }} title={`Drag ${guideLabel(hit.kind)} to ${marker.isMine ? 'set' : 'suggest'} a price`} aria-label={`Drag ${guideLabel(hit.kind)} to ${marker.isMine ? 'set' : 'suggest'} a price`} onPointerDown={event => startGuideDrag(event, marker, hit.kind)} onPointerMove={moveGuideDrag} onPointerUp={finishGuideDrag} onPointerCancel={() => { dragRef.current = null; setDrag(null); }} disabled={guidesDisabled}>{guideLabel(hit.kind)}</button>;
      })}
    </div>
    {!candles.length && <div className="chart-empty">Waiting for live market data</div>}
  </div>;
}