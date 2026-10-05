'use client';

import { useEffect, useRef, useState, type PointerEvent } from 'react';
import { CandlestickSeries, ColorType, createChart, LineSeries, type AutoscaleInfo, type IChartApi, type ISeriesApi, type SeriesType, type UTCTimestamp } from 'lightweight-charts';
import type { Candle, ChartMarker, Market } from '@/lib/contracts';
import { dollars, signedDollars } from '@/lib/format';
import { avatarSrc, initialsOf } from './Avatar';

export type ChartStyle = 'candles' | 'line';
type GuideKind = 'takeProfit' | 'stopLoss';
type Props = {
  candles: Candle[]; markers: ChartMarker[]; market: Market; selectedId: string | null;
  onSelect: (marker: ChartMarker) => void;
  onGuideDrop: (marker: ChartMarker, kind: GuideKind, price: number) => void;
  guidesDisabled?: boolean;
  avatars?: Record<string, string | null>; // memberId -> photo, drawn in each badge
  chartStyle?: ChartStyle;
};
type Hit = { id: string; x: number; y: number; width: number; height: number };
type GuideHit = { markerId: string; kind: GuideKind; x: number; y: number };
type Drag = { markerId: string; kind: GuideKind; price: number; startY: number; moved: boolean };

const markerColor = (origin: ChartMarker['origin']) => origin === 'auto_mirror' ? '#8fb4ff' : origin === 'manual_stack' ? '#f6bf68' : '#c084fc';
const guideColor = (kind: GuideKind) => kind === 'takeProfit' ? '#34d399' : '#ff6b6b';
const guideLabel = (kind: GuideKind) => kind === 'takeProfit' ? 'TP' : 'SL';
const seriesData = (candles: Candle[], style: ChartStyle) => style === 'line'
  ? candles.map(c => ({ time: c.time as UTCTimestamp, value: c.close }))
  : candles.map(c => ({ ...c, time: c.time as UTCTimestamp }));

// Trader photos for the badges, shared by every chart on the page. A photo
// that arrives later redraws the charts that asked for it.
const photos = new Map<string, HTMLImageElement | null>();
const redraws = new Set<() => void>();
const photo = (src: string) => {
  if (photos.has(src)) return photos.get(src) ?? null;
  const img = new Image();
  img.onload = () => redraws.forEach(redraw => redraw());
  img.onerror = () => photos.set(src, null);
  img.src = src;
  photos.set(src, img);
  return img;
};

