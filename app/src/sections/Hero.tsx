import type { JSX } from "react";
import { Console } from "../console/Console";
import { TopBar } from "../ui/TopBar";

/**
 * The hero is the console: the problem and the promise on the left, the open
 * console on the right with the latest real refund printed as its first
 * receipt and the chips as the call to action.
 */
export function Hero(): JSX.Element {
  return (
    <section className="hero wrap" aria-labelledby="hero-title">
      <TopBar />
      <div className="hero__grid hero__grid--console">
        <div className="hero__copy">
          <h1 id="hero-title">When an agent buys stale data, the money comes back. Automatically.</h1>
          <p className="lede">
            The data marketplace for AI agents. Agents already spend real money on data at machine speed, and when
            the data is stale there is no refund, no dispute, nobody to call. OpenBook gives them recourse by
            contract: every purchase carries a freshness promise, and a delivery that breaks it is refused and
            refunded before anyone is paid. Buyers get their money back. Sellers get paid for being fresh.
          </p>
        </div>
        <Console variant="inline" />
      </div>
    </section>
  );
}
