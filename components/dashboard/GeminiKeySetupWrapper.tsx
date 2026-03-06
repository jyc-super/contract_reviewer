"use client";

import { useEffect, useState } from "react";
import { GeminiKeySetup } from "./GeminiKeySetup";

export function GeminiKeySetupWrapper() {
  const [initialShowFromInvalid, setInitialShowFromInvalid] = useState(false);

  useEffect(() => {
    const params = new URLSearchParams(typeof window !== "undefined" ? window.location.search : "");
    setInitialShowFromInvalid(params.get("geminiKeyInvalid") === "1");
  }, []);

  return <GeminiKeySetup initialShowFromInvalid={initialShowFromInvalid} />;
}
