import { randomUUID } from 'node:crypto';
import { ethers } from 'ethers';

// Some wallet steps only the member's own key may sign: opening their
// Polymarket account, its approvals, authorizing our trading key, moving their
// money out. The Polymarket SDK runs those as flows that stop and ask a Signer
// for a signature. Here the Signer is the browser: when the flow asks, we park
// it, answer the HTTP call with what to sign, and pick it up again when the
// signature comes back on the next call. The backend never holds the member's
// key and never signs for it.
//
// One flow per member at a time; starting another cancels the old one. Flows
// live in memory (one Railway replica), so a restart drops them and the member
// starts again; nothing half-signed is ever submitted.

export interface TypedDataField {
  name: string;
  type: string;
}

// EIP-712, JSON-safe: bigints become decimal strings, and `types` carries
// EIP712Domain so eth_signTypedData_v4 in any wallet accepts it as is.
export interface TypedDataJson {
  domain: Record<string, unknown>;
  types: Record<string, TypedDataField[]>;
  primaryType: string;
  message: Record<string, unknown>;
}

export interface SignatureRequest {
  challengeId: string;
  label: string; // what the member is approving, in plain words
  kind: 'typedData' | 'message';
  typedData: TypedDataJson | null; // kind typedData: eth_signTypedData_v4
  message: string | null; // kind message: personal_sign over these bytes (0x hex)
  expiresAt: string;
}

// What every call in a flow answers with. `working`: the flow is busy (e.g.
// waiting for a transaction); ask again with the same flowId.
export type FlowStep<T> =
  | { status: 'needs_signature'; flowId: string; signature: SignatureRequest }
  | { status: 'working'; flowId: string; label: string }
  | { status: 'done'; flowId: string; result: T };

export class FlowError extends Error {
  constructor(
    readonly status: 400 | 403 | 404 | 409 | 410,
    message: string,
  ) {
    super(message);
  }
}

// The SDK's Signer contract (see @polymarket/client), declared here so tests
// don't need the SDK.
export interface BrowserSigner {
  getAddress(): Promise<`0x${string}`>;
  signTypedData(payload: { domain: object; types: Record<string, readonly TypedDataField[]>; primaryType: string; message: object }): Promise<`0x${string}`>;
  signMessage(message: `0x${string}`): Promise<`0x${string}`>;
  sendTransaction(request: unknown): Promise<never>;
}

type Event = { type: 'sign'; request: SignatureRequest } | { type: 'done'; result: unknown } | { type: 'error'; error: unknown };

interface Pending {
  request: SignatureRequest;
  raw: TypedDataJson | null;
  resolve: (signature: `0x${string}`) => void;
  reject: (reason: unknown) => void;
  expires: number;
}

const SIGN_TTL_MS = 5 * 60_000; // a member has this long to sign each step
const WAIT_MS = 20_000; // one HTTP call waits at most this long for the next step

class Flow {
  readonly id = randomUUID();
  pending: Pending | null = null;
  finished = false;
  private queue: Event[] = [];
  private waiter: ((e: Event) => void) | null = null;
  private lastLabel: string;

  constructor(
    readonly userId: string,
    readonly wallet: string,
    label: string,
    private readonly labelFor: (payload: TypedDataJson | null) => string,
  ) {
    this.lastLabel = label;
  }

  signer(): BrowserSigner {
    return {
      getAddress: async () => ethers.getAddress(this.wallet) as `0x${string}`,
      signTypedData: (payload) => this.ask('typedData', toTypedDataJson(payload), null),
      signMessage: (message) => this.ask('message', null, message),
      sendTransaction: async () => {
        // Every Polymarket wallet step we use is gasless (relayer); a direct
        // Polygon transaction would need POL the member doesn't have.
        throw new FlowError(409, 'this step needs a Polygon transaction, which Cult does not send');
      },
    };
  }

  private ask(kind: SignatureRequest['kind'], typedData: TypedDataJson | null, message: string | null): Promise<`0x${string}`> {
    if (this.finished) return Promise.reject(new FlowError(410, 'this step was cancelled'));
    return new Promise((resolve, reject) => {
      const expires = Date.now() + SIGN_TTL_MS;
      const request: SignatureRequest = {
        challengeId: randomUUID(),
        label: this.labelFor(typedData),
        kind,
        typedData,
        message,
        expiresAt: new Date(expires).toISOString(),
      };
      this.lastLabel = request.label;
      this.pending = { request, raw: typedData, resolve, reject, expires };
      this.emit({ type: 'sign', request });
    });
  }

  emit(e: Event) {
    if (e.type !== 'sign') this.finished = true;
    if (this.waiter) {
      const w = this.waiter;
      this.waiter = null;
      w(e);
    } else this.queue.push(e);
  }

  // The next thing the caller should hear: a signature to collect, the result,
  // or "still working" after WAIT_MS.
  async next<T>(): Promise<FlowStep<T>> {
    const queued = this.queue.shift();
    // Asked again while a signature is still outstanding: the same request.
    if (!queued && this.pending) return { status: 'needs_signature', flowId: this.id, signature: this.pending.request };
    const e =
      queued ??
      (await new Promise<Event | null>((resolve) => {
        const timer = setTimeout(() => {
          this.waiter = null;
          resolve(null);
        }, WAIT_MS);
        timer.unref?.();
        this.waiter = (ev) => {
          clearTimeout(timer);
          resolve(ev);
        };
      }));
    if (!e) return { status: 'working', flowId: this.id, label: this.lastLabel };
    if (e.type === 'sign') return { status: 'needs_signature', flowId: this.id, signature: e.request };
    if (e.type === 'done') return { status: 'done', flowId: this.id, result: e.result as T };
    throw e.error;
  }

