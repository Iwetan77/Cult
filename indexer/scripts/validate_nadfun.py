#!/usr/bin/env python3
"""
Nad.fun gate harness. Re-derives a wallet's realized MON PnL / trade count / wins
from raw router Buy/Sell logs with an independent decoder, and cross-checks it
against Nad.fun's own swap history.

Usage:
  python3 scripts/validate_nadfun.py --wallet 0x... --token 0x... [--from-block N]
  python3 scripts/validate_nadfun.py --wallet 0x... --token 0x... --check-api

Cost-basis rules (from CONTRACTS.md): average cost per (wallet, token) in MON wei.
  Buy:  qty += amountOut; cost += amountIn
  Sell: realized += amountOut - cost * amountIn / qty; cost -= cost * amountIn / qty; qty -= amountIn
A "trade" is a round trip from qty 0 back to qty 0. A win is realized > 0.
"""

import argparse
import json
import os
import sys
import urllib.request

_SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, _SCRIPT_DIR)
from validate import topic0, rpc  # noqa: E402

ROUTER = "0x75588668999cA0557b78046b8a5E86b47b9234ec"
API_BASE = "https://dev-api.nadapp.net"
MON = 10**18

ABI = json.load(open(os.path.join(_SCRIPT_DIR, "..", "abis", "NadFunRouter.json")))
EV = {e["name"]: e for e in ABI}


def sig_of(name):
    e = EV[name]
    return name + "(" + ",".join(i["type"] for i in e["inputs"]) + ")"


def addr_topic(a):
    return "0x" + a[2:].lower().rjust(64, "0")


def get_events(wallet, from_block, to_block, step=100):
    wallet_t = addr_topic(wallet)
    out = []
    for name in ("Buy", "Sell"):
        topics = [topic0(sig_of(name)), wallet_t]
        f = from_block
        while f <= to_block:
            t = min(f + step - 1, to_block)
            try:
                logs = rpc("eth_getLogs", [{
                    "address": ROUTER,
                    "topics": topics,
                    "fromBlock": hex(f),
                    "toBlock": hex(t),
                }])["result"]
            except Exception as e:
                print(f"  (rpc error {f}-{t}: {e})", file=sys.stderr)
                logs = []
            for lg in logs:
                token = "0x" + lg["topics"][2][-40:]
                data = bytes.fromhex(lg["data"][2:])
                amountIn = int.from_bytes(data[0:32], "big")
                amountOut = int.from_bytes(data[32:64], "big")
                graduated = data[95] == 1
                out.append((name, token, amountIn, amountOut, graduated,
                            int(lg["blockNumber"], 16), lg["transactionHash"]))
            f = t + 1
    out.sort(key=lambda e: (e[5], e[6]))
    return out


def recompute(events, wallet, token):
    qty = 0
    cost = 0
    realized = 0
    trades = []
    buys = sells = 0
    for name, tok, amountIn, amountOut, graduated, block, tx in events:
        if tok.lower() != token.lower():
            continue
        if name == "Buy":
            qty += amountOut
            cost += amountIn
            buys += 1
        else:  # Sell
            sold_cost = (cost * amountIn) // qty if qty > 0 else 0
            realized += amountOut - sold_cost
            cost -= sold_cost
            qty -= amountIn
            sells += 1
            if qty <= 0:
                trades.append((realized, block, tx))
                realized = 0
                qty = 0
                cost = 0
    return trades, buys, sells


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--wallet", required=True)
    ap.add_argument("--token", required=True)
    ap.add_argument("--from-block", type=int, default=30418626)
    ap.add_argument("--to-block", type=int, default=None)
    ap.add_argument("--check-api", action="store_true")
    args = ap.parse_args()

    to_block = args.to_block if args.to_block is not None else int(rpc("eth_blockNumber", [])["result"], 16)
    events = get_events(args.wallet, args.from_block, to_block)
    trades, buys, sells = recompute(events, args.wallet, args.token)

    total = len(trades)
    wins = sum(1 for r, _, _ in trades if r > 0)
    pnl = sum(r for r, _, _ in trades)

    print(f"wallet {args.wallet}")
    print(f"token  {args.token}")
    print(f"buys={buys} sells={sells}")
    print(f"closed trades: {total}")
    print(f"wins: {wins}")
    print(f"realized PnL: {pnl / MON:.6f} MON (raw {pnl} wei)")

    if args.check_api:
        url = f"{API_BASE}/trade/swap-history/{args.token}"
        req = urllib.request.Request(url, headers={"User-Agent": "cult-indexer/1.0"})
        data = json.loads(urllib.request.urlopen(req, timeout=60).read())
        swaps = data.get("swaps", [])
        mine = [s for s in swaps if s["account_info"]["account_id"].lower() == args.wallet.lower()]
        native_in = sum(int(s["swap_info"]["native_amount"]) for s in mine if s["swap_info"]["event_type"] == "BUY")
        native_out = sum(int(s["swap_info"]["native_amount"]) for s in mine if s["swap_info"]["event_type"] == "SELL")
        api_pnl = native_out - native_in
        print(f"\nNad.fun API: buys MON={native_in/MON:.6f} sells MON={native_out/MON:.6f} realized={api_pnl/MON:.6f} MON")
        print(f"match: {api_pnl == pnl}")


if __name__ == "__main__":
    main()
