#!/usr/bin/env python3
"""
Independent validation harness for the Cult indexer's Perpl logic.

The GATE: prove the indexer's per-address win rate / realized PnL matches what
Perpl's own position history reports. This script re-derives the SAME numbers the
indexer computes, but from raw on-chain logs with a completely separate decoder —
so if the indexer and this script agree, the event-decoding and PnL logic are sound.
When a Perpl API key is available (backend Phase 1 E2E), feed the account's
position-history JSON to `--perpl-json` to diff against the venue's own API.

Usage:
  python3 scripts/validate.py --account-id 1234 --from-block 62953
  python3 scripts/validate.py --account-id 1234 --perpl-json /tmp/position_history.json

Requires Python 3 (stdlib only — keccak256 is implemented below).
"""

import argparse
import json
import sys
import urllib.request

RPC = "https://testnet-rpc.monad.xyz"
EXCHANGE = "0x1964C32f0bE608E7D29302AFF5E61268E72080cc"
CNS = 10**6

# --- keccak-256 (Ethereum) ------------------------------------------------
RC = [
    0x0000000000000001, 0x0000000000008082, 0x800000000000808A, 0x8000000080008000,
    0x000000000000808B, 0x0000000080000001, 0x8000000080008081, 0x8000000000008009,
    0x000000000000008A, 0x0000000000000088, 0x0000000080008009, 0x000000008000000A,
    0x000000008000808B, 0x800000000000008B, 0x8000000000008089, 0x8000000000008003,
    0x8000000000008002, 0x8000000000000080, 0x000000000000800A, 0x800000008000000A,
    0x8000000080008081, 0x8000000000008080, 0x0000000080000001, 0x8000000080008008,
]

def _rotl(x, n):
    if n == 0:
        return x
    return ((x << n) | (x >> (64 - n))) & 0xFFFFFFFFFFFFFFFF

def _keccak_f(state):
    ROT = [
        0, 1, 62, 28, 27,
        36, 44, 6, 55, 20,
        3, 10, 43, 25, 39,
        41, 45, 15, 21, 8,
        18, 2, 61, 56, 14,
    ]
    for rc in RC:
        C = [state[x] ^ state[x+5] ^ state[x+10] ^ state[x+15] ^ state[x+20] for x in range(5)]
        D = [C[(x-1)%5] ^ _rotl(C[(x+1)%5], 1) for x in range(5)]
        for x in range(25):
            state[x] ^= D[x % 5]
        B = [0]*25
        for x in range(5):
            for y in range(5):
                B[y + 5 * ((2*x + 3*y) % 5)] = _rotl(state[x + 5*y], ROT[x + 5*y])
        for x in range(5):
            for y in range(5):
                idx = x + 5*y
                state[idx] = B[idx] ^ ((~B[(x+1)%5 + 5*y]) & B[(x+2)%5 + 5*y])
        state[0] ^= rc

