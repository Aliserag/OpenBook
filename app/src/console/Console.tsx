/**
 * Console — the docked command surface: a receipt PRINTER, not a dark
 * terminal (design ruling, spec §5.3c). Every command prints a perforated
 * receipt block (header row = serial + printed timestamp + kind chip; mono
 * body rows) with an inked rubber-stamp verdict for settle/refund/refusal
 * receipts (APPROVED / REFUNDED / REFUSED). The header strip carries the
 * always-live source chips OUTSIDE the tape (arc head, subgraph index, ENS
 * price — live/stale/error with reasons, never a stale value presented as
 * fresh; spec S9).
 *
 * Ask mode (chat-first, the LLM PROPOSES and the registry EXECUTES): the
 * mode chip above the input toggles command/ask (click or Tab when the
 * command lane resolves nothing, which also prints the "did you mean to
 * ask?" nudge). Ask submits an OpenAI-compatible chat request (env VITE_LLM_*,
 * see env.ts/.env.example) whose system prompt carries the registry schema,
 * the exact dataset ids, and a compact live context; the model returns only
 * `{"command", "argv", "rationale"}` or a refusal, validated against the
 * registry (exact name, arg arity, enumerated dataset ids) with one
 * temperature-0 retry. Proposals print as `proposed · <command argv>` tape
 * blocks; act/sandbox need the Run button or Enter (nothing auto-executes),
 * inspect/replay run on Enter like a typed line, and execution goes through
 * dispatch() unchanged so receipts are identical to typed usage. No key ->
 * the chip reads "ask: set VITE_LLM_API_KEY" and the chips (static mappings)
 * keep every command keyless. The asking state shows "asking <model>…" with
 * a cancel and a 45s budget; the dock never blocks on the model.
 *
 * Keyboard grammar (spec §5.3d): ⌘K opens the fuzzy palette over the
 * registry + dataset ids, ↑/↓ walk history, Tab completes (command mode) or
 * toggles the mode (ask mode / unresolvable input), Esc cancels the ask,
 * clears the pending proposal, then the popover, then the dock, ⌘L clears
 * the tape. Hashes/addresses copy on click with a printed ack; `sandbox
 * claim` prints a live countdown-bar block. Motion is ≤120ms on value change
 * only and zero under prefers-reduced-motion.
 *
 * The command files are imported for their registration side effects —
 * adding a command elsewhere requires no change here (registry contract).
 */
