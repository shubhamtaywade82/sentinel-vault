import {
  LayoutDashboard,
  KeyRound,
  Bot,
  Cable,
  RefreshCw,
  ScrollText,
  ShieldCheck,
  Timer,
  Building2,
  type LucideIcon,
} from "lucide-react";

import type { VaultView } from "./store";

export interface NavItem {
  id: VaultView;
  label: string;
  icon: LucideIcon;
  description: string;
}

export const NAV_ITEMS: NavItem[] = [
  {
    id: "dashboard",
    label: "Dashboard",
    icon: LayoutDashboard,
    description: "Operational overview & KPIs",
  },
  {
    id: "secrets",
    label: "Secrets",
    icon: KeyRound,
    description: "Versioned, encrypted secret store",
  },
  {
    id: "clients",
    label: "Service Clients",
    icon: Bot,
    description: "Identities & credentials",
  },
  {
    id: "connections",
    label: "Connections",
    icon: Cable,
    description: "Provider integrations & refresh",
  },
  {
    id: "runs",
    label: "Rotation Runs",
    icon: RefreshCw,
    description: "Durable rotation run ledger",
  },
  {
    id: "audit",
    label: "Audit Log",
    icon: ScrollText,
    description: "Value-free access trail",
  },
  {
    id: "grants",
    label: "Access Grants",
    icon: ShieldCheck,
    description: "Per-client secret grants",
  },
  {
    id: "leases",
    label: "Leases",
    icon: Timer,
    description: "Short-lived credential delivery",
  },
  {
    id: "workspaces",
    label: "Workspaces",
    icon: Building2,
    description: "Tenant isolation",
  },
];
