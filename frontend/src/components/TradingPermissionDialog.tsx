'use client';

import { X } from './icons';

export function TradingPermissionDialog({ onDecision }: { onDecision: (allowed: boolean) => void }) {
  return <div className="modal-backdrop permission-backdrop">
    <section className="simple-dialog" role="dialog" aria-modal="true" aria-labelledby="trading-permission-title">
      <button className="icon-btn dialog-close" title="Cancel" onClick={() => onDecision(false)}><X size={16} /></button>
      <h2 id="trading-permission-title">Allow Cult to place your trades</h2>
      <p className="field-note">Cult can only move money into your own trading accounts, up to $1,000 per transaction. It can never withdraw or send funds anywhere else.</p>
      <button className="btn btn-primary btn-block" autoFocus onClick={() => onDecision(true)}>Allow</button>
    </section>
  </div>;
}
