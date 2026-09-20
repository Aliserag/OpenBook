import { useState, type JSX } from "react";
import { env } from "../env";
import { ARC_FAUCET } from "./WalletButton";

const KEY = "ob.banner.faucet.v1";
const IS_MAINNET = env.arcChainId === 5042;

/** A dismissable notice: which network this deployment runs on, and what a buyer's wallet
 *  needs there (testnet USDC from the faucet, or real USDC over the bridge). */
export function FaucetBanner(): JSX.Element | null {
  const [shown, setShown] = useState<boolean>(() => {
    try {
      return localStorage.getItem(KEY) !== "off";
    } catch {
      return true;
    }
  });
  if (!shown) return null;
  return (
    <div className="banner" role="status">
      <span>
        {IS_MAINNET ? (
          <>OpenBook runs on Arc mainnet. Buying with your own wallet spends real USDC. The console's chips work with no wallet at all.</>
        ) : (
          <>
            OpenBook runs on Arc testnet. To buy with your own wallet you need testnet USDC: get it from the{" "}
            <a href={ARC_FAUCET} target="_blank" rel="noreferrer">
              Arc faucet
            </a>
            . The console's chips work with no wallet at all.
          </>
        )}
      </span>
      <button
        type="button"
        className="banner__close"
        aria-label="dismiss"
        onClick={() => {
          setShown(false);
          try {
            localStorage.setItem(KEY, "off");
          } catch {
            // storage may be unavailable; the banner simply returns next load
          }
        }}
      >
        ×
      </button>
    </div>
  );
}
