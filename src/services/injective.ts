import { getEnv } from "../config/env.js";
import { Network, getNetworkEndpoints } from "@injectivelabs/networks";
import { childLogger } from "../utils/logger.js";

const log = childLogger({ service: "injective" });

let _bankApi: any = null;
let _authApi: any = null;
let _explorerApi: any = null;
let _privateKey: any = null;
let _treasuryAddress: string = "";

function getNetwork() {
  const env = getEnv();
  return env.INJECTIVE_NETWORK === "mainnet" ? Network.Mainnet : Network.Testnet;
}

function getEndpoints() {
  return getNetworkEndpoints(getNetwork());
}

async function lazyInit() {
  if (_bankApi) return;

  const sdk = await import("@injectivelabs/sdk-ts");
  const endpoints = getEndpoints();

  _bankApi = new sdk.ChainGrpcBankApi(endpoints.grpc);
  _authApi = new sdk.ChainRestAuthApi(endpoints.rest);
  _explorerApi = new sdk.IndexerGrpcExplorerApi(endpoints.indexer);

  const env = getEnv();
  if (env.TREASURY_PRIVATE_KEY) {
    _privateKey = sdk.PrivateKey.fromHex(env.TREASURY_PRIVATE_KEY);
    _treasuryAddress = env.TREASURY_INJ_ADDRESS;

    const derivedAddress = _privateKey.toBech32();
    if (derivedAddress !== _treasuryAddress) {
      throw new Error(
        `Treasury address mismatch: env=${_treasuryAddress}, derived=${derivedAddress}`,
      );
    }
  }

  log.info(
    { network: env.INJECTIVE_NETWORK, treasury: _treasuryAddress },
    "Injective client initialized",
  );
}

export async function getBankBalance(address: string): Promise<string> {
  await lazyInit();
  const { amount } = await _bankApi.fetchBalance({
    accountAddress: address,
    denom: "inj",
  });
  return amount?.amount ?? "0";
}

export async function getTreasuryBalance(): Promise<string> {
  await lazyInit();
  return getBankBalance(_treasuryAddress);
}

export interface IncomingTx {
  txHash: string;
  height: bigint;
  fromAddress: string;
  toAddress: string;
  denom: string;
  amount: string;
  memo: string;
  code: number;
}

export async function searchByMemo(
  memo: string,
  minHeight?: number,
): Promise<IncomingTx[]> {
  await lazyInit();
  const endpoints = getEndpoints();
  const results: IncomingTx[] = [];

  try {
    const tmUrl = `${(endpoints as any).tm?.replace(/\/$/, "")}/tx_search?query="memo='${memo}'"&per_page=100${minHeight ? `&minHeight=${minHeight}` : ""}`;
    const response = await fetch(tmUrl, {
      signal: AbortSignal.timeout(15_000),
    });
    const data = (await response.json()) as {
      result?: { txs: any[] };
    };

    if (data.result?.txs) {
      for (const tx of data.result.txs) {
        const parsed = parseTxResult(tx);
        if (parsed) results.push(parsed);
      }
    }
  } catch (err) {
    log.warn({ err, memo }, "tm tx_search failed");
  }

  return results;
}

function parseTxResult(tx: any): IncomingTx | null {
  try {
    const hash = tx.hash;
    const height = BigInt(tx.height);
    const code = tx.result?.code ?? 0;

    const body = tx.tx?.value?.msg?.[0]?.value;
    if (!body) return null;

    return {
      txHash: hash,
      height,
      fromAddress: body.from_address ?? "",
      toAddress: body.to_address ?? "",
      denom: body.amount?.denom ?? "inj",
      amount: body.amount?.amount ?? "0",
      memo: tx.tx?.value?.memo ?? "",
      code,
    };
  } catch {
    return null;
  }
}

export async function getLatestHeight(): Promise<bigint> {
  await lazyInit();
  const endpoints = getEndpoints();
  const response = await fetch(`${(endpoints as any).rest}/cosmos/base/tendermint/v1beta1/blocks/latest`, {
    signal: AbortSignal.timeout(10_000),
  });
  const data = (await response.json()) as {
    block?: { header?: { height?: string } };
  };
  return BigInt(data.block?.header?.height ?? "0");
}

export async function broadcastMsgSend(args: {
  to: string;
  amountBase: string;
  memo: string;
}): Promise<{ txHash: string; height?: bigint; code: number }> {
  await lazyInit();

  const sdk = await import("@injectivelabs/sdk-ts");
  const networks = await import("@injectivelabs/networks");

  const env = getEnv();
  const network = env.INJECTIVE_NETWORK === "mainnet" ? Network.Mainnet : Network.Testnet;
  const endpoints = networks.getNetworkEndpoints(network);

  const accountDetails = await _authApi.fetchAccount(_treasuryAddress);

  const amountInChain = {
    denom: "inj",
    amount: args.amountBase,
  };

  const msg = sdk.MsgSend.fromJSON({
    amount: amountInChain,
    srcInjectiveAddress: _treasuryAddress,
    dstInjectiveAddress: args.to,
  });

  const pubKey = _privateKey.toPublicKey().toBase64();

  const { txRaw } = sdk.createTransaction({
    message: msg,
    memo: args.memo,
    fee: {
      amount: [{ denom: "inj", amount: "500000000000000" }],
      gas: "200000",
    },
    chainId: network === Network.Mainnet ? "injective-1" : "injective-888",
    pubKey,
    sequence: accountDetails.account?.sequence ?? 0,
    accountNumber: accountDetails.account?.accountNumber ?? 0,
  });

  const preHash = sdk.TxClient.hash(txRaw);

  const broadcaster = new sdk.MsgBroadcasterWithPk({
    network,
    privateKey: _privateKey,
    endpoints,
  });

  log.info({ to: args.to, memo: args.memo, preHash }, "Broadcasting MsgSend");

  const result = await broadcaster.broadcast({
    msgs: msg,
    memo: args.memo,
  });

  return {
    txHash: result.txHash ?? preHash,
    height: result.height ? BigInt(result.height) : undefined,
    code: result.code ?? 0,
  };
}

export async function fetchTxByHash(
  txHash: string,
): Promise<{ code: number; height: bigint } | null> {
  await lazyInit();
  try {
    const tx = await _explorerApi.fetchTxByHash({ txHash });
    return {
      code: tx.code ?? 0,
      height: BigInt(tx.height ?? 0),
    };
  } catch {
    return null;
  }
}
