"use client";

import { useEffect, useState } from "react";
import { GeminiKeySetup } from "./GeminiKeySetup";

export function GeminiKeySetupWrapper() {
  const [initialShowFromInvalid, setInitialShowFromInvalid] = useState(false);

  useEffect(() => {
    // WARN-03: useEffect는 항상 클라이언트에서만 실행되므로 typeof window 체크 불필요
    const params = new URLSearchParams(window.location.search);
    setInitialShowFromInvalid(params.get("geminiKeyInvalid") === "1");
  }, []);

  return <GeminiKeySetup initialShowFromInvalid={initialShowFromInvalid} />;
}