import { useEffect, useMemo, useRef, useState, type JSX, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { CONFIG } from "../config";
import { env } from "../env";
import { demoAddress, getPublicClient, pickSigner } from "../data/chain";
import { fetchLagShared } from "../data/subgraph";
import { STUDIO_GATE } from "../data/cache";
import { useLiveValue } from "../ui/useLiveValue";
import { createEnsTextReader } from "../../../mcp/src/ens";
import { commands, dispatch, find, type CommandContext, type CommandResult } from "./registry";
import {
  ASK_TIMEOUT_MS,
  askLlm,
  buildLiveAskContext,
  buildSystemPrompt,
  llmConfigured,
  missingKeyRefusal,
  proposalLine,
  parseFreshnessSeconds,
  freshnessQuestionFor,
  registrySchema,
  requiresRun,
  suggestionsFor,
  type AskMode,
  type AskOutcome,
  type AskProposal,
} from "./ask";
import { askConfig } from "../data/api";
const ASK = askConfig();
const hasLlmKey = ASK !== null;
import { renderResult } from "./renderers";
import { CountdownBlock } from "./blocks/CountdownBlock";
import { LogBlock } from "./blocks/LogBlock";
import { copyAckReducer, copyAckText, type CopyAck } from "./blocks/copyAck";
import { verdictFor, type Verdict } from "./blocks/verdict";
import { completionCandidates, Palette, paletteItems, type CompletionItem } from "./palette";
import { getSandboxState } from "./commands/sandbox"; // registers the sandbox commands (side effect)
import { getActJob } from "./commands/act";
import "./commands/inspect"; // registers the inspect commands (side effect)
import "./commands/act"; // registers buy/deliver/settle (side effect)
import "./tape.css";

interface Entry {
  id: number;
  line: string;
  at: number;
  results: CommandResult[] | null; // null while the command is running
  error?: string;
  /** unix seconds when a live claim countdown should render under the block */
  countdownUntil?: number;
  /** ask-mode receipt: the model's proposal or refusal (never auto-executed) */
  ask?: AskOutcome;
  /** ask-mode in-flight: the model being asked (renders "asking <model>…") */
  asking?: string;
  /** printed by the page itself (the escrow feed), not typed: no prompt, its own badge */
  system?: boolean;
}

interface TabPopover {
  candidates: CompletionItem[];
  index: number;
}

function LiveChip({
  label,
  read,
  gateKey,
}: {
  label: string;
  read: () => Promise<string>;
  /** shared cooldown gate (the Studio chip shares the page's) */
  gateKey?: string;
}): JSX.Element {
  // last-good per chip: a failed first read shows the previous value marked
  // stale (hover for the reason) instead of a bare "error" until the next poll
  const live = useLiveValue(read, { pollMs: 15_000, staleAfterMs: 45_000, cacheKey: `console.${label}`, gateKey });
  const text =
    live.state === "live"
      ? `${label} ${live.value}`
      : live.state === "loading"
        ? `${label} …`
        : live.state === "stale"
          ? `${label} ${live.value ?? "n/a"} · stale`
          : `${label} · error`;
  const dot =
    live.state === "live" ? "ob-live" : live.state === "stale" ? "ob-live stale" : "ob-live off";
  const title =
    live.state === "live"
      ? `live · as of ${new Date(live.at).toLocaleTimeString()}`
      : (live.reason ?? live.state);
  return (
    <span className={`console__chip console__chip--${live.state}`} title={title}>
      <span className={dot} aria-hidden="true" />
      {text}
    </span>
  );
}

/** Receipt header kind chip label + state class for an entry. */
function entryBadge(entry: Entry): { label: string; stateClass: string } {
  if (entry.system) return { label: "refund", stateClass: " tape__kind--error" };
  if (entry.error !== undefined) return { label: "error", stateClass: " tape__kind--error" };
  if (entry.countdownUntil !== undefined) return { label: "countdown", stateClass: " tape__kind--countdown" };
  if (entry.ask !== undefined || entry.asking !== undefined) return { label: "ask", stateClass: "" };
  if (entry.results === null) return { label: "running", stateClass: "" };
  // plain words: a first-time reader should know what kind of receipt this is
  const labels: Record<string, string> = {
    text: "output",
    kv: "details",
    table: "table",
    ruler: "freshness",
    tx: "transaction",
    frames: "replay",
  };
  const render = entry.results[0]?.render ?? "text";
  return {
    label: labels[render] ?? render,
    stateClass: render === "tx" ? " tape__kind--tx" : "",
  };
}

function verdictStampClass(verdict: Verdict): string {
  return verdict === "APPROVED" ? "ok" : verdict === "REFUNDED" ? "refund" : "refuse";
}

function formatPrintedAt(at: number): string {
  return new Date(at).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

/** sandbox claim prints a live countdown bar while the deadline is ahead. */
function countdownUntilFor(line: string, result: CommandResult): number | undefined {
  if (line !== "sandbox claim" || result.render !== "kv") return undefined;
  const countdownRow = result.data.rows.find(([key]) => key === "countdown");
  if (countdownRow === undefined || countdownRow[1].startsWith("✗")) return undefined;
  const state = getSandboxState();
  if (state === null || state.job.deadline === 0n) return undefined;
  const until = Number(state.job.deadline);
  return until > Math.floor(Date.now() / 1000) ? until : undefined;
}

/**
 * Proposal receipt block in the tape: `proposed · <command argv>` with the
 * rationale and the proposing model, plus the confirmation gate — act and
 * sandbox proposals show a Run button (nothing auto-executes); inspect and
 * replay note they run on Enter like a typed line. Refusals print as an
 * error-styled log line (model refusal, no key, or invalid twice).
 */
function AskReceiptBlock({
  outcome,
  onRun,
}: {
  outcome: AskOutcome;
  onRun: (proposal: AskProposal) => void;
}): JSX.Element {
  if (outcome.status === "refusal") {
    return (
      <div className="console__block tape__block tape__block--ask tape__block--refusal">
        <LogBlock text={`refused · ${outcome.refusal} (by ${outcome.model})`} error />
      </div>
    );
  }
  const { proposal, model } = outcome;
  const gated = requiresRun(find(proposal.command)?.kind ?? "inspect");
  return (
    <div className="console__block tape__block tape__block--ask">
      <div className="console__ask-line">
        <span className="console__ask-tag">proposed</span>
        <code>{proposalLine(proposal)}</code>
      </div>
      <p className="console__ask-why">
        {proposal.rationale} · by {model}
      </p>
      {proposal.command === "buy" ? (
        <p className="console__ask-note">a purchase · the console asks how fresh the data must be, then runs buy, deliver and settle, one receipt each</p>
      ) : proposal.command === "sandbox stale" ? (
        <p className="console__ask-note">the fail run · executes now, every step prints below</p>
      ) : gated ? (
        <button type="button" className="console__ask-run" onClick={() => onRun(proposal)}>
          Run ↵ <span className="console__ask-run-note">nothing auto-executes</span>
        </button>
      ) : (
        <p className="console__ask-note">read-only · ran below</p>
      )}
    </div>
  );
}

/**
 * `inline` renders the console open inside the hero (no launcher, no close):
 * it is the page's main call to action. `dock` is the fixed bottom drawer used
 * on secondary routes (the system map).
 */
export function Console({ variant = "dock" }: { variant?: "dock" | "inline" } = {}): JSX.Element {
  const inline = variant === "inline";
  const [open, setOpen] = useState(inline);
  const sectionRef = useRef<HTMLElement | null>(null);
  const [mode, setMode] = useState<AskMode>("command");
  const [paletteOpen, setPaletteOpen] = useState(false);
  const paletteOpenedDrawerRef = useRef(false);
  const [entries, setEntries] = useState<Entry[]>([]);
  const [input, setInput] = useState("");
  const [history, setHistory] = useState<string[]>([]);
  const [historyIndex, setHistoryIndex] = useState(-1);
  const [popover, setPopover] = useState<TabPopover | null>(null);
  const [copyAck, setCopyAck] = useState<CopyAck | null>(null);
  const [pendingAsk, setPendingAsk] = useState<{ proposal: AskProposal } | null>(null);
  /** a spoken purchase waiting for its freshness answer */
  const [pendingFresh, setPendingFresh] = useState<{ datasetId: string; max?: string; match?: string } | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const seqRef = useRef(0);
  const askAbortRef = useRef<AbortController | null>(null);

  const readEnsText = useMemo(() => createEnsTextReader({ rpcUrl: env.sepoliaRpc }), []);

  const ctx = useMemo<CommandContext>(
    () => ({
      publicClient: getPublicClient(),
      signer: {
        kind: pickSigner({ demoKey: import.meta.env.VITE_DEMO_BUYER_KEY as string | undefined }),
        address: demoAddress(),
      },
      config: CONFIG,
      navigate: (route: string) => {
        window.location.hash = route;
      },
    }),
    [],
  );

  /** Close: the dock hides; the inline console only gives focus back to the page. */
  const close = (): void => {
    if (inline) inputRef.current?.blur();
    else setOpen(false);
  };

  /** Bring the inline console into view and focus its input (⌘K, Buy buttons, chips elsewhere). */
  const reveal = (): void => {
    sectionRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
    inputRef.current?.focus();
  };

  /** Registry snapshot (side-effect imports in commands/* populate it once). */
  const allCommands = useMemo(() => commands(), []);
  const paletteItemsMemo = useMemo(() => paletteItems(allCommands, CONFIG.datasets), [allCommands]);

  // release the in-flight ask when the dock unmounts
  useEffect(() => () => askAbortRef.current?.abort(), []);

  // ⌘K (or Ctrl+K) opens the fuzzy palette; ⌘L clears the tape.
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (paletteOpen && event.key === "Escape") {
        // wherever focus is, Escape closes the palette (it made the page inert);
        // when ⌘K opened the drawer for the palette, it closes the drawer too so
        // focus returns to where the judge was
        event.preventDefault();
        setPaletteOpen(false);
        if (paletteOpenedDrawerRef.current) {
          paletteOpenedDrawerRef.current = false;
          if (!inline) setOpen(false);
        }
        return;
      }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        // first ⌘K opens the console with its input and mode chip reachable;
        // a second ⌘K opens the command palette over it; a third closes the palette
        if (paletteOpen) {
          setPaletteOpen(false);
        } else if (inline && document.activeElement !== inputRef.current) {
          reveal();
        } else if (!open) {
          paletteOpenedDrawerRef.current = false;
          setOpen(true);
        } else {
          setPaletteOpen(true);
        }
        return;
      }
      if (open && (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "l") {
        event.preventDefault();
        setEntries([]);
        setPopover(null);
        setPaletteOpen(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, paletteOpen, inline]);

  // Buy buttons elsewhere on the page run a line here: `openbook:console-run` { line }
  useEffect(() => {
    const onRun = (event: Event): void => {
      const line = (event as CustomEvent<{ line?: string }>).detail?.line;
      if (typeof line !== "string" || line.length === 0) return;
      if (!open) setOpen(true);
      reveal();
      void runLine(line);
    };
    window.addEventListener("openbook:console-run", onRun);
    return () => window.removeEventListener("openbook:console-run", onRun);
  });


  useEffect(() => {
    if (open && !paletteOpen) inputRef.current?.focus();
  }, [open, paletteOpen]);

  // keep the newest print in view
  useEffect(() => {
    const el = bodyRef.current;
    if (!el) return;
    // the tape's scroll container is the body around the entries (overflow-y: auto)
    const scroller = el.closest<HTMLElement>(".console__body") ?? el;
    scroller.scrollTop = scroller.scrollHeight;
  }, [entries]);

  // the printed copy-ack auto-fades after a beat (value change only)
  useEffect(() => {
    if (copyAck === null) return;
    const timer = window.setTimeout(
      () => setCopyAck((prev) => copyAckReducer(prev, { type: "clear" })),
      2000,
    );
    return () => window.clearTimeout(timer);
  }, [copyAck]);

  const handleCopy = (entryId: number, hash: string): void => {
    setCopyAck((prev) => copyAckReducer(prev, { type: "copied", entryId, hash }));
  };

  const handleCopyFailed = (entryId: number, hash: string): void => {
    setCopyAck((prev) => copyAckReducer(prev, { type: "failed", entryId, hash }));
  };

  // The chips follow the tape and are hidden while an entry is still in flight: the opening
  // "try these" list is an invitation, not something to read while the answer prints.
  // A proposal counts as an answer — the line the model picked is what the next chips key
  // off, so a spoken purchase immediately offers the relevant next move.
  const busy = entries.some((en) => en.results === null && en.error === undefined && en.ask === undefined);
  const lastDone = [...entries].reverse().find((en) => !en.system && (en.results !== null || en.error !== undefined));
  const proposalEntry = [...entries].reverse().find((en) => en.ask?.status === "proposal");
  const proposalAsk =
    proposalEntry !== undefined && proposalEntry.ask !== undefined && proposalEntry.ask.status === "proposal"
      ? proposalEntry.ask
      : null;
  const actJob = getActJob();
  const suggestions = suggestionsFor({
    lastLine: lastDone?.line ?? (proposalAsk !== null ? proposalLine(proposalAsk.proposal) : null),
    job: actJob === null ? null : { jobId: actJob.jobId, datasetId: actJob.datasetId, delivered: actJob.payloadHash !== undefined, ...(actJob.outcome !== undefined ? { outcome: actJob.outcome } : {}) },
  });

  const runLine = async (line: string): Promise<CommandResult | null> => {
    if (line.length === 0) return null;
    // a typed line supersedes any pending proposal (the explicit keyboard way)
    setPendingAsk(null);
    setHistory((h) => [...h, line]);
    setHistoryIndex(-1);
    setPopover(null);
    setInput("");
    const id = seqRef.current++;
    setEntries((es) => [...es, { id, line, at: Date.now(), results: null }]);
    try {
      const result = await dispatch(line, ctx);
      setEntries((es) =>
        es.map((en) =>
          en.id === id
            ? { ...en, results: [result], countdownUntil: countdownUntilFor(line, result) }
            : en,
        ),
      );
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setEntries((es) => es.map((en) => (en.id === id ? { ...en, error: message } : en)));
      return null;
    }
  };

  /** Print a line the console says back (a question, a confirmation), not a command. */
  const say = (line: string, text: string): void => {
    const id = seqRef.current++;
    setEntries((es) => [...es, { id, line, at: Date.now(), results: [{ render: "text", data: text }] }]);
  };

  /**
   * A spoken purchase: buy with the buyer's cap and freshness, then deliver,
   * then settle, one receipt each, stopping at the first step that fails.
   */
  const runPurchasePlan = async (datasetId: string, freshSeconds: number, max?: string, match?: string): Promise<void> => {
    const flags = `--fresh ${freshSeconds}${max !== undefined ? ` --max ${max}` : ""}${match !== undefined ? ` --match "${match.replace(/"/g, "")}"` : ""}`;
    // with a freshness window the buy runs the whole purchase (fund, deliver, settle or refund) in one receipt
    await runLine(`buy ${datasetId} ${flags}`);
  };

  /** Execute a confirmed proposal through the SAME dispatch path as a typed
   * line — receipts are identical to typed usage (the LLM never executed). */
  const runProposal = (proposal: AskProposal): void => {
    setPendingAsk(null);
    void runLine(proposalLine(proposal));
  };

  /** Ask lane: build the live-context system prompt, call the LLM (propose
   * only), print a proposal or refusal receipt. Never blocks the dock: the
   * in-flight entry shows "asking <model>…" with a cancel. With no key the
   * refusal receipt is immediate: no asking state, no live-context reads, no
   * fetch (round-1 review — the tape must not pretend a model call happens). */
  const runAsk = async (question: string): Promise<void> => {
    const text = question.trim();
    if (text.length === 0) return;
    setPendingAsk(null);
    setPopover(null);
    setInput("");
    const id = seqRef.current++;
    if (ASK === null || !llmConfigured(ASK.apiKey)) {
      setEntries((es) => [...es, { id, line: `ask · ${text}`, at: Date.now(), results: null, ask: missingKeyRefusal() }]);
      return;
    }
    const controller = new AbortController();
    askAbortRef.current?.abort();
    askAbortRef.current = controller;
    setEntries((es) => [...es, { id, line: `ask · ${text}`, at: Date.now(), results: null, asking: ASK?.model === "server" ? "the server model" : (ASK?.model ?? "") }]);
    try {
      const systemPrompt = buildSystemPrompt(registrySchema(allCommands), await buildLiveAskContext());
      const outcome = await askLlm(
        text,
        { baseUrl: ASK!.baseUrl, apiKey: ASK!.apiKey, model: ASK!.model, signal: controller.signal },
        systemPrompt,
        allCommands,
      );
      setEntries((es) => es.map((en) => (en.id === id ? { ...en, asking: undefined, ask: outcome } : en)));
      if (outcome.status === "proposal") {
        const picked = find(outcome.proposal.command);
        const argv = outcome.proposal.argv;
        if (picked !== undefined && !requiresRun(picked.kind)) {
          // a read: run it now, the proposal receipt above shows what was picked and why
          void runLine(proposalLine(outcome.proposal));
        } else if (outcome.proposal.command === "sandbox stale") {
          // a spoken fail run is the demo's second act: run it, it prints every step
          void runLine(proposalLine(outcome.proposal));
        } else if (outcome.proposal.command === "buy" && argv[0] !== undefined) {
          const at = argv.indexOf("--fresh");
          const maxAt = argv.indexOf("--max");
          const matchAt = argv.indexOf("--match");
          const max = maxAt >= 0 ? argv[maxAt + 1] : undefined;
          const match = matchAt >= 0 ? argv[matchAt + 1] : undefined;
          const fresh = at >= 0 ? parseFloat(argv[at + 1] ?? "") : NaN;
          if (Number.isFinite(fresh) && fresh > 0) {
            void runPurchasePlan(argv[0], fresh, max, match);
          } else {
            setPendingFresh({ datasetId: argv[0], max, match });
            say(`ask · ${text}`, freshnessQuestionFor(argv[0]));
          }
        } else {
          setPendingAsk({ proposal: outcome.proposal });
        }
      }
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      const message = err.name === "AbortError" ? "ask cancelled" : err.message;
      setEntries((es) => es.map((en) => (en.id === id ? { ...en, asking: undefined, error: message } : en)));
    } finally {
      if (askAbortRef.current === controller) askAbortRef.current = null;
    }
  };

  const cancelAsk = (): void => {
    askAbortRef.current?.abort();
  };

  const navHistory = (delta: number): void => {
    if (history.length === 0) return;
    const next = Math.min(history.length - 1, Math.max(-1, historyIndex + delta));
    setHistoryIndex(next);
    setInput(next === -1 ? "" : history[history.length - 1 - next]);
  };

  /** Tab: cycles the popover's current match set, or builds it from the input. */
  const complete = (): void => {
    if (popover !== null) {
      const next = (popover.index + 1) % popover.candidates.length;
      setInput(popover.candidates[next].value);
      setPopover({ ...popover, index: next });
      return;
    }
    const candidates = completionCandidates(input, allCommands, CONFIG.datasets);
    if (candidates.length === 0) return;
    setInput(candidates[0].value);
    setPopover({ candidates, index: 0 });
  };

  const applyCompletion = (candidate: CompletionItem): void => {
    setInput(candidate.value);
    setPopover(null);
    inputRef.current?.focus();
  };

  const onKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>): void => {
    if (event.key === "Tab") {
      event.preventDefault();
      // ask mode: Tab returns to the command lane (the nudge's invitation)
      if (mode === "ask") {
        setMode("command");
        return;
      }
      // command mode: Tab completes a command prefix; plain language needs no mode switch
      // any more (Enter routes it to the model), so a line with no completion just stays
      complete();
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      navHistory(1);
      return;
    }
    if (event.key === "ArrowDown") {
      event.preventDefault();
      navHistory(-1);
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      const text = input.trim();
      if (mode === "ask" && text.length > 0) {
        void runAsk(text);
        return;
      }
      // an empty input with a pending proposal runs it (explicit second Enter)
      if (pendingAsk !== null && text.length === 0) {
        runProposal(pendingAsk.proposal);
        return;
      }
      // the answer to "how fresh?": a time runs the purchase, anything else is a new question
      if (pendingFresh !== null && text.length > 0 && find(text) === undefined) {
        const seconds = parseFreshnessSeconds(text);
        const plan = pendingFresh;
        setInput("");
        if (seconds === null) {
          say(`ask · ${text}`, "I need a time, for example: under 10 seconds, or a minute");
          return;
        }
        setPendingFresh(null);
        say(`ask · ${text}`, `freshness set to ${seconds} second${seconds === 1 ? "" : "s"} · buying ${plan.datasetId}${plan.match !== undefined ? ` for "${plan.match}"` : ""}${plan.max !== undefined ? ` with a cap of ${plan.max} USDC` : ""} now`);
        void runPurchasePlan(plan.datasetId, seconds, plan.max, plan.match);
        return;
      }
      // plain language goes to the model: anything that is not a known command is a question
      if (text.length > 0 && find(text) === undefined) {
        void runAsk(text);
        return;
      }
      void runLine(text);
      return;
    }
    if (event.key === "Escape") {
      if (askAbortRef.current !== null) {
        cancelAsk();
        return;
      }
      if (popover !== null) {
        setPopover(null);
        return;
      }
      if (pendingAsk !== null) {
        setPendingAsk(null);
        return;
      }
      close();
    }
  };

  if (!open && !inline) {
    return (
      <button
        type="button"
        className="console__launcher"
        onClick={() => setOpen(true)}
        aria-label="open the console (⌘K)"
      >
        console <kbd>⌘K</kbd>
      </button>
    );
  }

  return (
    <section ref={sectionRef} id="console" className={inline ? "console console--inline" : "console"} aria-label="openbook console · the receipt printer">
      <header className="console__head">
        <span className="console__title">console</span>
        {!inline && (
        <span className="console__chips">
          <LiveChip label={inline ? "Arc block" : "arc"} read={() => getPublicClient().getBlockNumber().then((n) => n.toLocaleString("en-US"))} />
          <LiveChip label={inline ? "indexed" : "subgraph"} gateKey={STUDIO_GATE} read={() => fetchLagShared().then((l) => (inline ? l.indexed.toLocaleString("en-US") : `idx ${l.indexed.toLocaleString("en-US")} · ${l.rows} rows`))} />
          <LiveChip label={inline ? "openbook.eth" : "ens"} read={() => readEnsText(CONFIG.ens, "svc.price").then((p) => (p === null ? "no price" : inline ? p.replace(/\/query$/, "") : p))} />
        </span>
        )}
        <span className="console__hints">{inline ? "⌘K palette · Tab complete · ↵ runs" : "⌘K palette · Tab complete · mode chip · ↵ runs · Esc close"}</span>
        <button
          type="button"
          className="console__close"
          hidden={inline}
          onClick={close}
          aria-label="close console (⌘K)"
        >
          ×
        </button>
      </header>

      <div className="console__body">
        <div className="console__entries" ref={bodyRef} aria-live="polite" role="log">
          {entries.length === 0 ? (
            <div className="console__empty">
              <p className="console__empty-line">
                ask in plain English, pick a chip, or type a command · every one runs against the live escrow and
                prints a receipt · a purchase waits for your Enter before it spends
              </p>
              <p className="tape__hints">
                <kbd>⌘K</kbd> palette · <kbd>Tab</kbd> complete or ask · <kbd>↑↓</kbd> history ·{" "}
                <kbd>⌘L</kbd> clears · <kbd>Esc</kbd> close
              </p>
            </div>
          ) : (
            entries.map((entry) => {
              const badge = entryBadge(entry);
              const verdict = verdictFor(entry.line, entry.results?.[0] ?? null);
              return (
                <article className="console__entry tape__receipt" key={entry.id}>
                  <header className="tape__rec-head">
                    <span className="tape__serial">receipt {entry.id + 1}</span>
                    <time className="tape__at" dateTime={new Date(entry.at).toISOString()}>
                      {formatPrintedAt(entry.at)}
                    </time>
                    <span className={`tape__kind${badge.stateClass}`}>{badge.label}</span>
                  </header>
                  <div className={entry.system ? "console__line console__line--system" : "console__line"}>
                    {!entry.system && (
                      <>
                        <span className="console__prompt" aria-hidden="true">
                          ›
                        </span>{" "}
                      </>
                    )}
                    {entry.line}
                  </div>
                  <div className="console__result">
                    {entry.error !== undefined ? (
                      <div className="console__block tape__block tape__block--error">
                        <LogBlock text={`${entry.line} failed: ${entry.error}`} error />
                      </div>
                    ) : entry.asking !== undefined ? (
                      <div className="console__block tape__block tape__block--ask">
                        <LogBlock text={`asking ${entry.asking}… (budget ${ASK_TIMEOUT_MS / 1000}s)`} />
                        <button type="button" className="console__ask-cancel" onClick={cancelAsk}>
                          cancel
                        </button>
                      </div>
                    ) : entry.ask !== undefined ? (
                      <AskReceiptBlock outcome={entry.ask} onRun={runProposal} />
                    ) : entry.results === null ? (
                      <div className="console__block tape__block tape__block--log">
                        <LogBlock text="printing…" />
                      </div>
                    ) : (
                      entry.results.map((result, i) => (
                        <div key={i} className={`console__block console__block--${result.render} tape__block tape__block--${result.render}`}>
                          {renderResult(
                            result,
                            (jobId) => ctx.navigate(`#theater/${jobId}`),
                            (hash) => handleCopy(entry.id, hash),
                            (hash) => handleCopyFailed(entry.id, hash),
                          )}
                        </div>
                      ))
                    )}
                    {entry.countdownUntil !== undefined && (
                      <div className="console__block tape__block tape__block--countdown">
                        <CountdownBlock until={entry.countdownUntil} />
                      </div>
                    )}
                  </div>
                  {verdict !== null && (
                    <span
                      className={`tape__stamp tape__stamp--${verdictStampClass(verdict)}`}
                      aria-label={`verdict: ${verdict}`}
                    >
                      {verdict}
                    </span>
                  )}
                  {copyAck !== null && copyAck.entryId === entry.id && (
                    <div className={`tape__ack${copyAck.failed === true ? " tape__ack--failed" : ""}`}>
                      {copyAckText(copyAck)}
                    </div>
                  )}
                  <div className="tape__perf" aria-hidden="true" />
                </article>
              );
            })
          )}
        </div>
      </div>

      {popover !== null && (
        <div className="tape__pop" role="listbox" aria-label="tab completion · commands and datasets">
          <div className="tape__pop-head">
            {popover.candidates.length} match{popover.candidates.length === 1 ? "" : "es"} · tab cycles · click picks
          </div>
          {popover.candidates.map((candidate) => (
            <div
              key={`${candidate.kind}-${candidate.label}`}
              role="option"
              aria-selected={candidate.value === popover.candidates[popover.index]?.value}
              className={`tape__pop-item tape__pop-item--${candidate.kind}${
                candidate.value === popover.candidates[popover.index]?.value ? " tape__pop-item--sel" : ""
              }`}
              onClick={() => applyCompletion(candidate)}
            >
              <span className="tape__pop-name">{candidate.label}</span>
              <span className="tape__pop-hint">{candidate.hint}</span>
              <span className="tape__pop-kind">{candidate.kind === "command" ? "CMD" : "DATA"}</span>
            </div>
          ))}
        </div>
      )}

      {!busy && (
      <div className="console__asks">
        <span className="console__asks-cap">{entries.length === 0 ? "try these" : "next"}</span>
        {suggestions.map((ask) => (
          <button
            type="button"
            key={ask.line}
            className="console__ask-chip"
            title={`runs: ${ask.line} (static mapping, no key needed)`}
            onClick={() => void runLine(ask.line)}
          >
            {ask.label}
          </button>
        ))}
      </div>
      )}


      <div className="console__inputrow">
        <button
          type="button"
          className={`console__mode console__mode--${mode}`}
          onClick={() => setMode((m) => (m === "command" ? "ask" : "command"))}
          title="click or Tab to toggle mode"
          aria-label={`input mode: ${mode}`}
          aria-pressed={mode === "ask"}
        >
          {mode === "command" ? (hasLlmKey ? "command ▸ ask" : "command") : hasLlmKey ? "ask ◂ command" : "ask mode is off on this deployment"}
        </button>
        <span className="console__prompt" aria-hidden="true">
          ›
        </span>
        <input
          ref={inputRef}
          className="console__input"
          value={input}
          onChange={(event) => {
            setInput(event.target.value);
            setPopover(null);
          }}
          onKeyDown={onKeyDown}
          placeholder={mode === "command" ? "type a command · help" : "ask a question · the LLM proposes, the registry executes"}
          aria-label={`console ${mode} input`}
          autoComplete="off"
          autoCapitalize="off"
          spellCheck={false}
        />
        <span className="tape__rowhint">
          {pendingAsk !== null ? (
            <kbd>↵</kbd>
          ) : (
            <kbd>⌘L</kbd>
          )}
          {pendingAsk !== null ? " runs proposal" : " clears"}
        </span>
      </div>

      <Palette
        open={paletteOpen}
        items={paletteItemsMemo}
        onRun={(line) => {
          setPaletteOpen(false);
          void runLine(line);
        }}
        onClose={() => {
          setPaletteOpen(false);
          inputRef.current?.focus();
        }}
      />
    </section>
  );
}
