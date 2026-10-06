import { useEffect, useState } from "react";
import type { AppState } from "../state/app";
import { controller } from "../state/useApp";
import { CONTRACTS } from "../market/instruments";
import { money, signedMoney, pnlClass, price as fmtPrice, num } from "../util/format";

export function RightColumn({ state }: { state: AppState }) {
  const { engine, position, settings, session } = state;
  const spec = CONTRACTS[settings.contract];

  const cursor = engine?.cursor ?? 0;
  const lastPrice = session && controller.session ? controller.session.bars.c[cursor] : NaN;

  const [qty, setQty] = useState(1);
  const [price, setPrice] = useState("");
  const [stop, setStop] = useState("");
  const [target, setTarget] = useState("");

  useEffect(() => {
    if (Number.isFinite(lastPrice) && price === "") setPrice(lastPrice.toFixed(spec.tickSize === 0.25 ? 2 : 2));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lastPrice]);

  const numOr = (v: string): number | undefined => {
    const n = Number(v);
    return v.trim() !== "" && Number.isFinite(n) ? n : undefined;
  };

  const submit = (side: "buy" | "sell", type: "market" | "limit" | "stop") => {
    controller.placeOrder({
      side,
      type,
      qty: Math.max(1, Math.floor(qty)),
      price: type === "market" ? undefined : numOr(price),
      stopLoss: numOr(stop),
      takeProfit: numOr(target),
    });
  };

  const working = state.orders.filter((o) => o.status === "working");

  return (
    <div className="col right">
      <section className="panel">
        <div className="panel-head">
          <span className="panel-title">Order ticket</span>
          <span className="right badge">{spec.id}</span>
        </div>
        <div className="panel-body">
          <div className="field">
            <label>Size</label>
            <input
              type="number"
              min={1}
              step={1}
              value={qty}
              onChange={(e) => setQty(Number(e.target.value))}
            />
          </div>
          <div className="field">
            <label>Price</label>
            <div style={{ display: "flex", gap: 6 }}>
              <input type="text" value={price} onChange={(e) => setPrice(e.target.value)} />
              <button
                className="btn sm"
                onClick={() => Number.isFinite(lastPrice) && setPrice(lastPrice.toFixed(2))}
              >
                LAST
              </button>
            </div>
          </div>
          <div className="field">
            <label>Stop loss</label>
            <input type="text" placeholder="optional" value={stop} onChange={(e) => setStop(e.target.value)} />
          </div>
          <div className="field">
            <label>Take profit</label>
            <input type="text" placeholder="optional" value={target} onChange={(e) => setTarget(e.target.value)} />
          </div>

          <div className="grid2" style={{ marginBottom: 6 }}>
            <button className="btn buy wide" onClick={() => submit("buy", "market")} disabled={!engine}>
              MARKET BUY
            </button>
            <button className="btn sell wide" onClick={() => submit("sell", "market")} disabled={!engine}>
              MARKET SELL
            </button>
          </div>
          <div className="grid2" style={{ marginBottom: 6 }}>
            <button className="btn buy wide" onClick={() => submit("buy", "limit")} disabled={!engine}>
              LIMIT BUY
            </button>
            <button className="btn sell wide" onClick={() => submit("sell", "limit")} disabled={!engine}>
              LIMIT SELL
            </button>
          </div>
          <div className="grid2">
            <button className="btn buy wide" onClick={() => submit("buy", "stop")} disabled={!engine}>
              STOP BUY
            </button>
            <button className="btn sell wide" onClick={() => submit("sell", "stop")} disabled={!engine}>
              STOP SELL
            </button>
          </div>
          <p className="dim" style={{ fontSize: 10.5, margin: "9px 0 0" }}>
            Market orders fill at the <strong>next revealed candle's open</strong> plus slippage.
            Orders only ever act on bars the replay has already revealed.
          </p>
        </div>
      </section>

      <section className="panel">
        <div className="panel-head">
          <span className="panel-title">Position</span>
          <span className="right badge">{position.direction.toUpperCase()}</span>
        </div>
        <div className={`pos-hero ${position.direction}`}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
            <span className="pos-dir">
              {position.direction === "flat"
                ? "FLAT"
                : `${position.direction === "long" ? "LONG" : "SHORT"} ${position.contracts}`}
            </span>
            <span className={`pnl-big ${pnlClass(position.unrealized)}`}>
              {signedMoney(position.unrealized)}
            </span>
          </div>
          <div className="dim mono" style={{ fontSize: 10.5 }}>
            unrealized at {fmtPrice(position.mark)} · realized {signedMoney(position.realized)}
          </div>
        </div>
        <div className="panel-body">
          <div className="kv">
            <span className="k">Contracts</span>
            <span className="v">{position.contracts || "—"}</span>
            <span className="k">Avg entry</span>
            <span className="v">{position.contracts ? fmtPrice(position.avgEntry) : "—"}</span>
            <span className="k">Current price</span>
            <span className="v">{fmtPrice(position.mark)}</span>
            <span className="k">Stop</span>
            <span className="v">{position.stop !== undefined ? fmtPrice(position.stop) : "—"}</span>
            <span className="k">Target</span>
            <span className="v">{position.target !== undefined ? fmtPrice(position.target) : "—"}</span>
            <span className="k">Unrealized P&amp;L</span>
            <span className={`v ${pnlClass(position.unrealized)}`}>{signedMoney(position.unrealized)}</span>
            <span className="k">Realized P&amp;L</span>
            <span className={`v ${pnlClass(position.realized)}`}>{signedMoney(position.realized)}</span>
            <span className="k">Risk</span>
            <span className="v">{position.risk !== undefined ? money(position.risk) : "—"}</span>
            <span className="k">Reward</span>
            <span className="v">{position.reward !== undefined ? money(position.reward) : "—"}</span>
            <span className="k">R multiple</span>
            <span className={`v ${pnlClass(position.rMultiple)}`}>
              {position.rMultiple !== undefined ? `${num(position.rMultiple, 2)}R` : "—"}
            </span>
          </div>
          <div className="btn-row" style={{ marginTop: 12 }}>
            <button className="btn flat wide" onClick={() => controller.flatten()} disabled={position.direction === "flat"}>
              FLATTEN
            </button>
            <button className="btn flat wide" onClick={() => controller.reverse()} disabled={position.direction === "flat"}>
              REVERSE
            </button>
          </div>
        </div>
      </section>

      <section className="panel">
        <div className="panel-head">
          <span className="panel-title">Working orders</span>
          <span className="right badge">{working.length}</span>
        </div>
        <div className="panel-body" style={{ padding: working.length ? 0 : 11 }}>
          {working.length === 0 ? (
            <p className="dim" style={{ fontSize: 11, margin: 0 }}>
              No working orders.
            </p>
          ) : (
            <table className="table">
              <thead>
                <tr>
                  <th>Type</th>
                  <th>Side</th>
                  <th className="r">Qty</th>
                  <th className="r">Price</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {working.map((o) => (
                  <tr key={o.id}>
                    <td>{o.type.toUpperCase()}</td>
                    <td className={o.side === "buy" ? "up" : "down"}>{o.side.toUpperCase()}</td>
                    <td className="r">{o.qty}</td>
                    <td className="r">{o.price !== undefined ? fmtPrice(o.price) : "MKT"}</td>
                    <td className="r">
                      <button className="btn sm" onClick={() => controller.cancelOrder(o.id)}>
                        ✕
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </section>

      <section className="panel">
        <div className="panel-head">
          <span className="panel-title">Order-flow interfaces</span>
          <span className="right badge warn">REQUIRES TICK / L2</span>
        </div>
        <div className="panel-body">
          <p className="dim" style={{ fontSize: 11, margin: 0 }}>
            This terminal shows OHLCV 5-minute bars, which contain no Time &amp; Sales, depth or
            aggressor data — those panels stay empty here on purpose. Train order flow on
            deterministic synthetic events in the <strong>Flow Lab</strong>, or connect a real
            tick / Level-2 source to enable them on recorded sessions.
          </p>
        </div>
      </section>
    </div>
  );
}