  cancel(reason: string) {
    const p = this.pending;
    this.pending = null;
    this.finished = true;
    p?.reject(new FlowError(410, reason));
  }
}

export class SignatureBroker {
  private flows = new Map<string, Flow>(); // by flow id
  private byUser = new Map<string, Flow>();

  constructor(private readonly labelFor: (payload: TypedDataJson | null) => string = () => 'Approve in your wallet') {
    setInterval(() => this.sweep(), 30_000).unref();
  }

  // Run `work` with a signer that asks the member's browser. Answers with the
  // first step: a signature to collect, the result, or "working".
  async start<T>(userId: string, wallet: string, label: string, work: (signer: BrowserSigner) => Promise<T>): Promise<FlowStep<T>> {
    this.byUser.get(userId)?.cancel('replaced by a newer request');
    const flow = new Flow(userId, wallet, label, this.labelFor);
    this.flows.set(flow.id, flow);
    this.byUser.set(userId, flow);
    work(flow.signer()).then(
      (result) => flow.emit({ type: 'done', result }),
      (error) => flow.emit({ type: 'error', error }),
    );
    return this.settle<T>(flow);
  }

  // The member signed `challengeId`: check it's really their wallet, hand it to
  // the parked flow, and answer with the step after.
  async resume<T = unknown>(userId: string, flowId: string, challengeId: string, signature: string): Promise<FlowStep<T>> {
    const flow = this.flows.get(flowId);
    if (!flow || flow.userId !== userId) throw new FlowError(404, 'this request has expired, start again');
    const p = flow.pending;
    if (!p || p.request.challengeId !== challengeId) throw new FlowError(409, 'nothing is waiting for this signature');
    if (Date.now() > p.expires) {
      flow.cancel('the signature request expired');
      throw new FlowError(410, 'the signature request expired, start again');
    }
    if (!/^0x[0-9a-fA-F]+$/.test(signature)) throw new FlowError(400, 'not a signature');
    if (!signedBy(p, signature, flow.wallet)) throw new FlowError(403, 'that signature is not from your Cult wallet');
    flow.pending = null;
    p.resolve(signature as `0x${string}`);
    return this.settle<T>(flow);
  }

  // "Still working?" for a flow that answered `working`.
  async poll<T = unknown>(userId: string, flowId: string): Promise<FlowStep<T>> {
    const flow = this.flows.get(flowId);
    if (!flow || flow.userId !== userId) throw new FlowError(404, 'this request has expired, start again');
    return this.settle<T>(flow);
  }

  cancel(userId: string) {
    this.byUser.get(userId)?.cancel('cancelled');
  }

  private async settle<T>(flow: Flow): Promise<FlowStep<T>> {
    try {
      const step = await flow.next<T>();
      if (step.status === 'done') this.drop(flow);
      return step;
    } catch (e) {
      this.drop(flow);
      throw e;
    }
  }

  private drop(flow: Flow) {
    this.flows.delete(flow.id);
    if (this.byUser.get(flow.userId) === flow) this.byUser.delete(flow.userId);
  }

  private sweep() {
    const now = Date.now();
    for (const flow of this.flows.values()) {
      if (flow.pending && now > flow.pending.expires) flow.cancel('the signature request expired');
      if (flow.finished && !flow.pending) this.drop(flow);
    }
  }
}

function signedBy(p: Pending, signature: string, wallet: string): boolean {
  try {
    if (p.request.kind === 'message') return ethers.verifyMessage(ethers.getBytes(p.request.message!), signature).toLowerCase() === wallet.toLowerCase();
    const { EIP712Domain: _domain, ...types } = p.raw!.types;
    return ethers.verifyTypedData(p.raw!.domain as ethers.TypedDataDomain, types, p.raw!.message, signature).toLowerCase() === wallet.toLowerCase();
  } catch (e) {
    // Can't encode it ourselves (an exotic type): let the venue reject it
    // rather than block a member on our own limitation.
    console.warn('[sign] could not verify a signature locally:', (e as Error).message);
    return true;
  }
}

const DOMAIN_FIELDS: Array<[string, string]> = [
  ['name', 'string'],
  ['version', 'string'],
  ['chainId', 'uint256'],
  ['verifyingContract', 'address'],
  ['salt', 'bytes32'],
];

export function toTypedDataJson(payload: { domain: object; types: Record<string, readonly TypedDataField[]>; primaryType: string; message: object }): TypedDataJson {
  const domain = jsonSafe(payload.domain) as Record<string, unknown>;
  const types: Record<string, TypedDataField[]> = {};
  for (const [k, v] of Object.entries(payload.types)) if (k !== 'EIP712Domain') types[k] = v.map((f) => ({ name: f.name, type: f.type }));
  return {
    domain,
    types: { EIP712Domain: DOMAIN_FIELDS.filter(([name]) => domain[name] !== undefined).map(([name, type]) => ({ name, type })), ...types },
    primaryType: payload.primaryType,
    message: jsonSafe(payload.message) as Record<string, unknown>,
  };
}

function jsonSafe(v: unknown): unknown {
  if (typeof v === 'bigint') return v.toString();
  if (Array.isArray(v)) return v.map(jsonSafe);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).filter(([, x]) => x !== undefined).map(([k, x]) => [k, jsonSafe(x)]));
  return v;
}
