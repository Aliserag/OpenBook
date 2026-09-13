import type { JSX } from "react";
import { WalletButton } from "./WalletButton";

/** The page header: brand plus the section links. `current` names the page the reader is on. */
export function TopBar({ current }: { current?: "market" | "map" }): JSX.Element {
  return (
    <div className="hero__top">
      <a className="hero__brand" href="#" aria-label="OpenBook home">
        <span className="hero__mark" aria-hidden="true">
          OB
        </span>
        OpenBook
      </a>
      <nav className="hero__nav" aria-label="sections">
        <a href="#market" aria-current={current === "market" ? "page" : undefined}>
          Market
        </a>
        <a href="#try">Try it</a>
        <a href="#how">How it works</a>
        <a href="#map" aria-current={current === "map" ? "page" : undefined}>
          System map
        </a>
        <WalletButton />
      </nav>
    </div>
  );
}
