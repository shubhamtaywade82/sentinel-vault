"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useLayoutEffect, useState, type ReactNode } from "react";
import { useVaultStore } from "./store";

export function Providers({ children }: { children: ReactNode }) {
  const [client] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            retry: false,
            refetchOnWindowFocus: false,
            staleTime: 15_000,
          },
        },
      }),
  );

  // Layout effect runs before any child's passive effects and query fetches,
  // so persisted tokens are in place before the first API call.
  useLayoutEffect(() => {
    useVaultStore.persist.rehydrate();
  }, []);

  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}
