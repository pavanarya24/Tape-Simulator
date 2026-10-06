import type { ContractId, ContractSpec, RootSymbol } from "./types";

/**
 * Futures contract specifications.
 *
 * Values are the standard published multiplier / tick values for CME equity
 * index futures. Point value = dollars per index point per contract.
 */
export const CONTRACTS: Record<ContractId, ContractSpec> = {
  NQ: {
    id: "NQ",
    root: "NQ",
    label: "NQ — E-mini Nasdaq-100",
    pointValue: 20,
    tickSize: 0.25,
    tickValue: 5,
    currency: "USD",
  },
  MNQ: {
    id: "MNQ",
    root: "NQ",
    label: "MNQ — Micro E-mini Nasdaq-100",
    pointValue: 2,
    tickSize: 0.25,
    tickValue: 0.5,
    currency: "USD",
  },
  ES: {
    id: "ES",
    root: "ES",
    label: "ES — E-mini S&P 500",
    pointValue: 50,
    tickSize: 0.25,
    tickValue: 12.5,
    currency: "USD",
  },
  MES: {
    id: "MES",
    root: "ES",
    label: "MES — Micro E-mini S&P 500",
    pointValue: 5,
    tickSize: 0.25,
    tickValue: 1.25,
    currency: "USD",
  },
};

export const CONTRACT_IDS: ContractId[] = ["NQ", "MNQ", "ES", "MES"];
export const ROOT_SYMBOLS: RootSymbol[] = ["NQ", "ES"];

/** Contracts available for a given underlying root (e.g. NQ -> NQ, MNQ). */
export function contractsForRoot(root: RootSymbol): ContractSpec[] {
  return CONTRACT_IDS.map((id) => CONTRACTS[id]).filter((c) => c.root === root);
}

export function defaultContractForRoot(root: RootSymbol): ContractId {
  return root === "ES" ? "ES" : "NQ";
}

/** Round a price to the contract's tick grid. */
export function roundToTick(price: number, spec: ContractSpec): number {
  return Math.round(price / spec.tickSize) * spec.tickSize;
}

/** Dollar value of a price move, per `contracts`. */
export function priceToDollars(points: number, spec: ContractSpec, contracts: number): number {
  return points * spec.pointValue * contracts;
}