export function SharedChart({ candles, markers, market, selectedId, onSelect, onGuideDrop, guidesDisabled = false, avatars, chartStyle = 'candles' }: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const lastMarketRef = useRef<string | null>(null);
  const seriesRef = useRef<ISeriesApi<SeriesType> | null>(null);
  const candlesRef = useRef(candles);
  candlesRef.current = candles;
  const styleRef = useRef(chartStyle);
  styleRef.current = chartStyle;
  const drawRef = useRef<() => void>(() => {});
  const dragRef = useRef<Drag | null>(null);
  // Prices the chart must keep in view besides the candles: every visible
  // position's entry, and the selected one's TP/SL.
  const levelsRef = useRef<number[]>([]);
  const [drag, setDrag] = useState<Drag | null>(null);
  const [hitRegions, setHitRegions] = useState<Hit[]>([]);
  const [guideHits, setGuideHits] = useState<GuideHit[]>([]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const monoFont = getComputedStyle(document.body).getPropertyValue('--font-aeonik').trim() || 'sans-serif';
    const chart = createChart(host, {
      autoSize: true,
      layout: { background: { type: ColorType.Solid, color: 'rgba(0,0,0,0)' }, textColor: '#7d8792', fontFamily: monoFont, fontSize: 11, attributionLogo: false },
      grid: { vertLines: { color: 'rgba(255,255,255,0.035)' }, horzLines: { color: 'rgba(255,255,255,0.05)' } },
      crosshair: { vertLine: { color: 'rgba(168,85,247,0.35)', labelBackgroundColor: '#2a2340' }, horzLine: { color: 'rgba(168,85,247,0.35)', labelBackgroundColor: '#2a2340' } },
      rightPriceScale: { borderColor: 'rgba(255,255,255,0.06)', scaleMargins: { top: 0.12, bottom: 0.12 } },
      timeScale: { borderColor: 'rgba(255,255,255,0.06)', timeVisible: true, secondsVisible: false, rightOffset: 14 },
      handleScroll: true,
      handleScale: true,
    });
    chartRef.current = chart;
    const redraw = () => drawRef.current();
    redraws.add(redraw);
    const resize = new ResizeObserver(() => drawRef.current());
    resize.observe(host);
    const onRange = () => drawRef.current();
    chart.timeScale().subscribeVisibleLogicalRangeChange(onRange);
    return () => {
      chart.timeScale().unsubscribeVisibleLogicalRangeChange(onRange);
      redraws.delete(redraw);
      resize.disconnect();
      chart.remove();
      chartRef.current = null;
      seriesRef.current = null;
    };
  }, []);

  // The price series: candles or a single close line. Switching swaps the
  // series in place; the badges and TP/SL handles read prices off whichever
  // is current.
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;
    if (seriesRef.current) chart.removeSeries(seriesRef.current);
    const autoscaleInfoProvider = (original: () => AutoscaleInfo | null) => {
      const base = original();
      const levels = levelsRef.current;
      if (!base || !base.priceRange || !levels.length) return base;
      return { ...base, priceRange: { minValue: Math.min(base.priceRange.minValue, ...levels), maxValue: Math.max(base.priceRange.maxValue, ...levels) } };
    };
    const price = { priceLineVisible: true, priceLineColor: 'rgba(168,85,247,0.5)', priceLineStyle: 2, autoscaleInfoProvider };
    const series: ISeriesApi<SeriesType> = chartStyle === 'line'
      ? chart.addSeries(LineSeries, { ...price, color: '#a855f7', lineWidth: 2, crosshairMarkerRadius: 4, crosshairMarkerBorderColor: '#13111c', crosshairMarkerBackgroundColor: '#a855f7' })
      : chart.addSeries(CandlestickSeries, { ...price, upColor: '#34d399', downColor: '#ff6b6b', borderVisible: false, wickUpColor: 'rgba(52,211,153,0.7)', wickDownColor: 'rgba(255,107,107,0.7)' });
    series.setData(seriesData(candlesRef.current, chartStyle));
    seriesRef.current = series;
    drawRef.current();
  }, [chartStyle]);

  useEffect(() => {
    const series = seriesRef.current;
    if (!series) return;
    series.setData(seriesData(candles, styleRef.current));
    if (candles.length) {
      if (lastMarketRef.current !== market.id) chartRef.current?.timeScale().fitContent();
      lastMarketRef.current = market.id;
    }
    drawRef.current();
  }, [candles, market.id]);

  useEffect(() => {
    const onChart = markers.filter(marker => marker.marketId === market.id && marker.venue === market.venue);
    levelsRef.current = onChart.flatMap(marker => [marker.entryPrice, ...(marker.id === selectedId ? [marker.takeProfitPrice, marker.stopLossPrice] : [])])
      .filter((price): price is number => typeof price === 'number' && price > 0);
    chartRef.current?.priceScale('right').applyOptions({ autoScale: true });
  }, [markers, market.id, market.venue, selectedId]);

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
      const font = getComputedStyle(document.body).getPropertyValue('--font-aeonik').trim() || 'sans-serif';
      ctx.font = `12px ${font}`;
      ctx.textBaseline = 'middle';
      const hits: Hit[] = [];
      const guides: GuideHit[] = [];
      const visible = markers.filter(marker => marker.marketId === market.id && marker.venue === market.venue);
      const placed: number[] = [];
      visible.forEach(marker => {
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
        // Badges never sit on one another: start at the entry and step to the
        // nearest free slot below or above the badges already placed.
        const clash = (candidate: number) => placed.some(other => Math.abs(other - candidate) < 28);
        let markerY = Math.max(20, Math.min(height - 28, y));
        for (let step = 1; clash(markerY) && step < 14; step++) {
          const down = markerY + step * 28;
          const up = markerY - step * 28;
          if (down <= height - 28 && !clash(down)) { markerY = down; break; }
          if (up >= 20 && !clash(up)) { markerY = up; break; }
        }
        placed.push(markerY);
        const color = markerColor(marker.origin);
        ctx.strokeStyle = color;
        ctx.lineWidth = selected ? 1.5 : 1;
        ctx.globalAlpha = selected ? 0.8 : 0.3;
        ctx.setLineDash([4, 5]);
        ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(width - 56, y); ctx.stroke();
        ctx.setLineDash([]); ctx.globalAlpha = 1;
        // The badge: how they're in (symbol), who (photo), and their PnL.
        const perp = marker.venue === 'perpl';
        const value = perp ? marker.pnlUsd : marker.valueUsd;
        const amount = value == null ? 'Pending' : perp ? signedDollars(value) : dollars(value);
        ctx.font = `500 11.5px ${font}`;
        const textWidth = ctx.measureText(amount).width;
        const badgeWidth = Math.ceil(56 + textWidth + (marker.pendingAdd ? 30 : 0));
        ctx.fillStyle = selected ? '#2a1d47' : 'rgba(19, 17, 28, 0.94)';
        ctx.strokeStyle = color; ctx.lineWidth = selected ? 1.5 : 1; ctx.globalAlpha = selected ? 1 : 0.75;
        ctx.beginPath(); ctx.roundRect(x, markerY - 13, badgeWidth, 26, 13); ctx.fill(); ctx.stroke();
        ctx.globalAlpha = 1;
        const iconX = x + 13;
        ctx.strokeStyle = color; ctx.fillStyle = color; ctx.lineWidth = 1.5;
        if (marker.origin === 'auto_mirror') {
          ctx.beginPath(); ctx.arc(iconX, markerY, 4, 0, Math.PI * 2); ctx.stroke();
        } else if (marker.origin === 'manual_stack') {
          ctx.fillRect(iconX - 4, markerY - 4, 8, 8);
        } else {
          ctx.beginPath(); ctx.moveTo(iconX, markerY - 5); ctx.lineTo(iconX + 5, markerY + 4); ctx.lineTo(iconX - 5, markerY + 4); ctx.closePath(); ctx.fill();
        }
        const faceX = x + 33;
        const src = avatarSrc(avatars?.[marker.memberId]);
        const img = src ? photo(src) : null;
        ctx.save();
        ctx.beginPath(); ctx.arc(faceX, markerY, 10, 0, Math.PI * 2); ctx.clip();
        if (img?.complete && img.naturalWidth) ctx.drawImage(img, faceX - 10, markerY - 10, 20, 20);
        else {
          ctx.fillStyle = '#2a2340'; ctx.fillRect(faceX - 10, markerY - 10, 20, 20);
          ctx.fillStyle = '#efe4ff'; ctx.font = `700 8.5px ${font}`; ctx.textAlign = 'center';
          ctx.fillText(initialsOf(marker.memberName), faceX, markerY + 0.5);
          ctx.textAlign = 'left';
        }
        ctx.restore();
        ctx.font = `500 11.5px ${font}`;
        ctx.fillStyle = value == null ? '#7d8792' : !perp ? '#eceef1' : value >= 0 ? '#34d399' : '#ff6b6b';
        ctx.fillText(amount, faceX + 17, markerY + 1);
        if (marker.pendingAdd) { ctx.fillStyle = '#f6bf68'; ctx.font = `500 10px ${font}`; ctx.fillText('ADD', faceX + 23 + textWidth, markerY + 1); }
        ctx.font = `12px ${font}`;
        hits.push({ id: marker.id, x, y: markerY - 15, width: badgeWidth, height: 30 });
      });
      setHitRegions(hits);
      setGuideHits(guides);
    };
    drawRef.current();
  }, [markers, market, selectedId, drag, avatars]);

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