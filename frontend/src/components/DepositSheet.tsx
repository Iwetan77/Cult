'use client';

import { useEffect, useState } from 'react';
import { getAccessToken } from '@/lib/auth';
import { QRCodeSVG } from 'qrcode.react';
import { Copy, RefreshCw, X } from './icons';
import { getDeposit } from '@/lib/api';
import type { DepositInfo } from '@/lib/contracts';
import { dollars } from '@/lib/format';
import { depositInstruction, testnetDepositWarning } from '@/lib/deposit';
import { TokenLogo } from './TokenLogo';
import { CrossChainDeposit } from './CrossChain';

// crossChain: also offer deposits from other chains (Aurora Intents).
type Props = { onClose: () => void; signerReady: boolean; permissionBusy: boolean; onGrantPermission: () => void; crossChain?: boolean };

export function DepositSheet({ onClose, signerReady, permissionBusy, onGrantPermission, crossChain = false }: Props) {
  const [network, setNetwork] = useState<'monad' | 'other'>('monad');
  const [info, setInfo] = useState<DepositInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [revision, setRevision] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let active = true;
    getAccessToken().then(token => {
      if (!token) throw new Error('Sign in again to see your deposit address.');
      return getDeposit(token);
    }).then(value => { if (active) { setInfo(value); setError(null); } })
      .catch(reason => { if (active) setError(reason instanceof Error ? reason.message : 'Deposit details unavailable.'); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [revision]);

  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose(); };
    window.addEventListener('keydown', closeOnEscape);
    return () => window.removeEventListener('keydown', closeOnEscape);
  }, [onClose]);

  const copy = async () => {
    if (!info) return;
    try { await navigator.clipboard.writeText(info.address); setCopied(true); }
    catch { setError('Could not copy the address. Select it manually.'); }
  };

  return <div className="modal-backdrop deposit-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}>
    <section className="deposit-sheet" role="dialog" aria-modal="true" aria-label="Deposit">
      <div className="trade-sheet-head"><h2>Deposit</h2><button className="icon-btn" title="Close deposit" onClick={onClose}><X size={18} /></button></div>
      {!signerReady && <div className="deposit-permission"><strong>Allow Cult to place your trades</strong><p className="field-note">{info?.tokens.some(token => token.symbol === 'USDC') ? 'Needed to convert USDC and fund trades automatically' : 'Needed to fund trades automatically'}</p><button className="btn btn-ghost btn-block" disabled={permissionBusy} onClick={onGrantPermission}>Allow</button></div>}
      {crossChain && <div className="seg seg--sm" role="tablist">
        <button role="tab" aria-selected={network === 'monad'} className={network === 'monad' ? 'on' : ''} onClick={() => setNetwork('monad')}>Monad</button>
        <button role="tab" aria-selected={network === 'other'} className={network === 'other' ? 'on' : ''} onClick={() => setNetwork('other')}>Another chain</button>
      </div>}
      {network === 'other' ? <CrossChainDeposit /> : loading ? <p className="field-note">Loading your wallet...</p> : error && !info ? <><p className="notice-line">{error}</p><button className="btn btn-ghost" onClick={() => { setLoading(true); setRevision(value => value + 1); }}><RefreshCw size={14} /> Retry</button></> : info && <>
        <div className="deposit-qr"><QRCodeSVG value={info.address} size={184} level="M" bgColor="#ffffff" fgColor="#151820" /></div>
        <div className="deposit-address-large">{info.address}</div>
        <button className="btn btn-ghost btn-block" onClick={copy}><Copy size={15} /> {copied ? 'Copied' : 'Copy address'}</button>
        <p className="deposit-instruction">{depositInstruction(info)}</p>
        {info.network.chainId === 10143 && <p className="notice-line" role="note">{testnetDepositWarning}</p>}
        <div className="deposit-tokens">{info.tokens.map(token => <div className="deposit-token" key={token.symbol}><TokenLogo symbol={token.symbol} className="deposit-token-icon" /><span className="deposit-token-name"><strong>{token.name}</strong><small>{token.what}</small></span><span className="deposit-token-balance"><strong>{new Intl.NumberFormat('en-US', { maximumFractionDigits: 6 }).format(token.balance)} {token.symbol}</strong><small>{dollars(token.balanceUsd)}</small></span></div>)}</div>
        {info.tradingAccountUsd != null && <div className="deposit-total"><span>Trading account</span><strong>{dollars(info.tradingAccountUsd)}</strong></div>}
        <div className="deposit-total grand"><span>Total</span><strong>{dollars(info.totalUsd)}</strong></div>
        {error && <p className="notice-line" role="status">{error}</p>}
      </>}
    </section>
  </div>;
}
