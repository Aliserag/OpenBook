import { useState, type JSX } from "react";
import { ARC_FAUCET } from "./WalletButton";

const KEY = "ob.banner.faucet.v1";

/** A dismissable notice: this is a testnet, and a wallet needs testnet USDC to buy. */
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
        OpenBook runs on Arc testnet. To buy with your own wallet you need testnet USDC: get it from the{" "}
        <a href={ARC_FAUCET} target="_blank" rel="noreferrer">
          Arc faucet
        </a>
        . The console's chips work with no wallet at all.
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