def keccak256(data: bytes) -> bytes:
    rate = 136
    pad = rate - (len(data) % rate)
    if pad == 1:
        data = data + b"\x81"
    else:
        data = data + b"\x01" + b"\x00" * (pad - 2) + b"\x80"
    state = [0]*25
    for i in range(0, len(data), rate):
        block = data[i:i+rate]
        for j in range(rate // 8):
            state[j] ^= int.from_bytes(block[j*8:j*8+8], "little")
        _keccak_f(state)
    return b"".join(int.to_bytes(x, 8, "little") for x in state[:4])[:32]

def topic0(sig: str) -> str:
    return "0x" + keccak256(sig.encode()).hex()

# --- RPC + ABI decode -----------------------------------------------------
def rpc(method, params):
    body = json.dumps({"jsonrpc": "2.0", "id": 1, "method": method, "params": params}).encode()
    req = urllib.request.Request(RPC, data=body, headers={"Content-Type": "application/json"})
    return json.loads(urllib.request.urlopen(req, timeout=120).read())

import os
_SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
ABI = json.load(open(os.path.join(_SCRIPT_DIR, "..", "abis", "Exchange.json")))
EV = {e["name"]: e for e in ABI}
SIG = {n: n + "(" + ",".join(i["type"] for i in EV[n]["inputs"]) + ")" for n in EV}

POSITION_EVENTS = [
    "PositionOpened", "PositionOpenedV2",
    "PositionIncreased", "PositionIncreasedV2",
    "PositionDecreased", "PositionClosed", "PositionInverted",
    "PositionLiquidated", "PositionDeleveraged", "PositionDeleveragedV2",
    "PositionUnwound", "PositionUnwoundV2",
]

def decode_fixed(types, data_hex):
    data = bytes.fromhex(data_hex[2:])
    out = []
    for t in types:
        if t in ("uint256", "int256"):
            out.append(int.from_bytes(data[:32], "big", signed=(t == "int256")))
            data = data[32:]
        elif t == "uint8":
            out.append(data[31]); data = data[32:]
        elif t == "bool":
            out.append(data[31] == 1); data = data[32:]
        elif t == "address":
            out.append("0x" + data[12:32].hex()); data = data[32:]
        else:
            raise ValueError(t)
    return out

def get_logs_chunked(topics, from_block, to_block, step=100):
    logs = []
    f = from_block
    while f <= to_block:
        t = min(f + step - 1, to_block)
        try:
            res = rpc("eth_getLogs", [{"address": EXCHANGE, "topics": topics, "fromBlock": hex(f), "toBlock": hex(t)}])
            logs.extend(res.get("result", []))
        except Exception as e:
            print(f"  (rpc error {f}-{t}: {e})", file=sys.stderr)
        f = t + 1
    return logs

def account_id_field(evname):
    return "posAccountId" if evname == "PositionLiquidated" else "accountId"

# --- replicate indexer logic ----------------------------------------------
class Position:
    def __init__(self, perpId, accountId, side, size, entry_price_pns):
        self.perpId = perpId
        self.accountId = accountId
        self.side = side
        self.size = size
        self.entry_price_pns = entry_price_pns
        self.realized = 0  # CNS

    def key(self):
        return (self.perpId, self.accountId)

def recompute(events):
    positions = {}
    trades = []
    for ev in events:
        name, d = ev
        perp = d["perpId"]
        acc = d[account_id_field(name)]
        key = (perp, acc)
        pos = positions.get(key)
        if name.startswith("PositionOpened"):
            if pos is not None and pos.size > 0:
                trades.append((pos.realized, pos.size))
            pos = Position(perp, acc, d["positionType"], d["lotLNS"], d["pricePNS"])
            positions[key] = pos
        elif name.startswith("PositionIncreased"):
            if pos is None:
                continue
            pos.size = d["endLotLNS"]
            pos.entry_price_pns = d["pricePNS"]
        elif name.startswith("PositionDecreased"):
            if pos is None:
                continue
            pos.realized += d["deltaPnlCNS"] + d["fundingCNS"]
            pos.size = d["endLotLNS"]
            if d["endLotLNS"] == 0:
                trades.append((pos.realized, 0))
                del positions[key]
        elif name.startswith("PositionClosed"):
            if pos is None:
                continue
            pos.realized += d["deltaPnlCNS"] + d["fundingCNS"]
            trades.append((pos.realized, 0))
            del positions[key]
        elif name.startswith("PositionInverted"):
            if pos is None:
                continue
            pos.realized += d["deltaPnlCNS"] + d["fundingCNS"]
            trades.append((pos.realized, 0))
            pos.side = d["positionType"]
            pos.size = d["endLotLNS"]
            pos.entry_price_pns = d["pricePNS"]
            pos.realized = 0
        elif name.startswith("PositionLiquidated"):
            if pos is None:
                continue
            pos.realized += d["deltaPnlCNS"] + d["fundingCNS"]
            remaining = d["posLotLNS"] - d["liqLotLNS"]
            if remaining <= 0:
                trades.append((pos.realized, 0))
                del positions[key]
            else:
                pos.size = remaining
        elif name.startswith("PositionDeleveraged"):
            if pos is None:
                continue
            pos.realized += d["deltaPnlCNS"] + d["fundingCNS"]
            pos.size = d["endLotLNS"]
            if d["endLotLNS"] == 0:
                trades.append((pos.realized, 0))
                del positions[key]
        elif name.startswith("PositionUnwound"):
            if pos is None:
                continue
            pos.realized += d["positionFmvCNS"]
            trades.append((pos.realized, 0))
            del positions[key]
    return trades

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--account-id", type=int, required=True)
    ap.add_argument("--from-block", type=int, default=62953)
    ap.add_argument("--perpl-json", help="path to Perpl position-history JSON for the same account")
    args = ap.parse_args()

    to_block = int(rpc("eth_blockNumber", [])["result"], 16)

    events = []
    for name in POSITION_EVENTS:
        topics = [topic0(SIG[name])]
        ev = EV[name]
        types = [i["type"] for i in ev["inputs"]]
        names = [i["name"] for i in ev["inputs"]]
        for lg in get_logs_chunked(topics, args.from_block, to_block):
            vals = decode_fixed(types, lg["data"])
            d = dict(zip(names, vals))
            if d[account_id_field(name)] == args.account_id:
                events.append((name, d, int(lg["blockNumber"], 16), int(lg["logIndex"], 16)))
    events.sort(key=lambda e: (e[2], e[3]))

    trades = recompute([(e[0], e[1]) for e in events])
    total = len(trades)
    wins = sum(1 for pnl, _ in trades if pnl > 0)
    realized = sum(pnl for pnl, _ in trades)

    print(f"account {args.account_id}: {total} closed trades, {wins} wins, "
          f"win rate {wins/total if total else 0:.4f}, realized PnL {realized/CNS:.2f} USD "
          f"(raw {realized} CNS)")

    if args.perpl_json:
        perpl = json.load(open(args.perpl_json))
        print("\nPerpl position-history summary (manual diff):")
        print(json.dumps(perpl, indent=2)[:2000])

if __name__ == "__main__":
    main()
