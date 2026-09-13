/**
 * OpenBook: one page, five sections. Hero (the console, open, with the latest
 * real refund as its first receipt) → The market (an exchange screen) → The
 * books → Try it (the same purchase with buttons) → How it works. The replay
 * theater and the system map stay as secondary surfaces; the system map keeps
 * the docked console.
 */
import { useEffect, useState, type JSX } from "react";
import { setEscrowAddress, setUsdcAddress } from "../../agent/escrow";
import { env } from "./env";
import { ADDR } from "./data/addresses";
import { FeedProvider } from "./data/feed";
import { Hero } from "./sections/Hero";
import { TryIt } from "./sections/TryIt";
import { MarketSection } from "./sections/MarketSection";
import { Builders } from "./sections/Builders";
import { Console } from "./console/Console";
import { TheaterRoute } from "./theater/Theater";
import { SystemMap } from "./map/MapCanvas";
import { TopBar } from "./ui/TopBar";
import { FaucetBanner } from "./ui/FaucetBanner";

// Chain-specific USDC (VITE_USDC_ADDRESS), mainnet override for the escrow module.
if (env.usdcAddress !== undefined && /^0x[0-9a-fA-F]{40}$/.test(env.usdcAddress)) {
  setUsdcAddress(env.usdcAddress as `0x${string}`);
}
// Every write targets the market escrow (the instance that whitelists our SlaHook).
setEscrowAddress(ADDR.escrow);

export default function App(): JSX.Element {
  const [armed, setArmed] = useState<"fresh" | "fail" | null>(null);
  const routeOf = (): "map" | "market" | "page" =>
    window.location.hash === "#map" ? "map" : window.location.hash === "#market" ? "market" : "page";
  const [route, setRoute] = useState<"map" | "market" | "page">(routeOf);
  const mapRoute = route === "map";
  const marketRoute = route === "market";

  useEffect(() => {
    const onHash = (): void => {
      const next = routeOf();
      setRoute(next);
      if (next !== "page") window.scrollTo(0, 0);
      // a section link from another page: the section mounts after the route flips
      else if (/^#[A-Za-z][\w-]*$/.test(window.location.hash)) window.setTimeout(() => document.getElementById(window.location.hash.slice(1))?.scrollIntoView({ behavior: "smooth", block: "start" }), 60);
    };
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  const go = (mode: "fresh" | "fail"): void => {
    setArmed(null);
    document.getElementById("try")?.scrollIntoView({ behavior: "smooth", block: "start" });
    window.setTimeout(() => setArmed(mode), 350);
  };
  const openConsole = (): void => {
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "k", metaKey: true, bubbles: true }));
  };

  return (
    <FeedProvider>
      <FaucetBanner />
      {mapRoute ? (
        <main className="wrap map-route">
          <TopBar current="map" />
          <SystemMap />
        </main>
      ) : marketRoute ? (
        <main className="market-route">
          <div className="wrap">
            <TopBar current="market" />
          </div>
          <MarketSection variant="page" />
        </main>
      ) : (
        <main>
          <Hero />
          <MarketSection variant="teaser" />
          <TryIt armed={armed} onArmedConsumed={() => setArmed(null)} />
          <Builders onConsole={openConsole} onBuy={() => go("fresh")} />
          <footer className="foot wrap">
            <span className="tiny">OpenBook · built for ETHOnline 2026 · Arc testnet, ENSv2 on Sepolia, The Graph</span>
          </footer>
        </main>
      )}
      {(mapRoute || marketRoute) && <Console />}
      <TheaterRoute />
    </FeedProvider>
  );
}
