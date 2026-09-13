import type { JSX } from "react";
import { useAccount, useBalance, useConnect, useDisconnect } from "wagmi";
import { ensureArcChain } from "../arc";
import { truncateHash } from "../format";

export const ARC_FAUCET = "https://faucet.circle.com";

/**
 * Connect a browser wallet on Arc testnet. Once connected, the console's
 * act commands buy with this wallet (three signatures: createJob, approve,
 * fund; gas in Arc's native USDC) instead of the deployment's Circle wallet.
 */
export function WalletButton(): JSX.Element {
  const { address, isConnected } = useAccount();
  const { connect, connectors, isPending } = useConnect();
  const { disconnect } = useDisconnect();
  const balance = useBalance({ address, query: { enabled: isConnected, refetchInterval: 30_000 } });
  const injected = connectors[0];
  if (!isConnected || !address) {
    return (
      <button
        type="button"
        className="wallet"
        disabled={injected === undefined || isPending}
        title={injected === undefined ? "no browser wallet found" : "connect a browser wallet on Arc testnet"}
        onClick={() => {
          if (injected === undefined) return;
          connect({ connector: injected }, { onSuccess: () => void ensureArcChain().catch(() => undefined) });
        }}
      >
        {isPending ? "connecting…" : "Connect wallet"}
      </button>
    );
  }
  const usdc = balance.data ? Number(balance.data.value) / 1e18 : null;
  const low = usdc !== null && usdc < 0.2;
  return (
    <span className="wallet wallet--on" title={address}>
      <span className="wallet__addr">{truncateHash(address)}</span>
      <span className="wallet__bal">{usdc === null ? "…" : `${usdc.toFixed(2)} USDC`}</span>
      {low && (
        <a className="wallet__faucet" href={ARC_FAUCET} target="_blank" rel="noreferrer">
          get testnet USDC
        </a>
      )}
      <button type="button" className="wallet__off" onClick={() => disconnect()} aria-label="disconnect wallet">
        ×
      </button>
    </span>
  );
}
